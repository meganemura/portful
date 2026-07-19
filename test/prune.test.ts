import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describeStaleReport, detectStaleEntries, isStaleReportEmpty, isWorktreeStale } from '../src/prune.ts';
import { pruneCommand } from '../src/commands/prune.ts';
import { ensureRepoState, withState, type State } from '../src/state.ts';

const execFileAsync = promisify(execFile);

function makeState(): State {
  return { repos: {}, tasks: {} };
}

test('isWorktreeStale: true only when the name is absent from the actual set', () => {
  const actual = new Set(['main', 'feature-x']);
  assert.equal(isWorktreeStale(actual, 'main'), false);
  assert.equal(isWorktreeStale(actual, 'gone'), true);
});

test('detectStaleEntries: flags stale servers, ports, active pointer, and task members; ignores what still exists', () => {
  const state = makeState();
  const api = ensureRepoState(state, 'api');
  api.active = 'gone-wt';
  api.ports.main = 3101;
  api.ports['gone-wt'] = 3102;
  api.servers.main = { path: '/x', branch: 'main', port: 3101, pid: 1 };
  api.servers['gone-wt'] = { path: '/y', branch: 'gone', port: 3102, pid: 2 };
  state.tasks.prod = { members: { api: 'gone-wt', front: 'main' } };

  const front = ensureRepoState(state, 'front');
  front.ports.main = 8101;

  const report = detectStaleEntries(state, {
    api: new Set(['main']),
    front: new Set(['main']),
  });

  assert.equal(report.repos.length, 1);
  assert.equal(report.repos[0].repo, 'api');
  assert.deepEqual(report.repos[0].staleServers, ['gone-wt']);
  assert.deepEqual(report.repos[0].stalePorts, ['gone-wt']);
  assert.equal(report.repos[0].staleActive, 'gone-wt');

  assert.deepEqual(report.taskMembers, [{ task: 'prod', repo: 'api', worktree: 'gone-wt' }]);
});

test('detectStaleEntries: an empty report when nothing is stale', () => {
  const state = makeState();
  const api = ensureRepoState(state, 'api');
  api.active = 'main';
  api.ports.main = 3101;
  api.servers.main = { path: '/x', branch: 'main', port: 3101, pid: 1 };

  const report = detectStaleEntries(state, { api: new Set(['main']) });
  assert.equal(isStaleReportEmpty(report), true);
  assert.deepEqual(report.repos, []);
  assert.deepEqual(report.taskMembers, []);
});

test('detectStaleEntries: ignores repos with no state entry, and task members for unconfigured repos', () => {
  const state = makeState();
  state.tasks.prod = { members: { untracked: 'whatever' } };
  const report = detectStaleEntries(state, { api: new Set(['main']) });
  assert.equal(isStaleReportEmpty(report), true);
});

test('describeStaleReport: one line per stale entry, phrased consistently', () => {
  const report = detectStaleEntries(
    (() => {
      const state = makeState();
      const api = ensureRepoState(state, 'api');
      api.active = 'gone';
      api.ports.gone = 3101;
      api.servers.gone = { path: '/x', branch: 'gone', port: 3101, pid: 1 };
      state.tasks.prod = { members: { api: 'gone' } };
      return state;
    })(),
    { api: new Set() }
  );

  const lines = describeStaleReport(report);
  assert.deepEqual(lines, [
    'api/gone: stop the running server (worktree gone)',
    'api/gone: remove the sticky port assignment (worktree gone)',
    'api: clear the active pointer "gone" (worktree gone)',
    'task "prod": remove member api/gone (worktree gone)',
  ]);
});

// --- pruneCommand end-to-end, against real git repos and a real spawned "server" process ---

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

interface Fixture {
  base: string;
  configDir: string;
  stateDir: string;
  apiMain: string;
  apiTaskB: string;
  frontMain: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-prune-repo-'));

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

  const frontMain = join(base, 'front-main');
  await mkdir(frontMain, { recursive: true });
  await git(frontMain, ['init', '-q', '-b', 'main']);
  await git(frontMain, ['config', 'user.email', 'test@example.com']);
  await git(frontMain, ['config', 'user.name', 'Test']);
  await writeFile(join(frontMain, 'f.txt'), 'hi');
  await git(frontMain, ['add', '.']);
  await git(frontMain, ['commit', '-q', '-m', 'init']);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-prune-config-'));
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

  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-prune-state-'));

