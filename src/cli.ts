import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

function notImplemented(name: string): () => Promise<void> {
  return async () => {
    console.error(`"${name}" is not implemented yet.`);
    process.exitCode = 1;
  };
}

function reportError(err: unknown): void {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

function handle(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
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
  .parserConfiguration({ 'unknown-options-as-args': true })
  .command('use [repo]', 'Select the active worktree for a repo', repoPositional, handle(notImplemented('use')))
  .command(
    'serve [repo]',
    'Start a server for the active (or given) worktree in the foreground',
    repoPositional,
    handle(notImplemented('serve'))
  )
  .command(
    'run [target] [cmd..]',
    'Run a command inside a worktree (flags are passed through untouched)',
    (y) => y,
    handle(notImplemented('run'))
  )
  .command('status', 'Show active worktrees, running servers, and proxy state', () => {}, handle(notImplemented('status')))
  .command('stop [repo]', 'Stop the server for the active (or given) worktree', repoPositional, handle(notImplemented('stop')))
  .command(
    'proxy [repo]',
    'Start the reverse proxy for a repo in the foreground',
    repoPositional,
    handle(notImplemented('proxy'))
  )
  .completion('completion', 'Generate a shell completion script', async () => [])
  .demandCommand(1)
  .strict(false)
  .fail((msg, err) => {
    reportError(err ?? new Error(msg));
  })
  .help()
  .parse();
