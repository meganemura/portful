import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadConfig } from './config.ts';
import { listWorktrees } from './repo.ts';
import { serveCommand } from './commands/serve.ts';
import { runCommand } from './commands/run.ts';
import { useCommand } from './commands/use.ts';
import { statusCommand } from './commands/status.ts';
import { stopCommand } from './commands/stop.ts';
import { proxyCommand } from './commands/proxy.ts';

async function completeRepoOrWorktree(current: string): Promise<string[]> {
  let config;
  try {
    config = await loadConfig();
  } catch {
    return [];
  }

  if (current.includes('/')) {
    const [repoName] = current.split('/');
    const repoConfig = config.repos[repoName];
    if (!repoConfig) {
      return Object.keys(config.repos);
    }
    try {
      const worktrees = await listWorktrees(repoConfig.path);
      return worktrees.map((wt) => `${repoName}/${wt.name}`);
    } catch {
      return [];
    }
  }

  return Object.keys(config.repos);
}

function reportError(err: unknown): void {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

/**
 * Words already typed on the command line at completion time, excluding the
 * script name and the in-progress word being completed. Computed directly
 * from `process.argv` rather than the `argv` yargs hands to the completion
 * function: that `argv` comes from an internal re-parse whose positional
 * array shape depends on whether a command matched, which is unreliable to
 * introspect.
 */
function completionPositionals(): string[] {
  const args = hideBin(process.argv);
  const idx = args.indexOf('--get-yargs-completions');
  if (idx === -1) {
    return [];
  }
  const rest = args.slice(idx + 1); // [scriptName, ...typed words, currentWord]
  return rest.slice(1, -1);
}

// yargs internally re-parses the completion args to build the `argv` object
// handed to the custom completion function below, and that re-parse also
// invokes the matched command's handler as a side effect. Guard against it so
// that pressing <Tab> never actually runs `use`, `serve`, `stop`, etc.
const isCompletionRequest = process.argv.includes('--get-yargs-completions');

function handle<A>(fn: (argv: A) => Promise<void>): (argv: A) => Promise<void> {
  return async (argv: A) => {
    if (isCompletionRequest) {
      return;
    }
    try {
      await fn(argv);
    } catch (err) {
      reportError(err);
    }
  };
}

const repoPositional = (y: Argv) =>
  y.positional('repo', {
    type: 'string',
    describe: 'repo, or repo/worktree to target directly',
  });

// `run` bypasses yargs entirely: any flag on the passed-through command (e.g.
// `-h`, `--help`) would otherwise be intercepted by yargs' own option parser
// (`-h`/`--help` are registered globally) instead of reaching the child
// process. This check runs before yargs ever sees argv.
const bypassArgs = hideBin(process.argv);
if (bypassArgs[0] === 'run') {
  try {
    await runCommand(bypassArgs.slice(1));
  } catch (err) {
    reportError(err);
  }
  process.exit(process.exitCode ?? 0);
}

await yargs(hideBin(process.argv))
  .scriptName('wtshunt')
  .locale('en')
  .command(
    'use [repo]',
    'Select the active worktree for a repo',
    repoPositional,
    handle(async (argv) => {
      await useCommand({ repo: argv.repo as string | undefined });
    })
  )
  .command(
    'serve [repo]',
    'Start a server for the active (or given) worktree in the foreground',
    repoPositional,
    handle(async (argv) => {
      await serveCommand({ repo: argv.repo as string | undefined });
    })
  )
  .command(
    'run [target] [cmd..]',
    'Run a command inside a worktree (flags are passed through untouched)',
    (y) => y,
    // Unreachable in practice: the bypass above intercepts every real `run`
    // invocation before yargs parses anything. Kept only so `run` shows up
    // in --help and top-level completion, with a safety-net implementation.
    handle(async () => {
      await runCommand(hideBin(process.argv).slice(1));
    })
  )
  .command(
    'status',
    'Show active worktrees, running servers, and proxy state',
    () => {},
    handle(async () => {
      await statusCommand();
    })
  )
  .command(
    'stop [repo]',
    'Stop the server for the active (or given) worktree',
    repoPositional,
    handle(async (argv) => {
      await stopCommand({ repo: argv.repo as string | undefined });
    })
  )
  .command(
    'proxy [repo]',
    'Start the reverse proxy for a repo in the foreground',
    repoPositional,
    handle(async (argv) => {
      await proxyCommand({ repo: argv.repo as string | undefined });
    })
  )
  .completion('completion', 'Generate a shell completion script', async (current) => {
    const positionals = completionPositionals();
    if (positionals.length === 0) {
      return ['use', 'serve', 'run', 'status', 'stop', 'proxy'];
    }
    const command = positionals[0];
    if (command === 'use' || command === 'serve' || command === 'stop' || command === 'proxy' || command === 'run') {
      return completeRepoOrWorktree(current);
    }
    return [];
  })
  .demandCommand(1)
  .strict(false)
  .fail((msg, err) => {
    reportError(err ?? new Error(msg));
  })
  .help()
  .parse();
