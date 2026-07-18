import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { waitForExit } from '../src/commands/stop.ts';
import { ensureRepoState, withState } from '../src/state.ts';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'wtshunt.js');

async function makeConfigDir(): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-stop-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    ['[repos.b]', 'path = "/tmp"', 'fixed_port = 3000', 'port_range = [3101, 3199]', 'serve = "echo {port}"', ''].join(
      '\n'
    )
  );
  return configDir;
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const configDir = await makeConfigDir();
  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-stop-state-'));
  const original = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.XDG_STATE_HOME = stateDir;
  try {
    return await fn();
  } finally {
    process.env.XDG_CONFIG_HOME = original.XDG_CONFIG_HOME;
    process.env.XDG_STATE_HOME = original.XDG_STATE_HOME;
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('waitForExit: resolves true once the process is gone', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 150)']);
  const exited = await waitForExit(child.pid!, 20, 2000);
  assert.equal(exited, true);
});

test('waitForExit: resolves false if the process outlives the timeout', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    const exited = await waitForExit(child.pid!, 20, 200);
    assert.equal(exited, false);
  } finally {
    child.kill('SIGKILL');
  }
});

test('stop: a normal process is confirmed dead and its entry is removed', async () => {
  await withEnv({}, async () => {
    const child = spawn('sh', ['-c', 'while true; do sleep 1; done'], { detached: true, stdio: 'ignore' });
    const pid = child.pid!;
    child.unref();

    await withState((state) => {
      const rs = ensureRepoState(state, 'b');
      rs.active = 'main';
      rs.servers.main = { path: '/tmp', branch: 'main', port: 3101, pid };
    });

    const { stdout } = await execFileAsync(process.execPath, [binPath, 'stop', 'b'], { env: process.env });
    assert.match(stdout, /Stopped server for "main"/);

    const raw = await readFile(join(process.env.XDG_STATE_HOME!, 'wtshunt', 'state.json'), 'utf8');
    const state = JSON.parse(raw);
    assert.equal(state.repos.b.servers.main, undefined);
  });
});

test('stop: a SIGTERM-trapping process is left running with a warning and its entry stays', async () => {
  await withEnv({}, async () => {
    const child = spawn('sh', ['-c', 'trap "" TERM; while true; do sleep 0.2; done'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = child.pid!;
    child.unref();

    await withState((state) => {
      const rs = ensureRepoState(state, 'b');
      rs.active = 'main';
      rs.servers.main = { path: '/tmp', branch: 'main', port: 3101, pid };
    });

    try {
      await assert.rejects(
        () => execFileAsync(process.execPath, [binPath, 'stop', 'b'], { env: process.env }),
        (err: NodeJS.ErrnoException & { stderr?: string }) => {
          assert.match(String(err.stderr), /still running/);
          assert.match(String(err.stderr), /wtshunt status/);
          return true;
        }
      );

      const raw = await readFile(join(process.env.XDG_STATE_HOME!, 'wtshunt', 'state.json'), 'utf8');
      const state = JSON.parse(raw);
      assert.equal(state.repos.b.servers.main.pid, pid);
      assert.doesNotThrow(() => process.kill(pid, 0)); // still alive, unlike a normal process by now
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  });
});
