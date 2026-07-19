import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withState } from '../src/state.ts';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'wtshunt.js');

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function makeRepoFixture(): Promise<{ base: string; configDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-completion-repo-'));
  const main = join(base, 'main');
  await mkdir(main, { recursive: true });
  await git(main, ['init', '-q', '-b', 'main']);
  await git(main, ['config', 'user.email', 'test@example.com']);
  await git(main, ['config', 'user.name', 'Test']);
  await writeFile(join(main, 'file.txt'), 'hello');
  await git(main, ['add', '.']);
  await git(main, ['commit', '-q', '-m', 'init']);
  await git(main, ['worktree', 'add', '-q', '-b', 'feature/auth', join(base, 'feature-auth')]);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-completion-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    ['[repos.b]', `path = "${main}"`, 'fixed_port = 3000', 'port_range = [3101, 3199]', 'serve = "echo {port}"', ''].join(
      '\n'
    )
  );

  return { base, configDir };
}

/** Runs `wtshunt --get-yargs-completions ...` and returns the suggested completions, one per line. */
async function getCompletions(
  configDir: string,
  args: string[],
  compCword?: number,
  stateDir?: string
): Promise<string[]> {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: configDir };
  if (compCword !== undefined) {
    env.COMP_CWORD = String(compCword);
  } else {
    delete env.COMP_CWORD;
  }
  if (stateDir !== undefined) {
    env.XDG_STATE_HOME = stateDir;
  }

  const { stdout } = await execFileAsync(
    process.execPath,
    [binPath, '--get-yargs-completions', 'wtshunt', ...args],
    { env }
  );
  return stdout.split('\n').filter((line) => line.length > 0);
}

/** Seeds state.json (under a fresh tmp XDG_STATE_HOME) with the given task names, returning that dir. */
async function makeStateDirWithTasks(taskNames: string[]): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-completion-state-'));
  const original = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateDir;
  try {
    await withState((state) => {
      for (const name of taskNames) {
        state.tasks[name] = { members: {} };
      }
    });
  } finally {
    if (original === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = original;
    }
  }
  return stateDir;
}

