import { spawn } from 'node:child_process';
import { loadConfig } from '../config.ts';
import { findWorktree, listWorktrees, looksLikeRepoArg, parseRepoArg, resolveRepoFromCwd } from '../repo.ts';
import { readState } from '../state.ts';

/**
 * `wtshunt run [target] <cmd...>` never goes through yargs option parsing
 * (see cli.ts), so `rawArgs` is the raw argv exactly as typed after `run`,
 * flags and all.
 */
export async function runCommand(rawArgs: string[]): Promise<void> {
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
    throw new Error('No command given. Usage: wtshunt run [repo[/worktree]] <cmd...>');
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
    throw new Error(`No active worktree for repo "${repoName}". Run "wtshunt use ${repoName}/<worktree>" first.`);
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
