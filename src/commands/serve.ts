import { spawn } from 'node:child_process';
import { loadConfig } from '../config.ts';
import { allocatePort, findPortOccupant } from '../ports.ts';
import { applyPortRefs, parsePortRefs, resolvePortRef } from '../portRefs.ts';
import { cwdActiveMismatchWarning, resolveRepo, resolveWorktreeFromCwd, listWorktrees, findWorktree } from '../repo.ts';
import { ensureRepoState, readState, withState, type ServerEntry } from '../state.ts';
import { resolveScriptCommand } from '../startCommand.ts';

const EARLY_EXIT_THRESHOLD_MS = 2000;

export interface ServeArgs {
  repo?: string;
  /**
   * Binds the repo's `fixedPort` directly instead of allocating/reusing a
   * sticky worktree port: a one-off substitution of `fixedPort` for
   * `{port}`, for running this worktree unproxied, the way it'd look bound
   * on the fixed port in production. The sticky ports map (`state`'s
   * per-worktree assignments) is left completely untouched -- this never
   * allocates, records, or overwrites a sticky port. The server entry this
   * records still carries `fixedPort` as its `port`, so `portful
   * status`/`portful ui` show it exactly like any other running server.
   */
  direct?: boolean;
  /**
   * An explicit command, from the `portful <repo> <cmd...>` form, replacing
   * the repo's `serve` template. portless starts an app this way, so a
   * developer coming from portless can start a worktree server without
   * writing a template first. The command is spawned directly rather than
   * through `sh -c`, so its arguments reach it exactly as typed, and it
   * reads its port from `PORT` rather than from a `{port}` substitution.
   */
  command?: string[];
  /**
   * Takes the worktree from the current directory rather than the repo's
   * active pointer. `run` and a bare invocation set this, because portless
   * starts the app in the directory you are standing in. `serve` leaves it
   * unset and keeps following the active pointer, which is the pointer this
   * tool exists to switch.
   */
  fromCwd?: boolean;
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

  let cwdWorktreeName: string | undefined;
  if (worktreeName === undefined && args.fromCwd) {
    try {
      const match = await resolveWorktreeFromCwd(config, cwd);
      if (match.repoName === repoName) {
        cwdWorktreeName = match.worktree.name;
      }
    } catch {
      // Standing outside every worktree is fine here; the active pointer
      // below still answers.
    }
  }

  const targetName = worktreeName ?? cwdWorktreeName ?? state.repos[repoName]?.active;
  if (!targetName) {
    throw new Error(
      `No active worktree for repo "${repoName}". Run "portful use ${repoName}/<worktree>" first, ` +
        `or run this from inside a worktree.`
    );
  }

  // Only when the target came from the active pointer (repo omitted, or
  // given bare with no explicit /worktree) — an explicit repo/worktree
  // means the user picked this on purpose, so there's nothing to warn about.
  if (worktreeName === undefined && cwdWorktreeName === undefined) {
    const warning = await cwdActiveMismatchWarning(config, cwd, repoName, targetName);
    if (warning) {
      console.error(warning);
    }
  }

  const worktree = findWorktree(worktrees, targetName);
  if (!worktree) {
    throw new Error(`Worktree "${targetName}" not found in repo "${repoName}".`);
  }

  // An explicit command replaces the template outright, so it also carries
  // no `{<repo>.port}` references to resolve.
  const template = args.command ? undefined : repoConfig.serve;

  // With neither an explicit command nor a template, fall back to the
  // project's own dev script, which is how portless starts an app with no
  // configuration at all.
  let command = args.command;
  if (command === undefined && template === undefined) {
    const resolution = await resolveScriptCommand(worktree.path, repoConfig.script);
    if (!resolution.found) {
      const listed =
        resolution.available.length > 0
          ? `Scripts defined there: ${resolution.available.join(', ')}.`
          : `No scripts are defined in that worktree's package.json.`;
      throw new Error(
        `Repo "${repoName}" has no "serve" template, and worktree "${targetName}" defines no ` +
          `"${resolution.script}" script. ${listed} Add a "serve" template to ` +
          `${repoConfig.path}/portful.json, name a different "script", or pass the command directly: ` +
          `portful ${repoName}/${targetName} <cmd...>`
      );
    }
    command = resolution.command;
  }

  const refTemplate = template ?? '';

  let allocation: Allocation;

  if (args.direct) {
    // Guard (a): the proxy already owns fixedPort -- starting here too
    // would fight it for the same port, so refuse outright with a clear
    // error rather than racing it.
    const proxy = state.repos[repoName]?.proxy;
    if (proxy) {
      throw new Error(
        `Proxy for "${repoName}" is running on port ${repoConfig.fixedPort} (pid ${proxy.pid}). ` +
          `Run "portful proxy stop ${repoName}" first, then retry "portful serve ${repoName}/${targetName} --direct".`
      );
    }

    // Guard (b): same lsof-based occupant check "portful proxy start" itself runs
    // before binding fixedPort.
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
      for (const refRepoName of parsePortRefs(refTemplate)) {
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
      for (const refRepoName of parsePortRefs(refTemplate)) {
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

  console.log(
    args.direct
      ? `Starting server for "${targetName}" directly on fixed port ${port} (--direct)...`
      : `Starting server for "${targetName}" on port ${port}...`
  );

  // PORT reaches the child on both paths. A template puts the port on the
  // command line, and a server that reads PORT instead needs no template at
  // all. PORTFUL_URL is the address clients keep using, which is the fixed
  // port rather than this worktree's own.
  const childEnv = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    PORTFUL_URL: `${repoConfig.https?.cert ? 'https' : 'http'}://127.0.0.1:${repoConfig.fixedPort}`,
  };

  const child = command
    ? spawn(command[0], command.slice(1), {
        cwd: worktree.path,
        stdio: 'inherit',
        detached: true,
        env: childEnv,
      })
    : spawn(
        'sh',
        [
          '-c',
          // {<repo>.port} references are substituted before the plain {port}
          // placeholder (see portRefs.ts for why the two can't collide).
          applyPortRefs(template!, resolvedRefs).replaceAll('{port}', String(port)),
        ],
        {
          cwd: worktree.path,
          stdio: 'inherit',
          detached: true,
          env: childEnv,
        }
      );

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
