import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ensureRepoState, getStatePath, readState, withState } from '../src/state.ts';

async function withTempState<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'portful-state-'));
  const original = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = original;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function spawnAndWaitForExit(): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    child.on('exit', () => resolvePromise(child.pid!));
  });
}

test('state: atomic write and read round trip', async () => {
  await withTempState(async () => {
    await withState((state) => {
      const rs = ensureRepoState(state, 'b');
      rs.ports.a = 3101;
    });

    const state = await readState();
    assert.equal(state.repos.b.ports.a, 3101);

    const raw = await readFile(getStatePath(), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
  });
});

test('state: cleans up dead pids on read but keeps sticky ports', async () => {
  await withTempState(async () => {
    const deadPid = await spawnAndWaitForExit();

    await withState((state) => {
      const rs = ensureRepoState(state, 'b');
      rs.ports = { alive: 1, dead: 2 };
      rs.servers = {
        alive: { path: '/x', branch: 'main', port: 3101, pid: process.pid },
        dead: { path: '/y', branch: 'main', port: 3102, pid: deadPid },
      };
      rs.proxy = { pid: deadPid, port: 3000 };
    });

    const state = await readState();
    assert.ok(state.repos.b.servers.alive);
    assert.equal(state.repos.b.servers.dead, undefined);
    assert.equal(state.repos.b.proxy, undefined);
    assert.deepEqual(state.repos.b.ports, { alive: 1, dead: 2 });
  });
});

test('state: withState serializes concurrent read-modify-write', async () => {
  await withTempState(async () => {
    await withState((state) => {
      ensureRepoState(state, 'counter').ports.n = 0;
    });

    const increments = Array.from({ length: 10 }, () =>
      withState(async (state) => {
        const rs = ensureRepoState(state, 'counter');
        const current = rs.ports.n;
        await new Promise((r) => setTimeout(r, 5));
        rs.ports.n = current + 1;
      })
    );
    await Promise.all(increments);

    const state = await readState();
    assert.equal(state.repos.counter.ports.n, 10);
  });
});
