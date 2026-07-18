import { connect } from 'node:net';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RepoConfig } from './config.ts';
import { readState, type ServerEntry } from './state.ts';

export interface StartProxyOptions {
  repoName: string;
  repoConfig: RepoConfig;
}

export interface ProxyHandle {
  /** The actual bound port (equals repoConfig.fixedPort, unless that was 0). */
  port: number;
  close(): Promise<void>;
}

export async function startProxy(options: StartProxyOptions): Promise<ProxyHandle> {
  const { repoName, repoConfig } = options;

  const server: Server = createServer((req, res) => {
    void handleRequest(repoName, req, res);
  });

  // WebSocket / other Upgrade requests (ActionCable, Vite/webpack HMR, ...)
  // arrive as a separate event, not as a normal request/response pair.
  server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(repoName, req, socket, head);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(repoConfig.fixedPort, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : repoConfig.fixedPort;

  return {
    port,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

type ActiveServerLookup =
  | { ok: true; activeName: string; entry: ServerEntry }
  | { ok: false; activeName: string | undefined; message: string };

/** Shared by the normal-request and upgrade paths: find who "active" currently points at. */
async function resolveActiveServer(repoName: string): Promise<ActiveServerLookup> {
  const state = await readState();
  const rs = state.repos[repoName];
  const activeName = rs?.active;

  if (!activeName) {
    return {
      ok: false,
      activeName: undefined,
      message: `No active worktree set for repo "${repoName}". Run "wtshunt use ${repoName}/<worktree>".`,
    };
  }

  const entry = rs?.servers[activeName];
  if (!entry) {
    return {
      ok: false,
      activeName,
      message: `Server for worktree "${activeName}" is not running. Start it with "wtshunt serve".`,
    };
  }

  return { ok: true, activeName, entry };
}

async function handleRequest(repoName: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const lookup = await resolveActiveServer(repoName);
  if (!lookup.ok) {
    send502(res, lookup.activeName, lookup.message);
    return;
  }
  const { activeName, entry } = lookup;

  const proxyReq = httpRequest(
    {
      host: '127.0.0.1',
      port: entry.port,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (proxyRes) => {
      res.setHeader('X-Wtshunt-Worktree', activeName);
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', () => {
    send502(
      res,
      activeName,
      `Failed to reach server for worktree "${activeName}" on port ${entry.port}. Start it with "wtshunt serve".`
    );
  });

  req.pipe(proxyReq);
}

function send502(res: ServerResponse, worktree: string | undefined, message: string): void {
  res.setHeader('X-Wtshunt-Worktree', worktree ?? '(none)');
  res.writeHead(502, { 'Content-Type': 'text/plain' });
  res.end(message);
}

/**
 * Forwards a WebSocket (or other Upgrade) handshake to whichever worktree is
 * active *at the time the connection is opened*. An already-established
 * connection is not moved if `use` switches the active worktree afterward —
 * only the next new connection picks up the change. That's deliberate: there
 * is no clean way to migrate a live socket, and clients that reconnect on
 * their own (ActionCable, HMR) pick up the new target the moment they do.
 *
 * The 101 response from upstream is relayed byte-for-byte; unlike the plain
 * HTTP path, no `X-Wtshunt-Worktree` header is injected into it, since doing
 * that would require parsing and rewriting the raw handshake response for a
 * benefit that doesn't justify the complexity.
 */
async function handleUpgrade(repoName: string, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const lookup = await resolveActiveServer(repoName);
  if (!lookup.ok) {
    sendRawBadGateway(socket, lookup.message);
    return;
  }
  const { activeName, entry } = lookup;

  const upstream = connect(entry.port, '127.0.0.1');
  let connected = false;
  let torndown = false;

  // A raw byte tunnel has no meaningful "half-closed" state worth preserving:
  // once either side is done — gracefully ('end'), abruptly ('close' without
  // a prior 'end', e.g. a reset), or by erroring out — tear down both, so
  // neither socket outlives the other. This matters even for a graceful
  // close: 'end' alone doesn't imply 'close' will ever follow (a socket that
  // received EOF but was never itself ended or destroyed stays half-open
  // indefinitely), which would otherwise wedge `server.close()` forever on
  // an upgraded connection whose client end already went away.
  const teardown = () => {
    if (torndown) {
      return;
    }
    torndown = true;
    socket.destroy();
    upstream.destroy();
  };

  upstream.once('connect', () => {
    connected = true;

    const requestLines = [`${req.method} ${req.url} HTTP/1.1`];
    // rawHeaders is a flat [name, value, name, value, ...] array that
    // preserves original casing and duplicate header lines, unlike the
    // folded/lowercased `req.headers` object.
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      requestLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(requestLines.join('\r\n') + '\r\n\r\n');
    if (head.length > 0) {
      upstream.write(head);
    }

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.once('error', () => {
    if (connected) {
      teardown();
    } else {
      sendRawBadGateway(
        socket,
        `Failed to reach server for worktree "${activeName}" on port ${entry.port}. Start it with "wtshunt serve".`
      );
      upstream.destroy();
    }
  });

  socket.once('error', teardown);
  socket.once('end', teardown);
  socket.once('close', teardown);
  upstream.once('end', teardown);
  upstream.once('close', teardown);
}

function sendRawBadGateway(socket: Duplex, message: string): void {
  socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\n${message}`);
}
