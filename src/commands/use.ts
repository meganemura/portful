import { loadConfig } from '../config.ts';
import { pickOne } from '../picker.ts';
import { findWorktree, listWorktrees, parseRepoArg, resolveRepoFromCwd, type WorktreeInfo } from '../repo.ts';
import { ensureRepoState, readState, withState } from '../state.ts';

export interface UseArgs {
  repo?: string;
}

export async function useCommand(args: UseArgs): Promise<void> {
  const config = await loadConfig();

  if (args.repo !== undefined && args.repo.includes('/')) {
    const { repo, worktreeName } = parseRepoArg(args.repo);
    if (!config.repos[repo]) {
      throw unknownRepoError(config, repo);
    }
    const worktrees = await listWorktrees(config.repos[repo].path);
    const worktree = findWorktree(worktrees, worktreeName!);
    if (!worktree) {
      throw new Error(
        `Worktree "${worktreeName}" not found in repo "${repo}". Available: ${worktrees.map((w) => w.name).join(', ') || '(none)'}`
      );
    }
    await setActiveAndReport(repo, worktree);
    return;
  }

  let repoName: string;
  if (args.repo !== undefined) {
    if (!config.repos[args.repo]) {
      throw unknownRepoError(config, args.repo);
    }
    repoName = args.repo;
  } else {
    repoName = await resolveRepoFromCwd(config, process.cwd());
  }

  const repoConfig = config.repos[repoName];
  const worktrees = await listWorktrees(repoConfig.path);
  if (worktrees.length === 0) {
    throw new Error(`No worktrees found for repo "${repoName}".`);
  }

  const state = await readState();
  const ports = state.repos[repoName]?.ports ?? {};

  const chosenName = await pickOne(
    worktrees.map((wt) => ({ columns: [wt.name, wt.branch, String(ports[wt.name] ?? '-')] })),
    'Select worktree: '
  );
  const chosen = chosenName !== undefined ? findWorktree(worktrees, chosenName) : undefined;

  if (!chosen) {
    console.log('No worktree selected.');
    return;
  }

  await setActiveAndReport(repoName, chosen);
}

function unknownRepoError(config: { repos: Record<string, unknown> }, repo: string): Error {
  const names = Object.keys(config.repos);
  return new Error(`Unknown repo "${repo}". Registered repos: ${names.length > 0 ? names.join(', ') : '(none)'}`);
}

export interface SetActiveResult {
  hasServer: boolean;
  proxyActive: boolean;
}

/**
 * The bare state mutation behind `use`, with no console output — reused
 * as-is by `portful ui`'s "use worktree" action, which reports the result
 * in its own message line instead.
 */
export async function setActiveWorktree(repoName: string, worktreeName: string): Promise<SetActiveResult> {
  return withState((state) => {
    const rs = ensureRepoState(state, repoName);
    rs.active = worktreeName;
    return { hasServer: Boolean(rs.servers[worktreeName]), proxyActive: Boolean(rs.proxy) };
  });
}

async function setActiveAndReport(repoName: string, worktree: WorktreeInfo): Promise<void> {
  const result = await setActiveWorktree(repoName, worktree.name);

  console.log(`Active worktree for "${repoName}" set to "${worktree.name}".`);

  if (!result.hasServer) {
    console.warn(
      `Warning: no server running for "${worktree.name}". Start one with \`portful serve ${repoName}\`.`
    );
  }
  if (result.proxyActive) {
    console.log(`proxy now routes to ${worktree.name}`);
  }
}
