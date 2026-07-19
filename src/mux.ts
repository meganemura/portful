import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config.ts';

const execFileAsync = promisify(execFile);

export interface MuxOpenOptions {
  /** Human-readable label for the new tab/window/pane. */
  title: string;
  /** Full shell command to run inside it. */
  command: string;
  cwd?: string;
  /**
   * This row's index in `wtshunt ui`'s flat row list (`buildRows`), so an
   * adapter that can control pane placement (currently only herdr) can lay
   * panes out to match the list's top-to-bottom order regardless of which
   * order rows are actually opened in. Adapters that can't control
   * placement (template/cmux/tmux/fallback) ignore it.
   */
  order?: number;
}

/**
 * A pluggable "open a labeled pane/tab/window running a command" adapter.
 * `wtshunt ui` uses this to launch `serve`/`proxy` externally, in a new
 * pane — never in-process — so they stay the same kind of foreground
 * process `wtshunt serve`/`wtshunt proxy` always have been.
 */
export interface Mux {
  name: string;
  detect(): boolean;
  open(options: MuxOpenOptions): Promise<void>;
}

/** Shell-quotes `value` for safe embedding in a `sh -c` command line. */
export function shQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_/:=.@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Restricts a title/label to characters safe for tmux window names and herdr agent names. */
function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9_./-]/g, '-');
  return cleaned.length > 0 ? cleaned : 'wtshunt';
}

/** True if `bin` resolves to an executable file somewhere on `$PATH`. */
function isBinOnPath(bin: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * `tmux new-window`/`herdr agent start` both spawn the new pane's shell with
 * the multiplexer server's own stored environment, not this process's — so
 * a custom `XDG_CONFIG_HOME`/`XDG_STATE_HOME` set only for this invocation
 * (rather than sourced by the user's shell rc files) would otherwise
 * silently fall back to the default paths in the new pane. Forwarded
 * explicitly via each adapter's own `-e`/`--env` flag so `serve`/`proxy`
 * always see the same config/state this `wtshunt ui` process resolved.
 */
function envForwardArgs(flag: string): string[] {
  const args: string[] = [];
  for (const name of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME']) {
    const value = process.env[name];
    if (value !== undefined) {
      args.push(flag, `${name}=${value}`);
    }
  }
  return args;
}

/** Absolute path to wtshunt's own executable, so opened panes don't depend on `$PATH`. */
export function wtshuntBinPath(): string {
  return resolve(process.argv[1] ?? 'wtshunt');
}

/** Builds `node <wtshunt-bin> <args...>`, fully shell-quoted, for use as a `Mux.open` command. */
export function wtshuntCommand(...args: string[]): string {
  return [shQuote(process.execPath), shQuote(wtshuntBinPath()), ...args.map(shQuote)].join(' ');
}

/** Substitutes `{title}`, `{cmd}`, and `{cwd}` into a `[ui] open` template, each shell-quoted. */
export function renderTemplate(template: string, options: MuxOpenOptions): string {
  return template
    .replaceAll('{title}', shQuote(options.title))
    .replaceAll('{cmd}', shQuote(options.command))
    .replaceAll('{cwd}', shQuote(options.cwd ?? process.cwd()));
}

/** Priority 1: a user-configured `[ui] open = "..."` shell template. */
export function templateMux(template: string): Mux {
  return {
    name: 'template',
    detect: () => true,
    async open(options) {
      const rendered = renderTemplate(template, options);
      await execFileAsync('sh', ['-c', rendered]);
    },
  };
}

export interface HerdrMuxOptions {
  /** Overrides the binary invoked for every herdr subcommand this adapter runs (`agent start`, `pane list`, `pane neighbor`, `pane swap`) — for tests only, so the real `herdr` is never exercised. */
  herdrBin?: string;
}

/** One entry of `herdr pane list`'s `.result.panes[]`, as much of it as this module cares about. */
interface HerdrPane {
  pane_id: string;
}

function isHerdrPane(value: unknown): value is HerdrPane {
  return value !== null && typeof value === 'object' && typeof (value as { pane_id?: unknown }).pane_id === 'string';
}

/**
 * Runs `herdr pane list` and returns `.result.panes[]`, or `undefined` if
 * the command fails, its stdout isn't JSON, or the shape doesn't match what
 * hands-on inspection confirmed (`{"result":{"panes":[{"pane_id":...},
 * ...]}}`). `undefined` is the "skip this step" signal used throughout
 * `herdrMux` below — never thrown, since a `pane list` hiccup shouldn't
 * stop `agent start` (or the swap-bubbling that follows it) from still
 * doing its job.
 */
async function herdrPaneList(herdrBin: string): Promise<HerdrPane[] | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin, ['pane', 'list']));
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as { result?: { panes?: unknown } };
    const panes = parsed.result?.panes;
    return Array.isArray(panes) ? panes.filter(isHerdrPane) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts `result.agent.pane_id` from `herdr agent start`'s own stdout —
 * confirmed by hands-on testing to always be present on success
 * (`{"result":{"agent":{"pane_id":"w5:p2",...},"type":"agent_started"}}`),
 * which is far more robust than the diff-based approach this replaced (see
 * `herdrMux`'s doc comment). `undefined` if stdout isn't JSON or the field
 * isn't a string.
 */
function parseAgentStartPaneId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { result?: { agent?: { pane_id?: unknown } } };
    const paneId = parsed.result?.agent?.pane_id;
    return typeof paneId === 'string' ? paneId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `herdr pane neighbor --direction <direction> --pane <paneId>`.
 * Confirmed by hands-on testing to exit 0 either way: with a neighbor,
 * `result.neighbor.neighbor_pane_id` holds its id; with none, that field is
 * simply absent. That distinction is preserved in the return type — `{
 * paneId }` (where `paneId` may itself be `undefined`, meaning "no
 * neighbor") for a successful call, vs. bare `undefined` for a failed one
 * (nonzero exit or unparseable stdout), which callers treat as "give up".
 */
async function herdrPaneNeighbor(
  herdrBin: string,
  direction: 'left' | 'right',
  paneId: string
): Promise<{ paneId: string | undefined } | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin, ['pane', 'neighbor', '--direction', direction, '--pane', paneId]));
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as { result?: { neighbor?: { neighbor_pane_id?: unknown } } };
    const neighborPaneId = parsed.result?.neighbor?.neighbor_pane_id;
    return { paneId: typeof neighborPaneId === 'string' ? neighborPaneId : undefined };
  } catch {
    return undefined;
  }
}

