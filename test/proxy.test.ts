import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRepoState, withState } from '../src/state.ts';
import { startProxy } from '../src/proxy.ts';
import type { RepoConfig } from '../src/config.ts';

async function withTempState<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-proxy-state-'));
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

function startBackend(label: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`hello from ${label}`);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

test('proxy: forwards to the active worktree, switches on state change, and 502s when down', async () => {
  await withTempState(async () => {
    const a = await startBackend('a');
    const b = await startBackend('b');

    await withState((state) => {
      const rs = ensureRepoState(state, 'b');
      rs.active = 'wt-a';
      rs.servers['wt-a'] = { path: '/x', branch: 'a', port: a.port, pid: process.pid };
      rs.servers['wt-b'] = { path: '/y', branch: 'b', port: b.port, pid: process.pid };
    });

    // fixedPort: 0 lets the OS assign a free port for the proxy's own listener.
    const repoConfig: RepoConfig = { path: '/repo', fixedPort: 0, portRange: [0, 0], serve: '' };
    const handle = await startProxy({ repoName: 'b', repoConfig });

    try {
      const res1 = await fetch(`http://127.0.0.1:${handle.port}/`);
      assert.equal(await res1.text(), 'hello from a');
      assert.equal(res1.headers.get('x-wtshunt-worktree'), 'wt-a');

      await withState((state) => {
        ensureRepoState(state, 'b').active = 'wt-b';
      });

      const res2 = await fetch(`http://127.0.0.1:${handle.port}/`);
      assert.equal(await res2.text(), 'hello from b');
      assert.equal(res2.headers.get('x-wtshunt-worktree'), 'wt-b');

      await withState((state) => {
        delete ensureRepoState(state, 'b').servers['wt-b'];
      });

      const res3 = await fetch(`http://127.0.0.1:${handle.port}/`);
      assert.equal(res3.status, 502);
      assert.equal(res3.headers.get('x-wtshunt-worktree'), 'wt-b');
      assert.match(await res3.text(), /wt-b/);
    } finally {
      await handle.close();
      await closeHttpServer(a.server);
      await closeHttpServer(b.server);
    }
  });
});

test('proxy: 502s with a hint when no worktree is active', async () => {
  await withTempState(async () => {
    const repoConfig: RepoConfig = { path: '/repo', fixedPort: 0, portRange: [0, 0], serve: '' };
    const handle = await startProxy({ repoName: 'unconfigured', repoConfig });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/`);
      assert.equal(res.status, 502);
      assert.match(await res.text(), /wtshunt use/);
    } finally {
      await handle.close();
    }
  });
});
