import type { State } from './state.ts';

/** True if `worktreeName` is not among a repo's *actual* current worktree names. */
export function isWorktreeStale(actualNames: ReadonlySet<string>, worktreeName: string): boolean {
  return !actualNames.has(worktreeName);
}

export interface StaleRepoEntries {
  repo: string;
  /** Worktree names with a running server entry, but the worktree itself no longer exists. */
  staleServers: string[];
  /** Worktree names with a sticky port assignment, but the worktree itself no longer exists. */
  stalePorts: string[];
  /** The active worktree pointer, if it names a worktree that no longer exists. */
  staleActive?: string;
}

export interface StaleTaskMember {
  task: string;
  repo: string;
  worktree: string;
}

export interface StaleReport {
  repos: StaleRepoEntries[];
  taskMembers: StaleTaskMember[];
}

/**
 * Detects every reference in `state` to a worktree that no longer exists,
 * given each repo's *actual* current worktree names (typically from `git
 * worktree list`). One detector shared by `prune` (which acts on this),
 * `doctor` (report-only), and `status`/`ui`'s "(worktree gone)" marker —
 * see `isWorktreeStale` for the single-worktree check status/ui use
 * directly.
 */
export function detectStaleEntries(
  state: State,
  actualWorktreesByRepo: Record<string, ReadonlySet<string>>
): StaleReport {
  const repos: StaleRepoEntries[] = [];

  for (const [repoName, actualNames] of Object.entries(actualWorktreesByRepo)) {
    const rs = state.repos[repoName];
    if (!rs) {
      continue;
    }

    const staleServers = Object.keys(rs.servers).filter((wt) => isWorktreeStale(actualNames, wt));
    const stalePorts = Object.keys(rs.ports).filter((wt) => isWorktreeStale(actualNames, wt));
    const staleActive = rs.active !== undefined && isWorktreeStale(actualNames, rs.active) ? rs.active : undefined;

    if (staleServers.length > 0 || stalePorts.length > 0 || staleActive !== undefined) {
      repos.push({
        repo: repoName,
        staleServers,
        stalePorts,
        ...(staleActive !== undefined ? { staleActive } : {}),
      });
    }
  }

  const taskMembers: StaleTaskMember[] = [];
  for (const [taskName, task] of Object.entries(state.tasks)) {
    for (const [repoName, worktreeName] of Object.entries(task.members)) {
      const actualNames = actualWorktreesByRepo[repoName];
      if (actualNames && isWorktreeStale(actualNames, worktreeName)) {
        taskMembers.push({ task: taskName, repo: repoName, worktree: worktreeName });
      }
    }
  }

  return { repos, taskMembers };
}

/** True if `report` has nothing stale at all. */
export function isStaleReportEmpty(report: StaleReport): boolean {
  return report.repos.length === 0 && report.taskMembers.length === 0;
}

/**
 * Human-readable lines describing everything in `report`, phrased as
 * "would <verb>" — shared by `prune --dry-run` and `doctor`'s state
 * section, so the two never drift apart on wording.
 */
export function describeStaleReport(report: StaleReport): string[] {
  const lines: string[] = [];

  for (const r of report.repos) {
    for (const wt of r.staleServers) {
      lines.push(`${r.repo}/${wt}: stop the running server (worktree gone)`);
    }
    for (const wt of r.stalePorts) {
      lines.push(`${r.repo}/${wt}: remove the sticky port assignment (worktree gone)`);
    }
    if (r.staleActive !== undefined) {
      lines.push(`${r.repo}: clear the active pointer "${r.staleActive}" (worktree gone)`);
    }
  }

  for (const tm of report.taskMembers) {
    lines.push(`task "${tm.task}": remove member ${tm.repo}/${tm.worktree} (worktree gone)`);
  }

  return lines;
}
