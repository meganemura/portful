import type { Mux } from '../mux.ts';
import { fallbackMessage, wtshuntCommand } from '../mux.ts';
import type { Overview } from '../overview.ts';
import type { SetActiveResult } from '../commands/use.ts';
import type { TaskUseResult } from '../commands/task.ts';
import type { StopResult } from '../commands/stop.ts';
import { buildRows, pendingKey, proxyPid, repoPath, serverPid, worktreePath, type UiRow } from './model.ts';

export type Action =
  | { type: 'quit' }
  | { type: 'use-worktree'; repo: string; worktree: string }
  | { type: 'use-task'; task: string }
  | { type: 'serve'; repo: string; worktree: string }
  | { type: 'direct'; repo: string; worktree: string }
  | { type: 'stop'; repo: string; worktree: string }
  | { type: 'restart'; repo: string; worktree: string }
  | { type: 'toggle-proxy'; repo: string }
  | { type: 'none' };

/**
 * Maps a normalized key (`'u'`, `'return'`, `'s'`, `'d'`, `'x'`, `'r'`,
 * `'p'`, `'q'`, `'ctrl-c'`, ...) and the currently selected row to the
 * action it triggers, if any. Pure and independent of readline/terminal
 * state, so every key binding is unit-testable without a TTY. Navigation
 * (`j`/`k`/arrow keys) is handled by the caller via `moveSelection`
 * instead — it doesn't depend on the selected row.
 *
 * `u` and `return` (Enter) are deliberately different bindings, not
 * aliases of each other: `u` always sets the active worktree/applies a
 * task, the same "pick this" action regardless of what's currently
 * running. `return` instead toggles the selected row on/off — stop a
 * running server or start a stopped one (worktree row), toggle the proxy
 * (repo row, same as `p`), or apply a task (task row, same as `u`, since a
 * task row has no on/off state to toggle).
 */
export function keyToAction(row: UiRow | undefined, key: string): Action {
  if (key === 'q' || key === 'ctrl-c') {
    return { type: 'quit' };
  }
  if (!row) {
    return { type: 'none' };
  }

  if (key === 'u') {
    if (row.kind === 'worktree') {
      return { type: 'use-worktree', repo: row.repo, worktree: row.worktree };
    }
    if (row.kind === 'task') {
      return { type: 'use-task', task: row.task };
    }
    return { type: 'none' };
  }

  if (key === 'return') {
    if (row.kind === 'worktree') {
      return row.pid !== undefined
        ? { type: 'stop', repo: row.repo, worktree: row.worktree }
        : { type: 'serve', repo: row.repo, worktree: row.worktree };
    }
    if (row.kind === 'repo') {
      return { type: 'toggle-proxy', repo: row.repo };
    }
    return { type: 'use-task', task: row.task };
  }

  if (key === 's' && row.kind === 'worktree') {
    return { type: 'serve', repo: row.repo, worktree: row.worktree };
  }

  if (key === 'd' && row.kind === 'worktree') {
    return { type: 'direct', repo: row.repo, worktree: row.worktree };
  }

  if (key === 'x' && row.kind === 'worktree') {
    return { type: 'stop', repo: row.repo, worktree: row.worktree };
  }

  if (key === 'r' && row.kind === 'worktree') {
    return { type: 'restart', repo: row.repo, worktree: row.worktree };
  }

  if (key === 'p' && (row.kind === 'repo' || row.kind === 'worktree')) {
    return { type: 'toggle-proxy', repo: row.repo };
  }

  return { type: 'none' };
}

/** A key `keyToAction` recognizes as bound to *some* action, on the right row kind. */
export type ActionKey = 'u' | 'return' | 's' | 'd' | 'x' | 'r' | 'p';

function isActionKey(key: string): key is ActionKey {
  return key === 'u' || key === 'return' || key === 's' || key === 'd' || key === 'x' || key === 'r' || key === 'p';
}

