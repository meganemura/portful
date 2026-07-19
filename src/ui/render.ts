import type { UiRow } from './model.ts';

export const ENTER_ALT_SCREEN = '\x1b[?1049h';
export const LEAVE_ALT_SCREEN = '\x1b[?1049l';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
/** Cursor home + clear-to-end-of-screen, written before every redraw. */
export const CLEAR_AND_HOME = '\x1b[H\x1b[2J';
export const BOLD = '\x1b[1m';
export const RED = '\x1b[31m';
export const RESET = '\x1b[0m';

/**
 * The message line's payload: empty `text` means "nothing to say right
 * now", so `renderLines` renders the message line as blank instead of
 * dropping it — the help line always stays on the line right after it, at
 * a fixed position, whether or not there's a message to show. A
 * non-empty `text` is rendered bold (red as well when `isError`) so it
 * stands out from the surrounding plain text.
 */
export interface UiMessage {
  text: string;
  isError: boolean;
}

/** `●` for "something is actually running here", `○` for "it isn't" — lets a glance at the list answer that before reading any pid/proxy text. */
const RUNNING = '●';
const STOPPED = '○';

function formatRow(row: UiRow): string {
  if (row.kind === 'repo') {
    const indicator = row.proxyRunning ? RUNNING : STOPPED;
    const proxyText = row.proxyRunning ? `proxy: running (pid ${row.proxyPid})` : 'proxy: stopped';
    return `${indicator} ${row.repo}  fixed_port=${row.fixedPort}  ${proxyText}`;
  }

  if (row.kind === 'worktree') {
    const indicator = row.pid !== undefined ? RUNNING : STOPPED;
    const activeMark = row.active ? '*' : ' ';
    const portText = row.port !== undefined ? String(row.port) : '-';
    const pidText = row.pid !== undefined ? String(row.pid) : '-';
    const goneNote = row.worktreeGone ? ' (worktree gone)' : '';
    return `  ${indicator} ${activeMark} ${row.worktree}\t${row.branch}\tport ${portText}\tpid ${pidText}${goneNote}`;
  }

  const marker = row.matches ? '*' : ' ';
  const memberList = Object.entries(row.members)
    .map(([repo, wt]) => `${repo}/${wt}`)
    .join(', ');
  return `task ${marker} ${row.task}\t${memberList}`;
}

/**
 * Help text per row kind, listing only the keys that actually do
 * something there — matches the existing `key label` style (`u/enter
 * use`, `p proxy`, ...). `j/k move` and `q quit` apply regardless of the
 * selected row's kind (navigation always works; `q`/`ctrl-c` quit is
 * checked in `keyToAction` before it even looks at the row), so both are
 * listed on every line. Kept in lockstep with `VALID_ROW_KINDS` in
 * `actions.ts` by convention rather than by construction — the
 * ui-render test suite cross-checks the two so this can't silently drift
 * from what `keyToAction` actually accepts.
 */
const HELP_BY_KIND: Record<UiRow['kind'], string> = {
  repo: 'j/k move  p proxy  q quit',
  worktree: 'j/k move  u/enter use  s serve  x stop  r restart  p proxy  q quit',
  task: 'j/k move  u/enter apply  q quit',
};

/** Shown when there's no selected row at all (e.g. no repos configured) — only navigation-independent `quit` still works. */
const NO_ROW_HELP = 'q quit';

function helpLine(row: UiRow | undefined): string {
  return row ? HELP_BY_KIND[row.kind] : NO_ROW_HELP;
}

/** Bold (and red, for errors) so a message reads as distinct from the plain rows/help text around it; empty text renders as a blank line so the help line beneath it never shifts position. */
function formatMessageLine(message: UiMessage): string {
  if (!message.text) {
    return '';
  }
  const style = message.isError ? BOLD + RED : BOLD;
  return `${style}${message.text}${RESET}`;
}

/**
 * Renders the full screen as an array of lines: one per row (with a `>`
 * cursor on the selected one), a blank separator, the message line (blank
 * when there's nothing to say, so its absence never moves the help line
 * below it), and a help line listing only the keys that do something on
 * the selected row. Pure function of the row list/selection/message, so
 * it's testable without a terminal — actual raw-mode drawing (writing
 * these to the alternate screen) is manual-verification-only.
 */
export function renderLines(rows: UiRow[], selectedIndex: number, message: UiMessage): string[] {
  const lines: string[] = [];

  if (rows.length === 0) {
    lines.push('(no repos configured)');
  } else {
    rows.forEach((row, i) => {
      const cursor = i === selectedIndex ? '> ' : '  ';
      lines.push(cursor + formatRow(row));
    });
  }

  lines.push('');
  lines.push(formatMessageLine(message));
  lines.push(helpLine(rows[selectedIndex]));
  return lines;
}
