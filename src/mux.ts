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
 * `tmux new-window`/`herdr pane split`/`herdr tab create` all spawn the new
 * pane's shell with the multiplexer server's own stored environment, not
 * this process's — so
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
  /** Overrides the binary invoked for every herdr subcommand this adapter runs (`pane list`, `pane split`, `pane rename`, `pane run`, `tab create`) — for tests only, so the real `herdr` is never exercised. */
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
 * `herdrMux` below — never thrown, since a `pane list` hiccup should only
 * skip the anchor-cleanup step that calls it, not stop pane creation
 * (`pane split`/`tab create`) from still doing its job.
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
 * Runs `herdr pane split --pane <anchorPaneId> --direction right --no-focus
 * [--cwd <cwd>] [--env K=V]...` and returns the new pane's id, taken from
 * `.result.pane.pane_id`. Confirmed by hands-on testing: the new pane is
 * created immediately right of `anchorPaneId` — never at an arbitrary
 * position, and never wherever the server's own focus happens to be — and
 * `--no-focus` keeps focus from moving to it. `--cwd`/`--env` apply to the
 * new pane's own shell, same as they would to a fresh terminal.
 *
 * Unlike every other herdr helper in this module, this one throws (either
 * `execFileAsync`'s own rejection on a nonzero exit, or an explicit `Error`
 * if an exit-0 response is missing `pane_id`) instead of returning
 * `undefined` on failure — see `herdrMux`'s doc comment for why: without a
 * pane, there's nowhere for `serve`/`proxy` to run, so the caller has
 * nothing useful to do but let `wtshunt ui` surface the error.
 */
async function herdrPaneSplit(herdrBin: string, anchorPaneId: string, cwd: string | undefined): Promise<string> {
  const args = ['pane', 'split', '--pane', anchorPaneId, '--direction', 'right', '--no-focus'];
  if (cwd) {
    args.push('--cwd', cwd);
  }
  args.push(...envForwardArgs('--env'));
  const { stdout } = await execFileAsync(herdrBin, args);
  const parsed = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
  const paneId = parsed.result?.pane?.pane_id;
  if (typeof paneId !== 'string') {
    throw new Error(`herdr pane split did not return a pane_id: ${stdout}`);
  }
  return paneId;
}

/**
 * Fallback for when there's no anchor pane to split from at all (see
 * `herdrMux`'s doc comment). Runs `herdr tab create --workspace <id>
 * --cwd <cwd> --env K=V... --no-focus` (`--workspace` only when
 * `HERDR_WORKSPACE_ID` is set) and returns the new tab's root pane id, taken
 * from `.result.root_pane.pane_id`. Same throw-on-failure behavior as
 * `herdrPaneSplit`, for the same reason.
 */
async function herdrTabCreate(herdrBin: string, cwd: string | undefined): Promise<string> {
  const args = ['tab', 'create'];
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (workspaceId !== undefined) {
    args.push('--workspace', workspaceId);
  }
  if (cwd) {
    args.push('--cwd', cwd);
  }
  args.push(...envForwardArgs('--env'));
  args.push('--no-focus');
  const { stdout } = await execFileAsync(herdrBin, args);
  const parsed = JSON.parse(stdout) as { result?: { root_pane?: { pane_id?: unknown } } };
  const paneId = parsed.result?.root_pane?.pane_id;
  if (typeof paneId !== 'string') {
    throw new Error(`herdr tab create did not return a pane_id: ${stdout}`);
  }
  return paneId;
}

/**
 * Runs `herdr pane rename <paneId> <label>`, labeling the pane. Failure
 * (nonzero exit, or any other rejection) is swallowed: a missing label is
 * cosmetic, not worth failing the whole `open()` call over when the pane
 * itself was already created successfully.
 */
async function herdrPaneRename(herdrBin: string, paneId: string, label: string): Promise<void> {
  try {
    await execFileAsync(herdrBin, ['pane', 'rename', paneId, label]);
  } catch {
    // Cosmetic only — the pane still exists and can still run its command.
  }
}

/**
 * Runs `herdr pane run <paneId> <command>`, which types `command` into the
 * pane's shell followed by Enter (confirmed by hands-on testing: exit 0 and
 * empty stdout on success). Confirmed safe to call immediately after
 * `herdrPaneSplit`/`herdrTabCreate` with no delay in between — the pty's own
 * type-ahead buffer holds the keystrokes even if the shell isn't fully
 * ready yet, so nothing has ever been observed to get lost. Throws on
 * failure (propagating `execFileAsync`'s rejection), same "nothing useful
 * to do but surface it" reasoning as `herdrPaneSplit` — a pane that exists
 * but never got its command is as useless to the caller as no pane at all.
 */
