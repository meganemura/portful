import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RepoConfig } from './config.ts';
import { readState } from './state.ts';

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

async function handleRequest(repoName: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const state = await readState();
  const rs = state.repos[repoName];
  const activeName = rs?.active;

  if (!activeName) {
    send502(res, undefined, `No active worktree set for repo "${repoName}". Run "wtshunt use ${repoName}/<worktree>".`);
    return;
  }

  const entry = rs?.servers[activeName];
  if (!entry) {
    send502(res, activeName, `Server for worktree "${activeName}" is not running. Start it with "wtshunt serve".`);
    return;
  }

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