/**
 * Runs `herdr pane swap --source-pane <sourcePaneId> --target-pane
 * <targetPaneId>`, which exchanges two panes' positions within a tab.
 * Returns `false` on any failure (nonzero exit or unparseable stdout) — the
 * caller's response is always the same, silently stop bubbling and leave
 * the pane where it is.
 */
async function herdrPaneSwap(herdrBin: string, sourcePaneId: string, targetPaneId: string): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin, ['pane', 'swap', '--source-pane', sourcePaneId, '--target-pane', targetPaneId]));
  } catch {
    return false;
  }
  try {
    JSON.parse(stdout);
    return true;
  } catch {
    return false;
  }
}

/** Upper bound on `bubbleIntoPlace`'s swap loop, so a herdr response that never satisfies its stop condition can't spin forever. */
const MAX_BUBBLE_SWAPS = 16;

/**
 * Slides `newPaneId` right, one `pane swap` at a time, until it's
 * immediately right of `basePaneId` — or until a failure or the
 * `MAX_BUBBLE_SWAPS` cap stops it early, in which case the pane just stays
 * wherever it ended up.
 *
 * `agent start --split right` always inserts the new pane immediately
 * right of the tab's current pane (in practice, `wtshunt ui`'s own pane —
 * see `herdrMux`'s doc comment), never at an arbitrary caller-chosen
 * anchor. So instead of one call that places it directly, each loop
 * iteration walks it one step:
 *
 *   1. `pane neighbor --direction left` of the new pane. If that's already
 *      `basePaneId`, it's in place — stop.
 *   2. `pane neighbor --direction right` of the new pane. If there is none,
 *      it's at the right edge — stop (nothing left to swap past).
 *   3. `pane swap` the new pane with that right neighbor, then repeat from
 *      1 — the new pane is now one position further right.
 *
 * Returns whether at least one swap actually ran. Confirmed by hands-on
 * testing, `pane swap --source-pane <a> --target-pane <b>` moves focus to
 * `a` as a side effect of swapping — here, always the new pane — so the
 * return value tells the caller whether focus needs restoring afterward
 * (see `restoreFocus`). Zero swaps means focus was never touched.
 */