test('completion: zsh-style invocation (no trailing word) uses COMP_CWORD', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    // "wtshunt <Tab>": rest = [wtshunt] (zsh omits the not-yet-started, empty
    // current word), COMP_CWORD=1 points one past the end of rest.
    assert.deepEqual(await getCompletions(configDir, [], 1), [
      'use',
      'serve',
      'run',
      'status',
      'stop',
      'proxy',
      'task',
      'ui',
      'whoami',
      'prune',
      'doctor',
      'help',
      'completion',
    ]);

    // "wtshunt use <Tab>": rest = [wtshunt, use], COMP_CWORD=2. First-argument
    // candidates are every repo name plus every repo/worktree name, flat.
    const afterUse = await getCompletions(configDir, ['use'], 2);
    assert.deepEqual(afterUse.sort(), ['b', 'b/feature-auth', 'b/main'].sort());

    // "wtshunt use b/<Tab>": rest = [wtshunt, use, b/] (the partial text "b/"
    // is real, non-empty text, so zsh does include it), COMP_CWORD=2 pointing
    // at that element directly.
    const afterUseRepoSlash = await getCompletions(configDir, ['use', 'b/'], 2);
    assert.deepEqual(afterUseRepoSlash.sort(), ['b/feature-auth', 'b/main'].sort());
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: bash-style invocation (trailing word present) uses COMP_CWORD', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    // "wtshunt <Tab>": rest = [wtshunt, ''] (bash always appends the current
    // word, empty or not), COMP_CWORD=1 points at that empty element.
    const topLevel = await getCompletions(configDir, [''], 1);
    assert.deepEqual(topLevel, [
      'use',
      'serve',
      'run',
      'status',
      'stop',
      'proxy',
      'task',
      'ui',
      'whoami',
      'prune',
      'doctor',
      'help',
      'completion',
    ]);

    // "wtshunt use <Tab>": rest = [wtshunt, use, ''], COMP_CWORD=2.
    const afterUse = await getCompletions(configDir, ['use', ''], 2);
    assert.deepEqual(afterUse.sort(), ['b', 'b/feature-auth', 'b/main'].sort());

    // "wtshunt use b/<Tab>": rest = [wtshunt, use, b/], COMP_CWORD=2.
    const afterUseRepoSlash = await getCompletions(configDir, ['use', 'b/'], 2);
    assert.deepEqual(afterUseRepoSlash.sort(), ['b/feature-auth', 'b/main'].sort());
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: falls back to last-word-is-current when COMP_CWORD is absent', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    const afterUse = await getCompletions(configDir, ['use', '']);
    assert.deepEqual(afterUse.sort(), ['b', 'b/feature-auth', 'b/main'].sort());
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: first argument is prefix-filtered across repo and worktree names', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    // "wtshunt run b/fe<Tab>": only worktrees under "b" starting with "fe".
    const feMatches = await getCompletions(configDir, ['run', 'b/fe'], 2);
    assert.deepEqual(feMatches, ['b/feature-auth']);

    // "wtshunt use b<Tab>": everything starts with "b" here, so all of them.
    const bMatches = await getCompletions(configDir, ['use', 'b'], 2);
    assert.deepEqual(bMatches.sort(), ['b', 'b/feature-auth', 'b/main'].sort());
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: prune\'s first argument suggests bare repo names only, not repo/worktree', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    const matches = await getCompletions(configDir, ['prune'], 2);
    assert.deepEqual(matches, ['b']);

    // Second argument onward for prune is unmatched, same as any command.
    const afterRepo = await getCompletions(configDir, ['prune', 'b', ''], 3);
    assert.deepEqual(afterRepo, []);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: first argument with no matches returns empty (falls through to shell default)', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    // "wtshunt run rails<Tab>": no repo/worktree starts with "rails", so this
    // must come back empty rather than some fallback list — that's what lets
    // zsh's `_default` take over and offer ordinary command/file completion.
    const noMatches = await getCompletions(configDir, ['run', 'rails'], 2);
    assert.deepEqual(noMatches, []);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: second argument onward is always empty, for any command', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    // "wtshunt run b <Tab>": the repo has already been chosen; from here on
    // it's an arbitrary command, so completion must fall through to the
    // shell's normal file/command completion (e.g. `run b bin/<Tab>`).
    const afterRepo = await getCompletions(configDir, ['run', 'b', ''], 3);
    assert.deepEqual(afterRepo, []);

    const afterRepoPartial = await getCompletions(configDir, ['run', 'b', 'bin/'], 3);
    assert.deepEqual(afterRepoPartial, []);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: top-level candidates are prefix-filtered', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    const stMatches = await getCompletions(configDir, ['st'], 1);
    assert.deepEqual(stMatches.sort(), ['status', 'stop'].sort());
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: help-argument candidates are prefix-filtered', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    const uMatches = await getCompletions(configDir, ['help', 'u'], 2);
    assert.deepEqual(uMatches.sort(), ['use', 'ui'].sort());
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: after "help", suggests command names (excluding help itself)', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    const afterHelp = await getCompletions(configDir, ['help'], 2);
    assert.deepEqual(afterHelp, [
      'use',
      'serve',
      'run',
      'status',
      'stop',
      'proxy',
      'task',
      'ui',
      'whoami',
      'prune',
      'doctor',
      'completion',
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: after "task", suggests its subcommands', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    const afterTask = await getCompletions(configDir, ['task'], 2);
    assert.deepEqual(afterTask, ['add', 'use', 'list', 'rm']);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: "task use"/"task rm" suggest defined task names', async () => {
  const { base, configDir } = await makeRepoFixture();
  const stateDir = await makeStateDirWithTasks(['prod', 'staging']);
  try {
    const afterUse = await getCompletions(configDir, ['task', 'use'], 3, stateDir);
    assert.deepEqual(afterUse.sort(), ['prod', 'staging'].sort());

    const afterRm = await getCompletions(configDir, ['task', 'rm'], 3, stateDir);
    assert.deepEqual(afterRm.sort(), ['prod', 'staging'].sort());
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('completion: "task add <name>" has no fixed candidates, but the next argument onward does', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    // Position 2 is the new task's own name: nothing to suggest.
    const nameArg = await getCompletions(configDir, ['task', 'add'], 3);
    assert.deepEqual(nameArg, []);

    // Position 3 onward are repo/worktree members, same as elsewhere.
    const memberArg = await getCompletions(configDir, ['task', 'add', 'myname'], 4);
    assert.deepEqual(memberArg.sort(), ['b', 'b/feature-auth', 'b/main'].sort());

    const secondMemberArg = await getCompletions(configDir, ['task', 'add', 'myname', 'b/main'], 5);
    assert.deepEqual(secondMemberArg.sort(), ['b', 'b/feature-auth', 'b/main'].sort());
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('help: shows the same output as top-level --help', async () => {
  const [{ stdout: helpOut }, { stdout: topLevelOut }] = await Promise.all([
    execFileAsync(process.execPath, [binPath, 'help']),
    execFileAsync(process.execPath, [binPath, '--help']),
  ]);
  assert.equal(helpOut, topLevelOut);
  assert.match(helpOut, /wtshunt use \[repo\]/);
});

test('help <command>: shows that command\'s own help', async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, 'help', 'use']);
  assert.match(stdout, /Select the active worktree for a repo/);
});

test('help run: shows run\'s own usage synopsis', async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, 'help', 'run']);
  assert.match(stdout, /Usage: wtshunt run \[repo\[\/worktree\]\] <cmd\.\.\.>/);
});

