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
 * Priority 2: herdr, detected via `HERDR_ENV`/`HERDR_SOCKET_PATH`. Uses
 * `herdr agent start <name> --cwd <cwd> -- sh -c <command>`: the only herdr
 * subcommand found (via read-only `herdr --help`/`herdr agent --help`/
 * `herdr api schema --json` inspection) that creates a fresh labeled
 * pane *and* runs a command in it in a single call — `tab create` doesn't
 * return a pane id to run a follow-up `pane run` against, and `pane
 * run`/`pane split` both require an existing/reference pane id rather than
 * creating one outright.
 */
export function herdrMux(options: HerdrMuxOptions = {}): Mux {
  const herdrBin = options.herdrBin ?? 'herdr';
  return {
    name: 'herdr',
    detect: () => Boolean(process.env.HERDR_ENV || process.env.HERDR_SOCKET_PATH),
    async open({ title, command, cwd }) {
      const args = ['agent', 'start', sanitizeLabel(title)];
      if (cwd) {
        args.push('--cwd', cwd);
      }
      args.push(...envForwardArgs('--env'));
      args.push('--', 'sh', '-c', command);
      await execFileAsync(herdrBin, args);
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
