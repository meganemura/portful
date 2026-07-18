import { spawn } from 'node:child_process';
import { loadConfig } from '../config.ts';
import { allocatePort, findPortOccupant } from '../ports.ts';
import { applyPortRefs, parsePortRefs, resolvePortRef } from '../portRefs.ts';
import { resolveRepo, listWorktrees, findWorktree } from '../repo.ts';
import { ensureRepoState, readState, withState } from '../state.ts';

const EARLY_EXIT_THRESHOLD_MS = 2000;

export interface ServeArgs {
  repo?: string;
}

export async function serveCommand(args: ServeArgs): Promise<void> {
  const config = await loadConfig();
  const cwd = process.cwd();
  const { repoName, worktreeName } = await resolveRepo(config, args.repo, cwd);
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

  const allocation = await withState(async (s) => {
    const rs = ensureRepoState(s, repoName);
    const existing = rs.servers[targetName];
    if (existing) {
      return { alreadyRunning: true as const, entry: existing };
    }

    const port = await allocatePort({ worktree: targetName, portRange: repoConfig.portRange, stickyPorts: rs.ports });
    rs.ports[targetName] = port;

    // {port:<repo>} references resolve inside this same transaction, so a
    // referenced repo's port allocation and this server's own land in one
    // atomic write together.
    const resolvedRefs: Record<string, number> = {};
    for (const refRepoName of parsePortRefs(repoConfig.serve)) {
      resolvedRefs[refRepoName] = await resolvePortRef(config, s, refRepoName);
    }

    return { alreadyRunning: false as const, port, resolvedRefs };
  });

  if (allocation.alreadyRunning) {
    console.log(
      `Server already running for "${targetName}" on port ${allocation.entry.port} (pid ${allocation.entry.pid}). Refusing to start a duplicate.`
    );
    return;
  }

  const { port, resolvedRefs } = allocation;
  // {port:<repo>} references are substituted before the plain {port}
  // placeholder (see portRefs.ts for why the two can't collide).
  const serveCmd = applyPortRefs(repoConfig.serve, resolvedRefs).replaceAll('{port}', String(port));

  console.log(`Starting server for "${targetName}" on port ${port}...`);

  const child = spawn('sh', ['-c', serveCmd], {
    cwd: worktree.path,
    stdio: 'inherit',
    detached: true,
  });

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('Failed to spawn server process.');
  }

  await withState((s) => {
    const rs = ensureRepoState(s, repoName);
    rs.servers[targetName] = {
      path: worktree.path,
      branch: worktree.branch,
      port,
      pid,
      ...(Object.keys(resolvedRefs).length > 0 ? { resolvedRefs } : {}),
    };
  });

  const startedAt = Date.now();

  const forwardSignal = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // Process group may already be gone.
    }
  };
  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  child.on('exit', (code, signal) => {
    void (async () => {
      if (Date.now() - startedAt < EARLY_EXIT_THRESHOLD_MS) {
        // Distinguish "something else is squatting the assigned port" (the
        // sticky/allocated port can be stolen between allocation and the
        // child's own bind) from the more common missing-.env/node_modules
        // crash, rather than always guessing the latter.
        const occupant = await findPortOccupant(port);
        if (occupant) {
          console.error(`Hint: port ${port} is held by another process:\n${occupant}`);
        } else {
          console.error(
            'Hint: the server exited very quickly. Check whether .env or node_modules ' +
              'have been copied into this worktree.'
          );
        }
      }

      await withState((s) => {
        const rs = ensureRepoState(s, repoName);
        delete rs.servers[targetName];
      });

      process.exit(code ?? (signal ? 1 : 0));
    })();
  });
}
