import { loadConfig } from '../config.ts';
import { resolveRepo } from '../repo.ts';
import { ensureRepoState, isAlive, readState, withState } from '../state.ts';

export interface StopArgs {
  repo?: string;
}

const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Polls `pid` for up to `timeoutMs`, returning true as soon as it's no
 * longer alive, or false if it's still alive once the timeout elapses.
 * Extracted so the "server traps SIGTERM and lingers" path is unit-testable
 * without spawning a real trapping process for every test run.
 */
export async function waitForExit(pid: number, intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive(pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
}

export type StopResult =
  | { status: 'no-server' }
  | { status: 'stopped'; pid: number }
  | { status: 'timeout'; pid: number };

/**
 * The bare stop-and-confirm logic behind `stop`, for a known repo/worktree
 * pair with no console output or repo/cwd resolution — reused as-is by
 * `portful ui`'s "stop" and "restart" actions, which report the result in
 * their own message line instead.
 */
export async function stopServer(repoName: string, worktreeName: string): Promise<StopResult> {
  const lookup = await withState((state) => {
    const rs = ensureRepoState(state, repoName);
    const entry = rs.servers[worktreeName];
    return entry ? { found: true as const, entry } : { found: false as const };
  });

  if (!lookup.found) {
    return { status: 'no-server' };
  }

  const { entry } = lookup;

  try {
    process.kill(-entry.pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      try {
        process.kill(entry.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }

  const exited = await waitForExit(entry.pid);

  if (!exited) {
    return { status: 'timeout', pid: entry.pid };
  }

  await withState((state) => {
    const rs = ensureRepoState(state, repoName);
    // Idempotent: the server's own foreground process may have already
    // removed this entry itself (or a new server may have since taken the
    // same worktree name), so only remove it if it's still the one we sent
    // SIGTERM to.
    if (rs.servers[worktreeName]?.pid === entry.pid) {
      delete rs.servers[worktreeName];
    }
  });

  return { status: 'stopped', pid: entry.pid };
}

export async function stopCommand(args: StopArgs): Promise<void> {
  const config = await loadConfig();
  const { repoName, worktreeName } = await resolveRepo(config, args.repo, process.cwd());

  const state = await readState();
  const targetName = worktreeName ?? state.repos[repoName]?.active;
  if (!targetName) {
    throw new Error(`No active worktree for repo "${repoName}".`);
  }

  const result = await stopServer(repoName, targetName);

  if (result.status === 'no-server') {
    console.log(`No server running for "${targetName}".`);
    return;
  }

  if (result.status === 'timeout') {
    console.error(
      `Sent SIGTERM but pid ${result.pid} is still running (it may be shutting down slowly or trapping ` +
        `SIGTERM). It remains visible in "portful status"; check again shortly or kill it manually.`
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Stopped server for "${targetName}" (pid ${result.pid}).`);
}
