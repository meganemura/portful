import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeAction, invalidKeyHint, keyToAction, pendingMessage, type ActionDeps } from '../src/ui/actions.ts';
import type { UiRow } from '../src/ui/model.ts';
import type { Overview } from '../src/overview.ts';
import type { Mux } from '../src/mux.ts';

const REPO_ROW: UiRow = { kind: 'repo', repo: 'api', fixedPort: 3000, proxyRunning: false };
const WORKTREE_ROW: UiRow = {
  kind: 'worktree',
  repo: 'api',
  worktree: 'api-main',
  branch: 'main',
  active: false,
};
const TASK_ROW: UiRow = { kind: 'task', task: 'prod', members: { api: 'api-main' }, matches: false };

test('keyToAction: q and ctrl-c always quit, regardless of the selected row', () => {
  assert.deepEqual(keyToAction(WORKTREE_ROW, 'q'), { type: 'quit' });
  assert.deepEqual(keyToAction(undefined, 'ctrl-c'), { type: 'quit' });
});

test('keyToAction: u/enter uses a worktree row or a task row, but not a repo header row', () => {
  assert.deepEqual(keyToAction(WORKTREE_ROW, 'u'), { type: 'use-worktree', repo: 'api', worktree: 'api-main' });
  assert.deepEqual(keyToAction(WORKTREE_ROW, 'return'), { type: 'use-worktree', repo: 'api', worktree: 'api-main' });
  assert.deepEqual(keyToAction(TASK_ROW, 'u'), { type: 'use-task', task: 'prod' });
  assert.deepEqual(keyToAction(REPO_ROW, 'u'), { type: 'none' });
});

test('keyToAction: s/x/r only act on worktree rows', () => {
  assert.deepEqual(keyToAction(WORKTREE_ROW, 's'), { type: 'serve', repo: 'api', worktree: 'api-main' });
  assert.deepEqual(keyToAction(WORKTREE_ROW, 'x'), { type: 'stop', repo: 'api', worktree: 'api-main' });
  assert.deepEqual(keyToAction(WORKTREE_ROW, 'r'), { type: 'restart', repo: 'api', worktree: 'api-main' });
  assert.deepEqual(keyToAction(REPO_ROW, 's'), { type: 'none' });
  assert.deepEqual(keyToAction(TASK_ROW, 'x'), { type: 'none' });
});

test('keyToAction: p toggles the proxy from a repo header row or a worktree row of that repo, not a task row', () => {
  assert.deepEqual(keyToAction(REPO_ROW, 'p'), { type: 'toggle-proxy', repo: 'api' });
  assert.deepEqual(keyToAction(WORKTREE_ROW, 'p'), { type: 'toggle-proxy', repo: 'api' });
  assert.deepEqual(keyToAction(TASK_ROW, 'p'), { type: 'none' });
});

test('keyToAction: an unmapped key with no row is a no-op', () => {
  assert.deepEqual(keyToAction(undefined, 's'), { type: 'none' });
  assert.deepEqual(keyToAction(WORKTREE_ROW, 'z'), { type: 'none' });
});

test('invalidKeyHint: names the key, but not the row kind (that vocabulary is not shown anywhere on screen), when a known action key does not apply to the selected row', () => {
  assert.equal(invalidKeyHint(TASK_ROW, 's'), 'Key "s" isn\'t available on this row.');
  assert.equal(invalidKeyHint(REPO_ROW, 'x'), 'Key "x" isn\'t available on this row.');
  assert.equal(invalidKeyHint(REPO_ROW, 'r'), 'Key "r" isn\'t available on this row.');
  assert.equal(invalidKeyHint(TASK_ROW, 'p'), 'Key "p" isn\'t available on this row.');
  assert.equal(invalidKeyHint(REPO_ROW, 'u'), 'Key "u" isn\'t available on this row.');
  assert.equal(invalidKeyHint(REPO_ROW, 'return'), 'Key "Enter" isn\'t available on this row.');
});

test('invalidKeyHint: is empty for a key that is unbound entirely, a valid combination, or no selected row', () => {
  assert.equal(invalidKeyHint(TASK_ROW, 'g'), '');
  assert.equal(invalidKeyHint(WORKTREE_ROW, 'z'), '');
  assert.equal(invalidKeyHint(WORKTREE_ROW, 's'), '');
  assert.equal(invalidKeyHint(undefined, 's'), '');
});

function fakeMux(name: string, openCalls: { title: string; command: string; cwd?: string }[]): Mux {
  return {
    name,
    detect: () => true,
    async open(options) {
      openCalls.push(options);
    },
  };
}

function makeOverview(): Overview {
  return {
    repos: [
      {
        name: 'api',
        path: '/repos/api',
        fixedPort: 3000,
        worktrees: [{ name: 'api-main', branch: 'main', path: '/repos/api-main' }],
        active: 'api-main',
        ports: { 'api-main': 3101 },
        servers: {},
        proxy: { pid: 999, port: 3000 },
      },
    ],
    tasks: [],
  };
}

