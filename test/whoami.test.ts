import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureRepoState, withState } from '../src/state.ts';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'portful.js');

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

interface Fixture {
  base: string;
  main: string;
  worktree: string;
  configDir: string;
  stateDir: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'portful-whoami-repo-'));
  const main = join(base, 'main');
  await mkdir(main, { recursive: true });
  await git(main, ['init', '-q', '-b', 'main']);
  await git(main, ['config', 'user.email', 'test@example.com']);
  await git(main, ['config', 'user.name', 'Test']);
  await writeFile(join(main, 'file.txt'), 'hello');
  await git(main, ['add', '.']);
  await git(main, ['commit', '-q', '-m', 'init']);

  const worktree = join(base, 'feature-auth');
  await git(main, ['worktree', 'add', '-q', '-b', 'feature/auth', worktree]);

  const configDir = await mkdtemp(join(tmpdir(), 'portful-whoami-config-'));
  await mkdir(join(configDir, 'portful'), { recursive: true });
  await writeFile(
    join(configDir, 'portful', 'config.json'),
    JSON.stringify({
      repos: {
        api: {
          path: `${main}`,
          fixedPort: 3000,
          portRange: [3101, 3199],
          serve: 'echo {port}'
        }
      }
    })
  );

  const stateDir = await mkdtemp(join(tmpdir(), 'portful-whoami-state-'));

  return { base, main, worktree, configDir, stateDir };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await rm(fixture.base, { recursive: true, force: true });
  await rm(fixture.configDir, { recursive: true, force: true });
  await rm(fixture.stateDir, { recursive: true, force: true });
}

function envFor(fixture: Fixture): NodeJS.ProcessEnv {
  return { ...process.env, XDG_CONFIG_HOME: fixture.configDir, XDG_STATE_HOME: fixture.stateDir };
}

test('whoami: reports the main checkout, stopped and not active, with no port segment', async () => {
  const fixture = await makeFixture();
  try {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'whoami'], {
      cwd: fixture.main,
      env: envFor(fixture),
    });
    assert.equal(stdout.trim(), 'api/main (stopped)');
  } finally {
    await cleanup(fixture);
  }
});

test('whoami: reports a non-main worktree the same way', async () => {
  const fixture = await makeFixture();
  try {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'whoami'], {
      cwd: fixture.worktree,
      env: envFor(fixture),
    });
    assert.equal(stdout.trim(), 'api/feature-auth (stopped)');
  } finally {
    await cleanup(fixture);
  }
});

test('whoami: resolves through a symlink into a worktree subdirectory', async () => {
  const fixture = await makeFixture();
  try {
    const appDir = join(fixture.worktree, 'app');
    await mkdir(appDir);
    const linkPath = join(fixture.base, 'link-to-wt-app');
    await symlink(appDir, linkPath, 'dir');

    const { stdout } = await execFileAsync(process.execPath, [binPath, 'whoami'], {
      cwd: linkPath,
      env: envFor(fixture),
    });
    assert.equal(stdout.trim(), 'api/feature-auth (stopped)');
  } finally {
    await cleanup(fixture);
  }
});

test('whoami: errors with exit 1 when cwd is outside every registered repo', async () => {
  const fixture = await makeFixture();
  const outside = await mkdtemp(join(tmpdir(), 'portful-whoami-outside-'));
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [binPath, 'whoami'], { cwd: outside, env: envFor(fixture) }),
      (err: NodeJS.ErrnoException & { stderr?: string; code?: number }) => {
        assert.match(String(err.stderr), /Could not determine repo/);
        assert.equal(err.code, 1);
        return true;
      }
    );
  } finally {
    await cleanup(fixture);
    await rm(outside, { recursive: true, force: true });
  }
});

test('whoami: reports port/active/server/proxy once they exist, and includes them in --json', async () => {
  const fixture = await makeFixture();
  try {
    const env = envFor(fixture);
    const original = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
    process.env.XDG_CONFIG_HOME = fixture.configDir;
    process.env.XDG_STATE_HOME = fixture.stateDir;
    try {
      await withState((state) => {
        const rs = ensureRepoState(state, 'api');
        rs.active = 'main';
        rs.ports.main = 3101;
        rs.servers.main = { path: fixture.main, branch: 'main', port: 3101, pid: process.pid };
        rs.proxy = { pid: process.pid, port: 3000 };
      });
    } finally {
      if (original.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = original.XDG_CONFIG_HOME;
      if (original.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = original.XDG_STATE_HOME;
    }

    const { stdout: line } = await execFileAsync(process.execPath, [binPath, 'whoami'], { cwd: fixture.main, env });
    assert.equal(line.trim(), 'api/main port 3101 (running, active)');

    const { stdout: jsonOut } = await execFileAsync(process.execPath, [binPath, 'whoami', '--json'], {
      cwd: fixture.main,
      env,
    });
    const parsed = JSON.parse(jsonOut);
    assert.deepEqual(parsed, {
      repo: 'api',
      worktree: 'main',
      branch: 'main',
      // git worktree list reports the real (symlink-resolved) path, which
      // on macOS differs from mkdtemp's raw /var/... form (-> /private/var/...).
      path: await realpath(fixture.main),
      port: 3101,
      server: { pid: process.pid, port: 3101 },
      active: true,
      proxy: { running: true, routedHere: true },
    });
  } finally {
    await cleanup(fixture);
  }
});

test('whoami: a sticky port with no running server reports "stopped" but still shows the port', async () => {
  const fixture = await makeFixture();
  try {
    const env = envFor(fixture);
    const original = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
    process.env.XDG_CONFIG_HOME = fixture.configDir;
    process.env.XDG_STATE_HOME = fixture.stateDir;
    try {
      await withState((state) => {
        const rs = ensureRepoState(state, 'api');
        rs.active = 'main';
        rs.ports.main = 3101;
      });
    } finally {
      if (original.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = original.XDG_CONFIG_HOME;
      if (original.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = original.XDG_STATE_HOME;
    }

    const { stdout } = await execFileAsync(process.execPath, [binPath, 'whoami'], { cwd: fixture.main, env });
    assert.equal(stdout.trim(), 'api/main port 3101 (stopped, active)');
  } finally {
    await cleanup(fixture);
  }
});
