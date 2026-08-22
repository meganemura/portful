import { loadConfig, type Config } from './config.ts';
import { readState, type State } from './state.ts';
import { listWorktrees } from './repo.ts';
import { isWorktreeStale } from './prune.ts';
import { computeStaleWiring, taskMatchesCurrentActive, type StaleWiringEntry } from './tasks.ts';

export interface OverviewWorktree {
  name: string;
  branch: string;
  path: string;
}

export interface OverviewServer {
  branch: string;
  port: number;
  pid: number;
  resolvedRefs?: Record<string, number>;
  /** `resolvedRefs` entries that no longer match what the referenced repo's active worktree currently resolves to. Omitted when there's none. */
  staleWiring?: StaleWiringEntry[];
  /** True if this server's worktree no longer exists (`git worktree list` doesn't report it). Omitted when it still does. */
  worktreeGone?: true;
}

export interface OverviewProxy {
  pid: number;
  port: number;
}

export interface OverviewRepo {
  name: string;
  path: string;
  fixedPort: number;
  /** True when the repo configures a cert/key pair, so the fixed-port listener terminates TLS and clients must use https. */
  tls: boolean;
  worktrees: OverviewWorktree[];
  active?: string;
  ports: Record<string, number>;
  servers: Record<string, OverviewServer>;
  proxy?: OverviewProxy;
}

export interface OverviewTask {
  name: string;
  members: Record<string, string>;
  matchesCurrentActive: boolean;
}

export interface Overview {
  repos: OverviewRepo[];
  tasks: OverviewTask[];
}

/**
 * Collects everything `portful status` (and `portful ui`) display: per-repo
 * worktrees, active pointer, sticky ports, running servers, and proxy state,
 * plus every defined task and whether it currently matches. Shared so both
 * the human-readable and `--json` status output, and the `ui` TUI's row
 * model, are built from the exact same data.
 */
export async function buildOverview(config?: Config, state?: State): Promise<Overview> {
  const cfg = config ?? (await loadConfig());
  const st = state ?? (await readState());

  const repos: OverviewRepo[] = await Promise.all(
    Object.entries(cfg.repos).map(async ([name, repoConfig]) => {
      let worktrees: OverviewWorktree[] = [];
      try {
        worktrees = (await listWorktrees(repoConfig.path)).map((wt) => ({
          name: wt.name,
          branch: wt.branch,
          path: wt.path,
        }));
      } catch {
        // Repo path may not exist (or not be a git repo) right now; report
        // an empty worktree list rather than failing the whole overview.
      }

      const rs = st.repos[name];
      const actualWorktreeNames = new Set(worktrees.map((wt) => wt.name));
      const servers: Record<string, OverviewServer> = {};
      for (const [wtName, entry] of Object.entries(rs?.servers ?? {})) {
        const staleWiring = computeStaleWiring(st, entry.resolvedRefs);
        servers[wtName] = {
          branch: entry.branch,
          port: entry.port,
          pid: entry.pid,
          ...(entry.resolvedRefs ? { resolvedRefs: entry.resolvedRefs } : {}),
          ...(staleWiring.length > 0 ? { staleWiring } : {}),
          ...(isWorktreeStale(actualWorktreeNames, wtName) ? { worktreeGone: true as const } : {}),
        };
      }

      const repo: OverviewRepo = {
        name,
        path: repoConfig.path,
        fixedPort: repoConfig.fixedPort,
        tls: repoConfig.https?.cert !== undefined,
        worktrees,
        ports: rs?.ports ?? {},
        servers,
      };
      if (rs?.active !== undefined) {
        repo.active = rs.active;
      }
      if (rs?.proxy) {
        repo.proxy = { pid: rs.proxy.pid, port: rs.proxy.port };
      }
      return repo;
    })
  );

  const tasks: OverviewTask[] = Object.entries(st.tasks).map(([name, task]) => ({
    name,
    members: task.members,
    matchesCurrentActive: taskMatchesCurrentActive(st, task),
  }));

  return { repos, tasks };
}
