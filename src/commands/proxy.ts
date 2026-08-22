import { loadConfig } from '../config.ts';
import { findPortOccupant } from '../ports.ts';
import { resolveRepo } from '../repo.ts';
import { ensureRepoState, readState, removeProxyEntrySync, withState } from '../state.ts';
import { startProxy } from '../proxy.ts';
import { waitForExit } from './stop.ts';

export interface ProxyStartArgs {
  repo?: string;
}

/**
 * Runs the proxy in the foreground, where portless's `proxy start` runs a
 * daemon. One terminal tab per proxy keeps the request log visible and makes
 * Ctrl-C the stop button, so `proxy stop` exists for the other tab rather
 * than for a background process this command left behind.
 */
export async function proxyStartCommand(args: ProxyStartArgs): Promise<void> {
  const config = await loadConfig();
  const { repoName } = await resolveRepo(config, args.repo, process.cwd());
  const repoConfig = config.repos[repoName];

  const occupant = await findPortOccupant(repoConfig.fixedPort);
  if (occupant) {
    console.error(
      `Port ${repoConfig.fixedPort} is already in use:\n${occupant}\n\n` +
        `Stop that process first, or check "portful status" to see if a portful proxy is already running.`
    );
    process.exitCode = 1;
    return;
  }

  let handle;
  try {
    handle = await startProxy({ repoName, repoConfig });
  } catch (err) {
    console.error(`Failed to start proxy on port ${repoConfig.fixedPort}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Proxy for "${repoName}" listening on 127.0.0.1:${handle.port} (pid ${process.pid}).`);

  await withState((state) => {
    const rs = ensureRepoState(state, repoName);
    rs.proxy = { pid: process.pid, port: handle.port };
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await handle.close();
    await withState((state) => {
      const rs = ensureRepoState(state, repoName);
      if (rs.proxy?.pid === process.pid) {
        delete rs.proxy;
      }
    });
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // Async cleanup isn't possible from a real 'exit' handler (e.g. an
  // uncaught exception bypassing the signal handlers above), so fall back to
  // a synchronous, best-effort removal of just this process's proxy entry.
  process.on('exit', () => {
    if (!shuttingDown) {
      removeProxyEntrySync(repoName, process.pid);
    }
  });
}

export interface ProxyStopArgs {
  repo?: string;
}

/**
 * Stops a proxy started in another terminal. The proxy removes its own state
 * entry when it exits, so this command only sends the signal and confirms the
 * process is gone, the same way `stop` does for a worktree server.
 */
export async function proxyStopCommand(args: ProxyStopArgs): Promise<void> {
  const config = await loadConfig();
  const { repoName } = await resolveRepo(config, args.repo, process.cwd());

  const state = await readState();
  const entry = state.repos[repoName]?.proxy;
  if (!entry) {
    console.log(`No proxy running for "${repoName}".`);
    return;
  }

  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw err;
    }
  }

  const exited = await waitForExit(entry.pid);

  if (!exited) {
    console.error(
      `Sent SIGTERM but pid ${entry.pid} is still running. It remains visible in "portful status"; ` +
        `check again shortly or kill it manually.`
    );
    process.exitCode = 1;
    return;
  }

  // Idempotent: the proxy's own shutdown handler normally removes this entry
  // first, so only clear it when the dead pid is still the recorded one.
  await withState((st) => {
    const rs = ensureRepoState(st, repoName);
    if (rs.proxy?.pid === entry.pid) {
      delete rs.proxy;
    }
  });

  console.log(`Stopped proxy for "${repoName}" (pid ${entry.pid}).`);
}
