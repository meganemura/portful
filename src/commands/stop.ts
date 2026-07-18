import { loadConfig } from '../config.ts';
import { resolveRepo } from '../repo.ts';
import { ensureRepoState, withState } from '../state.ts';

export interface StopArgs {
  repo?: string;
}

export async function stopCommand(args: StopArgs): Promise<void> {
  const config = await loadConfig();
  const { repoName, worktreeName } = await resolveRepo(config, args.repo, process.cwd());

  const result = await withState((state) => {
    const rs = ensureRepoState(state, repoName);
    const targetName = worktreeName ?? rs.active;
    if (!targetName) {
      return { status: 'no-target' as const };
    }
    const entry = rs.servers[targetName];
    if (!entry) {
      return { status: 'not-running' as const, worktree: targetName };
    }
    delete rs.servers[targetName];
    return { status: 'stopped' as const, worktree: targetName, entry };
  });

  if (result.status === 'no-target') {
    throw new Error(`No active worktree for repo "${repoName}".`);
  }
  if (result.status === 'not-running') {
    console.log(`No server running for "${result.worktree}".`);
    return;
  }

  try {
    process.kill(-result.entry.pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      try {
        process.kill(result.entry.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }

  console.log(`Stopped server for "${result.worktree}" (pid ${result.entry.pid}).`);
}
