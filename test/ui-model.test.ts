import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRows,
  moveSelection,
  pendingKey,
  PENDING_TIMEOUT_MS,
  prunePending,
  proxyPid,
  repoPath,
  serverPid,
  worktreePath,
} from '../src/ui/model.ts';
import type { Overview } from '../src/overview.ts';

const OVERVIEW: Overview = {
  repos: [
    {
      name: 'api',
      path: '/repos/api',
      fixedPort: 3000,
      worktrees: [
        { name: 'api-main', branch: 'main', path: '/repos/api-main' },
        { name: 'api-feature-x', branch: 'feature/x', path: '/repos/api-feature-x' },
      ],
      active: 'api-main',
      ports: { 'api-main': 3101 },
      servers: { 'api-main': { branch: 'main', port: 3101, pid: 111 } },
      proxy: { pid: 222, port: 3000 },
    },
    {
      name: 'front',
      path: '/repos/front',
      fixedPort: 8080,
      worktrees: [{ name: 'front-main', branch: 'main', path: '/repos/front-main' }],
      ports: {},
      servers: {},
    },
  ],
  tasks: [{ name: 'prod', members: { api: 'api-main', front: 'front-main' }, matchesCurrentActive: false }],
};

test('buildRows: one repo header row, then its worktree rows, then task rows at the bottom', () => {
  const rows = buildRows(OVERVIEW);

  assert.deepEqual(
    rows.map((r) => r.kind),
    ['repo', 'worktree', 'worktree', 'repo', 'worktree', 'task']
  );

  const apiHeader = rows[0];
  assert.equal(apiHeader.kind, 'repo');
  if (apiHeader.kind === 'repo') {
    assert.equal(apiHeader.repo, 'api');
    assert.equal(apiHeader.fixedPort, 3000);
    assert.equal(apiHeader.proxyRunning, true);
    assert.equal(apiHeader.proxyPid, 222);
    assert.equal(apiHeader.activeWorktree, 'api-main');
  }

  const apiMainRow = rows[1];
  assert.equal(apiMainRow.kind, 'worktree');
  if (apiMainRow.kind === 'worktree') {
    assert.equal(apiMainRow.repo, 'api');
    assert.equal(apiMainRow.worktree, 'api-main');
    assert.equal(apiMainRow.branch, 'main');
    assert.equal(apiMainRow.port, 3101);
    assert.equal(apiMainRow.pid, 111);
    assert.equal(apiMainRow.active, true);
  }

  const apiFeatureRow = rows[2];
  assert.equal(apiFeatureRow.kind, 'worktree');
  if (apiFeatureRow.kind === 'worktree') {
    assert.equal(apiFeatureRow.active, false);
    assert.equal(apiFeatureRow.port, undefined);
    assert.equal(apiFeatureRow.pid, undefined);
  }

  const frontHeader = rows[3];
  assert.equal(frontHeader.kind, 'repo');
  if (frontHeader.kind === 'repo') {
    assert.equal(frontHeader.proxyRunning, false);
    assert.equal(frontHeader.proxyPid, undefined);
    assert.equal(frontHeader.activeWorktree, undefined);
  }

  const taskRow = rows[5];
  assert.equal(taskRow.kind, 'task');
  if (taskRow.kind === 'task') {
    assert.equal(taskRow.task, 'prod');
    assert.equal(taskRow.matches, false);
    assert.deepEqual(taskRow.members, { api: 'api-main', front: 'front-main' });
  }
});

test('buildRows: synthesizes an extra worktree row for a server whose worktree no longer exists', () => {
  const overview: Overview = {
    repos: [
      {
        name: 'api',
        path: '/repos/api',
        fixedPort: 3000,
        worktrees: [{ name: 'api-main', branch: 'main', path: '/repos/api-main' }],
        active: 'api-gone',
        ports: { 'api-main': 3101, 'api-gone': 3105 },
        servers: {
          'api-main': { branch: 'main', port: 3101, pid: 111 },
          'api-gone': { branch: 'gone-branch', port: 3105, pid: 222 },
        },
      },
    ],
    tasks: [],
  };

  const rows = buildRows(overview);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['repo', 'worktree', 'worktree']
  );

  const orphanRow = rows[2];
  assert.equal(orphanRow.kind, 'worktree');
  if (orphanRow.kind === 'worktree') {
    assert.equal(orphanRow.repo, 'api');
    assert.equal(orphanRow.worktree, 'api-gone');
    assert.equal(orphanRow.branch, 'gone-branch');
    assert.equal(orphanRow.port, 3105);
    assert.equal(orphanRow.pid, 222);
    assert.equal(orphanRow.active, true);
    assert.equal(orphanRow.worktreeGone, true);
  }

  const normalRow = rows[1];
  assert.equal(normalRow.kind, 'worktree');
  if (normalRow.kind === 'worktree') {
    assert.equal(normalRow.worktreeGone, undefined);
  }
});

