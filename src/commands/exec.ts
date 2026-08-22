import { spawn } from 'node:child_process';
import { loadConfig } from '../config.ts';
import {
  cwdActiveMismatchWarning,
  findWorktree,
  listWorktrees,
  looksLikeRepoArg,
  parseRepoArg,
  resolveRepoFromCwd,
} from '../repo.ts';
import { readState } from '../state.ts';

const EXEC_USAGE =
  'Usage: portful exec [repo[/worktree]] <cmd...>\n' +
  'Run a command inside a worktree without changing directory. Flags on <cmd...> are passed through untouched.';

/**
 * `rawArgs` is the raw argv exactly as typed after `run`, flags and all
 * (see cli.ts: the `run` command disables yargs' own --help/--version so
 * nothing upstream intercepts a flag meant for the wrapped command; this
 * function reads `rawArgs` directly rather than any yargs-parsed argv).
 */
export async function execCommand(rawArgs: string[]): Promise<void> {
  if (rawArgs[0] === '-h' || rawArgs[0] === '--help') {
    console.log(EXEC_USAGE);
    return;
  }

  const config = await loadConfig();

  let target: string | undefined;
  let cmd: string[];

  if (rawArgs.length > 0 && looksLikeRepoArg(config, rawArgs[0])) {
    target = rawArgs[0];
    cmd = rawArgs.slice(1);
  } else {
    cmd = rawArgs;
  }

  if (cmd.length === 0) {
    throw new Error('No command given. Usage: portful exec [repo[/worktree]] <cmd...>');
  }

  const cwd = process.cwd();
  let repoName: string;
  let worktreeName: string | undefined;
  if (target !== undefined) {
    ({ repo: repoName, worktreeName } = parseRepoArg(target));
  } else {
    repoName = await resolveRepoFromCwd(config, cwd);
  }

  const repoConfig = config.repos[repoName];
  const worktrees = await listWorktrees(repoConfig.path);

  const state = await readState();
  const targetName = worktreeName ?? state.repos[repoName]?.active;
  if (!targetName) {
    throw new Error(`No active worktree for repo "${repoName}". Run "portful use ${repoName}/<worktree>" first.`);
  }

  // Only when the target came from the active pointer (repo omitted, or
  // given bare with no explicit /worktree) — an explicit repo/worktree
  // means the user picked this on purpose, so there's nothing to warn about.
  if (worktreeName === undefined) {
    const warning = await cwdActiveMismatchWarning(config, cwd, repoName, targetName);
    if (warning) {
      console.error(warning);
    }
  }

  const worktree = findWorktree(worktrees, targetName);
  if (!worktree) {
    throw new Error(`Worktree "${targetName}" not found in repo "${repoName}".`);
  }

  const exitCode = await new Promise<number>((resolvePromise) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: worktree.path, stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      resolvePromise(code ?? (signal ? 1 : 0));
    });
    child.on('error', (err) => {
      console.error(`Failed to run command: ${err.message}`);
      resolvePromise(1);
    });
  });

  process.exitCode = exitCode;
}