  return { base, configDir, stateDir, apiMain, apiTaskB, frontMain };
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

async function readStateFile(stateDir: string): Promise<State> {
  const raw = await readFile(join(stateDir, 'wtshunt', 'state.json'), 'utf8');
  return JSON.parse(raw) as State;
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

test('pruneCommand: reports "Nothing to prune." and changes nothing when everything still exists', async () => {
  await withFixtureEnv(async (fixture) => {
    await withState((state) => {
      const rs = ensureRepoState(state, 'api');
      rs.active = 'api-main';
      rs.ports['api-main'] = 3101;
    });

    const lines = await captureLog(() => pruneCommand({}));
    assert.deepEqual(lines, ['Nothing to prune.']);

    const state = await readStateFile(fixture.stateDir);
    assert.equal(state.repos.api.active, 'api-main');
  });
});

test('pruneCommand: stops a running server, removes its port/active/task references once its worktree is gone', async () => {
  await withFixtureEnv(async (fixture) => {
    const child = spawn('sh', ['-c', 'while true; do sleep 1; done'], { detached: true, stdio: 'ignore' });
    const pid = child.pid!;
    child.unref();

    await withState((state) => {
      const rs = ensureRepoState(state, 'api');
      rs.active = 'api-task-b';
      rs.ports['api-task-b'] = 3105;
      rs.servers['api-task-b'] = { path: fixture.apiTaskB, branch: 'task-b', port: 3105, pid };
      state.tasks.prod = { members: { api: 'api-task-b', front: 'front-main' } };
    });

    await git(fixture.apiMain, ['worktree', 'remove', '--force', fixture.apiTaskB]);

    await pruneCommand({});

    // The spawned "server" was actually SIGTERM'd and confirmed dead, not
    // just forgotten about in state.
    assert.throws(() => process.kill(pid, 0), (err: NodeJS.ErrnoException) => err.code === 'ESRCH');

    const state = await readStateFile(fixture.stateDir);
    assert.equal(state.repos.api.servers['api-task-b'], undefined);
    assert.equal(state.repos.api.ports['api-task-b'], undefined);
    assert.equal(state.repos.api.active, undefined);
    // The task keeps its still-valid front member; only the stale api member is dropped.
    assert.deepEqual(state.tasks.prod.members, { front: 'front-main' });
  });
});

test('pruneCommand: a task with only stale members is removed entirely', async () => {
  await withFixtureEnv(async (fixture) => {
    await withState((state) => {
      const rs = ensureRepoState(state, 'api');
      rs.ports['api-task-b'] = 3105;
      state.tasks.prod = { members: { api: 'api-task-b' } };
    });

    await git(fixture.apiMain, ['worktree', 'remove', '--force', fixture.apiTaskB]);

    await pruneCommand({});

    const state = await readStateFile(fixture.stateDir);
    assert.equal(state.tasks.prod, undefined);
  });
});

test('pruneCommand: --dry-run reports what would change without changing anything', async () => {
  await withFixtureEnv(async (fixture) => {
    await withState((state) => {
      const rs = ensureRepoState(state, 'api');
      rs.active = 'api-task-b';
      rs.ports['api-task-b'] = 3105;
    });

    await git(fixture.apiMain, ['worktree', 'remove', '--force', fixture.apiTaskB]);

    const lines = await captureLog(() => pruneCommand({ dryRun: true }));
    assert.ok(lines.some((l) => l.includes('Would prune:')));
    assert.ok(lines.some((l) => l.includes('api/api-task-b') && l.includes('sticky port')));
    assert.ok(lines.some((l) => l.includes('api') && l.includes('active pointer') && l.includes('api-task-b')));

    const state = await readStateFile(fixture.stateDir);
    assert.equal(state.repos.api.active, 'api-task-b');
    assert.equal(state.repos.api.ports['api-task-b'], 3105);
  });
});

test('pruneCommand: scoping to a single repo leaves other repos untouched', async () => {
  await withFixtureEnv(async (fixture) => {
    await withState((state) => {
      ensureRepoState(state, 'api').ports['api-task-b'] = 3105;
      ensureRepoState(state, 'front').ports['gone-front-wt'] = 8105;
    });

    await git(fixture.apiMain, ['worktree', 'remove', '--force', fixture.apiTaskB]);

    await pruneCommand({ repo: 'api' });

    const state = await readStateFile(fixture.stateDir);
    assert.equal(state.repos.api.ports['api-task-b'], undefined);
    // front was never targeted, so its own stale port is left alone.
    assert.equal(state.repos.front.ports['gone-front-wt'], 8105);
  });
});

test('pruneCommand: errors on an unknown repo', async () => {
  await withFixtureEnv(async () => {
    await assert.rejects(() => pruneCommand({ repo: 'nosuchrepo' }), /Unknown repo "nosuchrepo"/);
  });
});
