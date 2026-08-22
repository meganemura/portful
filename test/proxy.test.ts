import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ensureRepoState, withState } from '../src/state.ts';
import { startProxy } from '../src/proxy.ts';
import type { RepoConfig } from '../src/config.ts';

const execFileAsync = promisify(execFile);

async function opensslAvailable(): Promise<boolean> {
  try {
    // `which` merely checks $PATH — this never actually invokes openssl.
    await execFileAsync('which', ['openssl']);
    return true;
  } catch {
    return false;
  }
}

const hasOpenssl = await opensslAvailable();

/** Generates a throwaway self-signed cert/key pair in a temp dir for the TLS tests below. Never committed to the repo. */
async function makeSelfSignedCert(): Promise<{ dir: string; certPath: string; keyPath: string; cert: Buffer; key: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), 'portful-proxy-cert-'));
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  return { dir, certPath, keyPath, cert, key };
}

async function withTempState<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'portful-proxy-state-'));
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

function closeServer(server: { close(callback: () => void): unknown }): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

/** Echoes back the request headers as JSON, so a test can see what the proxy actually forwarded. */
function startHeaderEchoBackend(label: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ label, headers: req.headers }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

/** Same as `startHeaderEchoBackend`, but over TLS, for exercising the https-backend forwarding path. */
function startHttpsHeaderEchoBackend(
  label: string,
  tlsOptions: { cert: Buffer; key: Buffer }
): Promise<{ server: HttpsServer; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createHttpsServer(tlsOptions, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ label, headers: req.headers }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

/** Issues a GET over TLS with `rejectUnauthorized: false`, the same way the proxy's own https backend requests do. */
function httpsGet(port: number, path = '/'): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk;
      });
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
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
      assert.equal(res1.headers.get('x-portful-worktree'), 'wt-a');

      await withState((state) => {
        ensureRepoState(state, 'b').active = 'wt-b';
      });

      const res2 = await fetch(`http://127.0.0.1:${handle.port}/`);
      assert.equal(await res2.text(), 'hello from b');
      assert.equal(res2.headers.get('x-portful-worktree'), 'wt-b');

      await withState((state) => {
        delete ensureRepoState(state, 'b').servers['wt-b'];
      });

      const res3 = await fetch(`http://127.0.0.1:${handle.port}/`);
      assert.equal(res3.status, 502);
      assert.equal(res3.headers.get('x-portful-worktree'), 'wt-b');
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
      assert.match(await res.text(), /portful use/);
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

/** Same handshake server as `startWsBackend`, but over TLS, for the https-backend WebSocket-tunnel test. */
function startWssBackend(label: string, tlsOptions: { cert: Buffer; key: Buffer }): Promise<{ server: HttpsServer; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createHttpsServer(tlsOptions);
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
      // No X-Portful-Worktree injection on the upgrade path (see proxy.ts).
      assert.doesNotMatch(handshakeResponse.toString('latin1'), /X-Portful-Worktree/i);

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
      const response = await readUntil(client, (buf) => buf.includes('portful use'));
      assert.match(response.toString('latin1'), /^HTTP\/1\.1 502 Bad Gateway/);
    } finally {
      client?.destroy();
      await handle.close();
    }
  });
});

test('proxy: close() does not wait for held connections', async () => {
  await withTempState(async () => {
    // Backend that starts streaming and never ends the response (SSE-like).
    const backend = await new Promise<{ server: Server; port: number }>((resolvePromise) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: tick\n\n');
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolvePromise({ server, port });
      });
    });

    await withState((state) => {
      const rs = ensureRepoState(state, 'b');
      rs.active = 'wt-a';
      rs.servers['wt-a'] = { path: '/x', branch: 'a', port: backend.port, pid: process.pid };
    });

    const repoConfig: RepoConfig = { path: '/repo', fixedPort: 0, portRange: [0, 0], serve: '' };
    const handle = await startProxy({ repoName: 'b', repoConfig });

    const held = connect(handle.port, '127.0.0.1');
    held.on('error', () => {});
    held.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise<void>((resolvePromise) => held.once('data', () => resolvePromise()));

    const t0 = Date.now();
    await handle.close();
    assert.ok(Date.now() - t0 < 1500, `close() took ${Date.now() - t0}ms with a held connection`);

    held.destroy();
    backend.server.closeAllConnections();
    await closeHttpServer(backend.server);
  });
});

