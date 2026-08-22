import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { explicitCommandForm } from '../src/dispatch.ts';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'portful.js');

test('explicitCommandForm: a non-command first word plus a command is the <repo> <cmd...> form', () => {
  assert.deepEqual(explicitCommandForm(['api', 'bundle', 'exec', 'rails', 's']), {
    repo: 'api',
    command: ['bundle', 'exec', 'rails', 's'],
  });
});

test('explicitCommandForm: a repo/worktree first word is accepted the same way', () => {
  assert.deepEqual(explicitCommandForm(['api/feature-x', 'npm', 'run', 'dev']), {
    repo: 'api/feature-x',
    command: ['npm', 'run', 'dev'],
  });
});

test('explicitCommandForm: reserved command names stay with yargs', () => {
  for (const name of ['use', 'serve', 'exec', 'status', 'list', 'stop', 'proxy', 'task', 'doctor']) {
    assert.equal(explicitCommandForm([name, 'whatever']), undefined, `"${name}" should stay reserved`);
  }
});

test('explicitCommandForm: a lone word stays with yargs, so an unknown command still errors', () => {
  assert.equal(explicitCommandForm(['api']), undefined);
  assert.equal(explicitCommandForm([]), undefined);
});

test('explicitCommandForm: a leading flag stays with yargs, which owns --help and --version', () => {
  assert.equal(explicitCommandForm(['--help']), undefined);
  assert.equal(explicitCommandForm(['--version']), undefined);
  assert.equal(explicitCommandForm(['--get-yargs-completions', 'portful', '']), undefined);
});

test('explicitCommandForm: a mistyped verb followed by a flag stays with yargs', () => {
  assert.equal(explicitCommandForm(['sttatus', '--json']), undefined);
});

test('portful <repo> <cmd...>: runs the command in the worktree with PORT set to the assigned port', async () => {
  const base = await mkdtemp(join(tmpdir(), 'portful-explicit-repo-'));
  const main = join(base, 'main');
  await mkdir(main, { recursive: true });
  const git = (args: string[]) => execFileAsync('git', args, { cwd: main });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(join(main, 'f.txt'), 'hi');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'init']);

  const configDir = await mkdtemp(join(tmpdir(), 'portful-explicit-config-'));
  await mkdir(join(configDir, 'portful'), { recursive: true });
  await writeFile(
    join(configDir, 'portful', 'config.toml'),
    ['[repos.e]', `path = "${main}"`, 'fixed_port = 42010', 'port_range = [42011, 42020]', 'serve = "echo {port}"', ''].join('\n')
  );
  const stateDir = await mkdtemp(join(tmpdir(), 'portful-explicit-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [binPath, 'e/main', 'sh', '-c', 'echo "saw PORT=$PORT URL=$PORTFUL_URL cwd=$PWD"'],
      { env }
    );

    assert.match(stdout, /Starting server for "main" on port 4201\d/);
    // The command replaces the serve template, so the template's own echo of
    // the port must not appear; only the command's own line does.
    assert.match(stdout, /saw PORT=4201\d URL=http:\/\/127\.0\.0\.1:42010/);
    // macOS resolves /var through a symlink to /private/var, so compare the
    // worktree's own directory name rather than the whole path.
    assert.match(stdout, /cwd=\S*\/main\b/);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('portful <unknown repo> <cmd...>: reports the unknown repo rather than running anything', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'portful-explicit-unknown-config-'));
  await mkdir(join(configDir, 'portful'), { recursive: true });
  await writeFile(
    join(configDir, 'portful', 'config.toml'),
    ['[repos.e]', 'path = "/nonexistent"', 'fixed_port = 42030', 'port_range = [42031, 42040]', 'serve = "echo {port}"', ''].join('\n')
  );
  const stateDir = await mkdtemp(join(tmpdir(), 'portful-explicit-unknown-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };

  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [binPath, 'nosuchrepo', 'echo', 'hi'], { env }),
      (err: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => {
        assert.doesNotMatch(String(err.stdout), /hi/);
        assert.match(String(err.stderr), /nosuchrepo/);
        assert.equal(err.code, 1);
        return true;
      }
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
