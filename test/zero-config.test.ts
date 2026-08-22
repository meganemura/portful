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
const binPath = join(here, '..', 'bin', 'portful.js');

/**
 * A repo whose config names no `serve` template, so starting it has to fall
 * back to the worktree's own package.json script.
 */
async function makeFixture(slug: string, fixedPort: number, packageJson: unknown) {
  const base = await mkdtemp(join(tmpdir(), `portful-${slug}-repo-`));
  const main = join(base, 'main');
  await mkdir(main, { recursive: true });
  const git = (args: string[]) => execFileAsync('git', args, { cwd: main });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  if (packageJson !== undefined) {
    await writeFile(join(main, 'package.json'), JSON.stringify(packageJson));
  }
  await writeFile(join(main, 'f.txt'), 'hi');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'init']);

  const configDir = await mkdtemp(join(tmpdir(), `portful-${slug}-config-`));
  await mkdir(join(configDir, 'portful'), { recursive: true });
  await writeFile(
    join(configDir, 'portful', 'config.json'),
    JSON.stringify({ repos: { e: { path: main, fixedPort, portRange: [fixedPort + 1, fixedPort + 10] } } })
  );
  const stateDir = await mkdtemp(join(tmpdir(), `portful-${slug}-state-`));

  return {
    main,
    env: { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir },
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

test('run: with no serve template, starts the worktree\'s own dev script with PORT set', async () => {
  const fx = await makeFixture('zero-config', 42100, {
    name: 'e',
    version: '0.0.0',
    scripts: { dev: 'echo "dev-script saw PORT=$PORT"' },
  });
  try {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'run', '--name', 'e/main'], { env: fx.env });
    assert.match(stdout, /Starting server for "main" on port 4210\d/);
    assert.match(stdout, /dev-script saw PORT=4210\d/);
  } finally {
    await fx.cleanup();
  }
});

test('run: a named script in the config replaces the default dev script', async () => {
  const fx = await makeFixture('zero-config-script', 42120, {
    name: 'e',
    version: '0.0.0',
    scripts: { dev: 'echo wrong-one', serve: 'echo "serve-script saw PORT=$PORT"' },
  });
  try {
    // The repo names the script from its own checkout, the way portless reads
    // "script" from portless.json.
    await writeFile(join(fx.main, 'portful.json'), JSON.stringify({ script: 'serve' }));
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'run', '--name', 'e/main'], { env: fx.env });
    assert.match(stdout, /serve-script saw PORT=4212\d/);
    assert.doesNotMatch(stdout, /wrong-one/);
  } finally {
    await fx.cleanup();
  }
});

test('run: no template and no matching script reports the scripts the project does define', async () => {
  const fx = await makeFixture('zero-config-missing', 42140, {
    name: 'e',
    version: '0.0.0',
    scripts: { build: 'tsc', test: 'node --test' },
  });
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [binPath, 'run', '--name', 'e/main'], { env: fx.env }),
      (err: NodeJS.ErrnoException & { stderr?: string; code?: number }) => {
        assert.match(String(err.stderr), /defines no "dev" script/);
        assert.match(String(err.stderr), /Scripts defined there: build, test\./);
        assert.equal(err.code, 1);
        return true;
      }
    );
  } finally {
    await fx.cleanup();
  }
});

test('a bare invocation inside a worktree starts that worktree, the way a bare portless does', async () => {
  const fx = await makeFixture('zero-config-bare', 42160, {
    name: 'e',
    version: '0.0.0',
    scripts: { dev: 'echo "bare saw PORT=$PORT"' },
  });
  try {
    const { stdout } = await execFileAsync(process.execPath, [binPath], { env: fx.env, cwd: fx.main });
    assert.match(stdout, /bare saw PORT=4216\d/);
  } finally {
    await fx.cleanup();
  }
});
