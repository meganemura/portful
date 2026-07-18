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
 * Words already typed on the command line at completion time, plus the
 * in-progress word being completed. Computed directly from `process.argv`
 * rather than the `argv`/`current` yargs hands to the completion function:
 * that `argv` comes from an internal re-parse whose positional array shape
 * depends on whether a command matched, which is unreliable to introspect.
 *
 * `COMP_CWORD` (exported by both the zsh and bash completion scripts as a
 * 0-based index into the full word array, where index 0 is the script name)
 * is the authoritative way to find the in-progress word: zsh's completion
 * script does not pass a trailing empty element for it the way bash's does,
 * so assuming "last element = current word" silently breaks under zsh.
 */
function completionContext(): { positionals: string[]; current: string } {
  const args = hideBin(process.argv);
  const idx = args.indexOf('--get-yargs-completions');
  if (idx === -1) {
    return { positionals: [], current: '' };
  }
  const rest = args.slice(idx + 1); // rest[0] is the script name.

  const cword = Number.parseInt(process.env.COMP_CWORD ?? '', 10);
  if (Number.isInteger(cword) && cword >= 1) {
    return { positionals: rest.slice(1, cword), current: rest[cword] ?? '' };
  }

  // Fallback if COMP_CWORD is unavailable: assume the last word is the one
  // being completed (holds for bash-style invocations).
  return { positionals: rest.slice(1, -1), current: rest.length > 0 ? rest[rest.length - 1] : '' };
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
    // Disables this command's own --help/--version so a flag meant for the
    // wrapped command (e.g. `wtshunt run b rails s -h`) reaches it instead
    // of being swallowed by yargs. Other commands are unaffected.
    (y) => y.help(false).version(false),
    handle(async () => {
      // Read raw argv rather than yargs' parsed result: yargs-parser still
      // splits flags like `-p 3105` out of the positional array internally,
      // but since runCommand ignores that parse entirely, it doesn't matter.
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
  .completion('completion', 'Generate a shell completion script', async () => {
    const { positionals, current } = completionContext();
    if (positionals.length === 0) {
      return ['use', 'serve', 'run', 'status', 'stop', 'proxy'];
    }
    const command = positionals[0];
    if (command === 'use' || command === 'serve' || command === 'stop' || command === 'proxy' || command === 'run') {
      return completeRepoOrWorktree(current);
    }
    return [];
  })
  .demandCommand(1, 'Please specify a command.')
  .strictCommands()
  .fail((msg, err, yargsInstance) => {
    if (err) {
      // A real thrown Error (not a yargs parsing/validation failure). Every
      // command handler already catches and reports its own errors via
      // handle(), so this only fires for errors thrown outside that path
      // (e.g. during argument coercion).
      reportError(err);
      return;
    }
    // yargs' own validation failure (no command, unknown command, bad
    // option, ...). A custom .fail() handler replaces yargs' default
    // behavior entirely, including the help text it would otherwise print,
    // so show it back here rather than leaving the user with just `msg`.
    yargsInstance.showHelp();
    console.error(`\n${msg}`);
    process.exitCode = 1;
  })
  .help()
  .parse();
