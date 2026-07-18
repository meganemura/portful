import { loadConfig } from '../config.ts';
import { resolveRepo } from '../repo.ts';
import { ensureRepoState, isAlive, withState } from '../state.ts';

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

export async function stopCommand(args: StopArgs): Promise<void> {
  const config = await loadConfig();
  const { repoName, worktreeName } = await resolveRepo(config, args.repo, process.cwd());

  const lookup = await withState((state) => {
    const rs = ensureRepoState(state, repoName);
    const targetName = worktreeName ?? rs.active;
    if (!targetName) {
      return { status: 'no-target' as const };
    }
    const entry = rs.servers[targetName];
    if (!entry) {
      return { status: 'not-running' as const, worktree: targetName };
    }
    return { status: 'found' as const, worktree: targetName, entry };
  });

  if (lookup.status === 'no-target') {
    throw new Error(`No active worktree for repo "${repoName}".`);
  }
  if (lookup.status === 'not-running') {
    console.log(`No server running for "${lookup.worktree}".`);
    return;
  }

  const { worktree: targetName, entry } = lookup;

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
    console.error(
      `Sent SIGTERM but pid ${entry.pid} is still running (it may be shutting down slowly or trapping ` +
        `SIGTERM). It remains visible in "wtshunt status"; check again shortly or kill it manually.`
    );
    process.exitCode = 1;
    return;
  }

  await withState((state) => {
    const rs = ensureRepoState(state, repoName);
    // Idempotent: the server's own foreground process may have already
    // removed this entry itself (or a new server may have since taken the
    // same worktree name), so only remove it if it's still the one we sent
    // SIGTERM to.
    if (rs.servers[targetName]?.pid === entry.pid) {
      delete rs.servers[targetName];
    }
  });

  console.log(`Stopped server for "${targetName}" (pid ${entry.pid}).`);
}