async function bubbleIntoPlace(herdrBin: string, newPaneId: string, basePaneId: string): Promise<boolean> {
  let swapped = false;
  for (let i = 0; i < MAX_BUBBLE_SWAPS; i++) {
    const left = await herdrPaneNeighbor(herdrBin, 'left', newPaneId);
    if (left === undefined || left.paneId === basePaneId) {
      return swapped;
    }
    const right = await herdrPaneNeighbor(herdrBin, 'right', newPaneId);
    if (right === undefined || right.paneId === undefined) {
      return swapped;
    }
    const didSwap = await herdrPaneSwap(herdrBin, newPaneId, right.paneId);
    if (!didSwap) {
      return swapped;
    }
    swapped = true;
  }
  return swapped;
}

/** Upper bound on `restoreFocus`'s walk-left loop, so a herdr response that never satisfies its stop condition can't spin forever. */
const MAX_FOCUS_RESTORE_STEPS = 8;

/**
 * Runs `herdr pane layout --pane <paneId>` and returns
 * `.result.layout.focused_pane_id` — the id of whichever pane currently has
 * focus within `paneId`'s tab (confirmed by hands-on testing: `paneId` need
 * not itself be the focused pane — any pane in the tab reports the same tab
 * -wide focus). `undefined` on any failure: nonzero exit, unparseable
 * stdout, or the field missing/non-string — the same "give up silently"
 * signal used throughout this module.
 */
async function herdrPaneLayout(herdrBin: string, paneId: string): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin, ['pane', 'layout', '--pane', paneId]));
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout) as { result?: { layout?: { focused_pane_id?: unknown } } };
    const focusedPaneId = parsed.result?.layout?.focused_pane_id;
    return typeof focusedPaneId === 'string' ? focusedPaneId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `herdr pane focus --direction <direction> --pane <paneId>`, which
 * moves focus to whatever pane sits immediately in that direction from
 * `paneId` — confirmed by hands-on testing to focus `paneId`'s *neighbor*,
 * never `paneId` itself. Returns `false` on any failure (nonzero exit or
 * unparseable stdout).
 */
