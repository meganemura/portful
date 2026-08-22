import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertConfig, convertRepoTable } from '../src/commands/migrate.ts';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'portful.js');

test('convertRepoTable: renames the snake_case port keys and leaves the rest alone', () => {
  assert.deepEqual(
    convertRepoTable({ path: '~/work/api', fixed_port: 3000, port_range: [3101, 3199], serve: 'echo {port}' }),
    { path: '~/work/api', fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' }
  );
});

test('convertRepoTable: an unrecognised key passes through rather than being dropped', () => {
  assert.deepEqual(convertRepoTable({ somethingNew: 1 }), { somethingNew: 1 });
});

test('convertConfig: converts every repo and carries ui and picker across', () => {
  const out = convertConfig({
    repos: {
      api: { path: '/tmp/api', fixed_port: 3000, port_range: [3101, 3199], serve: 'echo {port}' },
      front: { path: '/tmp/front', fixed_port: 8080, port_range: [8101, 8199], serve: 'echo {port}' },
    },
    picker: { command: 'fzf' },
    ui: { open: 'launcher {cmd}' },
  });

  assert.deepEqual(out, {
    repos: {
      api: { path: '/tmp/api', fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' },
      front: { path: '/tmp/front', fixedPort: 8080, portRange: [8101, 8199], serve: 'echo {port}' },
    },
    picker: { command: 'fzf' },
    ui: { open: 'launcher {cmd}' },
  });
});

test('convertConfig: a nested https table survives the conversion untouched', () => {
  const out = convertConfig({
    repos: { api: { path: '/tmp/api', fixed_port: 3000, port_range: [3101, 3199], serve: 'echo {port}', https: { cert: '/c.pem', key: '/k.pem', backend: true } } },
  });
  assert.deepEqual((out.repos as Record<string, Record<string, unknown>>).api.https, {
    cert: '/c.pem',
    key: '/k.pem',
    backend: true,
  });
});

async function withLegacyConfig<T>(toml: string, fn: (configRoot: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const configRoot = await mkdtemp(join(tmpdir(), 'portful-migrate-'));
  try {
    await mkdir(join(configRoot, 'portful'), { recursive: true });
    await writeFile(join(configRoot, 'portful', 'config.toml'), toml);
    return await fn(configRoot, { ...process.env, XDG_CONFIG_HOME: configRoot });
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
}

const LEGACY = ['[repos.api]', 'path = "/tmp/api"', 'fixed_port = 3000', 'port_range = [3101, 3199]', 'serve = "echo {port}"', ''].join('\n');

test('migrate: writes config.json from config.toml and leaves the original in place', async () => {
  await withLegacyConfig(LEGACY, async (configRoot, env) => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'migrate'], { env });
    assert.match(stdout, /Converted .*config\.toml to .*config\.json/);
    assert.match(stdout, /Repos carried over: api/);

    const written = JSON.parse(await readFile(join(configRoot, 'portful', 'config.json'), 'utf8'));
    assert.deepEqual(written, {
      repos: { api: { path: '/tmp/api', fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' } },
    });

    // The old file stays, so a failed conversion can be retried from it.
    await readFile(join(configRoot, 'portful', 'config.toml'), 'utf8');
  });
});

test('migrate: refuses to overwrite an existing config.json unless --force is given', async () => {
  await withLegacyConfig(LEGACY, async (configRoot, env) => {
    await writeFile(join(configRoot, 'portful', 'config.json'), '{"repos":{"kept":{"path":"/tmp/kept"}}}');

    await assert.rejects(
      () => execFileAsync(process.execPath, [binPath, 'migrate'], { env }),
      (err: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.match(String(err.stderr), /already exists.*--force/s);
        return true;
      }
    );

    const kept = JSON.parse(await readFile(join(configRoot, 'portful', 'config.json'), 'utf8'));
    assert.ok(kept.repos.kept, 'the existing config should be untouched');

    await execFileAsync(process.execPath, [binPath, 'migrate', '--force'], { env });
    const replaced = JSON.parse(await readFile(join(configRoot, 'portful', 'config.json'), 'utf8'));
    assert.ok(replaced.repos.api, 'the forced run should have replaced it');
  });
});

test('migrate: finds a TOML config left under the previous name', async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'portful-migrate-prev-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'portful-migrate-prev-state-'));
  try {
    await mkdir(join(configRoot, 'wtshunt'), { recursive: true });
    await writeFile(join(configRoot, 'wtshunt', 'config.toml'), LEGACY);
    await mkdir(join(stateRoot, 'wtshunt'), { recursive: true });
    await writeFile(join(stateRoot, 'wtshunt', 'state.json'), JSON.stringify({ repos: { api: { ports: { main: 3101 }, servers: {} } }, tasks: { t: { members: { api: 'main' } } } }));

    const env = { ...process.env, XDG_CONFIG_HOME: configRoot, XDG_STATE_HOME: stateRoot };
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'migrate'], { env });
    assert.match(stdout, /wtshunt\/config\.toml to .*portful\/config\.json/);
    assert.match(stdout, /Carried the state file across/);

    const written = JSON.parse(await readFile(join(configRoot, 'portful', 'config.json'), 'utf8'));
    assert.equal(written.repos.api.fixedPort, 3000);

    // Sticky ports and tasks come across, so nothing is handed out again from
    // scratch and no task definition is lost.
    const state = JSON.parse(await readFile(join(stateRoot, 'portful', 'state.json'), 'utf8'));
    assert.equal(state.repos.api.ports.main, 3101);
    assert.deepEqual(state.tasks.t.members, { api: 'main' });
  } finally {
    await rm(configRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('migrate: with no TOML config to read, says so instead of writing an empty file', async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'portful-migrate-none-'));
  try {
    await mkdir(join(configRoot, 'portful'), { recursive: true });
    await assert.rejects(
      () => execFileAsync(process.execPath, [binPath, 'migrate'], { env: { ...process.env, XDG_CONFIG_HOME: configRoot } }),
      (err: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.match(String(err.stderr), /No TOML config to convert/);
        assert.match(String(err.stderr), /wtshunt\/config\.toml/, 'the previous name should be listed among the places checked');
        return true;
      }
    );
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
});