test('moveSelection: clamps at both ends and handles an empty row list', () => {
  const rows = buildRows(OVERVIEW);
  assert.equal(moveSelection(rows, 0, -1), 0);
  assert.equal(moveSelection(rows, 0, 1), 1);
  assert.equal(moveSelection(rows, rows.length - 1, 1), rows.length - 1);
  assert.equal(moveSelection([], 0, 1), 0);
});

test('lookup helpers: read server pid, worktree/repo path, and proxy pid from an Overview', () => {
  assert.equal(serverPid(OVERVIEW, 'api', 'api-main'), 111);
  assert.equal(serverPid(OVERVIEW, 'api', 'api-feature-x'), undefined);
  assert.equal(serverPid(OVERVIEW, 'nosuch', 'x'), undefined);

  assert.equal(worktreePath(OVERVIEW, 'api', 'api-main'), '/repos/api-main');
  assert.equal(worktreePath(OVERVIEW, 'api', 'nosuch'), undefined);

  assert.equal(repoPath(OVERVIEW, 'front'), '/repos/front');
  assert.equal(repoPath(OVERVIEW, 'nosuch'), undefined);

  assert.equal(proxyPid(OVERVIEW, 'api'), 222);
  assert.equal(proxyPid(OVERVIEW, 'front'), undefined);
});

test('pendingKey: bare repo name for a proxy row, "repo/worktree" for a server row', () => {
  assert.equal(pendingKey('api'), 'api');
  assert.equal(pendingKey('api', 'api-main'), 'api/api-main');
});

test('prunePending: drops an entry once the overview observes it running -- a server row via serverPid, a proxy row via proxyPid', () => {
  // OVERVIEW: api/api-main has a server (pid 111); api itself has a proxy
  // (pid 222); front and front/front-main have neither.
  const pending = new Map([
    ['api/api-main', 1000], // observed running -> dropped.
    ['api', 1000], // observed running -> dropped.
    ['front/front-main', 1000], // not observed, not timed out -> kept.
  ]);

  const result = prunePending(pending, OVERVIEW, 1000 + 1); // barely any time elapsed.

  assert.deepEqual([...result.keys()], ['front/front-main']);
});

test('prunePending: drops an entry once PENDING_TIMEOUT_MS has elapsed, even though it was never observed running', () => {
  const pending = new Map([['front/front-main', 1000]]);

  const stillWaiting = prunePending(pending, OVERVIEW, 1000 + PENDING_TIMEOUT_MS - 1);
  assert.deepEqual([...stillWaiting.keys()], ['front/front-main']);

  const timedOut = prunePending(pending, OVERVIEW, 1000 + PENDING_TIMEOUT_MS);
  assert.deepEqual([...timedOut.keys()], []);
});

test('prunePending: keeps an entry that is neither observed running nor timed out, and returns a fresh Map rather than mutating the input', () => {
  const pending = new Map([['front/front-main', 1000]]);
  const result = prunePending(pending, OVERVIEW, 1500);

  assert.deepEqual([...result.keys()], ['front/front-main']);
  assert.notEqual(result, pending);
  assert.deepEqual([...pending.keys()], ['front/front-main'], 'the input map must not be mutated');
});

test('prunePending: independently resolves multiple entries in a single call', () => {
  const pending = new Map([
    ['api/api-main', 1000], // observed running -> dropped.
    ['api', 1000], // observed running -> dropped.
    ['front/front-main', 1000], // neither -> kept (not timed out yet).
    ['front', 1000 - PENDING_TIMEOUT_MS], // not observed, already past the timeout -> dropped.
  ]);

  const result = prunePending(pending, OVERVIEW, 1000);

  assert.deepEqual([...result.keys()], ['front/front-main']);
});