test('pendingMessage: one line per action, in the tone of the matching executeAction completion message', () => {
  assert.equal(
    pendingMessage({ type: 'use-worktree', repo: 'api', worktree: 'api-feature-x' }),
    'Setting active worktree for "api" to "api-feature-x"…'
  );
  assert.equal(pendingMessage({ type: 'use-task', task: 'prod' }), 'Applying task "prod"…');
  assert.equal(
    pendingMessage({ type: 'serve', repo: 'api', worktree: 'api-feature-x' }),
    'Opening serve for "api/api-feature-x"…'
  );
  assert.equal(
    pendingMessage({ type: 'stop', repo: 'api', worktree: 'api-feature-x' }),
    'Stopping "api/api-feature-x"…'
  );
  assert.equal(
    pendingMessage({ type: 'restart', repo: 'api', worktree: 'api-feature-x' }),
    'Restarting "api/api-feature-x"…'
  );
  assert.equal(pendingMessage({ type: 'toggle-proxy', repo: 'api' }), 'Toggling proxy for "api"…');
  assert.equal(pendingMessage({ type: 'none' }), '');
  assert.equal(pendingMessage({ type: 'quit' }), '');
});

test('executeAction: use-worktree calls setActiveWorktree and reports whether a server is running', async () => {
  const calls: [string, string][] = [];
  const deps: ActionDeps = {
    setActiveWorktree: async (repo, worktree) => {
      calls.push([repo, worktree]);
      return { hasServer: false, proxyActive: false };
    },
    applyTask: async () => ({ members: {}, needsServe: [], proxying: [], mismatches: [] }),
    stopServer: async () => ({ status: 'no-server' }),
    mux: fakeMux('fallback', []),
  };

  const message = await executeAction(
    { type: 'use-worktree', repo: 'api', worktree: 'api-main' },
    makeOverview(),
    deps
  );

  assert.deepEqual(calls, [['api', 'api-main']]);
  assert.match(message, /set to "api-main"/);
  assert.match(message, /No server running yet/);
});

test('executeAction: serve refuses to open a second pane when a server is already running', async () => {
  const opened: { title: string; command: string; cwd?: string }[] = [];
  const overview = makeOverview();
  overview.repos[0].servers['api-main'] = { branch: 'main', port: 3101, pid: 555 };

  const deps: ActionDeps = {
    setActiveWorktree: async () => ({ hasServer: true, proxyActive: false }),
    applyTask: async () => ({ members: {}, needsServe: [], proxying: [], mismatches: [] }),
    stopServer: async () => ({ status: 'no-server' }),
    mux: fakeMux('tmux', opened),
  };

  const message = await executeAction({ type: 'serve', repo: 'api', worktree: 'api-main' }, overview, deps);

  assert.equal(opened.length, 0);
  assert.match(message, /already running/);
  assert.match(message, /555/);
});

test('executeAction: serve opens via the mux adapter with the worktree path as cwd when no server is running', async () => {
  const opened: { title: string; command: string; cwd?: string }[] = [];
  const deps: ActionDeps = {
    setActiveWorktree: async () => ({ hasServer: true, proxyActive: false }),
    applyTask: async () => ({ members: {}, needsServe: [], proxying: [], mismatches: [] }),
    stopServer: async () => ({ status: 'no-server' }),
    mux: fakeMux('tmux', opened),
  };

  const message = await executeAction({ type: 'serve', repo: 'api', worktree: 'api-main' }, makeOverview(), deps);

  assert.equal(opened.length, 1);
  assert.equal(opened[0].cwd, '/repos/api-main');
  assert.match(opened[0].command, /serve/);
  assert.match(opened[0].command, /api\/api-main/);
  assert.match(message, /Opened serve/);
  assert.match(message, /via tmux/);
});

test('executeAction: serve via the fallback adapter reports guidance instead of "opened via fallback"', async () => {
  const opened: { title: string; command: string; cwd?: string }[] = [];
  const deps: ActionDeps = {
    setActiveWorktree: async () => ({ hasServer: true, proxyActive: false }),
    applyTask: async () => ({ members: {}, needsServe: [], proxying: [], mismatches: [] }),
    stopServer: async () => ({ status: 'no-server' }),
    mux: fakeMux('fallback', opened),
  };

  const message = await executeAction({ type: 'serve', repo: 'api', worktree: 'api-main' }, makeOverview(), deps);

  assert.equal(opened.length, 1);
  assert.match(message, /No multiplexer detected/);
  assert.doesNotMatch(message, /via fallback/);
});

