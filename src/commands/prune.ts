import { loadConfig, type Config } from '../config.ts';
import { listWorktrees } from '../repo.ts';
import { ensureRepoState, readState, withState } from '../state.ts';
import { describeStaleReport, detectStaleEntries, isStaleReportEmpty } from '../prune.ts';
import { stopServer } from './stop.ts';

export interface PruneArgs {
  repo?: string;
  dryRun?: boolean;
}

function unknownRepoError(config: Config, repo: string): Error {
  const names = Object.keys(config.repos);
  return new Error(`Unknown repo "${repo}". Registered repos: ${names.length > 0 ? names.join(', ') : '(none)'}`);
}

/** Each target repo's *actual* current worktree names, from `git worktree list` (empty set if the repo's path can't be listed right now). */
async function buildActualWorktrees(config: Config, repoNames: string[]): Promise<Record<string, Set<string>>> {
  const result: Record<string, Set<string>> = {};
  await Promise.all(
    repoNames.map(async (repoName) => {
      const repoConfig = config.repos[repoName];
      let names: string[] = [];
      try {
        names = (await listWorktrees(repoConfig.path)).map((wt) => wt.name);
      } catch {
        // Repo path unavailable right now; treat as "no worktrees currently
        // visible" rather than failing prune entirely.
      }
      result[repoName] = new Set(names);
    })
  );
  return result;
}

export async function pruneCommand(args: PruneArgs = {}): Promise<void> {
  const config = await loadConfig();

  let repoNames: string[];
  if (args.repo !== undefined) {
    if (!config.repos[args.repo]) {
      throw unknownRepoError(config, args.repo);
    }
    repoNames = [args.repo];
  } else {
    repoNames = Object.keys(config.repos);
  }

  const actualWorktreesByRepo = await buildActualWorktrees(config, repoNames);
  const state = await readState();
  const report = detectStaleEntries(state, actualWorktreesByRepo);

  if (isStaleReportEmpty(report)) {
    console.log('Nothing to prune.');
    return;
  }

  if (args.dryRun) {
    console.log('Would prune:');
    for (const line of describeStaleReport(report)) {
      console.log(`  ${line}`);
    }
    return;
  }

  console.log('Pruning:');

  for (const r of report.repos) {
    for (const wt of r.staleServers) {
      const result = await stopServer(r.repo, wt);
      if (result.status === 'stopped') {
        console.log(`  ${r.repo}/${wt}: stopped server (pid ${result.pid}), worktree gone`);
      } else if (result.status === 'timeout') {
        console.error(
          `  ${r.repo}/${wt}: sent SIGTERM but pid ${result.pid} is still running; left in place. ` +
            `Check "wtshunt status" and stop it manually.`
        );
      }
      // 'no-server': the entry vanished between detection and now (e.g. it
      // exited on its own since) — nothing left to report.
    }
  }

  const changes = await withState((s) => {
    const madeChanges: string[] = [];

    for (const r of report.repos) {
      const rs = ensureRepoState(s, r.repo);
      for (const wt of r.stalePorts) {
        if (rs.ports[wt] !== undefined) {
          delete rs.ports[wt];
          madeChanges.push(`${r.repo}/${wt}: removed sticky port assignment, worktree gone`);
        }
      }
      if (r.staleActive !== undefined && rs.active === r.staleActive) {
        delete rs.active;
        madeChanges.push(`${r.repo}: cleared active pointer "${r.staleActive}", worktree gone`);
      }
    }

    for (const tm of report.taskMembers) {
      const task = s.tasks[tm.task];
      if (!task || task.members[tm.repo] !== tm.worktree) {
        continue;
      }
      delete task.members[tm.repo];
      madeChanges.push(`task "${tm.task}": removed member ${tm.repo}/${tm.worktree}, worktree gone`);
      if (Object.keys(task.members).length === 0) {
        delete s.tasks[tm.task];
        madeChanges.push(`task "${tm.task}": removed entirely, no members left`);
      }
    }

    return madeChanges;
  });

  for (const line of changes) {
    console.log(`  ${line}`);
  }
}
