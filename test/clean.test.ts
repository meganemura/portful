import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { State } from '../src/state.ts';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'portful.js');

async function withState<T>(state: State, fn: (statePath: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const configDir = await mkdtemp(join(tmpdir(), 'portful-clean-config-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'portful-clean-state-'));
  try {
    await mkdir(join(configDir, 'portful'), { recursive: true });
    await writeFile(
      join(configDir, 'portful', 'config.json'),
      JSON.stringify({ repos: { e: { path: '/tmp/e', fixedPort: 42200, portRange: [42201, 42210] } } })
    );
    await mkdir(join(stateDir, 'portful'), { recursive: true });
    const statePath = join(stateDir, 'portful', 'state.json');
    await writeFile(statePath, JSON.stringify(state));
    return await fn(statePath, { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir });
  } finally {
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
}

const IDLE: State = { repos: { e: { ports: { main: 42201 }, servers: {}, active: 'main' } }, tasks: {} };

test('clean: removes the state file when nothing is running', async () => {
  await withState(IDLE, async (statePath, env) => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'clean'], { env });
    assert.match(stdout, /Removed .*state\.json/);
    await assert.rejects(() => access(statePath), 'the state file should be gone');
  });
});

test('clean: refuses while a server is recorded as running, and names it', async () => {
  // This process's own pid is alive by definition, so the entry survives the
  // liveness sweep that readState performs.
  const running: State = {
    repos: { e: { ports: {}, servers: { main: { path: '/tmp/e', branch: 'main', port: 42201, pid: process.pid } } } },
    tasks: {},
  };
  await withState(running, async (statePath, env) => {
    await assert.rejects(
      () => execFileAsync(process.execPath, [binPath, 'clean'], { env }),
      (err: NodeJS.ErrnoException & { stderr?: string; code?: number }) => {
        assert.match(String(err.stderr), /server e\/main \(pid \d+\)/);
        assert.match(String(err.stderr), /--force/);
        assert.equal(err.code, 1);
        return true;
      }
    );
    await access(statePath);
  });
});

test('clean --force: removes the state anyway and says what is now untracked', async () => {
  const running: State = {
    repos: { e: { ports: {}, servers: {}, proxy: { pid: process.pid, port: 42200 } } },
    tasks: {},
  };
  await withState(running, async (statePath, env) => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, 'clean', '--force'], { env });
    assert.match(stdout, /1 process\(es\) were still recorded as running/);
    await assert.rejects(() => access(statePath));
  });
});
