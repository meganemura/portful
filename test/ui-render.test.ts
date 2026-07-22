import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLines, BOLD, RED, GREEN, RESET, type UiMessage } from '../src/ui/render.ts';
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

test('renderLines: a running worktree row (pid set) is marked with ● and a stopped one with ○, without disturbing the active-mark alignment', () => {
  const lines = renderLines(ROWS, 1, NO_MESSAGE);
  // ROWS[1]: active, pid 111 -> running. Strip the 2-char cursor and (since
  // it's active) the GREEN wrapper so the assertion doesn't care whether
  // the row happens to be selected or colored.
  assert.match(lines[1].slice(2), /^\x1b\[32m {2}● \* api-main\t/);
  // ROWS[2]: inactive, no pid -> stopped; '*' becomes a blank so the name
  // still lines up under the running row's name.
  assert.match(lines[2].slice(2), /^ {2}○ {3}api-feature-x\t/);
});

test('renderLines: a repo row is marked ● when its proxy is running and ○ when it is stopped', () => {
  const running: UiRow = { kind: 'repo', repo: 'api', fixedPort: 3000, proxyRunning: true, proxyPid: 42 };
  const stopped: UiRow = { kind: 'repo', repo: 'api', fixedPort: 3000, proxyRunning: false };

  const runningLine = renderLines([running], 0, NO_MESSAGE)[0].slice(2);
  const stoppedLine = renderLines([stopped], 0, NO_MESSAGE)[0].slice(2);

  assert.match(runningLine, /^● api\b/);
  assert.match(runningLine, /running \(pid 42\)/);
  assert.match(stoppedLine, /^○ api\b/);
  assert.match(stoppedLine, /proxy: stopped/);
});

test('renderLines: a repo row shows " -> activeWorktree" after the pid when the proxy is running and an active worktree is set', () => {
  const row: UiRow = { kind: 'repo', repo: 'api', fixedPort: 3000, proxyRunning: true, proxyPid: 42, activeWorktree: 'feature-x' };
  const line = renderLines([row], 0, NO_MESSAGE)[0];
  assert.match(line, /proxy: running \(pid 42\) → feature-x$/);
});

test('renderLines: a repo row shows no arrow when the proxy is running but no active worktree is set', () => {
  const row: UiRow = { kind: 'repo', repo: 'api', fixedPort: 3000, proxyRunning: true, proxyPid: 42 };
  const line = renderLines([row], 0, NO_MESSAGE)[0];
  assert.match(line, /proxy: running \(pid 42\)$/);
  assert.doesNotMatch(line, /→/);
});

test('renderLines: a repo row shows no arrow when the proxy is stopped, even if an active worktree is set', () => {
  const row: UiRow = { kind: 'repo', repo: 'api', fixedPort: 3000, proxyRunning: false, activeWorktree: 'feature-x' };
  const line = renderLines([row], 0, NO_MESSAGE)[0];
  assert.match(line, /proxy: stopped$/);
  assert.doesNotMatch(line, /→/);
});

test('renderLines: an active worktree row is wrapped in GREEN...RESET (whole row content, cursor stays outside)', () => {
  const rows: UiRow[] = [
    { kind: 'worktree', repo: 'api', worktree: 'api-main', branch: 'main', port: 3101, pid: 111, active: true },
  ];
  const line = renderLines(rows, 0, NO_MESSAGE)[0];
  assert.ok(line.startsWith('> '), 'cursor stays outside the color codes');
  const content = line.slice(2);
  assert.equal(content, `${GREEN}  ● * api-main\tmain\tport 3101\tpid 111${RESET}`);
});

test('renderLines: a non-active worktree row has no color codes', () => {
  const rows: UiRow[] = [{ kind: 'worktree', repo: 'api', worktree: 'api-feature-x', branch: 'feature/x', active: false }];
  const line = renderLines(rows, 0, NO_MESSAGE)[0];
  assert.doesNotMatch(line, /\x1b\[/);
});

test('renderLines: an active worktree row with worktreeGone is still wrapped in GREEN and keeps the note inside it', () => {
  const rows: UiRow[] = [
    { kind: 'worktree', repo: 'api', worktree: 'api-gone', branch: 'gone', port: 3105, pid: 222, active: true, worktreeGone: true },
  ];
  const line = renderLines(rows, 0, NO_MESSAGE)[0].slice(2);
  assert.equal(line, `${GREEN}  ● * api-gone\tgone\tport 3105\tpid 222 (worktree gone)${RESET}`);
});

test('renderLines: task rows show no running/stopped indicator', () => {
  const line = renderLines(ROWS, 3, NO_MESSAGE)[3];
  assert.doesNotMatch(line, /[●○]/);
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

  assert.equal(repoHelp, 'j/k move  enter/p proxy  q quit');
  assert.equal(worktreeHelp, 'j/k move  u use  enter on/off  s/d serve  x stop  r restart  p proxy  q quit');
  assert.equal(taskHelp, 'j/k move  u/enter apply  q quit');
});

/**
 * `render.ts`'s per-row help text is a separate literal from
 * `actions.ts`'s `VALID_ROW_KINDS` (different display order and labels,
 * merging keys into combined phrases like `u/enter` or `s/d`), so nothing
 * at the type level stops them from drifting apart. This walks every row
 * kind and action key and checks the help line advertises a key — alone,
 * or as part of a merged phrase — if and only if `VALID_ROW_KINDS` says
 * that key works on that row kind. `return`'s on-screen label is `enter`
 * (matching `actions.ts`'s own `KEY_LABEL`); every other key is its own
 * letter.
 */
test('renderLines: the per-row-kind help line stays consistent with actions.ts VALID_ROW_KINDS', () => {
  const sampleRow: Record<UiRow['kind'], UiRow> = {
    repo: { kind: 'repo', repo: 'api', fixedPort: 3000, proxyRunning: false },
    worktree: { kind: 'worktree', repo: 'api', worktree: 'api-main', branch: 'main', active: false },
    task: { kind: 'task', task: 'prod', members: {}, matches: false },
  };

  const LABEL: Record<ActionKey, string> = { u: 'u', return: 'enter', s: 's', d: 'd', x: 'x', r: 'r', p: 'p' };
  const KEYS = Object.keys(LABEL) as ActionKey[];

  for (const kind of Object.keys(sampleRow) as UiRow['kind'][]) {
    const helpLine = renderLines([sampleRow[kind]], 0, NO_MESSAGE).at(-1) ?? '';
    for (const key of KEYS) {
      const expected = VALID_ROW_KINDS[key].includes(kind);
      // '/' counts as a boundary too, so this matches a key merged into a
      // combined phrase ("s/d", "enter/p", "u/enter") as well as a
      // standalone one ("x stop").
      const pattern = new RegExp(`(^|\\s|/)${LABEL[key]}(\\s|/|$)`);
      assert.equal(
        pattern.test(helpLine),
        expected,
        `row kind "${kind}": expected key "${key}" ${expected ? '' : 'not '}to appear in help line "${helpLine}"`
      );
    }
  }
});

test('renderLines: a pending worktree/repo row shows ◐ regardless of its real pid/proxyRunning state, with no ANSI color of its own', () => {
  const worktreeRow: UiRow = { kind: 'worktree', repo: 'api', worktree: 'api-main', branch: 'main', active: false };
  const runningWorktreeRow: UiRow = { ...worktreeRow, pid: 111 };
  const repoRow: UiRow = { kind: 'repo', repo: 'api', fixedPort: 3000, proxyRunning: false };
  const runningRepoRow: UiRow = { ...repoRow, proxyRunning: true, proxyPid: 42 };

  const pendingKeys = new Set(['api/api-main', 'api']);

  // Worktree rows carry their own two leading spaces ahead of the
  // indicator (`  ${indicator} ${activeMark} ...`), so only the repo row's
  // indicator sits right at the start of the (cursor-stripped) line.
  for (const row of [worktreeRow, runningWorktreeRow]) {
    const line = renderLines([row], 0, NO_MESSAGE, pendingKeys)[0].slice(2);
    assert.match(line, /^ {2}◐/);
    assert.doesNotMatch(line, /[●○]/);
  }
  for (const row of [repoRow, runningRepoRow]) {
    const line = renderLines([row], 0, NO_MESSAGE, pendingKeys)[0].slice(2);
    assert.match(line, /^◐/);
    assert.doesNotMatch(line, /[●○]/);
  }
});

test('renderLines: a row not in pendingKeys renders its ordinary ●/○ indicator, unaffected by other rows being pending', () => {
  const worktreeRow: UiRow = { kind: 'worktree', repo: 'api', worktree: 'api-main', branch: 'main', active: false };
  const pendingKeys = new Set(['front/front-main']); // a different row entirely.
  const line = renderLines([worktreeRow], 0, NO_MESSAGE, pendingKeys)[0].slice(2);
  assert.match(line, /^ {2}○/);
});

test('renderLines: omitting pendingKeys defaults to no pending rows, rendering exactly as before this parameter existed', () => {
  const withDefault = renderLines(ROWS, 1, NO_MESSAGE);
  const withEmptySet = renderLines(ROWS, 1, NO_MESSAGE, new Set());
  assert.deepEqual(withDefault, withEmptySet);
});
