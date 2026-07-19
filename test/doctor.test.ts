import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureRepoState, withState } from '../src/state.ts';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'wtshunt.js');

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

interface Fixture {
  base: string;
  configDir: string;
  stateDir: string;
  apiMain: string;
}

async function makeFixture(fixedPort = 3000, portRange: [number, number] = [3101, 3199]): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-doctor-repo-'));
  const apiMain = join(base, 'api-main');
  await mkdir(apiMain, { recursive: true });
  await git(apiMain, ['init', '-q', '-b', 'main']);
  await git(apiMain, ['config', 'user.email', 'test@example.com']);
  await git(apiMain, ['config', 'user.name', 'Test']);
  await writeFile(join(apiMain, 'f.txt'), 'hi');
  await git(apiMain, ['add', '.']);
  await git(apiMain, ['commit', '-q', '-m', 'init']);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-doctor-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    [
      '[repos.api]',
      `path = "${apiMain}"`,
      `fixed_port = ${fixedPort}`,
      `port_range = [${portRange[0]}, ${portRange[1]}]`,
      'serve = "echo {port}"',
      '',
    ].join('\n')
  );

  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-doctor-state-'));

  return { base, configDir, stateDir, apiMain };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await rm(fixture.base, { recursive: true, force: true });
  await rm(fixture.configDir, { recursive: true, force: true });
  await rm(fixture.stateDir, { recursive: true, force: true });
}

async function seedState(stateDir: string, fn: Parameters<typeof withState>[0]): Promise<void> {
  const original = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateDir;
  try {
    await withState(fn);
  } finally {
    if (original === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = original;
    }
  }
}

function envFor(fixture: Fixture): NodeJS.ProcessEnv {
  return { ...process.env, XDG_CONFIG_HOME: fixture.configDir, XDG_STATE_HOME: fixture.stateDir };
}

test('doctor: a healthy fixture prints every section and exits 0', async () => {
  const fixture = await makeFixture();
  try {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'doctor'], { env: envFor(fixture) });

    assert.match(stdout, /^wtshunt \d+\.\d+\.\d+/m);
    assert.match(stdout, /^Node v/m);
    assert.match(stdout, /^Platform: /m);
    assert.match(stdout, /^Config: /m);
    assert.match(stdout, /loads OK/);
    assert.match(stdout, /repos\.api: OK, 1 worktree\(s\)/);
    assert.match(stdout, /^Ports:/m);
    assert.match(stdout, /fixed_port 3000: not listening.*-- OK/);
    assert.match(stdout, /^State: /m);
    assert.match(stdout, /no stale entries/);
    assert.match(stdout, /^Environment:/m);
    assert.match(stdout, /Picker: /);
    assert.match(stdout, /Multiplexer: /);
  } finally {
    await cleanup(fixture);
  }
});

test('doctor: reports a missing config as a finding and exits 1, without crashing', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-doctor-noconfig-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-doctor-noconfig-state-'));
  try {
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [binPath, 'doctor'], {
          env: { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir },
        }),
      (err: NodeJS.ErrnoException & { code?: number; stdout?: string }) => {
        assert.equal(err.code, 1);
        assert.match(String(err.stdout), /wtshunt \d+\.\d+\.\d+/); // version/node/platform still printed
        assert.match(String(err.stdout), /FAILED to load/);
        assert.match(String(err.stdout), /\(skipped: config failed to load\)/);
        return true;
      }
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('doctor: exits 1 and reports stale state entries (reusing prune\'s own detector)', async () => {
  const fixture = await makeFixture();
  try {
    await git(fixture.apiMain, ['worktree', 'add', '-q', '-b', 'task-b', join(fixture.base, 'api-task-b')]);
    await git(fixture.apiMain, ['worktree', 'remove', '--force', join(fixture.base, 'api-task-b')]);
    await seedState(fixture.stateDir, (state) => {
      ensureRepoState(state, 'api').ports['api-task-b'] = 3105;
    });

    await assert.rejects(
      () => execFileAsync(process.execPath, [binPath, 'doctor'], { env: envFor(fixture) }),
      (err: NodeJS.ErrnoException & { code?: number; stdout?: string }) => {
        assert.equal(err.code, 1);
        assert.match(String(err.stdout), /stale entries found/);
        assert.match(String(err.stdout), /api\/api-task-b: remove the sticky port assignment \(worktree gone\)/);
        return true;
      }
    );
  } finally {
    await cleanup(fixture);
  }
});

test('doctor: exits 1 on a port mismatch — something listening that state does not expect', async () => {
  const fixedPort = 41955;
  const fixture = await makeFixture(fixedPort, [41961, 41970]);
  let server: Server | undefined;
  try {
    server = createServer();
    await new Promise<void>((resolvePromise, reject) => {
      server!.once('error', reject);
      server!.listen({ port: fixedPort, host: '127.0.0.1' }, () => resolvePromise());
    });

    // No proxy recorded in state, yet something is listening on fixed_port.
    await assert.rejects(
      () => execFileAsync(process.execPath, [binPath, 'doctor'], { env: envFor(fixture) }),
      (err: NodeJS.ErrnoException & { code?: number; stdout?: string }) => {
        assert.equal(err.code, 1);
        assert.match(String(err.stdout), new RegExp(`fixed_port ${fixedPort}: listening.*-- MISMATCH`));
        return true;
      }
    );
  } finally {
    if (server) {
      await new Promise<void>((resolvePromise) => server!.close(() => resolvePromise()));
    }
    await cleanup(fixture);
  }
});
