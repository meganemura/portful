import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureRepoState, withState } from '../src/state.ts';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'portful.js');

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function makeRepoFixture(): Promise<{ base: string; configDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'portful-exec-repo-'));
  const main = join(base, 'main');
  await mkdir(main, { recursive: true });
  await git(main, ['init', '-q', '-b', 'main']);
  await git(main, ['config', 'user.email', 'test@example.com']);
  await git(main, ['config', 'user.name', 'Test']);
  await writeFile(join(main, 'file.txt'), 'hello');
  await git(main, ['add', '.']);
  await git(main, ['commit', '-q', '-m', 'init']);

  const configDir = await mkdtemp(join(tmpdir(), 'portful-exec-config-'));
  await mkdir(join(configDir, 'portful'), { recursive: true });
  await writeFile(
    join(configDir, 'portful', 'config.json'),
    JSON.stringify({
      repos: {
        b: {
          path: `${main}`,
          fixedPort: 3000,
          portRange: [3101, 3199],
          serve: 'echo {port}'
        }
      }
    })
  );

  return { base, configDir };
}

test('exec: flags on the wrapped command pass through untouched', async () => {
  const { base, configDir } = await makeRepoFixture();
  const stateDir = await mkdtemp(join(tmpdir(), 'portful-exec-state-'));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      // "b/main" targets the worktree directly, so no `portful use` is needed first.
      [binPath, 'exec', 'b/main', 'echo', '-n', '-h'],
      { env: { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir } }
    );
    assert.equal(stdout, '-h');
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('exec: --help on the wrapped command passes through when a repo is given', async () => {
  const { base, configDir } = await makeRepoFixture();
  const stateDir = await mkdtemp(join(tmpdir(), 'portful-exec-state-'));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'exec', 'b/main', 'echo', '--help', 'world'],
      { env: { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir } }
    );
    assert.equal(stdout.trim(), '--help world');
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function makeTwoWorktreeFixture(): Promise<{ base: string; main: string; taskB: string; configDir: string }> {
  const { base, configDir } = await makeRepoFixture();
  const main = join(base, 'main');
  const taskB = join(base, 'task-b');
  await git(main, ['worktree', 'add', '-q', '-b', 'task-b', taskB]);
  return { base, main, taskB, configDir };
}

test('exec: warns on stderr when cwd is in a different worktree than active, given just the repo name', async () => {
  const { base, taskB, configDir } = await makeTwoWorktreeFixture();
  const stateDir = await mkdtemp(join(tmpdir(), 'portful-exec-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };
  const original = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.XDG_STATE_HOME = stateDir;
  try {
    await withState((state) => {
      ensureRepoState(state, 'b').active = 'main';
    });
  } finally {
    if (original.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original.XDG_CONFIG_HOME;
    if (original.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = original.XDG_STATE_HOME;
  }

  try {
    // cwd is task-b, but active is main, and only the bare repo name "b" is
    // given (no explicit /worktree) — this is exactly the trap the warning
    // targets.
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, 'exec', 'b', 'echo', 'hi'], {
      cwd: taskB,
      env,
    });
    assert.equal(stdout.trim(), 'hi');
    assert.match(stderr, /Note: cwd is in b\/task-b/);
    assert.match(stderr, /active worktree b\/main/);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('exec: does not warn when the worktree is given explicitly, even if it differs from cwd', async () => {
  const { base, taskB, configDir } = await makeTwoWorktreeFixture();
  const stateDir = await mkdtemp(join(tmpdir(), 'portful-exec-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };

  try {
    // cwd is task-b, but "b/main" is given explicitly — the user picked
    // this on purpose, so no warning.
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, 'exec', 'b/main', 'echo', 'hi'], {
      cwd: taskB,
      env,
    });
    assert.equal(stdout.trim(), 'hi');
    assert.equal(stderr, '');
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('exec: bare -h/--help shows exec usage instead of executing anything', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'exec', '-h'], {
      env: { ...process.env, XDG_CONFIG_HOME: configDir },
    });
    assert.match(stdout, /Usage: portful exec/);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});
