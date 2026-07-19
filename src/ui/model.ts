import type { Overview } from '../overview.ts';

export interface RepoRow {
  kind: 'repo';
  repo: string;
  fixedPort: number;
  proxyRunning: boolean;
  proxyPid?: number;
}

export interface WorktreeRow {
  kind: 'worktree';
  repo: string;
  worktree: string;
  branch: string;
  port?: number;
  pid?: number;
  active: boolean;
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
