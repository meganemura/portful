import type { State, TaskDefinition } from './state.ts';

export interface WiringMismatch {
  /** The repo whose running server has stale wiring. */
  repo: string;
  worktree: string;
  /** The repo it was wired to via `{refRepo.port}` at serve time. */
  refRepo: string;
  recordedPort: number;
  /** What refRepo's active worktree is *currently* wired to, if anything. */
  currentPort: number | undefined;
}

/** The sticky port for `repoName`'s currently active worktree, if it has one. */
export function currentActivePort(state: State, repoName: string): number | undefined {
  const rs = state.repos[repoName];
  const active = rs?.active;
  if (active === undefined) {
    return undefined;
  }
  return rs?.ports[active];
}

export interface StaleWiringEntry {
  /** The referenced repo (what `{repo.port}` pointed to). */
  repo: string;
  recordedPort: number;
  /** What that repo's active worktree is *currently* wired to, if anything. */
  currentPort: number | undefined;
}

/**
 * Per-server-entry version of the wiring-staleness check: given one
 * server's recorded `resolvedRefs` (any server, not just a repo's active
 * one), reports every reference whose recorded port no longer matches
 * what the referenced repo's active worktree currently resolves to.
 * `detectWiringMismatches` and `status --json`'s per-server `staleWiring`
 * both build on this.
 */
export function computeStaleWiring(
  state: State,
  resolvedRefs: Record<string, number> | undefined
): StaleWiringEntry[] {
  if (!resolvedRefs) {
    return [];
  }
  const stale: StaleWiringEntry[] = [];
  for (const [refRepo, recordedPort] of Object.entries(resolvedRefs)) {
    const currentPort = currentActivePort(state, refRepo);
    if (currentPort !== recordedPort) {
      stale.push({ repo: refRepo, recordedPort, currentPort });
    }
  }
  return stale;
}

/**
 * Finds running servers among `repoNames` whose recorded `{ref.port}`
 * resolutions no longer match what their referenced repo's active worktree
 * currently resolves to — i.e. something (typically `task use`) moved a
 * referenced repo's active worktree out from under an already-running
 * server that was wired to its old port.
 */
export function detectWiringMismatches(state: State, repoNames: string[]): WiringMismatch[] {
  const mismatches: WiringMismatch[] = [];

  for (const repo of repoNames) {
    const rs = state.repos[repo];
    const active = rs?.active;
    if (active === undefined) {
      continue;
    }
    const entry = rs?.servers[active];
    for (const stale of computeStaleWiring(state, entry?.resolvedRefs)) {
      mismatches.push({ repo, worktree: active, refRepo: stale.repo, recordedPort: stale.recordedPort, currentPort: stale.currentPort });
    }
  }

  return mismatches;
}

/** True if every member repo's active worktree currently matches this task's. */
export function taskMatchesCurrentActive(state: State, task: TaskDefinition): boolean {
  return Object.entries(task.members).every(([repo, worktree]) => state.repos[repo]?.active === worktree);
}