test('help <unknown command>: fails the same way a bare unknown command would', async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [binPath, 'help', 'nosuchcmd']),
    (err: NodeJS.ErrnoException & { stderr?: string }) => {
      assert.match(String(err.stderr), /Unknown command: nosuchcmd/);
      return true;
    }
  );
});

test('completion script: zsh output self-initializes compsys and registers compdef', async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, 'completion'], {
    env: { ...process.env, SHELL: '/bin/zsh' },
  });

  assert.match(stdout, /###-begin-wtshunt-completions-###/);
  assert.match(stdout, /###-end-wtshunt-completions-###/);
  assert.match(stdout, /autoload -Uz compinit/);
  assert.match(stdout, /compinit/);
  assert.match(stdout, /compdef _wtshunt_yargs_completions wtshunt/);
  assert.match(stdout, /wtshunt --get-yargs-completions "\$\{words\[@\]\}"/);
  // Upstream yargs has a stray quote here ("'${zsh_eval_context...").
  assert.doesNotMatch(stdout, /"'\$\{zsh_eval_context/);
});

test('completion script: bash output uses complete -F with no init guard', async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, 'completion'], {
    env: { ...process.env, SHELL: '/bin/bash' },
  });

  assert.match(stdout, /###-begin-wtshunt-completions-###/);
  assert.match(stdout, /###-end-wtshunt-completions-###/);
  assert.match(stdout, /complete -o bashdefault -o default -F _wtshunt_yargs_completions wtshunt/);
  assert.doesNotMatch(stdout, /compinit/);
});

test('completion script: the hidden completion-script command does not appear in --help', async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, '--help']);
  assert.match(stdout, /wtshunt completion\s/);
  assert.doesNotMatch(stdout, /completion-script/);
});

test('completion: emits nothing on stderr even when the internal re-parse fails validation', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    // `task u` makes yargs' internal re-parse hit "Unknown command: u";
    // without the completion guard in .fail(), help + error text would leak
    // to stderr and smear over the user's prompt on every <Tab>.
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, '--get-yargs-completions', 'wtshunt', 'task', 'u'],
      { env: { ...process.env, XDG_CONFIG_HOME: configDir, COMP_CWORD: '2' } }
    );
    assert.deepEqual(
      stdout.split('\n').filter((line) => line.length > 0),
      ['use']
    );
    assert.equal(stderr, '');
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});
