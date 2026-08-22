import { spawn } from 'node:child_process';
import { loadConfig } from '../config.ts';
import { allocatePort, findPortOccupant } from '../ports.ts';
import { applyPortRefs, parsePortRefs, resolvePortRef } from '../portRefs.ts';
import { cwdActiveMismatchWarning, resolveRepo, listWorktrees, findWorktree } from '../repo.ts';
import { ensureRepoState, readState, withState, type ServerEntry } from '../state.ts';

const EARLY_EXIT_THRESHOLD_MS = 2000;

export interface ServeArgs {
  repo?: string;
  /**
   * Binds the repo's `fixed_port` directly instead of allocating/reusing a
   * sticky worktree port: a one-off substitution of `fixed_port` for
   * `{port}`, for running this worktree unproxied, the way it'd look bound
   * on the fixed port in production. The sticky ports map (`state`'s
   * per-worktree assignments) is left completely untouched -- this never
   * allocates, records, or overwrites a sticky port. The server entry this
   * records still carries `fixed_port` as its `port`, so `portful
   * status`/`portful ui` show it exactly like any other running server.
   */
  direct?: boolean;
}

/** What either allocation path (sticky or `--direct`) hands off to the shared spawn logic below. */
type Allocation =
  | { alreadyRunning: true; entry: ServerEntry }
  | { alreadyRunning: false; port: number; resolvedRefs: Record<string, number> };

export async function serveCommand(args: ServeArgs): Promise<void> {
  const config = await loadConfig();
  const cwd = process.cwd();
  const { repoName, worktreeName } = await resolveRepo(config, args.repo, cwd);
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

  let allocation: Allocation;

  if (args.direct) {
    // Guard (a): the proxy already owns fixed_port -- starting here too
    // would fight it for the same port, so refuse outright with a clear
    // error rather than racing it.
    const proxy = state.repos[repoName]?.proxy;
    if (proxy) {
      throw new Error(
        `Proxy for "${repoName}" is running on port ${repoConfig.fixedPort} (pid ${proxy.pid}). ` +
          `Stop "portful proxy" first, then retry "portful serve ${repoName}/${targetName} --direct".`
      );
    }

    // Guard (b): same lsof-based occupant check "portful proxy" itself runs
    // before binding fixed_port.
    const occupant = await findPortOccupant(repoConfig.fixedPort);
    if (occupant) {
      console.error(
        `Port ${repoConfig.fixedPort} is already in use:\n${occupant}\n\n` +
          `Stop that process first, or check "portful status" to see what's using it.`
      );
      process.exitCode = 1;
      return;
    }

    allocation = await withState(async (s) => {
      const rs = ensureRepoState(s, repoName);
      const existing = rs.servers[targetName];
      if (existing) {
        return { alreadyRunning: true as const, entry: existing };
      }

      // {<repo>.port} references still resolve normally -- only this
      // server's own {port} placeholder is overridden below. The sticky
      // ports map (rs.ports) is deliberately never touched here.
      const resolvedRefs: Record<string, number> = {};
      for (const refRepoName of parsePortRefs(repoConfig.serve)) {
        resolvedRefs[refRepoName] = await resolvePortRef(config, s, refRepoName);
      }

      return { alreadyRunning: false as const, port: repoConfig.fixedPort, resolvedRefs };
    });
  } else {
    allocation = await withState(async (s) => {
      const rs = ensureRepoState(s, repoName);
      const existing = rs.servers[targetName];
      if (existing) {
        return { alreadyRunning: true as const, entry: existing };
      }

      const port = await allocatePort({ worktree: targetName, portRange: repoConfig.portRange, stickyPorts: rs.ports });
      rs.ports[targetName] = port;

      // {<repo>.port} references resolve inside this same transaction, so a
      // referenced repo's port allocation and this server's own land in one
      // atomic write together.
      const resolvedRefs: Record<string, number> = {};
      for (const refRepoName of parsePortRefs(repoConfig.serve)) {
        resolvedRefs[refRepoName] = await resolvePortRef(config, s, refRepoName);
      }

      return { alreadyRunning: false as const, port, resolvedRefs };
    });
  }

  if (allocation.alreadyRunning) {
    console.log(
      `Server already running for "${targetName}" on port ${allocation.entry.port} (pid ${allocation.entry.pid}). Refusing to start a duplicate.`
    );
    return;
  }

  const { port, resolvedRefs } = allocation;
  // {<repo>.port} references are substituted before the plain {port}
  // placeholder (see portRefs.ts for why the two can't collide).
  const serveCmd = applyPortRefs(repoConfig.serve, resolvedRefs).replaceAll('{port}', String(port));

  console.log(
    args.direct
      ? `Starting server for "${targetName}" directly on fixed port ${port} (--direct)...`
      : `Starting server for "${targetName}" on port ${port}...`
  );

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