async function herdrPaneRun(herdrBin: string, paneId: string, command: string): Promise<void> {
  await execFileAsync(herdrBin, ['pane', 'run', paneId, command]);
}

/**
 * Priority 2: herdr, detected via `HERDR_ENV`/`HERDR_SOCKET_PATH`.
 *
 * herdr's own docs are explicit about which command family a process like
 * `wtshunt ui` should use here: "Use `herdr pane ...` commands for ordinary
 * terminals, servers, tests, shells, and low-level terminal input. For
 * example, use `pane split` and `pane run` for `cargo test`, not `agent
 * start`, unless that terminal is intentionally being treated as an agent
 * target." `serve`/`proxy` are exactly that kind of ordinary long-running
 * server process, not an agent — so this adapter opens panes with `pane
 * split` + `pane rename` + `pane run`, never `agent start`.
 *
 * That choice also removes a whole layer an earlier version of this
 * adapter needed: `agent start --split right` could only ever insert the
 * new pane immediately right of the tab's *current* pane, with no way to
 * name an arbitrary anchor, so lining panes up to match `wtshunt ui`'s own
 * list order (`MuxOpenOptions.order`) required `pane swap`-based
 * "bubbling" after the fact, plus a focus-restore walk to undo a side
 * effect of swapping. `pane split --pane <anchor>` takes the anchor
 * directly and (confirmed by hands-on testing) always inserts the new pane
 * immediately right of it, so list-order placement now falls out of
 * choosing the right anchor up front — no swapping, no focus ever moves,
 * nothing to restore.
 *
 * The anchor is chosen from `order` (this row's index in `wtshunt ui`'s
 * list) against `openedPanes`, a map of every order this adapter has
 * placed so far to the pane it landed in: the closest lower order's pane
 * if one exists, else `wtshunt ui`'s own pane (`HERDR_PANE_ID`). A row with
 * no `order` (e.g. a `toggle-proxy` open with no matching list row) is
 * anchored to the highest order seen so far, or also the ui pane if
 * nothing's been placed yet. Before choosing it, a single `pane list` call
 * drops any previously-tracked pane no longer reported as live (the user
 * closed it, etc.) so it can never be picked as an anchor again — if `pane
 * list` itself fails, only that cleanup is skipped; placement still
 * proceeds against whatever `openedPanes` already held.
 *
 * If there's no anchor at all — nothing tracked yet, and `HERDR_PANE_ID`
 * unset because this `wtshunt ui` wasn't itself started from a herdr pane
 * — there's nothing to split from, so this falls back to `herdrTabCreate`
 * instead, opening a fresh tab.
 *
 * Either way, a failure to create the pane (nonzero exit, or a response
 * missing the expected `pane_id`) is not swallowed: `herdrPaneSplit`/
 * `herdrTabCreate` throw, so `wtshunt ui` surfaces the error instead of
 * silently doing nothing. Without a pane there's nowhere for `serve`/
 * `proxy` to run — unlike, say, a failed `pane rename`, which only costs a
 * label and is swallowed instead (see `herdrPaneRename`).
 */
export function herdrMux(options: HerdrMuxOptions = {}): Mux {
  const herdrBin = options.herdrBin ?? 'herdr';
  const openedPanes = new Map<number, string>(); // order -> pane_id

  return {
    name: 'herdr',
    detect: () => Boolean(process.env.HERDR_ENV || process.env.HERDR_SOCKET_PATH),
    async open({ title, command, cwd, order }) {
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

      let anchorPaneId: string | undefined;
      let bestOrder = -Infinity;
      for (const [ord, paneId] of openedPanes) {
        const qualifies = order !== undefined ? ord < order : true;
        if (qualifies && ord > bestOrder) {
          bestOrder = ord;
          anchorPaneId = paneId;
        }
      }
      if (anchorPaneId === undefined) {
        anchorPaneId = process.env.HERDR_PANE_ID;
      }

      const newPaneId =
        anchorPaneId !== undefined
          ? await herdrPaneSplit(herdrBin, anchorPaneId, cwd)
          : await herdrTabCreate(herdrBin, cwd);

      await herdrPaneRename(herdrBin, newPaneId, sanitizeLabel(title));
      // `exec` replaces the pane's shell with the command, so the pane
      // closes when the server exits (confirmed by hands-on testing) instead
      // of dropping back to an idle shell that piles up across restarts.
      // This matches every other adapter, where the command *is* the pane's
      // root process.
      await herdrPaneRun(herdrBin, newPaneId, `exec ${command}`);

      if (order !== undefined) {
        openedPanes.set(order, newPaneId);
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
