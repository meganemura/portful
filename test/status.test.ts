import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureRepoState, withState, type State } from '../src/state.ts';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'wtshunt.js');

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Polls state.json until `predicate` is satisfied (or times out). */
async function waitForState(stateDir: string, predicate: (state: State) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(join(stateDir, 'wtshunt', 'state.json'), 'utf8');
      if (predicate(JSON.parse(raw) as State)) {
        return;
      }
    } catch {
      // state.json may not exist yet.
    }
    await sleep(50);
  }
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

test('status --json / status: staleWiring appears once a referenced repo moves its active worktree out from under a running server', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-status-stale-repo-'));
  const apiMain = join(base, 'api-main');
  const frontMain = join(base, 'front-main');

  await mkdir(apiMain, { recursive: true });
  await git(apiMain, ['init', '-q', '-b', 'main']);
  await git(apiMain, ['config', 'user.email', 'test@example.com']);
  await git(apiMain, ['config', 'user.name', 'Test']);
  await writeFile(join(apiMain, 'f.txt'), 'hi');
  await git(apiMain, ['add', '.']);
  await git(apiMain, ['commit', '-q', '-m', 'init']);
  const apiFeatureX = join(base, 'api-feature-x');
  await git(apiMain, ['worktree', 'add', '-q', '-b', 'feature/x', apiFeatureX]);

  await mkdir(frontMain, { recursive: true });
  await git(frontMain, ['init', '-q', '-b', 'main']);
  await git(frontMain, ['config', 'user.email', 'test@example.com']);
  await git(frontMain, ['config', 'user.name', 'Test']);
  await writeFile(join(frontMain, 'f.txt'), 'hi');
  await git(frontMain, ['add', '.']);
  await git(frontMain, ['commit', '-q', '-m', 'init']);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-status-stale-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    [
      '[repos.api]',
      `path = "${apiMain}"`,
      'fixed_port = 3000',
      'port_range = [41900, 41910]',
      'serve = "echo {port}; sleep 30"',
      '',
      '[repos.front]',
      `path = "${frontMain}"`,
      'fixed_port = 8080',
      'port_range = [42000, 42010]',
      'serve = "echo {port}-api-at-{api.port}; sleep 30"',
      '',
    ].join('\n')
  );

  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-status-stale-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };

  let apiServe: ReturnType<typeof spawn> | undefined;
  let frontServe: ReturnType<typeof spawn> | undefined;
  try {
    await execFileAsync(process.execPath, [binPath, 'use', 'api/api-main'], { env });
    await execFileAsync(process.execPath, [binPath, 'use', 'front/front-main'], { env });

    apiServe = spawn(process.execPath, [binPath, 'serve', 'api'], { env, stdio: 'ignore' });
    await waitForState(stateDir, (s) => s.repos.api?.servers['api-main'] !== undefined, 5000);

    frontServe = spawn(process.execPath, [binPath, 'serve', 'front'], { env, stdio: 'ignore' });
    await waitForState(
      stateDir,
      (s) => s.repos.front?.servers['front-main']?.resolvedRefs !== undefined,
      5000
    );

    // Move api's active worktree without restarting front's already-running
    // server: front is now wired to api-main's old port.
    await execFileAsync(process.execPath, [binPath, 'use', 'api/api-feature-x'], { env });

    const { stdout: jsonOut } = await execFileAsync(process.execPath, [binPath, 'status', '--json'], { env });
    const overview = JSON.parse(jsonOut);
    const front = overview.repos.find((r: { name: string }) => r.name === 'front');
    const frontMainServer = front.servers['front-main'];
    assert.equal(frontMainServer.staleWiring.length, 1);
    assert.equal(frontMainServer.staleWiring[0].repo, 'api');
    assert.equal(typeof frontMainServer.staleWiring[0].recordedPort, 'number');
    assert.equal(frontMainServer.staleWiring[0].currentPort, undefined);

    // api's own server entry has no resolvedRefs at all, so staleWiring is
    // omitted for it, not an empty array.
    const api = overview.repos.find((r: { name: string }) => r.name === 'api');
    assert.equal(api.servers['api-main'].staleWiring, undefined);

    const { stdout: textOut } = await execFileAsync(process.execPath, [binPath, 'status'], { env });
    assert.match(textOut, /front-main\t.*\(stale wiring: api\)/);
  } finally {
    for (const proc of [apiServe, frontServe]) {
      if (proc?.pid) {
        try {
          process.kill(proc.pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    }
    await sleep(300);
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('status --json / status: marks a server whose worktree no longer exists, and status prints a prune hint', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-status-gone-repo-'));
  const apiMain = join(base, 'api-main');
  await mkdir(apiMain, { recursive: true });
  await git(apiMain, ['init', '-q', '-b', 'main']);
  await git(apiMain, ['config', 'user.email', 'test@example.com']);
  await git(apiMain, ['config', 'user.name', 'Test']);
  await writeFile(join(apiMain, 'f.txt'), 'hi');
  await git(apiMain, ['add', '.']);
  await git(apiMain, ['commit', '-q', '-m', 'init']);
  const apiTaskB = join(base, 'api-task-b');
  await git(apiMain, ['worktree', 'add', '-q', '-b', 'task-b', apiTaskB]);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-status-gone-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    ['[repos.api]', `path = "${apiMain}"`, 'fixed_port = 3000', 'port_range = [42100, 42110]', 'serve = "echo {port}"', ''].join(
      '\n'
    )
  );

  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-status-gone-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };

  try {
    const original = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    try {
      await withState((state) => {
        const rs = ensureRepoState(state, 'api');
        rs.ports['api-task-b'] = 42101;
        rs.servers['api-task-b'] = { path: apiTaskB, branch: 'task-b', port: 42101, pid: process.pid };
      });
    } finally {
      if (original === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = original;
    }

    await git(apiMain, ['worktree', 'remove', '--force', apiTaskB]);

    const { stdout: jsonOut } = await execFileAsync(process.execPath, [binPath, 'status', '--json'], { env });
    const overview = JSON.parse(jsonOut);
    const api = overview.repos.find((r: { name: string }) => r.name === 'api');
    assert.equal(api.servers['api-task-b'].worktreeGone, true);

    const { stdout: textOut } = await execFileAsync(process.execPath, [binPath, 'status'], { env });
    assert.match(textOut, /api-task-b\t.*\(worktree gone\)/);
    assert.match(textOut, /Run "wtshunt prune" to clean up/);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
