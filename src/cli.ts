import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadConfig } from './config.ts';
import { listWorktrees } from './repo.ts';
import { readState } from './state.ts';
import { serveCommand } from './commands/serve.ts';
import { runCommand } from './commands/run.ts';
import { useCommand } from './commands/use.ts';
import { statusCommand } from './commands/status.ts';
import { stopCommand } from './commands/stop.ts';
import { proxyCommand } from './commands/proxy.ts';
import { taskAddCommand, taskListCommand, taskRmCommand, taskUseCommand } from './commands/task.ts';
import { uiCommand } from './commands/ui.ts';
import { whoamiCommand } from './commands/whoami.ts';

/**
 * Flat list of every repo name plus every `repo/worktree` name across all
 * configured repos (a repo whose worktrees can't be listed is skipped, not
 * fatal to the rest). Prefix-filtering this single flat list against
 * `current` is what lets an empty result fall through to the shell's normal
 * file/command completion — see the completion handler below.
 */
async function repoAndWorktreeNames(): Promise<string[]> {
  let config;
  try {
    config = await loadConfig();
  } catch {
    return [];
  }

  const perRepo = await Promise.all(
    Object.entries(config.repos).map(async ([repoName, repoConfig]) => {
      const names = [repoName];
      try {
        const worktrees = await listWorktrees(repoConfig.path);
        names.push(...worktrees.map((wt) => `${repoName}/${wt.name}`));
      } catch {
        // Skip: this repo's worktrees can't be listed right now.
      }
      return names;
    })
  );

  return perRepo.flat();
}

/** Task names currently defined in state, or [] if state can't be read. */
async function taskNamesForCompletion(): Promise<string[]> {
  try {
    const state = await readState();
    return Object.keys(state.tasks);
  } catch {
    return [];
  }
}