/**
 * Row kinds each action key applies to — kept in lockstep with the `if`
 * conditions in `keyToAction` above. Exported so the row-kind help text in
 * `render.ts` (which lists keys per row kind for the ever-visible help
 * line) can be cross-checked against this table in tests, since the two
 * are maintained separately for the sake of display order/labels. `return`
 * is valid on every row kind now that it toggles per-kind rather than
 * being a plain alias of `u`.
 */
export const VALID_ROW_KINDS: Record<ActionKey, UiRow['kind'][]> = {
  u: ['worktree', 'task'],
  return: ['worktree', 'repo', 'task'],
  s: ['worktree'],
  d: ['worktree'],
  x: ['worktree'],
  r: ['worktree'],
  p: ['repo', 'worktree'],
};

const KEY_LABEL: Partial<Record<ActionKey, string>> = { return: 'Enter' };

/**
 * When `keyToAction` resolves to `none` because a *known* action key
 * doesn't apply to the selected row's kind (e.g. `s` on a task row, `x` on
 * a repo row), returns a short one-line explanation for the message line.
 * Doesn't name the row kind (that vocabulary — "repo row", "task row" —
 * isn't shown anywhere on screen, so it wouldn't mean anything to the
 * user); the per-row help line underneath already shows what *does* work.
 * Returns `''` for keys with no binding at all (e.g. `g`) or no selected
 * row — those stay silently ignored, same as before this existed.
 */
export function invalidKeyHint(row: UiRow | undefined, key: string): string {
  if (!row || !isActionKey(key) || VALID_ROW_KINDS[key].includes(row.kind)) {
    return '';
  }
  const keyLabel = KEY_LABEL[key] ?? key;
  return `Key "${keyLabel}" isn't available on this row.`;
}

/**
 * The `pendingKey` (see `ui/model.ts`) of the row `action` is about to
 * *stop*, if any -- the stop-side counterpart to `ActionDeps.onStart`
 * below, but called by `wtshunt ui`'s key handler itself, before
 * `executeAction` runs, rather than by `executeAction` after the fact.
 * Stopping (unlike starting) has no "did it actually do anything" guard to
 * wait for -- `x`/stop-side-Enter always sends the signal, and
 * `toggle-proxy` only takes the stop branch when `overview` already shows
 * the proxy running -- so the pending entry can be recorded straight from
 * the key press, using the same `overview` snapshot `keyToAction` resolved
 * the action against, with nothing left to fake in a test.
 *
 * - `stop`: the target worktree's key.
 * - `restart`: the target worktree's key too -- it stops before it starts,
 *   so the `◐` should read as pending from the first moment either way; if
 *   the start phase actually runs, `onStart` fires for the same key
 *   afterwards and overwrites the entry's `kind` from `'stop'` to
 *   `'start'`.
 * - `toggle-proxy`: the repo's key, but only when `overview` shows that
 *   repo's proxy already running (i.e. this invocation will stop it, not
 *   start it) -- the start side stays `onStart`'s job, as before.
 * - everything else (`use-worktree`, `use-task`, `serve`, `direct`,
 *   `none`, `quit`): `undefined`, nothing to stop.
 */
export function pendingStopEffect(action: Action, overview: Overview): string | undefined {
  switch (action.type) {
    case 'stop':
    case 'restart':
      return pendingKey(action.repo, action.worktree);
    case 'toggle-proxy':
      return proxyPid(overview, action.repo) !== undefined ? pendingKey(action.repo) : undefined;
    default:
      return undefined;
  }
}

/** Everything `executeAction` needs beyond the current `Overview` snapshot, injected so it's testable without touching real state/processes. */
export interface ActionDeps {
  setActiveWorktree(repo: string, worktree: string): Promise<SetActiveResult>;
  applyTask(name: string): Promise<TaskUseResult>;
  stopServer(repo: string, worktree: string): Promise<StopResult>;
  mux: Mux;
  /** Defaults to `process.kill`; injectable so tests never have to send a real signal. */
  kill?(pid: number, signal: NodeJS.Signals): void;
  /**
   * Called exactly when `executeAction` actually opens a fresh serve/direct
   * pane via a real multiplexer, or starts the proxy — never when a
   * duplicate-server/already-running guard refuses to, when `restart`'s
   * stop timed out and skipped its start phase, when `toggle-proxy` takes
   * the stop branch instead, or when the mux adapter is the `fallback`
   * (nothing was actually started on the user's behalf, just a command
   * printed for them to run by hand). `key` is `pendingKey`-shaped: the
   * bare repo for a proxy start, `repo/worktree` for a serve/direct start.
   * `wtshunt ui` (the only real caller) uses this to record the `◐`
   * "starting up" indicator's start time; optional so the rest of this
   * module's test suite, which doesn't care about that indicator, can omit
   * it. For `restart`, this fires for the same key `pendingStopEffect`
   * (below) already recorded as a *stop* pending entry -- `wtshunt ui`
   * overwrites it in place, flipping the entry's kind from `'stop'` to
   * `'start'` rather than leaving two competing entries.
   */
  onStart?(key: string): void;
}