test('executeAction: stop reports a timeout distinctly from a clean stop', async () => {
  const timeoutDeps: ActionDeps = {
    setActiveWorktree: async () => ({ hasServer: true, proxyActive: false }),
    applyTask: async () => ({ members: {}, needsServe: [], proxying: [], mismatches: [] }),
    stopServer: async () => ({ status: 'timeout', pid: 42 }),
    mux: fakeMux('tmux', []),
  };
  const timeoutMessage = await executeAction(
    { type: 'stop', repo: 'api', worktree: 'api-main' },
    makeOverview(),
    timeoutDeps
  );
  assert.match(timeoutMessage, /still running/);
  assert.match(timeoutMessage, /42/);

  const stoppedDeps: ActionDeps = { ...timeoutDeps, stopServer: async () => ({ status: 'stopped', pid: 42 }) };
  const stoppedMessage = await executeAction(
    { type: 'stop', repo: 'api', worktree: 'api-main' },
    makeOverview(),
    stoppedDeps
  );
  assert.match(stoppedMessage, /^Stopped server/);
});

test('executeAction: restart does not serve when the stop times out, but does after a clean stop or no-op stop', async () => {
  const opened: { title: string; command: string; cwd?: string }[] = [];
  const baseDeps: ActionDeps = {
    setActiveWorktree: async () => ({ hasServer: true, proxyActive: false }),
    applyTask: async () => ({ members: {}, needsServe: [], proxying: [], mismatches: [] }),
    stopServer: async () => ({ status: 'timeout', pid: 7 }),
    mux: fakeMux('tmux', opened),
  };

  const timeoutMessage = await executeAction(
    { type: 'restart', repo: 'api', worktree: 'api-main' },
    makeOverview(),
    baseDeps
  );
  assert.equal(opened.length, 0);
  assert.match(timeoutMessage, /not restarting/);

  const stoppedDeps: ActionDeps = { ...baseDeps, stopServer: async () => ({ status: 'stopped', pid: 7 }) };
  const stoppedMessage = await executeAction(
    { type: 'restart', repo: 'api', worktree: 'api-main' },
    makeOverview(),
    stoppedDeps
  );
  assert.equal(opened.length, 1);
  assert.match(stoppedMessage, /Stopped pid 7/);
  assert.match(stoppedMessage, /Opened serve/);
});

test('executeAction: toggle-proxy sends SIGTERM when running, else opens proxy via the mux adapter', async () => {
  const killed: [number, NodeJS.Signals][] = [];
  const runningDeps: ActionDeps = {
    setActiveWorktree: async () => ({ hasServer: true, proxyActive: false }),
    applyTask: async () => ({ members: {}, needsServe: [], proxying: [], mismatches: [] }),
    stopServer: async () => ({ status: 'no-server' }),
    mux: fakeMux('tmux', []),
    kill: (pid, signal) => killed.push([pid, signal]),
  };

  const runningMessage = await executeAction({ type: 'toggle-proxy', repo: 'api' }, makeOverview(), runningDeps);
  assert.deepEqual(killed, [[999, 'SIGTERM']]);
  assert.match(runningMessage, /SIGTERM/);
  assert.match(runningMessage, /999/);

  const overviewNoProxy = makeOverview();
  delete overviewNoProxy.repos[0].proxy;
  const opened: { title: string; command: string; cwd?: string }[] = [];
  const stoppedDeps: ActionDeps = { ...runningDeps, mux: fakeMux('tmux', opened) };

  const openedMessage = await executeAction({ type: 'toggle-proxy', repo: 'api' }, overviewNoProxy, stoppedDeps);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].cwd, '/repos/api');
  assert.match(opened[0].command, /proxy/);
  assert.match(openedMessage, /Opened proxy/);
});

test('executeAction: use-task summarizes needsServe and wiring mismatches in one message', async () => {
  const deps: ActionDeps = {
    setActiveWorktree: async () => ({ hasServer: true, proxyActive: false }),
    applyTask: async () => ({
      members: { api: 'api-main' },
      needsServe: ['api'],
      proxying: [],
      mismatches: [{ repo: 'front', worktree: 'front-main', refRepo: 'api', recordedPort: 3101, currentPort: 3102 }],
    }),
    stopServer: async () => ({ status: 'no-server' }),
    mux: fakeMux('tmux', []),
  };

  const message = await executeAction({ type: 'use-task', task: 'prod' }, makeOverview(), deps);
  assert.match(message, /applied/);
  assert.match(message, /Not running: api/);
  assert.match(message, /Wiring mismatch: front \(api\)/);
});

test('executeAction: none and quit are no-ops that return an empty message', async () => {
  const deps: ActionDeps = {
    setActiveWorktree: async () => ({ hasServer: true, proxyActive: false }),
    applyTask: async () => ({ members: {}, needsServe: [], proxying: [], mismatches: [] }),
    stopServer: async () => ({ status: 'no-server' }),
    mux: fakeMux('tmux', []),
  };
  assert.equal(await executeAction({ type: 'none' }, makeOverview(), deps), '');
  assert.equal(await executeAction({ type: 'quit' }, makeOverview(), deps), '');
});
