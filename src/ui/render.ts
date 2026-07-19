import type { UiRow } from './model.ts';

export const ENTER_ALT_SCREEN = '\x1b[?1049h';
export const LEAVE_ALT_SCREEN = '\x1b[?1049l';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
/** Cursor home + clear-to-end-of-screen, written before every redraw. */
export const CLEAR_AND_HOME = '\x1b[H\x1b[2J';

function formatRow(row: UiRow): string {
  if (row.kind === 'repo') {
    const proxyText = row.proxyRunning ? `proxy: running (pid ${row.proxyPid})` : 'proxy: stopped';
    return `${row.repo}  fixed_port=${row.fixedPort}  ${proxyText}`;
  }

  if (row.kind === 'worktree') {
    const activeMark = row.active ? '*' : ' ';
    const portText = row.port !== undefined ? String(row.port) : '-';
    const pidText = row.pid !== undefined ? String(row.pid) : '-';
    const goneNote = row.worktreeGone ? ' (worktree gone)' : '';
    return `  ${activeMark} ${row.worktree}\t${row.branch}\tport ${portText}\tpid ${pidText}${goneNote}`;
  }

  const marker = row.matches ? '*' : ' ';
  const memberList = Object.entries(row.members)
    .map(([repo, wt]) => `${repo}/${wt}`)
    .join(', ');
  return `task ${marker} ${row.task}\t${memberList}`;
}

const HELP_LINE =
  'j/k move  u/enter use  s serve  x stop  r restart  p proxy  q quit';

/**
 * Renders the full screen as an array of lines: one per row (with a `>`
 * cursor on the selected one), a blank separator, the message line, and a
 * trailing help line. Pure function of the row list/selection/message, so
 * it's testable without a terminal — actual raw-mode drawing (writing
 * these to the alternate screen) is manual-verification-only.
 */
export function renderLines(rows: UiRow[], selectedIndex: number, message: string): string[] {
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
  lines.push(message || HELP_LINE);
  return lines;
}
