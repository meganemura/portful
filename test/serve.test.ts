import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { State } from '../src/state.ts';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'wtshunt.js');

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Polls `predicate` instead of a fixed sleep, so a slow/loaded machine doesn't flake a "did it print yet" check. */
async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
}

/** Polls state.json itself until `predicate` is satisfied (or times out), rather than guessing a fixed delay for the spawned server to have written it. */
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

test('serve: {<repo>.port} references resolve and get recorded as resolvedRefs on the server entry', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-serve-refs-repo-'));
  const apiMain = join(base, 'api-main');
  const frontMain = join(base, 'front-main');

  await mkdir(apiMain, { recursive: true });
  await git(apiMain, ['init', '-q', '-b', 'main']);
  await git(apiMain, ['config', 'user.email', 'test@example.com']);
  await git(apiMain, ['config', 'user.name', 'Test']);
  await writeFile(join(apiMain, 'f.txt'), 'hi');
  await git(apiMain, ['add', '.']);
  await git(apiMain, ['commit', '-q', '-m', 'init']);

  await mkdir(frontMain, { recursive: true });
  await git(frontMain, ['init', '-q', '-b', 'main']);
  await git(frontMain, ['config', 'user.email', 'test@example.com']);
  await git(frontMain, ['config', 'user.name', 'Test']);
  await writeFile(join(frontMain, 'f.txt'), 'hi');
  await git(frontMain, ['add', '.']);
  await git(frontMain, ['commit', '-q', '-m', 'init']);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-serve-refs-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    [
      '[repos.api]',
      `path = "${apiMain}"`,
      'fixed_port = 3000',
      'port_range = [41500, 41510]',
      'serve = "echo api-on-{port}; sleep 30"',
      '',
      '[repos.front]',
      `path = "${frontMain}"`,
      'fixed_port = 8080',
      'port_range = [41600, 41610]',
      'serve = "echo front-on-{port}-api-at-{api.port}; sleep 30"',
      '',
    ].join('\n')
  );

  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-serve-refs-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };

  let apiServe: ReturnType<typeof spawn> | undefined;
  let frontServe: ReturnType<typeof spawn> | undefined;
  try {
    await execFileAsync(process.execPath, [binPath, 'use', 'api/api-main'], { env });
    await execFileAsync(process.execPath, [binPath, 'use', 'front/front-main'], { env });

    apiServe = spawn(process.execPath, [binPath, 'serve', 'api'], { env, stdio: 'ignore' });
    await waitForState(stateDir, (s) => s.repos.api?.servers['api-main'] !== undefined, 5000);

    frontServe = spawn(process.execPath, [binPath, 'serve', 'front'], { env, stdio: 'ignore' });
    await waitForState(stateDir, (s) => s.repos.front?.servers['front-main'] !== undefined, 5000);

    const raw = await readFile(join(stateDir, 'wtshunt', 'state.json'), 'utf8');
    const state = JSON.parse(raw);

    const apiPort = state.repos.api.servers['api-main'].port;
    const frontEntry = state.repos.front.servers['front-main'];

    assert.equal(typeof apiPort, 'number');
    assert.deepEqual(frontEntry.resolvedRefs, { api: apiPort });
  } finally {
    // Plain SIGTERM to each outer `wtshunt serve` process (not a process
    // group signal): that process isn't itself detached from this test, so
    // it isn't a group leader, but it does have its own SIGTERM handler
    // that forwards to its detached child's group and then exits.
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

test('serve: warns on stderr when cwd is in a different worktree than active, given just the repo name', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-serve-warn-repo-'));
  const main = join(base, 'main');
  await mkdir(main, { recursive: true });
  await git(main, ['init', '-q', '-b', 'main']);
  await git(main, ['config', 'user.email', 'test@example.com']);
  await git(main, ['config', 'user.name', 'Test']);
  await writeFile(join(main, 'f.txt'), 'hi');
  await git(main, ['add', '.']);
  await git(main, ['commit', '-q', '-m', 'init']);
  const taskB = join(base, 'task-b');
  await git(main, ['worktree', 'add', '-q', '-b', 'task-b', taskB]);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-serve-warn-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    ['[repos.b]', `path = "${main}"`, 'fixed_port = 3000', 'port_range = [41700, 41710]', 'serve = "echo {port}; sleep 30"', ''].join(
      '\n'
    )
  );
  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-serve-warn-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };

  let proc: ReturnType<typeof spawn> | undefined;
  try {
    await execFileAsync(process.execPath, [binPath, 'use', 'b/main'], { env });

    let stdout = '';
    let stderr = '';
    // cwd is task-b, but active is main, and only the bare repo name "b" is
    // given (no explicit /worktree) — the warning should fire before the
    // server starts.
    proc = spawn(process.execPath, [binPath, 'serve', 'b'], { cwd: taskB, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // "Starting server for" (serve.ts's own log line) is only printed after
    // the cwd-vs-active check, so waiting for it confirms that code path
    // has already run — more robust under load than a fixed sleep.
    await waitFor(() => stdout.includes('Starting server for'), 5000);
    assert.match(stderr, /Note: cwd is in b\/task-b/);
    assert.match(stderr, /active worktree b\/main/);
  } finally {
    if (proc?.pid) {
      try {
        process.kill(proc.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    await sleep(300);
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('serve: does not warn when the worktree is given explicitly, even if it differs from cwd', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-serve-nowarn-repo-'));
  const main = join(base, 'main');
  await mkdir(main, { recursive: true });
  await git(main, ['init', '-q', '-b', 'main']);
  await git(main, ['config', 'user.email', 'test@example.com']);
  await git(main, ['config', 'user.name', 'Test']);
  await writeFile(join(main, 'f.txt'), 'hi');
  await git(main, ['add', '.']);
  await git(main, ['commit', '-q', '-m', 'init']);
  const taskB = join(base, 'task-b');
  await git(main, ['worktree', 'add', '-q', '-b', 'task-b', taskB]);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-serve-nowarn-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    ['[repos.b]', `path = "${main}"`, 'fixed_port = 3000', 'port_range = [41800, 41810]', 'serve = "echo {port}; sleep 30"', ''].join(
      '\n'
    )
  );
  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-serve-nowarn-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };

  let proc: ReturnType<typeof spawn> | undefined;
  try {
    let stdout = '';
    let stderr = '';
    // cwd is task-b, but "b/main" is given explicitly — the user picked
    // this on purpose, so no warning.
    proc = spawn(process.execPath, [binPath, 'serve', 'b/main'], {
      cwd: taskB,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    await waitFor(() => stdout.includes('Starting server for'), 5000);
    assert.equal(stderr, '');
  } finally {
    if (proc?.pid) {
      try {
        process.kill(proc.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    await sleep(300);
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
