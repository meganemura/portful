import type { Overview } from '../overview.ts';

export interface RepoRow {
  kind: 'repo';
  repo: string;
  fixedPort: number;
  proxyRunning: boolean;
  proxyPid?: number;
  /** The worktree the proxy currently forwards to (`repo.active`). Omitted when none is set. */
  activeWorktree?: string;
}

export interface WorktreeRow {
  kind: 'worktree';
  repo: string;
  worktree: string;
  branch: string;
  port?: number;
  pid?: number;
  active: boolean;
  /** True for a server entry whose worktree no longer exists — synthesized (see buildRows), not from `repo.worktrees`. */
  worktreeGone?: true;
}

export interface TaskRow {
  kind: 'task';
  task: string;
  members: Record<string, string>;
  matches: boolean;
}

export type UiRow = RepoRow | WorktreeRow | TaskRow;

/**
 * Builds the flat, selectable row list `wtshunt ui` navigates: one header
 * row per repo followed by its worktree rows, then every task row at the
 * bottom. Pure function of an `Overview` snapshot, so it's independently
 * testable without a terminal.
 */
export function buildRows(overview: Overview): UiRow[] {
  const rows: UiRow[] = [];

  for (const repo of overview.repos) {
    rows.push({
      kind: 'repo',
      repo: repo.name,
      fixedPort: repo.fixedPort,
      proxyRunning: Boolean(repo.proxy),
      ...(repo.proxy ? { proxyPid: repo.proxy.pid } : {}),
      ...(repo.active !== undefined ? { activeWorktree: repo.active } : {}),
    });

    for (const wt of repo.worktrees) {
      const server = repo.servers[wt.name];
      rows.push({
        kind: 'worktree',
        repo: repo.name,
        worktree: wt.name,
        branch: wt.branch,
        ...(repo.ports[wt.name] !== undefined ? { port: repo.ports[wt.name] } : {}),
        ...(server ? { pid: server.pid } : {}),
        active: repo.active === wt.name,
      });
    }

    // A server entry whose worktree no longer exists has no row from the
    // loop above (repo.worktrees only lists what git currently reports) —
    // synthesize one so it's still visible and actionable (e.g. `x` to
    // stop it), same as `wtshunt prune` would clean up.
    const knownWorktreeNames = new Set(repo.worktrees.map((wt) => wt.name));
    for (const [wtName, server] of Object.entries(repo.servers)) {
      if (knownWorktreeNames.has(wtName)) {
        continue;
      }
      rows.push({
        kind: 'worktree',
        repo: repo.name,
        worktree: wtName,
        branch: server.branch,
        ...(repo.ports[wtName] !== undefined ? { port: repo.ports[wtName] } : {}),
        pid: server.pid,
        active: repo.active === wtName,
        worktreeGone: true,
      });
    }
  }

  for (const task of overview.tasks) {
    rows.push({ kind: 'task', task: task.name, members: task.members, matches: task.matchesCurrentActive });
  }

  return rows;
}

/** Clamped up/down movement through `rows`, used for `j`/`k`/arrow-key navigation. */
export function moveSelection(rows: UiRow[], current: number, delta: number): number {
  if (rows.length === 0) {
    return 0;
  }
  const next = current + delta;
  if (next < 0) {
    return 0;
  }
  if (next > rows.length - 1) {
    return rows.length - 1;
  }
  return next;
}

function findRepo(overview: Overview, repoName: string) {
  return overview.repos.find((r) => r.name === repoName);
}

export function serverPid(overview: Overview, repo: string, worktree: string): number | undefined {
  return findRepo(overview, repo)?.servers[worktree]?.pid;
}

export function worktreePath(overview: Overview, repo: string, worktree: string): string | undefined {
  return findRepo(overview, repo)?.worktrees.find((w) => w.name === worktree)?.path;
}

export function repoPath(overview: Overview, repo: string): string | undefined {
  return findRepo(overview, repo)?.path;
}

export function proxyPid(overview: Overview, repo: string): number | undefined {
  return findRepo(overview, repo)?.proxy?.pid;
}

