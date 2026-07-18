import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'wtshunt.js');

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

test('status --json: prints an Overview JSON shape reflecting active worktree and tasks', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-status-json-repo-'));
  const apiMain = join(base, 'api-main');
  await mkdir(apiMain, { recursive: true });
  await git(apiMain, ['init', '-q', '-b', 'main']);
  await git(apiMain, ['config', 'user.email', 'test@example.com']);
  await git(apiMain, ['config', 'user.name', 'Test']);
  await writeFile(join(apiMain, 'f.txt'), 'hi');
  await git(apiMain, ['add', '.']);
  await git(apiMain, ['commit', '-q', '-m', 'init']);
  const apiFeatureX = join(base, 'api-feature-x');
  await git(apiMain, ['worktree', 'add', '-q', '-b', 'feature/x', apiFeatureX]);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-status-json-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    ['[repos.api]', `path = "${apiMain}"`, 'fixed_port = 3000', 'port_range = [3101, 3199]', 'serve = "echo {port}"', ''].join(
      '\n'
    )
  );

  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-status-json-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };

  try {
    await execFileAsync(process.execPath, [binPath, 'use', 'api/api-main'], { env });
    await execFileAsync(process.execPath, [binPath, 'task', 'add', 'prod', 'api/api-main'], { env });

    const { stdout } = await execFileAsync(process.execPath, [binPath, 'status', '--json'], { env });
    const overview = JSON.parse(stdout);

    assert.ok(Array.isArray(overview.repos));
    assert.ok(Array.isArray(overview.tasks));

    const api = overview.repos.find((r: { name: string }) => r.name === 'api');
    assert.ok(api, 'api repo present in JSON output');
    assert.equal(api.active, 'api-main');
    assert.equal(api.fixedPort, 3000);
    assert.equal(api.path, apiMain);
    assert.deepEqual(
      api.worktrees.map((w: { name: string }) => w.name).sort(),
      ['api-feature-x', 'api-main'].sort()
    );
    assert.deepEqual(api.servers, {});
    assert.equal(api.proxy, undefined);

    assert.equal(overview.tasks.length, 1);
    assert.equal(overview.tasks[0].name, 'prod');
    assert.equal(overview.tasks[0].matchesCurrentActive, true);
    assert.deepEqual(overview.tasks[0].members, { api: 'api-main' });
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('status (human-readable, default) output is unchanged by the --json addition', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-status-text-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    ['[repos.api]', 'path = "/tmp"', 'fixed_port = 3000', 'port_range = [3101, 3199]', 'serve = "echo {port}"', ''].join(
      '\n'
    )
  );
  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-status-text-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };

  try {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'status'], { env });
    assert.match(stdout, /^api \(\/tmp\)/m);
    assert.match(stdout, /active: \(none\)/);
    assert.match(stdout, /servers: \(none running\)/);
    assert.match(stdout, /proxy: not running \(fixed port 3000\)/);
    assert.match(stdout, /Tasks: \(none defined\)/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
