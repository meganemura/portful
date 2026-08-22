/**
 * The reserved command names, and the rule that decides whether a first word
 * is one of them. Kept out of cli.ts because cli.ts runs the CLI at import
 * time, so anything that wants to read these (a test, another command) would
 * otherwise execute a whole invocation to get at them.
 */

export const COMMAND_NAMES = [
  'use',
  'serve',
  'run',
  'exec',
  'status',
  'list',
  'stop',
  'proxy',
  'task',
  'ui',
  'whoami',
  'prune',
  'doctor',
  'migrate',
  'help',
  'completion',
];

/**
 * portless keeps `portless <name> <cmd...>` usable next to its own verbs by
 * reserving those verb names. This tool takes the same shape: a first word
 * that is not one of COMMAND_NAMES, followed by at least one more word,
 * starts a server for that repo running that command.
 *
 * A first word starting with `-` stays with yargs, which owns `--help`,
 * `--version`, and the `--get-yargs-completions` probe. A second word
 * starting with `-` stays with yargs too, so a mistyped verb reaches yargs'
 * own "unknown command" error rather than being read as a repo name.
 */
export function explicitCommandForm(rawArgs: string[]): { repo: string; command: string[] } | undefined {
  const [first, ...rest] = rawArgs;
  if (first === undefined || first.startsWith('-') || COMMAND_NAMES.includes(first)) {
    return undefined;
  }
  if (rest.length === 0 || rest[0].startsWith('-')) {
    return undefined;
  }
  return { repo: first, command: rest };
}
