import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLines } from '../src/ui/render.ts';
import type { UiRow } from '../src/ui/model.ts';

const ROWS: UiRow[] = [
  { kind: 'repo', repo: 'api', fixedPort: 3000, proxyRunning: true, proxyPid: 42 },
  { kind: 'worktree', repo: 'api', worktree: 'api-main', branch: 'main', port: 3101, pid: 111, active: true },
  { kind: 'worktree', repo: 'api', worktree: 'api-feature-x', branch: 'feature/x', active: false },
  { kind: 'task', task: 'prod', members: { api: 'api-main' }, matches: true },
];

test('renderLines: marks the selected row with a cursor and shows repo/worktree/task details', () => {
  const lines = renderLines(ROWS, 1, '');

  assert.equal(lines.length, ROWS.length + 2); // + blank separator + message/help line
  assert.ok(lines[0].startsWith('  '), 'unselected row has no cursor');
  assert.ok(lines[1].startsWith('> '), 'selected row is marked');
  assert.match(lines[0], /api/);
  assert.match(lines[0], /3000/);
  assert.match(lines[0], /running \(pid 42\)/);
  assert.match(lines[1], /api-main/);
  assert.match(lines[1], /port 3101/);
  assert.match(lines[1], /pid 111/);
  assert.match(lines[2], /port -/);
  assert.match(lines[2], /pid -/);
  assert.match(lines[3], /prod/);
  assert.match(lines[3], /\*/);
});

test('renderLines: shows the help line when no message is set, else the message', () => {
  const withMessage = renderLines(ROWS, 0, 'Stopped server for "api/api-main" (pid 111).');
  assert.equal(withMessage[withMessage.length - 1], 'Stopped server for "api/api-main" (pid 111).');

  const withoutMessage = renderLines(ROWS, 0, '');
  assert.match(withoutMessage[withoutMessage.length - 1], /quit/);
});

test('renderLines: a worktree row with worktreeGone shows a "(worktree gone)" note', () => {
  const rows: UiRow[] = [
    { kind: 'worktree', repo: 'api', worktree: 'api-gone', branch: 'gone', port: 3105, pid: 222, active: false, worktreeGone: true },
  ];
  const lines = renderLines(rows, 0, '');
  assert.match(lines[0], /\(worktree gone\)/);
});

test('renderLines: an empty row list still renders a placeholder and the message line', () => {
  const lines = renderLines([], 0, '');
  assert.equal(lines.length, 3); // placeholder + blank separator + message/help line
  assert.match(lines[0], /no repos configured/);
  assert.match(lines[2], /quit/);
});
