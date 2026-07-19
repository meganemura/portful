import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLines, BOLD, RED, RESET, type UiMessage } from '../src/ui/render.ts';
import { VALID_ROW_KINDS, type ActionKey } from '../src/ui/actions.ts';
import type { UiRow } from '../src/ui/model.ts';

const ROWS: UiRow[] = [
  { kind: 'repo', repo: 'api', fixedPort: 3000, proxyRunning: true, proxyPid: 42 },
  { kind: 'worktree', repo: 'api', worktree: 'api-main', branch: 'main', port: 3101, pid: 111, active: true },
  { kind: 'worktree', repo: 'api', worktree: 'api-feature-x', branch: 'feature/x', active: false },
  { kind: 'task', task: 'prod', members: { api: 'api-main' }, matches: true },
];

const NO_MESSAGE: UiMessage = { text: '', isError: false };

test('renderLines: marks the selected row with a cursor and shows repo/worktree/task details', () => {
  const lines = renderLines(ROWS, 1, NO_MESSAGE);

  assert.equal(lines.length, ROWS.length + 3); // + blank separator + message line + help line
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

test('renderLines: message line is blank and the help line (for the selected row) follows it when no message is set', () => {
  const lines = renderLines(ROWS, 1, NO_MESSAGE); // ROWS[1] is a worktree row
  const messageLine = lines[lines.length - 2];
  const helpLine = lines[lines.length - 1];
  assert.equal(messageLine, '');
  assert.match(helpLine, /quit/);
  assert.doesNotMatch(helpLine, /\x1b\[/);
});

test('renderLines: a non-error message is bold but not red, and sits above the help line rather than replacing it', () => {
  const lines = renderLines(ROWS, 0, { text: 'Stopped server for "api/api-main" (pid 111).', isError: false });
  const messageLine = lines[lines.length - 2];
  const helpLine = lines[lines.length - 1];
  assert.equal(messageLine, `${BOLD}Stopped server for "api/api-main" (pid 111).${RESET}`);
  assert.doesNotMatch(messageLine, /\x1b\[31m/);
  assert.match(helpLine, /quit/);
});

test('renderLines: an error message is bold and red', () => {
  const lines = renderLines(ROWS, 0, { text: 'Something went wrong.', isError: true });
  const messageLine = lines[lines.length - 2];
  assert.equal(messageLine, `${BOLD}${RED}Something went wrong.${RESET}`);
});

test('renderLines: the message line stays at the same position whether or not a message is set, so the help line never moves', () => {
  const withMessage = renderLines(ROWS, 0, { text: 'Something happened.', isError: false });
  const withoutMessage = renderLines(ROWS, 0, NO_MESSAGE);
  assert.equal(withMessage.length, withoutMessage.length);
  // Same index holds the message line in both cases (blank when there's none).
  assert.equal(withoutMessage[withoutMessage.length - 2], '');
  assert.notEqual(withMessage[withMessage.length - 2], '');
});

test('renderLines: a worktree row with worktreeGone shows a "(worktree gone)" note', () => {
  const rows: UiRow[] = [
    { kind: 'worktree', repo: 'api', worktree: 'api-gone', branch: 'gone', port: 3105, pid: 222, active: false, worktreeGone: true },
  ];
  const lines = renderLines(rows, 0, NO_MESSAGE);
  assert.match(lines[0], /\(worktree gone\)/);
});

test('renderLines: an empty row list still renders a placeholder, a blank message line, and the no-row help line', () => {
  const lines = renderLines([], 0, NO_MESSAGE);
  assert.equal(lines.length, 4); // placeholder + blank separator + blank message line + help line
  assert.match(lines[0], /no repos configured/);
  assert.equal(lines[1], ''); // blank separator between the row list and the message line
  assert.equal(lines[2], ''); // blank message line (no message set)
  assert.equal(lines[3], 'q quit');
});

test('renderLines: the help line changes with the selected row kind, showing only keys that work there', () => {
  const repoHelp = renderLines(ROWS, 0, NO_MESSAGE).at(-1); // ROWS[0] is a repo row
  const worktreeHelp = renderLines(ROWS, 1, NO_MESSAGE).at(-1); // ROWS[1] is a worktree row
  const taskHelp = renderLines(ROWS, 3, NO_MESSAGE).at(-1); // ROWS[3] is a task row

  assert.equal(repoHelp, 'j/k move  p proxy  q quit');
  assert.equal(worktreeHelp, 'j/k move  u/enter use  s serve  x stop  r restart  p proxy  q quit');
  assert.equal(taskHelp, 'j/k move  u/enter apply  q quit');
});

/**
 * `render.ts`'s per-row help text is a separate literal from
 * `actions.ts`'s `VALID_ROW_KINDS` (different display order and labels,
 * e.g. `u/enter use` merges two keys into one phrase), so nothing at the
 * type level stops them from drifting apart. This walks every row kind
 * and action key and checks the help line advertises a key if and only if
 * `VALID_ROW_KINDS` says that key works on that row kind.
 */
test('renderLines: the per-row-kind help line stays consistent with actions.ts VALID_ROW_KINDS', () => {
  const sampleRow: Record<UiRow['kind'], UiRow> = {
    repo: { kind: 'repo', repo: 'api', fixedPort: 3000, proxyRunning: false },
    worktree: { kind: 'worktree', repo: 'api', worktree: 'api-main', branch: 'main', active: false },
    task: { kind: 'task', task: 'prod', members: {}, matches: false },
  };
  // The help line merges 'u' and 'return' into a single "u/enter" phrase,
  // which is only sound if the two keys are always valid on the same row
  // kinds — assert that so the merge itself can't silently go stale.
  assert.deepEqual(VALID_ROW_KINDS.u, VALID_ROW_KINDS.return);

  // Every other action key gets its own single-letter phrase in the help
  // line, keyed by the same letter used in VALID_ROW_KINDS.
  const soloKeys: Exclude<ActionKey, 'return'>[] = ['u', 's', 'x', 'r', 'p'];

  for (const kind of Object.keys(sampleRow) as UiRow['kind'][]) {
    const helpLine = renderLines([sampleRow[kind]], 0, NO_MESSAGE).at(-1) ?? '';
    for (const key of soloKeys) {
      const expected = VALID_ROW_KINDS[key].includes(kind);
      const phrase = key === 'u' ? 'u/enter' : key;
      const actual = new RegExp(`(^|\\s)${phrase}(\\s|$)`).test(helpLine);
      assert.equal(
        actual,
        expected,
        `row kind "${kind}": expected key "${key}" ${expected ? '' : 'not '}to appear in help line "${helpLine}"`
      );
    }
  }
});
