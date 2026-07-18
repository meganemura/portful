import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
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

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * A minimal WebSocket-handshake server: accepts the upgrade, replies 101,
 * and echoes back whatever bytes arrive afterward (prefixed with `label`, so
 * a test can tell which backend actually handled a given connection). It
 * only speaks enough of the protocol to prove the proxy tunnels an upgraded
 * connection's raw bytes both ways — it doesn't parse WebSocket frames.
 */
function startWsBackend(label: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      const accept = createHash('sha1')
        .update(`${key}${WS_MAGIC}`)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      socket.on('data', (chunk: Buffer) => {
        socket.write(`${label}:${chunk}`);
      });
      // A well-behaved server closes its side once the client is done, so a
      // destroyed test client doesn't leave this backend's own server.close()
      // waiting on a socket that received EOF but was never itself ended.
      socket.on('end', () => socket.destroy());
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

function connectRaw(port: number): Promise<Socket> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => resolvePromise(socket));
    socket.once('error', reject);
  });
}

function sendHandshake(socket: Socket, path = '/cable'): void {
  socket.write(
    `GET ${path} HTTP/1.1\r\n` +
      'Host: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n'
  );
}

/** Collects data off `socket` until `predicate` matches the accumulated buffer, then resolves with it. */
function readUntil(socket: Socket, predicate: (buf: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolvePromise) => {
    let acc = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk]);
      if (predicate(acc)) {
        socket.off('data', onData);
        resolvePromise(acc);
      }
    };
    socket.on('data', onData);
  });
}

test('proxy: forwards WebSocket upgrades to the active worktree and switches for new connections', async () => {
  await withTempState(async () => {
    const a = await startWsBackend('a');
    const b = await startWsBackend('b');

    await withState((state) => {
      const rs = ensureRepoState(state, 'b');
      rs.active = 'wt-a';
      rs.servers['wt-a'] = { path: '/x', branch: 'a', port: a.port, pid: process.pid };
      rs.servers['wt-b'] = { path: '/y', branch: 'b', port: b.port, pid: process.pid };
    });

    const repoConfig: RepoConfig = { path: '/repo', fixedPort: 0, portRange: [0, 0], serve: '' };
    const handle = await startProxy({ repoName: 'b', repoConfig });

    let clientA: Socket | undefined;
    let clientB: Socket | undefined;
    try {
      clientA = await connectRaw(handle.port);
      sendHandshake(clientA);
      const handshakeResponse = await readUntil(clientA, (buf) => buf.includes('\r\n\r\n'));
      assert.match(handshakeResponse.toString('latin1'), /^HTTP\/1\.1 101 Switching Protocols/);
      // No X-Wtshunt-Worktree injection on the upgrade path (see proxy.ts).
      assert.doesNotMatch(handshakeResponse.toString('latin1'), /X-Wtshunt-Worktree/i);

      clientA.write('ping-payload');
      const echoed = await readUntil(clientA, (buf) => buf.length > 0);
      assert.equal(echoed.toString(), 'a:ping-payload');

      await withState((state) => {
        ensureRepoState(state, 'b').active = 'wt-b';
      });

      // A brand new connection picks up the new active worktree; the one
      // above keeps talking to "a" (not exercised further here, but nothing
      // about the first connection changed).
      clientB = await connectRaw(handle.port);
      sendHandshake(clientB);
      await readUntil(clientB, (buf) => buf.includes('\r\n\r\n'));
      clientB.write('second-payload');
      const echoedB = await readUntil(clientB, (buf) => buf.length > 0);
      assert.equal(echoedB.toString(), 'b:second-payload');
    } finally {
      clientA?.destroy();
      clientB?.destroy();
      await handle.close();
      await closeHttpServer(a.server);
      await closeHttpServer(b.server);
    }
  });
});

test('proxy: WebSocket upgrade 502s when the active worktree has no server', async () => {
  await withTempState(async () => {
    const repoConfig: RepoConfig = { path: '/repo', fixedPort: 0, portRange: [0, 0], serve: '' };
    const handle = await startProxy({ repoName: 'unconfigured', repoConfig });
    let client: Socket | undefined;
    try {
      client = await connectRaw(handle.port);
      sendHandshake(client);
      const response = await readUntil(client, (buf) => buf.includes('wtshunt use'));
      assert.match(response.toString('latin1'), /^HTTP\/1\.1 502 Bad Gateway/);
    } finally {
      client?.destroy();
      await handle.close();
    }
  });
});