function reportError(err: unknown): void {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

const APP_NAME = 'wtshunt';

function isZshShell(): boolean {
  return (process.env.SHELL ?? '').includes('zsh');
}

/**
 * zsh script based on yargs' own template (node_modules/yargs/build/lib/completion-templates.js),
 * with two changes: a guard that initializes zsh's completion system
 * (compinit/compdef) if the user's shell startup files haven't already done
 * so — without it, sourcing this script fails with "command not found:
 * compdef" in any zshrc that never calls compinit — and a fix for a stray
 * quote in the upstream `zsh_eval_context` check.
 */
function zshCompletionScript(): string {
  return `#compdef ${APP_NAME}
###-begin-${APP_NAME}-completions-###
#
# yargs command completion script
#
# Installation: ${APP_NAME} completion >> ~/.zshrc
#    or ${APP_NAME} completion >> ~/.zprofile on OSX.
#
if ! typeset -f compdef >/dev/null 2>&1; then
  autoload -Uz compinit
  compinit
fi
_${APP_NAME}_yargs_completions()
{
  local reply
  local si=$IFS
  IFS=$'\\n' reply=($(COMP_CWORD="$((CURRENT-1))" COMP_LINE="$BUFFER" COMP_POINT="$CURSOR" ${APP_NAME} --get-yargs-completions "\${words[@]}"))
  IFS=$si
  if [[ \${#reply} -gt 0 ]]; then
    _describe 'values' reply
  else
    _default
  fi
}
if [[ "\${zsh_eval_context[-1]}" == "loadautofunc" ]]; then
  _${APP_NAME}_yargs_completions "$@"
else
  compdef _${APP_NAME}_yargs_completions ${APP_NAME}
fi
###-end-${APP_NAME}-completions-###
`;
}

/** bash script, ported as-is from yargs' own template: `complete -F` needs no init guard. */
function bashCompletionScript(): string {
  return `###-begin-${APP_NAME}-completions-###
#
# yargs command completion script
#
# Installation: ${APP_NAME} completion >> ~/.bashrc
#    or ${APP_NAME} completion >> ~/.bash_profile on OSX.
#
_${APP_NAME}_yargs_completions()
{
    local cur_word args type_list

    cur_word="\${COMP_WORDS[COMP_CWORD]}"
    args=("\${COMP_WORDS[@]}")

    # ask yargs to generate completions.
    # see https://stackoverflow.com/a/40944195/7080036 for the spaces-handling awk
    mapfile -t type_list < <(${APP_NAME} --get-yargs-completions "\${args[@]}")
    mapfile -t COMPREPLY < <(compgen -W "$( printf '%q ' "\${type_list[@]}" )" -- "\${cur_word}" |
        awk '/ / { print "\\""$0"\\"" } /^[^ ]+$/ { print $0 }')

    # if no match was found, fall back to filename completion
    if [ \${#COMPREPLY[@]} -eq 0 ]; then
      COMPREPLY=()
    fi

    return 0
}
complete -o bashdefault -o default -F _${APP_NAME}_yargs_completions ${APP_NAME}
###-end-${APP_NAME}-completions-###
`;
}

function generateCompletionScript(): string {
  return isZshShell() ? zshCompletionScript() : bashCompletionScript();
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

const COMMAND_NAMES = ['use', 'serve', 'run', 'status', 'stop', 'proxy', 'task', 'ui', 'whoami', 'help', 'completion'];

/** Commands whose first argument is a `repo` or `repo/worktree` name. */
const REPO_ARG_COMMANDS = new Set(['use', 'serve', 'stop', 'proxy', 'run']);

const TASK_SUBCOMMANDS = ['add', 'use', 'list', 'rm'];

// Extracted so `help` can build a second, independent yargs instance and
// re-parse `[command, '--help']` (or just `['--help']`) through it (see the
// `help` command below) without disturbing the instance driving the current
// invocation. `rawArgs` is threaded through explicitly (rather than each
// command reading `process.argv` directly) specifically so `run`'s handler
// — which reads raw argv rather than yargs' parsed result, see below — sees
// the same args this instance was built with, including when `help run`
// builds a second instance with a synthesized `['run', '--help']`.
function buildCli(rawArgs: string[] = hideBin(process.argv)): Argv {
  return yargs(rawArgs)
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
        // Uses `rawArgs` (this instance's own args), not `process.argv`
        // directly, so `wtshunt help run` — which builds a second instance
        // with `rawArgs = ['run', '--help']` — reaches the same '--help'
        // short-circuit a direct `wtshunt run --help` would.
        await runCommand(rawArgs.slice(1));
      })
    )
    .command(
      'status',
      'Show active worktrees, running servers, and proxy state',
      (y) =>
        y.option('json', {
          type: 'boolean',
          default: false,
          describe: 'Print machine-readable JSON instead of the human-readable summary',
        }),
      handle(async (argv) => {
        await statusCommand({ json: argv.json as boolean });
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
    .command(
      'task',
      'Manage named presets bundling one worktree per repo (task add/use/list/rm)',
      (y) =>
        y
          .command(
            'add <name> [members..]',
            'Create a task from repo/worktree pairs, prompting for any repo left out',
            (yy) =>
              yy
                .positional('name', { type: 'string', describe: 'task name' })
                .positional('members', {
                  type: 'string',
                  array: true,
                  describe: 'repo/worktree pairs to include explicitly',
                }),
            handle(async (argv) => {
              await taskAddCommand({
                name: argv.name as string,
                members: (argv.members as string[] | undefined) ?? [],
              });
            })
          )
          .command(
            'use <name>',
            "Switch every member repo's active worktree to this task's",
            (yy) => yy.positional('name', { type: 'string', describe: 'task name' }),
            handle(async (argv) => {
              await taskUseCommand({ name: argv.name as string });
            })
          )
          .command(
            'list',
            'List defined tasks',
            () => {},
            handle(async () => {
              await taskListCommand();
            })
          )
          .command(
            'rm <name>',
            'Remove a task',
            (yy) => yy.positional('name', { type: 'string', describe: 'task name' }),
            handle(async (argv) => {
              await taskRmCommand({ name: argv.name as string });
            })
          )
          .demandCommand(1, 'Specify a task subcommand: add, use, list, or rm.'),
      () => {}
    )
    .command(
      'ui',
      'Interactive terminal UI for switching worktrees and driving serve/proxy',
      () => {},
      handle(async () => {
        await uiCommand();
      })
    )
    .command(
      'whoami',
      'Show which repo/worktree the current directory is in',
      (y) =>
        y.option('json', {
          type: 'boolean',
          default: false,
          describe: 'Print machine-readable JSON instead of the one-line summary',
        }),
      handle(async (argv) => {
        await whoamiCommand({ json: argv.json as boolean });
      })
    )
    .command(
      'help [command]',
      'Show help, optionally for a specific command',
      (y) => y.positional('command', { type: 'string', describe: 'command to show help for' }),
      handle(async (argv) => {
        const target = argv.command as string | undefined;
        // A fresh instance rather than reusing the current one: yargs
        // instances carry parse state, and `--help` here should exit through
        // the exact same help/exit path a real `<command> --help` would.
        // Passed to buildCli() itself (not `.parse()`) so `run`'s handler,
        // which reads this instance's own `rawArgs`, sees it too.
        //
        // An unknown target is deliberately NOT given `--help`: yargs' own
        // --help flag takes priority over its "unknown command" validation
        // (confirmed: `wtshunt nosuchcmd --help` exits 0 with plain help,
        // same as a bare `--help`), which would silently turn "help
        // <unknown>" into a success instead of the same error a bare
        // `wtshunt <unknown>` produces.
        let args: string[];
        if (target === undefined) {
          args = ['--help'];
        } else if (COMMAND_NAMES.includes(target)) {
          args = [target, '--help'];
        } else {
          args = [target];
        }
        await buildCli(args).parse();
      })
    )
    .command(
      'completion',
      'Generate a shell completion script',
      () => {},
      handle(async () => {
        console.log(generateCompletionScript());
      })
    )
    // Registered under a hidden name (description: false keeps it out of
    // --help) rather than the default 'completion', so that name is free for
    // our own `completion` command above to print our own script instead of
    // yargs' built-in one. This only affects what command name shows the
    // script; the `--get-yargs-completions` flag our script actually invokes
    // is a separate, always-on mechanism unaffected by this rename.
    //
    // Every branch filters its candidates by `current` and, crucially,
    // returns an empty array on zero matches rather than falling back to a
    // broader list: our zsh script treats an empty reply as "fall through to
    // _default" (normal file/command completion), so an unmatched prefix
    // like `run rails<Tab>` or a second argument like `run b bin/<Tab>`
    // correctly gets ordinary shell completion instead of being stuck
    // offering worktree names that can never match.
    .completion('completion-script', false, async () => {
      const { positionals, current } = completionContext();
      const startsWithCurrent = (name: string) => name.startsWith(current);

      if (positionals.length === 0) {
        return COMMAND_NAMES.filter(startsWithCurrent);
      }

      const command = positionals[0];

      if (positionals.length === 1 && command === 'help') {
        return COMMAND_NAMES.filter((name) => name !== 'help').filter(startsWithCurrent);
      }

      if (positionals.length === 1 && REPO_ARG_COMMANDS.has(command)) {
        const names = await repoAndWorktreeNames();
        return names.filter(startsWithCurrent);
      }

      if (command === 'task') {
        if (positionals.length === 1) {
          return TASK_SUBCOMMANDS.filter(startsWithCurrent);
        }

        const subcommand = positionals[1];

        if (positionals.length === 2 && (subcommand === 'use' || subcommand === 'rm')) {
          const names = await taskNamesForCompletion();
          return names.filter(startsWithCurrent);
        }

        if (positionals.length >= 3 && subcommand === 'add') {
          // Position 2 is the new task's name (no fixed candidates); every
          // position from 3 onward is a repo/worktree member.
          const names = await repoAndWorktreeNames();
          return names.filter(startsWithCurrent);
        }

        return [];
      }

      // Second argument onward, for every command (e.g. `run b bin/<Tab>`).
      return [];
    })
    .demandCommand(1, 'Please specify a command.')
    .strictCommands()
    .fail((msg, err, yargsInstance) => {
      // During a completion request, yargs' internal re-parse of the typed
      // words routinely fails validation (e.g. `task u` while completing
      // `use`). The shell only captures stdout, so anything printed here
      // would splatter over the user's prompt on every <Tab>.
      if (isCompletionRequest) {
        return;
      }
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
    .help();
}

await buildCli().parse();
