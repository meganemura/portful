import { loadConfig } from '../config.ts';
import { resolveWorktreeFromCwd } from '../repo.ts';
import { readState } from '../state.ts';

export interface WhoamiArgs {
  json?: boolean;
}

export interface WhoamiResult {
  repo: string;
  worktree: string;
  branch: string;
  path: string;
  /** The worktree's sticky port, if one has ever been assigned. */
  port?: number;
  /** The currently running server for this worktree, if any. */
  server?: { pid: number; port: number };
  /** Whether this worktree is the repo's current `active` pointer. */
  active: boolean;
  proxy: {
    running: boolean;
    /** Whether the (running) proxy currently routes to this worktree. */
    routedHere: boolean;
  };
}

/**
 * Resolves which repo/worktree the current directory is in, for embedding
 * in a shell prompt or for an agent to confirm its own footing. Read-only:
 * touches neither config nor state.
 */
export async function whoami(): Promise<WhoamiResult> {
  const config = await loadConfig();
  const { repoName, worktree } = await resolveWorktreeFromCwd(config, process.cwd());

  const state = await readState();
  const rs = state.repos[repoName];

  const port = rs?.ports[worktree.name];
  const serverEntry = rs?.servers[worktree.name];
  const active = rs?.active === worktree.name;
  const proxyRunning = Boolean(rs?.proxy);

  return {
    repo: repoName,
    worktree: worktree.name,
    branch: worktree.branch,
    path: worktree.path,
    ...(port !== undefined ? { port } : {}),
    ...(serverEntry ? { server: { pid: serverEntry.pid, port: serverEntry.port } } : {}),
    active,
    proxy: { running: proxyRunning, routedHere: proxyRunning && active },
  };
}

function formatLine(result: WhoamiResult): string {
  const portPart = result.port !== undefined ? ` port ${result.port}` : '';
  const statusWord = result.server ? 'running' : 'stopped';
  const activePart = result.active ? ', active' : '';
  return `${result.repo}/${result.worktree}${portPart} (${statusWord}${activePart})`;
}

export async function whoamiCommand(args: WhoamiArgs = {}): Promise<void> {
  const result = await whoami();

  if (args.json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(formatLine(result));
}
