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
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-run-repo-'));
  const main = join(base, 'main');
  await mkdir(main, { recursive: true });
  await git(main, ['init', '-q', '-b', 'main']);
  await git(main, ['config', 'user.email', 'test@example.com']);
  await git(main, ['config', 'user.name', 'Test']);
  await writeFile(join(main, 'file.txt'), 'hello');
  await git(main, ['add', '.']);
  await git(main, ['commit', '-q', '-m', 'init']);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-run-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    ['[repos.b]', `path = "${main}"`, 'fixed_port = 3000', 'port_range = [3101, 3199]', 'serve = "echo {port}"', ''].join(
      '\n'
    )
  );

  return { base, configDir };
}

test('run: flags on the wrapped command pass through untouched', async () => {
  const { base, configDir } = await makeRepoFixture();
  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-run-state-'));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      // "b/main" targets the worktree directly, so no `wtshunt use` is needed first.
      [binPath, 'run', 'b/main', 'echo', '-n', '-h'],
      { env: { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir } }
    );
    assert.equal(stdout, '-h');
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('run: --help on the wrapped command passes through when a repo is given', async () => {
  const { base, configDir } = await makeRepoFixture();
  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-run-state-'));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'run', 'b/main', 'echo', '--help', 'world'],
      { env: { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir } }
    );
    assert.equal(stdout.trim(), '--help world');
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('run: bare -h/--help shows run usage instead of executing anything', async () => {
  const { base, configDir } = await makeRepoFixture();
  try {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'run', '-h'], {
      env: { ...process.env, XDG_CONFIG_HOME: configDir },
    });
    assert.match(stdout, /Usage: wtshunt run/);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});