/**
 * How long `wtshunt ui` waits, after starting a server/proxy, for a later
 * overview refresh to observe it actually running before giving up on the
 * `◐` "starting up" indicator and falling back to the ordinary `●`/`○` one
 * (see `prunePending`).
 */
export const PENDING_TIMEOUT_MS = 15000;

/**
 * How long `wtshunt ui` waits, after *stopping* a server/proxy, for a later
 * overview refresh to observe it actually gone before giving up on the `◐`
 * "stopping" indicator and falling back to the ordinary `●`/`○` one (see
 * `prunePending`). Much shorter than `PENDING_TIMEOUT_MS`: `stopServer`'s
 * own exit-poll (see `commands/stop.ts`) already caps at ~2s, and a stop
 * that times out leaves the server alive with a warning already on the
 * message line -- there's nothing more for `◐` to usefully wait for, so it
 * reverts to `●` promptly instead of lingering for the full start-side
 * timeout.
 */
export const PENDING_STOP_TIMEOUT_MS = 5000;

/** Which direction a pending-indicator entry is waiting on: a start (see `PENDING_TIMEOUT_MS`) or a stop (see `PENDING_STOP_TIMEOUT_MS`). */
export type PendingKind = 'start' | 'stop';

/** One `wtshunt ui` pending-indicator bookkeeping entry: which direction it's waiting on, and when the wait began (`Date.now()`-shaped). */
export interface PendingEntry {
  kind: PendingKind;
  since: number;
}

/**
 * Canonical key `wtshunt ui`'s in-process pending-indicator bookkeeping
 * (and `renderLines`'s `pendingKeys` set) uses to identify a row: the bare
 * repo name for a repo/proxy row, or `repo/worktree` for a worktree/server
 * row. The two never collide -- a worktree name never contains `/` (it's a
 * `basename()` of a filesystem path) -- so a single string namespace is
 * enough for both row kinds.
 */
export function pendingKey(repo: string, worktree?: string): string {
  return worktree === undefined ? repo : `${repo}/${worktree}`;
}

/** True once `overview` shows the row named by a `pendingKey()`-shaped `key` actually running. */
function isObservedRunning(overview: Overview, key: string): boolean {
  const slash = key.indexOf('/');
  if (slash === -1) {
    return proxyPid(overview, key) !== undefined;
  }
  return serverPid(overview, key.slice(0, slash), key.slice(slash + 1)) !== undefined;
}

/**
 * Prunes a "row key -> {kind, since}" pending map -- `wtshunt ui`'s own
 * bookkeeping for the `◐` indicator -- against a fresh `overview` snapshot
 * and the current time. A `start` entry drops out once its row is observed
 * running (the ◐ has done its job; the row's real pid/proxy state now
 * renders `●` on its own) or once `PENDING_TIMEOUT_MS` has elapsed with no
 * observed start (falls back to `○` -- a start failure is visible in the
 * pane itself, so `wtshunt ui` just stops waiting rather than guessing
 * why). A `stop` entry drops out the moment its row is observed *not*
 * running anymore (falls back to `○`) or once `PENDING_STOP_TIMEOUT_MS` has
 * elapsed with the row still observed running (falls back to `●` -- same
 * "stop stops waiting, doesn't guess why" reasoning, just mirrored). Pure
 * function of its inputs, so the transition logic is unit-testable without
 * a real timer, process, or terminal.
 */
export function prunePending(
  pending: ReadonlyMap<string, PendingEntry>,
  overview: Overview,
  now: number
): Map<string, PendingEntry> {
  const next = new Map<string, PendingEntry>();
  for (const [key, entry] of pending) {
    const running = isObservedRunning(overview, key);
    if (entry.kind === 'start') {
      if (running || now - entry.since >= PENDING_TIMEOUT_MS) {
        continue;
      }
    } else {
      if (!running || now - entry.since >= PENDING_STOP_TIMEOUT_MS) {
        continue;
      }
    }
    next.set(key, entry);
  }
  return next;
}