function killPid(deps: ActionDeps, pid: number): void {
  const kill = deps.kill ?? process.kill;
  try {
    kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

/**
 * Index, in `buildRows(overview)`, of the row matching `predicate` — or
 * `undefined` if none does (e.g. it vanished from the overview between the
 * keypress and this call). Passed through to `Mux.open` as `order` so an
 * adapter that can control pane placement (herdr) can line panes up with
 * the list's top-to-bottom order regardless of what order rows are actually
 * opened in; adapters that can't just ignore it.
 */
function rowOrder(overview: Overview, predicate: (row: UiRow) => boolean): number | undefined {
  const index = buildRows(overview).findIndex(predicate);
  return index === -1 ? undefined : index;
}

async function openServe(overview: Overview, deps: ActionDeps, repo: string, worktree: string): Promise<string> {
  const cwd = worktreePath(overview, repo, worktree);
  const command = wtshuntCommand('serve', `${repo}/${worktree}`);
  const order = rowOrder(overview, (row) => row.kind === 'worktree' && row.repo === repo && row.worktree === worktree);
  const options = {
    title: `${repo}/${worktree}`,
    command,
    ...(cwd ? { cwd } : {}),
    ...(order !== undefined ? { order } : {}),
  };
  await deps.mux.open(options);
  if (deps.mux.name === 'fallback') {
    return fallbackMessage(options);
  }
  deps.onStart?.(pendingKey(repo, worktree));
  return `Opened serve for "${repo}/${worktree}" via ${deps.mux.name}.`;
}

/** `d`'s counterpart to `openServe`: same pane-opening mechanics, but runs `serve --direct` instead. */
async function openDirect(overview: Overview, deps: ActionDeps, repo: string, worktree: string): Promise<string> {
  const cwd = worktreePath(overview, repo, worktree);
  const command = wtshuntCommand('serve', `${repo}/${worktree}`, '--direct');
  const order = rowOrder(overview, (row) => row.kind === 'worktree' && row.repo === repo && row.worktree === worktree);
  const options = {
    title: `${repo}/${worktree} (direct)`,
    command,
    ...(cwd ? { cwd } : {}),
    ...(order !== undefined ? { order } : {}),
  };
  await deps.mux.open(options);
  if (deps.mux.name === 'fallback') {
    return fallbackMessage(options);
  }
  deps.onStart?.(pendingKey(repo, worktree));
  return `Opened direct serve for "${repo}/${worktree}" via ${deps.mux.name}.`;
}

/**
 * Returns the one-line "in progress" message to show in the message line
 * the instant a key is pressed, before its (possibly slow — `stop` and
 * `restart` poll for up to a couple seconds) action has resolved. Tone
 * matches `executeAction`'s completion messages below so the message line
 * reads as one continuous narration rather than a silent gap followed by
 * a jump cut. `none`/`quit` have nothing pending, so they return `''`.
 */
export function pendingMessage(action: Action): string {
  switch (action.type) {
    case 'none':
    case 'quit':
      return '';
    case 'use-worktree':
      return `Setting active worktree for "${action.repo}" to "${action.worktree}"…`;
    case 'use-task':
      return `Applying task "${action.task}"…`;
    case 'serve':
      return `Opening serve for "${action.repo}/${action.worktree}"…`;
    case 'direct':
      return `Opening direct serve for "${action.repo}/${action.worktree}"…`;
    case 'stop':
      return `Stopping "${action.repo}/${action.worktree}"…`;
    case 'restart':
      return `Restarting "${action.repo}/${action.worktree}"…`;
    case 'toggle-proxy':
      return `Toggling proxy for "${action.repo}"…`;
  }
}

/**
 * Performs the effect of `action` against the given `Overview` snapshot
 * and returns the one-line message to show in the message line. Executes
 * `use`/`stop`/`task use` in-process via the injected functions, but always
 * opens `serve`/`proxy` externally through `deps.mux` — `wtshunt ui` never
 * runs them itself, keeping them the same kind of foreground process a
 * plain `wtshunt serve`/`wtshunt proxy` invocation would be.
 */
export async function executeAction(action: Action, overview: Overview, deps: ActionDeps): Promise<string> {
  switch (action.type) {
    case 'none':
    case 'quit':
      return '';

    case 'use-worktree': {
      const result = await deps.setActiveWorktree(action.repo, action.worktree);
      const base = `Active worktree for "${action.repo}" set to "${action.worktree}".`;
      return result.hasServer ? base : `${base} No server running yet.`;
    }

    case 'use-task': {
      const result = await deps.applyTask(action.task);
      let message = `Task "${action.task}" applied.`;
      if (result.needsServe.length > 0) {
        message += ` Not running: ${result.needsServe.join(', ')}.`;
      }
      if (result.mismatches.length > 0) {
        message += ` Wiring mismatch: ${result.mismatches.map((m) => `${m.repo} (${m.refRepo})`).join(', ')}.`;
      }
      return message;
    }

    case 'serve': {
      const existingPid = serverPid(overview, action.repo, action.worktree);
      if (existingPid !== undefined) {
        return `Server already running for "${action.repo}/${action.worktree}" (pid ${existingPid}).`;
      }
      return openServe(overview, deps, action.repo, action.worktree);
    }

    case 'direct': {
      const existingPid = serverPid(overview, action.repo, action.worktree);
      if (existingPid !== undefined) {
        return `Server already running for "${action.repo}/${action.worktree}" (pid ${existingPid}).`;
      }
      return openDirect(overview, deps, action.repo, action.worktree);
    }

    case 'stop': {
      const result = await deps.stopServer(action.repo, action.worktree);
      if (result.status === 'no-server') {
        return `No server running for "${action.repo}/${action.worktree}".`;
      }
      if (result.status === 'timeout') {
        return `Sent SIGTERM but pid ${result.pid} is still running for "${action.repo}/${action.worktree}".`;
      }
      return `Stopped server for "${action.repo}/${action.worktree}" (pid ${result.pid}).`;
    }

    case 'restart': {
      const result = await deps.stopServer(action.repo, action.worktree);
      if (result.status === 'timeout') {
        return `Sent SIGTERM but pid ${result.pid} is still running for "${action.repo}/${action.worktree}"; not restarting.`;
      }
      const openMessage = await openServe(overview, deps, action.repo, action.worktree);
      const prefix = result.status === 'stopped' ? `Stopped pid ${result.pid}. ` : '';
      return `${prefix}${openMessage}`;
    }

    case 'toggle-proxy': {
      const pid = proxyPid(overview, action.repo);
      if (pid !== undefined) {
        killPid(deps, pid);
        return `Sent SIGTERM to proxy for "${action.repo}" (pid ${pid}).`;
      }
      const cwd = repoPath(overview, action.repo);
      const command = wtshuntCommand('proxy', action.repo);
      const order = rowOrder(overview, (row) => row.kind === 'repo' && row.repo === action.repo);
      const options = {
        title: `${action.repo}/proxy`,
        command,
        ...(cwd ? { cwd } : {}),
        ...(order !== undefined ? { order } : {}),
      };
      await deps.mux.open(options);
      if (deps.mux.name === 'fallback') {
        return fallbackMessage(options);
      }
      deps.onStart?.(pendingKey(action.repo));
      return `Opened proxy for "${action.repo}" via ${deps.mux.name}.`;
    }
  }
}
