import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildOverview } from '../src/overview.ts';
import { ensureRepoState, withState } from '../src/state.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

interface Fixture {
  base: string;
  configDir: string;
  stateDir: string;
  apiMain: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-overview-repo-'));

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

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-overview-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    ['[repos.api]', `path = "${apiMain}"`, 'fixed_port = 3000', 'port_range = [3101, 3199]', 'serve = "echo {port}"', ''].join(
      '\n'
    )
  );

  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-overview-state-'));

  return { base, configDir, stateDir, apiMain };
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

test('buildOverview: lists worktrees, active, ports, servers (with resolvedRefs), proxy, and tasks', async () => {
  await withFixtureEnv(async () => {
    // Real, currently-alive pids: readState() prunes any server/proxy entry
    // whose pid isn't alive, so a made-up pid like 123 would vanish before
    // buildOverview ever saw it.
    await withState((state) => {
      const rs = ensureRepoState(state, 'api');
      rs.active = 'api-main';
      rs.ports['api-main'] = 3101;
      rs.servers['api-main'] = {
        path: '/tmp',
        branch: 'main',
        port: 3101,
        pid: process.pid,
        resolvedRefs: { front: 8101 },
      };
      rs.proxy = { pid: process.pid, port: 3000 };
      // front's active worktree currently resolves to the same port that
      // was recorded at serve time, so this resolvedRefs entry is NOT
      // stale — staleWiring should be omitted below.
      const front = ensureRepoState(state, 'front');
      front.active = 'front-main';
      front.ports['front-main'] = 8101;
      state.tasks.prod = { members: { api: 'api-main' } };
    });

    const overview = await buildOverview();

    const api = overview.repos.find((r) => r.name === 'api');
    assert.ok(api, 'api repo present');
    assert.equal(api!.fixedPort, 3000);
    assert.equal(api!.active, 'api-main');
    assert.deepEqual(
      api!.worktrees.map((w) => w.name).sort(),
      ['api-feature-x', 'api-main'].sort()
    );
    assert.equal(api!.ports['api-main'], 3101);
    assert.deepEqual(api!.servers['api-main'], {
      branch: 'main',
      port: 3101,
      pid: process.pid,
      resolvedRefs: { front: 8101 },
    });
    assert.deepEqual(api!.proxy, { pid: process.pid, port: 3000 });

    assert.equal(overview.tasks.length, 1);
    assert.equal(overview.tasks[0].name, 'prod');
    assert.equal(overview.tasks[0].matchesCurrentActive, true);
  });
});

test('buildOverview: staleWiring appears on a server entry whose resolvedRefs no longer match, and is omitted otherwise', async () => {
  await withFixtureEnv(async () => {
    await withState((state) => {
      const rs = ensureRepoState(state, 'api');
      rs.active = 'api-main';
      rs.ports['api-main'] = 3101;
      // Recorded at serve time as front=8101, but front's active worktree
      // has since moved to a different port — stale.
      rs.servers['api-main'] = {
        path: '/tmp',
        branch: 'main',
        port: 3101,
        pid: process.pid,
        resolvedRefs: { front: 8101 },
      };
      const front = ensureRepoState(state, 'front');
      front.active = 'front-main';
      front.ports['front-main'] = 8102;
    });

    const overview = await buildOverview();
    const api = overview.repos.find((r) => r.name === 'api');
    assert.deepEqual(api!.servers['api-main'].staleWiring, [
      { repo: 'front', recordedPort: 8101, currentPort: 8102 },
    ]);
  });
});

test('buildOverview: a task whose member no longer matches the active worktree is not marked as matching', async () => {
  await withFixtureEnv(async () => {
    await withState((state) => {
      ensureRepoState(state, 'api').active = 'api-feature-x';
      state.tasks.prod = { members: { api: 'api-main' } };
    });

    const overview = await buildOverview();
    assert.equal(overview.tasks[0].matchesCurrentActive, false);
  });
});

test('buildOverview: a repo with no state entry yet reports empty ports/servers and no active/proxy', async () => {
  await withFixtureEnv(async () => {
    const overview = await buildOverview();
    const api = overview.repos.find((r) => r.name === 'api');
    assert.ok(api);
    assert.equal(api!.active, undefined);
    assert.deepEqual(api!.ports, {});
    assert.deepEqual(api!.servers, {});
    assert.equal(api!.proxy, undefined);
  });
});