test(
  'proxy: TLS-terminates the fixed port, forwarding to a plain-http backend with X-Forwarded-Proto added',
  { skip: !hasOpenssl ? 'openssl is not installed' : false },
  async () => {
    await withTempState(async () => {
      const certDir = await makeSelfSignedCert();
      try {
        const backend = await startHeaderEchoBackend('a');

        await withState((state) => {
          const rs = ensureRepoState(state, 'tls-repo');
          rs.active = 'wt-a';
          rs.servers['wt-a'] = { path: '/x', branch: 'a', port: backend.port, pid: process.pid };
        });

        const repoConfig: RepoConfig = {
          path: '/repo',
          fixedPort: 0,
          portRange: [0, 0],
          serve: '',
          https: { cert: certDir.certPath, key: certDir.keyPath, backend: false },
        };
        const handle = await startProxy({ repoName: 'tls-repo', repoConfig });

        try {
          const res = await httpsGet(handle.port, '/');
          assert.equal(res.status, 200);
          assert.equal(res.headers['x-portful-worktree'], 'wt-a');
          const parsed = JSON.parse(res.body) as { label: string; headers: Record<string, string> };
          assert.equal(parsed.label, 'a');
          // The listener is TLS, so the plain-http backend should see the
          // request came in over https.
          assert.equal(parsed.headers['x-forwarded-proto'], 'https');
        } finally {
          await handle.close();
          await closeHttpServer(backend.server);
        }
      } finally {
        await rm(certDir.dir, { recursive: true, force: true });
      }
    });
  }
);

test(
  'proxy: forwards to an https backend when backend=true, leaving X-Forwarded-Proto untouched on a plain-http listener',
  { skip: !hasOpenssl ? 'openssl is not installed' : false },
  async () => {
    await withTempState(async () => {
      const certDir = await makeSelfSignedCert();
      try {
        const backend = await startHttpsHeaderEchoBackend('a', { cert: certDir.cert, key: certDir.key });

        await withState((state) => {
          const rs = ensureRepoState(state, 'https-backend-repo');
          rs.active = 'wt-a';
          rs.servers['wt-a'] = { path: '/x', branch: 'a', port: backend.port, pid: process.pid };
        });

        const repoConfig: RepoConfig = {
          path: '/repo',
          fixedPort: 0,
          portRange: [0, 0],
          serve: '',
          https: { backend: true },
        };
        const handle = await startProxy({ repoName: 'https-backend-repo', repoConfig });

        try {
          const res = await fetch(`http://127.0.0.1:${handle.port}/`);
          assert.equal(res.status, 200);
          assert.equal(res.headers.get('x-portful-worktree'), 'wt-a');
          const parsed = (await res.json()) as { label: string; headers: Record<string, string> };
          assert.equal(parsed.label, 'a');
          // The listener itself is plain http here, so existing behavior
          // (no header injected) must not change.
          assert.equal(parsed.headers['x-forwarded-proto'], undefined);
        } finally {
          await handle.close();
          await closeServer(backend.server);
        }
      } finally {
        await rm(certDir.dir, { recursive: true, force: true });
      }
    });
  }
);

test(
  'proxy: tunnels WebSocket upgrades to an https backend over TLS',
  { skip: !hasOpenssl ? 'openssl is not installed' : false },
  async () => {
    await withTempState(async () => {
      const certDir = await makeSelfSignedCert();
      try {
        const backend = await startWssBackend('a', { cert: certDir.cert, key: certDir.key });

        await withState((state) => {
          const rs = ensureRepoState(state, 'wss-repo');
          rs.active = 'wt-a';
          rs.servers['wt-a'] = { path: '/x', branch: 'a', port: backend.port, pid: process.pid };
        });

        const repoConfig: RepoConfig = {
          path: '/repo',
          fixedPort: 0,
          portRange: [0, 0],
          serve: '',
          https: { backend: true },
        };
        const handle = await startProxy({ repoName: 'wss-repo', repoConfig });

        let client: Socket | undefined;
        try {
          client = await connectRaw(handle.port);
          sendHandshake(client);
          const handshakeResponse = await readUntil(client, (buf) => buf.includes('\r\n\r\n'));
          assert.match(handshakeResponse.toString('latin1'), /^HTTP\/1\.1 101 Switching Protocols/);

          client.write('ping-payload');
          const echoed = await readUntil(client, (buf) => buf.length > 0);
          assert.equal(echoed.toString(), 'a:ping-payload');
        } finally {
          client?.destroy();
          await handle.close();
          await closeServer(backend.server);
        }
      } finally {
        await rm(certDir.dir, { recursive: true, force: true });
      }
    });
  }
);

test('proxy: startProxy fails clearly when the TLS cert/key cannot be read', async () => {
  await withTempState(async () => {
    const repoConfig: RepoConfig = {
      path: '/repo',
      fixedPort: 0,
      portRange: [0, 0],
      serve: '',
      https: { cert: '/nonexistent/portful-test-cert.pem', key: '/nonexistent/portful-test-key.pem', backend: false },
    };

    await assert.rejects(
      () => startProxy({ repoName: 'bad-cert-repo', repoConfig }),
      (err: Error) => {
        assert.match(err.message, /bad-cert-repo/);
        assert.match(err.message, /TLS/);
        return true;
      }
    );
  });
});
