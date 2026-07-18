import { access, constants } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { delimiter, join } from 'node:path';
import { loadConfig } from '../config.ts';
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

  const chosen = (await isPecoAvailable())
    ? await selectWithPeco(worktrees, ports)
    : await selectByNumber(worktrees, ports);

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

async function setActiveAndReport(repoName: string, worktree: WorktreeInfo): Promise<void> {
  const result = await withState((state) => {
    const rs = ensureRepoState(state, repoName);
    rs.active = worktree.name;
    return { hasServer: Boolean(rs.servers[worktree.name]), proxyActive: Boolean(rs.proxy) };
  });

  console.log(`Active worktree for "${repoName}" set to "${worktree.name}".`);

  if (!result.hasServer) {
    console.warn(
      `Warning: no server running for "${worktree.name}". Start one with \`wtshunt serve ${repoName}\`.`
    );
  }
  if (result.proxyActive) {
    console.log(`proxy now routes to ${worktree.name}`);
  }
}

async function isPecoAvailable(): Promise<boolean> {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    try {
      await access(join(dir, 'peco'), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function pecoLines(worktrees: WorktreeInfo[], ports: Record<string, number>): string[] {
  return worktrees.map((wt) => `${wt.name}\t${wt.branch}\t${ports[wt.name] ?? '-'}`);
}

function runPeco(lines: string[]): Promise<string | undefined> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('peco', [], { stdio: ['pipe', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || !output.trim()) {
        resolvePromise(undefined);
        return;
      }
      resolvePromise(output.trim());
    });
    child.stdin.write(lines.join('\n') + '\n');
    child.stdin.end();
  });
}

async function selectWithPeco(
  worktrees: WorktreeInfo[],
  ports: Record<string, number>
): Promise<WorktreeInfo | undefined> {
  const selectedLine = await runPeco(pecoLines(worktrees, ports));
  if (!selectedLine) {
    return undefined;
  }
  const name = selectedLine.split('\t')[0];
  return findWorktree(worktrees, name);
}

async function selectByNumber(
  worktrees: WorktreeInfo[],
  ports: Record<string, number>
): Promise<WorktreeInfo | undefined> {
  worktrees.forEach((wt, i) => {
    console.log(`${i + 1}) ${wt.name}\t${wt.branch}\t${ports[wt.name] ?? '-'}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question('Select worktree: ');
  } finally {
    rl.close();
  }

  const index = Number.parseInt(answer, 10) - 1;
  if (Number.isNaN(index) || index < 0 || index >= worktrees.length) {
    return undefined;
  }
  return worktrees[index];
}
