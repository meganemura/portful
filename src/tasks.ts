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
    if (!entry?.resolvedRefs) {
      continue;
    }
    for (const [refRepo, recordedPort] of Object.entries(entry.resolvedRefs)) {
      const currentPort = currentActivePort(state, refRepo);
      if (currentPort !== recordedPort) {
        mismatches.push({ repo, worktree: active, refRepo, recordedPort, currentPort });
      }
    }
  }

  return mismatches;
}

/** True if every member repo's active worktree currently matches this task's. */
export function taskMatchesCurrentActive(state: State, task: TaskDefinition): boolean {
  return Object.entries(task.members).every(([repo, worktree]) => state.repos[repo]?.active === worktree);
}
