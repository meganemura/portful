import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
async function getCompletions(configDir: string, args: string[], compCword?: number): Promise<string[]> {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: configDir };
  if (compCword !== undefined) {
    env.COMP_CWORD = String(compCword);
  } else {
    delete env.COMP_CWORD;
  }

  const { stdout } = await execFileAsync(
    process.execPath,
    [binPath, '--get-yargs-completions', 'wtshunt', ...args],
    { env }
  );
  return stdout.split('\n').filter((line) => line.length > 0);
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
      'help',
      'completion',
    ]);

    // "wtshunt use <Tab>": rest = [wtshunt, use], COMP_CWORD=2.
    const afterUse = await getCompletions(configDir, ['use'], 2);
    assert.deepEqual(afterUse, ['b']);

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
    assert.deepEqual(topLevel, ['use', 'serve', 'run', 'status', 'stop', 'proxy', 'help', 'completion']);

    // "wtshunt use <Tab>": rest = [wtshunt, use, ''], COMP_CWORD=2.
    const afterUse = await getCompletions(configDir, ['use', ''], 2);
    assert.deepEqual(afterUse, ['b']);

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
    assert.deepEqual(afterUse, ['b']);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('completion: after "help", suggests command names (excluding help itself)', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    const afterHelp = await getCompletions(configDir, ['help'], 2);
    assert.deepEqual(afterHelp, ['use', 'serve', 'run', 'status', 'stop', 'proxy', 'completion']);
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