async function herdrPaneFocus(herdrBin: string, direction: 'left' | 'right' | 'up' | 'down', paneId: string): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin, ['pane', 'focus', '--direction', direction, '--pane', paneId]));
  } catch {
    return false;
  }
  try {
    JSON.parse(stdout);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks focus back to `uiPaneId` (`wtshunt ui`'s own pane) after a
 * `bubbleIntoPlace` swap stole it — see that function's doc comment for why
 * a swap moves focus at all. There's no herdr API to focus a pane by id
 * directly (`agent focus <pane_id>` only works for agent panes, and
 * `uiPaneId` isn't one), so this walks there one step at a time instead:
 *
 *   1. `pane layout --pane uiPaneId` reports the tab's currently-focused
 *      pane. Already `uiPaneId`? Done — stop.
 *   2. `pane focus --direction left --pane <that focused pane>` moves focus
 *      one step further left (to *its* left neighbor, not to itself), then
 *      repeat from 1.
 *
 * Capped at `MAX_FOCUS_RESTORE_STEPS` iterations. Any failure along the way
 * — an unparseable/incomplete `pane layout` response, or a failed `pane
 * focus` call — silently stops the walk wherever it is, same "give up,
 * don't guess" policy as the rest of this module: focus just stays put
 * instead of landing back on the ui pane.
 */
async function restoreFocus(herdrBin: string, uiPaneId: string): Promise<void> {
  for (let i = 0; i < MAX_FOCUS_RESTORE_STEPS; i++) {
    const focusedPaneId = await herdrPaneLayout(herdrBin, uiPaneId);
    if (focusedPaneId === undefined || focusedPaneId === uiPaneId) {
      return;
    }
    const moved = await herdrPaneFocus(herdrBin, 'left', focusedPaneId);
    if (!moved) {
      return;
    }
  }
}

/**
 * Priority 2: herdr, detected via `HERDR_ENV`/`HERDR_SOCKET_PATH`. Uses
 * `herdr agent start <name> --cwd <cwd> --env ... --workspace <id> --tab
 * <id> --split right --no-focus -- sh -c <command>` to create a fresh
 * labeled pane and run a command in it, then walks it into place with
 * `herdr pane swap` (via `bubbleIntoPlace` above) so opening rows out of
 * list order still lines panes up left-to-right in `wtshunt ui`'s own order
 * (see `MuxOpenOptions.order`).
 *
 * Two pitfalls, confirmed by hands-on testing against a real herdr session,
 * shape this implementation:
 *
 * - `agent start` ignores this process's own `HERDR_*` env entirely and
 *   always creates the pane in whichever tab is currently focused
 *   server-side. An earlier version tried steering placement by overriding
 *   `HERDR_PANE_ID` in the child's env — that silently did nothing.
 *   `--workspace`/`--tab` (read from *this* process's own
 *   `HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`, i.e. wherever `wtshunt ui` itself
 *   is running) are passed explicitly instead, so the pane lands in the
 *   right tab even if focus has moved elsewhere. `--split right` always
 *   inserts the new pane immediately right of the tab's current pane — in
 *   practice `wtshunt ui`'s own pane, since `--no-focus` keeps the new pane
 *   from ever becoming "current" itself — so with no further correction,
 *   opening rows top-to-bottom would produce right-to-left panes.
 * - `herdr pane move <id> --tab <t> --split right --target-pane <p>`, the
 *   obvious tool for correcting that, is a documented no-op for a move
 *   within the same tab (`"reason":"same_tab"`, exit 0 — it looks like it
 *   worked, but nothing moves). Every pane wtshunt opens lives in one tab,
 *   so `pane move` can never actually reorder them; an earlier version's
 *   silent failure to reorder panes was this. `herdr pane swap
 *   --source-pane <a> --target-pane <b>`, which exchanges two panes'
 *   positions within a tab, is the primitive confirmed to actually work —
 *   so instead of moving the new pane to its final spot in one call, it's
 *   walked there one swap at a time.
 *
 * The new pane's id comes straight from `agent start`'s own JSON response
 * (`result.agent.pane_id`) rather than diffing `pane list` before/after —
 * confirmed to always be present on success, and immune to a concurrent
 * pane appearing mid-call. If it's missing (unparseable stdout, or no
 * `pane_id`), placement control and tracking are both skipped entirely —
 * `agent start` itself already ran, so the pane exists somewhere, just
 * untracked.
 *
 * The anchor (`bubbleIntoPlace`'s `basePaneId`) is chosen from `order`
 * (this row's index in `wtshunt ui`'s list) against `openedPanes`, a map of
 * every order this adapter has placed so far to the pane it landed in: the
 * closest lower order's pane if one exists, else `wtshunt ui`'s own pane
 * (`HERDR_PANE_ID`) as the left edge. A row with no `order` (e.g. a
 * `toggle-proxy` open with no matching list row) is appended after the
 * highest order seen so far, or also anchored to the ui pane if nothing has
 * been placed yet. Before choosing it, a single `pane list` call drops any
 * previously-tracked pane no longer reported as live (the user closed it,
 * etc.) so it can never be picked as an anchor again — if `pane list`
 * itself fails, only that cleanup is skipped; placement still proceeds
 * against whatever `openedPanes` already held.
 *
 * A third pitfall, also confirmed by hands-on testing: `pane swap` moves
 * focus to its `--source-pane` as a side effect of swapping. `bubbleIntoPlace`
 * always calls it with the new pane as source, so a swap silently drags
 * focus off wherever the user actually was (e.g. `wtshunt ui`'s own pane) and
 * onto the pane that was just opened — reported by a user opening `api` then
 * `front`, where opening `front` moved focus there (one swap ran); an order
 * requiring zero swaps never showed the bug. Since a swap only *sometimes*
 * runs, focus is only *sometimes* disturbed, so it's only restored when
 * `bubbleIntoPlace` reports it actually swapped at least once — see
 * `restoreFocus`'s doc comment for how it walks focus back to `HERDR_PANE_ID`
 * (the ui pane). Left untouched when nothing swapped, or when
 * `HERDR_PANE_ID` isn't set (this `wtshunt ui` wasn't itself started from a
 * herdr pane, so there's nothing to walk back to).
 */
export function herdrMux(options: HerdrMuxOptions = {}): Mux {
  const herdrBin = options.herdrBin ?? 'herdr';
  const openedPanes = new Map<number, string>(); // order -> pane_id

  return {
    name: 'herdr',
    detect: () => Boolean(process.env.HERDR_ENV || process.env.HERDR_SOCKET_PATH),
    async open({ title, command, cwd, order }) {
      const args = ['agent', 'start', sanitizeLabel(title)];
      if (cwd) {
        args.push('--cwd', cwd);
      }
      args.push(...envForwardArgs('--env'));
      const workspaceId = process.env.HERDR_WORKSPACE_ID;
      if (workspaceId !== undefined) {
        args.push('--workspace', workspaceId);
      }
      const tabId = process.env.HERDR_TAB_ID;
      if (tabId !== undefined) {
        args.push('--tab', tabId);
      }
      args.push('--split', 'right', '--no-focus', '--', 'sh', '-c', command);

      const { stdout } = await execFileAsync(herdrBin, args);

      const newPaneId = parseAgentStartPaneId(stdout);
      if (newPaneId === undefined) {
        // Can't tell which pane agent start just created — don't guess at
        // placement or tracking. The pane stays wherever herdr placed it,
        // untracked.
        return;
      }

      // Drop anything wtshunt placed previously that's no longer among the
      // live panes (the user closed it, etc.) so it never gets picked as an
      // anchor below. A `pane list` failure only skips this cleanup —
      // placement still proceeds against whatever `openedPanes` held.
      const panes = await herdrPaneList(herdrBin);
      if (panes !== undefined) {
        const currentIds = new Set(panes.map((p) => p.pane_id));
        for (const [ord, paneId] of openedPanes) {
          if (!currentIds.has(paneId)) {
            openedPanes.delete(ord);
          }
        }
      }

      let basePaneId: string | undefined;
      let bestOrder = -Infinity;
      for (const [ord, paneId] of openedPanes) {
        const qualifies = order !== undefined ? ord < order : true;
        if (qualifies && ord > bestOrder) {
          bestOrder = ord;
          basePaneId = paneId;
        }
      }
      if (basePaneId === undefined) {
        basePaneId = process.env.HERDR_PANE_ID;
      }

      let didSwap = false;
      if (basePaneId !== undefined) {
        didSwap = await bubbleIntoPlace(herdrBin, newPaneId, basePaneId);
      }

      if (order !== undefined) {
        openedPanes.set(order, newPaneId);
      }

      // A swap moves focus to its source (the new pane) as a side effect —
      // only restore it if bubbling actually swapped at least once, and only
      // if there's a ui pane to walk focus back to.
      if (didSwap) {
        const uiPaneId = process.env.HERDR_PANE_ID;
        if (uiPaneId !== undefined) {
          await restoreFocus(herdrBin, uiPaneId);
        }
      }
    },
  };
}

export interface CmuxMuxOptions {
  /**
   * Overrides which binary name/path is both invoked and PATH-checked by
   * `detect()` — for tests only, so detection can be verified against a
   * harmless stand-in (e.g. `ls`, or a deliberately-missing name) without
   * depending on whether the real `cmux` happens to be installed, and
   * `open()` is never actually exercised against the real binary in tests.
   */
  cmuxBin?: string;
}

/**
 * Priority 3: cmux, a Ghostty-based terminal app whose CLI supports opening
 * a new workspace directly. Detected via `CMUX_SOCKET_PATH`/
 * `CMUX_WORKSPACE_ID` *and* the `cmux` binary being on `$PATH` — when the
 * user's own terminal is running inside cmux, this is the adapter that
 * actually matters in practice, ahead of tmux.
 */
export function cmuxArgs({ title, command, cwd }: MuxOpenOptions): string[] {
  const args = ['new-workspace', '--name', title];
  if (cwd) {
    args.push('--cwd', cwd);
  }
  // `new-workspace` is the only cmux subcommand that accepts name/cwd/command
  // together (confirmed via `cmux --help`) — `tab-action` and `new-surface`
  // don't take a --command. `--focus false` keeps it from stealing focus
  // from wtshunt ui's own screen.
  args.push('--command', command, '--focus', 'false');
  return args;
}

export function cmuxMux(options: CmuxMuxOptions = {}): Mux {
  const cmuxBin = options.cmuxBin ?? 'cmux';
  return {
    name: 'cmux',
    detect: () => Boolean((process.env.CMUX_SOCKET_PATH || process.env.CMUX_WORKSPACE_ID) && isBinOnPath(cmuxBin)),
    async open(muxOptions) {
      await execFileAsync(cmuxBin, cmuxArgs(muxOptions));
    },
  };
}

export interface TmuxMuxOptions {
  tmuxBin?: string;
  /** Overrides the tmux server socket (`tmux -L <name>`) — for tests only; real usage attaches to the ambient `$TMUX` server. */
  socketName?: string;
  /** Overrides the target session (`new-window -t <name>`) — for tests only; real usage defaults to the current session. */
  targetSession?: string;
}

/** Priority 4: tmux, detected via `$TMUX`. */
export function tmuxMux(options: TmuxMuxOptions = {}): Mux {
  const tmuxBin = options.tmuxBin ?? 'tmux';
  const socketArgs = options.socketName ? ['-L', options.socketName] : [];
  return {
    name: 'tmux',
    detect: () => Boolean(process.env.TMUX),
    async open({ title, command, cwd }) {
      const args = [...socketArgs, 'new-window'];
      if (options.targetSession) {
        args.push('-t', options.targetSession);
      }
      args.push('-n', sanitizeLabel(title));
      if (cwd) {
        args.push('-c', cwd);
      }
      args.push(...envForwardArgs('-e'));
      args.push(command);
      await execFileAsync(tmuxBin, args);
    },
  };
}

/** The message printed/returned by the fallback adapter, shared so `wtshunt ui` can show it without invoking `open`'s own console output. */
export function fallbackMessage({ title, command, cwd }: MuxOpenOptions): string {
  const cd = cwd ? `cd ${shQuote(cwd)} && ` : '';
  return `No multiplexer detected for "${title}" — run this in another terminal: ${cd}${command}`;
}

/** Priority 5: no multiplexer detected and no `[ui] open` template — print guidance instead of opening anything. */
export function fallbackMux(): Mux {
  return {
    name: 'fallback',
    detect: () => true,
    async open(options) {
      console.log(fallbackMessage(options));
    },
  };
}

/**
 * Picks the multiplexer adapter to use: an explicit `[ui] open` template
 * always wins, then herdr, then cmux, then tmux, then the plain-text
 * fallback.
 */
export function resolveMux(config: Config): Mux {
  if (config.ui?.open) {
    return templateMux(config.ui.open);
  }

  const herdr = herdrMux();
  if (herdr.detect()) {
    return herdr;
  }

  const cmux = cmuxMux();
  if (cmux.detect()) {
    return cmux;
  }

  const tmux = tmuxMux();
  if (tmux.detect()) {
    return tmux;
  }

  return fallbackMux();
}
