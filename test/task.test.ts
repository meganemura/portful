import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { taskAddCommand, taskListCommand, taskRmCommand, taskUseCommand } from '../src/commands/task.ts';
import { readState } from '../src/state.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

interface Fixture {
  base: string;
  configDir: string;
  stateDir: string;
  apiMain: string;
  apiFeatureX: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-task-repo-'));

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

  const frontMain = join(base, 'front-main');
  await mkdir(frontMain, { recursive: true });
  await git(frontMain, ['init', '-q', '-b', 'main']);
  await git(frontMain, ['config', 'user.email', 'test@example.com']);
  await git(frontMain, ['config', 'user.name', 'Test']);
  await writeFile(join(frontMain, 'f.txt'), 'hi');
  await git(frontMain, ['add', '.']);
  await git(frontMain, ['commit', '-q', '-m', 'init']);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-task-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    [
      '[repos.api]',
      `path = "${apiMain}"`,
      'fixed_port = 3000',
      'port_range = [3101, 3199]',
      'serve = "echo {port}"',
      '',
      '[repos.front]',
      `path = "${frontMain}"`,
      'fixed_port = 8080',
      'port_range = [8101, 8199]',
      'serve = "echo {port}"',
      '',
    ].join('\n')
  );

  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-task-state-'));

  return { base, configDir, stateDir, apiMain, apiFeatureX };
}

async function withFixtureEnv<T>(fn: (fixture: Fixture) => Promise<T>): Promise<T> {
  const fixture = await makeFixture();
  const original = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_CONFIG_HOME = fixture.configDir;
  process.env.XDG_STATE_HOME = fixture.stateDir;
  try {
    return await fn(fixture);
  } finally {
    process.env.XDG_CONFIG_HOME = original.XDG_CONFIG_HOME;
    process.env.XDG_STATE_HOME = original.XDG_STATE_HOME;
    await rm(fixture.base, { recursive: true, force: true });
    await rm(fixture.configDir, { recursive: true, force: true });
    await rm(fixture.stateDir, { recursive: true, force: true });
  }
}

async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('task add: creates a task from explicit repo/worktree members', async () => {
  await withFixtureEnv(async () => {
    await taskAddCommand({ name: 'prod', members: ['api/api-main', 'front/front-main'] });
    const state = await readState();
    assert.deepEqual(state.tasks.prod.members, { api: 'api-main', front: 'front-main' });
  });
});

test('task add: errors if the task name already exists', async () => {
  await withFixtureEnv(async () => {
    await taskAddCommand({ name: 'prod', members: ['api/api-main', 'front/front-main'] });
    await assert.rejects(
      () => taskAddCommand({ name: 'prod', members: ['api/api-main', 'front/front-main'] }),
      /already exists/
    );
  });
});

test('task add: errors on an unknown repo', async () => {
  await withFixtureEnv(async () => {
    await assert.rejects(
      () => taskAddCommand({ name: 'x', members: ['nosuchrepo/main'] }),
      /Unknown repo "nosuchrepo"/
    );
  });
});

test('task add: errors on a nonexistent worktree', async () => {
  await withFixtureEnv(async () => {
    await assert.rejects(
      () => taskAddCommand({ name: 'x', members: ['api/nosuchworktree'] }),
      /Worktree "nosuchworktree" not found/
    );
  });
});

test('task use: applies all members atomically', async () => {
  await withFixtureEnv(async () => {
    await taskAddCommand({ name: 'prod', members: ['api/api-main', 'front/front-main'] });
    await taskUseCommand({ name: 'prod' });
    const state = await readState();
    assert.equal(state.repos.api.active, 'api-main');
    assert.equal(state.repos.front.active, 'front-main');
  });
});

test('task use: errors and applies nothing if a member worktree no longer exists', async () => {
  await withFixtureEnv(async (fixture) => {
    await taskAddCommand({ name: 'prod', members: ['api/api-feature-x', 'front/front-main'] });

    // Simulate the worktree having been removed since the task was created.
    await execFileAsync('git', ['worktree', 'remove', '--force', fixture.apiFeatureX], { cwd: fixture.apiMain });

    await assert.rejects(() => taskUseCommand({ name: 'prod' }), /no longer exist/);

    const state = await readState();
    assert.equal(state.repos.api?.active, undefined);
    assert.equal(state.repos.front?.active, undefined);
  });
});

test('task use: errors for an unknown task', async () => {
  await withFixtureEnv(async () => {
    await assert.rejects(() => taskUseCommand({ name: 'nosuch' }), /Unknown task "nosuch"/);
  });
});

test('task list: reports no tasks when empty, and marks the currently-active task with *', async () => {
  await withFixtureEnv(async () => {
    const emptyLines = await captureLog(() => taskListCommand());
    assert.match(emptyLines.join('\n'), /No tasks defined/);

    await taskAddCommand({ name: 'prod', members: ['api/api-main', 'front/front-main'] });
    await taskUseCommand({ name: 'prod' });

    const lines = await captureLog(() => taskListCommand());
    const line = lines.find((l) => l.startsWith('prod'));
    assert.match(line ?? '', /^prod \*\t/);
  });
});

test('task rm: removes a task and errors if it does not exist', async () => {
  await withFixtureEnv(async () => {
    await taskAddCommand({ name: 'prod', members: ['api/api-main', 'front/front-main'] });
    await taskRmCommand({ name: 'prod' });
    const state = await readState();
    assert.equal(state.tasks.prod, undefined);

    await assert.rejects(() => taskRmCommand({ name: 'prod' }), /Unknown task "prod"/);
  });
});
