import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isAlive, type State } from '../src/state.ts';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'portful.js');

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Polls state.json rather than guessing a fixed delay for the spawned proxy to have written it. */
async function waitForState(stateDir: string, predicate: (state: State) => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(join(stateDir, 'portful', 'state.json'), 'utf8');
      if (predicate(JSON.parse(raw) as State)) {
        return;
      }
    } catch {
      // Not written yet, or a partial write; poll again.
    }
    await sleep(50);
  }
  throw new Error('Timed out waiting for state.json');
}

async function makeFixture(slug: string, fixedPort: number) {
  const base = await mkdtemp(join(tmpdir(), `portful-${slug}-repo-`));
  const main = join(base, 'main');
  await mkdir(main, { recursive: true });
  const git = (args: string[]) => execFileAsync('git', args, { cwd: main });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(join(main, 'f.txt'), 'hi');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'init']);

  const configDir = await mkdtemp(join(tmpdir(), `portful-${slug}-config-`));
  await mkdir(join(configDir, 'portful'), { recursive: true });
  await writeFile(
    join(configDir, 'portful', 'config.toml'),
    [
      '[repos.e]',
      `path = "${main}"`,
      `fixed_port = ${fixedPort}`,
      `port_range = [${fixedPort + 1}, ${fixedPort + 10}]`,
      'serve = "echo {port}; sleep 30"',
      '',
    ].join('\n')
  );
  const stateDir = await mkdtemp(join(tmpdir(), `portful-${slug}-state-`));

  return {
    base,
    configDir,
    stateDir,
    env: { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir },
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

test('proxy stop: signals a proxy running in another terminal and clears its state entry', async () => {
  const fx = await makeFixture('proxy-stop', 41970);
  let proxyProc: ReturnType<typeof spawn> | undefined;
  try {
    proxyProc = spawn(process.execPath, [binPath, 'proxy', 'start', 'e'], { env: fx.env, stdio: 'ignore' });
    await waitForState(fx.stateDir, (s) => s.repos.e?.proxy !== undefined, 5000);

    const raw = await readFile(join(fx.stateDir, 'portful', 'state.json'), 'utf8');
    const proxyPid = (JSON.parse(raw) as State).repos.e!.proxy!.pid;

    const { stdout } = await execFileAsync(process.execPath, [binPath, 'proxy', 'stop', 'e'], { env: fx.env });
    assert.match(stdout, /Stopped proxy for "e"/);

    assert.equal(isAlive(proxyPid), false, 'the proxy process should be gone');

    const after = JSON.parse(await readFile(join(fx.stateDir, 'portful', 'state.json'), 'utf8')) as State;
    assert.equal(after.repos.e?.proxy, undefined, 'the proxy entry should be cleared');
  } finally {
    if (proxyProc?.pid) {
      try {
        process.kill(proxyProc.pid, 'SIGTERM');
      } catch {
        // Already gone, which is the expected case.
      }
    }
    await sleep(200);
    await fx.cleanup();
  }
});

test('proxy stop: reports plainly when no proxy is running, without failing', async () => {
  const fx = await makeFixture('proxy-stop-none', 41985);
  try {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'proxy', 'stop', 'e'], { env: fx.env });
    assert.match(stdout, /No proxy running for "e"/);
  } finally {
    await fx.cleanup();
  }
});

test('proxy: a bare invocation demands a subcommand instead of starting anything', async () => {
  const fx = await makeFixture('proxy-bare', 41995);
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [binPath, 'proxy'], { env: fx.env }),
      (err: NodeJS.ErrnoException & { stderr?: string; code?: number }) => {
        assert.match(String(err.stderr), /Specify a proxy subcommand: start or stop\./);
        assert.equal(err.code, 1);
        return true;
      }
    );
  } finally {
    await fx.cleanup();
  }
});
