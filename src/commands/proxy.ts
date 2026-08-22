import { loadConfig } from '../config.ts';
import { findPortOccupant } from '../ports.ts';
import { resolveRepo } from '../repo.ts';
import { ensureRepoState, removeProxyEntrySync, withState } from '../state.ts';
import { startProxy } from '../proxy.ts';

export interface ProxyArgs {
  repo?: string;
}

export async function proxyCommand(args: ProxyArgs): Promise<void> {
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
