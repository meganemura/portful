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
  herdrBin?: string;
}

/**
 * Deep-searches `agent start`'s JSON stdout for the newly created pane's
 * `pane_id` — its exact location in the response shape isn't documented,
 * only confirmed present somewhere (by analogy with `herdr pane current`'s
 * `result.pane.pane_id`, seen via read-only inspection) — so this walks
 * every object/array looking for the first `pane_id` string field rather
 * than assuming a fixed path. Returns `undefined` if `stdout` isn't JSON or
 * no `pane_id` turns up anywhere.
 */
function findPaneId(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPaneId(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.pane_id === 'string') {
      return obj.pane_id;
    }
    for (const key of Object.keys(obj)) {
      const found = findPaneId(obj[key]);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/** Extracts a created pane's id from `agent start`'s stdout, or `undefined` if it can't be parsed as JSON / has no `pane_id` anywhere. */
function extractPaneId(stdout: string): string | undefined {
  try {
    return findPaneId(JSON.parse(stdout));
  } catch {
    return undefined;
  }
}

/**
 * True if `paneId` still refers to a live pane, checked via `herdr pane get
 * <id>` — confirmed (via read-only inspection) to exit non-zero when the
 * pane doesn't exist; also treated as gone if it somehow exits 0 with a
 * top-level `error` field in its JSON response, matching the
 * `{"error":{"code":"pane_not_found",...}}` shape seen from herdr when a
 * bogus pane id is used elsewhere. Used so a `lastPaneId` left over from a
 * pane the user has since closed doesn't get used as a split base.
 */
async function herdrPaneAlive(herdrBin: string, paneId: string): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin, ['pane', 'get', paneId]));
  } catch {
    return false;
  }
  try {
    const parsed = JSON.parse(stdout) as { error?: unknown };
    return !parsed.error;
  } catch {
    return true;
  }
}

/**
 * Priority 2: herdr, detected via `HERDR_ENV`/`HERDR_SOCKET_PATH`. Uses
 * `herdr agent start <name> --cwd <cwd> -- sh -c <command>`: the only herdr
 * subcommand found (via read-only `herdr --help`/`herdr agent --help`/
 * `herdr api schema --json` inspection) that creates a fresh labeled
 * pane *and* runs a command in it in a single call — `tab create` doesn't
 * return a pane id to run a follow-up `pane run` against, and `pane
 * run`/`pane split` both require an existing/reference pane id rather than
 * creating one outright.
 *
 * Each new pane is split off of whichever pane the *previous* `open()` call
 * created (tracked below as `lastPaneId`), not off of `wtshunt ui`'s own
 * pane every time — so opening rows top-to-bottom in `wtshunt ui` lands
 * panes left-to-right in the order they were opened, instead of always
 * wedging the newest one in immediately right of the ui pane. herdr's CLI
 * resolves "the pane to split from" as "the current pane", which it in turn
 * resolves from the `HERDR_PANE_ID` environment variable of the process
 * invoking it (confirmed via read-only inspection: passing a bogus id
 * through that env var yields `{"error":{"code":"pane_not_found",...}}`) —
 * so chaining onto a prior pane means overriding `HERDR_PANE_ID` in the
 * child's env rather than just letting it inherit this process's own.
 */
export function herdrMux(options: HerdrMuxOptions = {}): Mux {
  const herdrBin = options.herdrBin ?? 'herdr';
  let lastPaneId: string | undefined;

  return {
    name: 'herdr',
    detect: () => Boolean(process.env.HERDR_ENV || process.env.HERDR_SOCKET_PATH),
    async open({ title, command, cwd }) {
      // Prefer the previously-opened pane as the split base, but only if it
      // still exists; otherwise fall back to wtshunt ui's own pane. If
      // neither is available (e.g. `wtshunt ui` itself wasn't started with
      // `HERDR_PANE_ID` set), no base pane is specified at all — the exact
      // pre-existing behavior, with no `--split` flag and no env override.
      const basePaneId =
        lastPaneId !== undefined && (await herdrPaneAlive(herdrBin, lastPaneId)) ? lastPaneId : process.env.HERDR_PANE_ID;

      const args = ['agent', 'start', sanitizeLabel(title)];
      if (cwd) {
        args.push('--cwd', cwd);
      }
      args.push(...envForwardArgs('--env'));
      if (basePaneId !== undefined) {
        args.push('--split', 'right');
      }
      args.push('--', 'sh', '-c', command);

      const execOptions = basePaneId !== undefined ? { env: { ...process.env, HERDR_PANE_ID: basePaneId } } : {};
      const { stdout } = await execFileAsync(herdrBin, args, execOptions);

      // Reset to undefined on anything unparsable so a bad/foreign response
      // never gets chained onto by the next open() — that call instead
      // falls back to wtshunt ui's own pane, same as the very first open().
      lastPaneId = extractPaneId(stdout);
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
