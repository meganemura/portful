import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Config, RepoConfig } from './config.ts';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
  name: string;
}

export function parseWorktreePorcelain(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  let current: { path?: string; branch?: string } = {};

  const flush = () => {
    if (current.path) {
      worktrees.push({
        path: current.path,
        branch: current.branch ?? '(detached)',
        name: basename(current.path),
      });
    }
    current = {};
  };

  for (const line of output.split('\n')) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      current.branch = '(detached)';
    }
  }
  flush();

  return worktrees;
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
  });
  return parseWorktreePorcelain(stdout);
}

export function findWorktree(worktrees: WorktreeInfo[], name: string): WorktreeInfo | undefined {
  return worktrees.find((wt) => wt.name === name);
}

export interface ParsedRepoArg {
  repo: string;
  worktreeName?: string;
}

export function parseRepoArg(arg: string): ParsedRepoArg {
  const idx = arg.indexOf('/');
  if (idx === -1) {
    return { repo: arg };
  }
  return { repo: arg.slice(0, idx), worktreeName: arg.slice(idx + 1) };
}

/** True if `arg` names a registered repo, or is a `repo/worktree` pattern for one. */
export function looksLikeRepoArg(config: Config, arg: string): boolean {
  if (config.repos[arg]) {
    return true;
  }
  const { repo } = parseRepoArg(arg);
  return Boolean(config.repos[repo]);
}

function withTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : path + sep;
}

function isUnderOrEqual(child: string, parent: string): boolean {
  return child === parent || child.startsWith(withTrailingSep(parent));
}

/**
 * Determines which registered repo the current directory belongs to.
 * Symlinks in `cwd` and in every candidate path are resolved before
 * comparison, since a worktree checkout is often reached through a symlink.
 */
export async function resolveRepoFromCwd(config: Config, cwd: string): Promise<string> {
  const realCwd = await realpath(cwd);

  for (const [name, repoConfig] of Object.entries(config.repos)) {
    let realRepoPath: string;
    try {
      realRepoPath = await realpath(repoConfig.path);
    } catch {
      continue;
    }
    if (isUnderOrEqual(realCwd, realRepoPath)) {
      return name;
    }

    let worktrees: WorktreeInfo[];
    try {
      worktrees = await listWorktrees(repoConfig.path);
    } catch {
      continue;
    }

    for (const wt of worktrees) {
      let realWtPath: string;
      try {
        realWtPath = await realpath(wt.path);
      } catch {
        continue;
      }
      if (isUnderOrEqual(realCwd, realWtPath)) {
        return name;
      }
    }
  }

  const names = Object.keys(config.repos);
  throw new Error(
    `Could not determine repo from current directory (${cwd}).\n` +
      `Registered repos: ${names.length > 0 ? names.join(', ') : '(none)'}`
  );
}

export interface CwdWorktreeMatch {
  repoName: string;
  worktree: WorktreeInfo;
}

/**
 * Determines which repo *and* which of its worktrees `cwd` is nested
 * under (worktree-granular sibling of `resolveRepoFromCwd`). `git
 * worktree list` always reports the main checkout as one of its own
 * entries, so listing each repo's worktrees alone is enough — no need to
 * check `repoConfig.path` separately.
 */
export async function resolveWorktreeFromCwd(config: Config, cwd: string): Promise<CwdWorktreeMatch> {
  const realCwd = await realpath(cwd);

  for (const [name, repoConfig] of Object.entries(config.repos)) {
    let worktrees: WorktreeInfo[];
    try {
      worktrees = await listWorktrees(repoConfig.path);
    } catch {
      continue;
    }

    for (const wt of worktrees) {
      let realWtPath: string;
      try {
        realWtPath = await realpath(wt.path);
      } catch {
        continue;
      }
      if (isUnderOrEqual(realCwd, realWtPath)) {
        return { repoName: name, worktree: wt };
      }
    }
  }

  const names = Object.keys(config.repos);
  throw new Error(
    `Could not determine repo from current directory (${cwd}).\n` +
      `Registered repos: ${names.length > 0 ? names.join(', ') : '(none)'}`
  );
}

/**
 * Builds a one-line warning for `run`/`serve` when the target worktree was
 * decided by the repo's `active` pointer (repo omitted or given bare, with
 * no explicit `/worktree`) but `cwd` actually sits in a *different*
 * worktree of that same repo — the classic "I cd'ed into task-b but
 * active is still task-a" trap. Returns `undefined` when there's nothing
 * to warn about: cwd isn't in any registered worktree, is in a different
 * repo entirely, or already matches the active worktree.
 */
export async function cwdActiveMismatchWarning(
  config: Config,
  cwd: string,
  repoName: string,
  activeWorktreeName: string
): Promise<string | undefined> {
  let match: CwdWorktreeMatch;
  try {
    match = await resolveWorktreeFromCwd(config, cwd);
  } catch {
    return undefined;
  }

  if (match.repoName !== repoName || match.worktree.name === activeWorktreeName) {
    return undefined;
  }

  return (
    `Note: cwd is in ${repoName}/${match.worktree.name}, but this runs in the active worktree ` +
    `${repoName}/${activeWorktreeName}.`
  );
}

export interface ResolvedRepo {
  repoName: string;
  worktreeName?: string;
}

/** Resolves the target repo from an explicit `<repo>`/`<repo>/<worktree>` arg, or from cwd. */
export async function resolveRepo(config: Config, arg: string | undefined, cwd: string): Promise<ResolvedRepo> {
  if (arg !== undefined) {
    if (!looksLikeRepoArg(config, arg)) {
      const names = Object.keys(config.repos);
      throw new Error(`Unknown repo "${arg}". Registered repos: ${names.length > 0 ? names.join(', ') : '(none)'}`);
    }
    const { repo, worktreeName } = parseRepoArg(arg);
    return { repoName: repo, worktreeName };
  }
  return { repoName: await resolveRepoFromCwd(config, cwd) };
}

export interface ResolvedTarget {
  repoName: string;
  repoConfig: RepoConfig;
  worktrees: WorktreeInfo[];
  worktree: WorktreeInfo;
}

/**
 * Resolves a full target worktree for a command, falling back to the
 * repo's `active` worktree from state when no `repo/worktree` arg is given.
 */
export async function resolveTargetWorktree(
  config: Config,
  arg: string | undefined,
  cwd: string,
  activeWorktreeName: string | undefined
): Promise<ResolvedTarget> {
  const { repoName, worktreeName } = await resolveRepo(config, arg, cwd);
  const repoConfig = config.repos[repoName];
  const worktrees = await listWorktrees(repoConfig.path);

  const targetName = worktreeName ?? activeWorktreeName;
  if (!targetName) {
    throw new Error(`No active worktree for repo "${repoName}". Run "wtshunt use ${repoName}/<worktree>" first.`);
  }

  const worktree = findWorktree(worktrees, targetName);
  if (!worktree) {
    const names = worktrees.map((wt) => wt.name);
    throw new Error(
      `Worktree "${targetName}" not found in repo "${repoName}". Available: ${names.join(', ') || '(none)'}`
    );
  }

  return { repoName, repoConfig, worktrees, worktree };
}
