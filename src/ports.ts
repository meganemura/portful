import { createServer } from 'node:net';

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => {
      resolvePromise(false);
    });
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

export interface AllocatePortOptions {
  worktree: string;
  portRange: [number, number];
  /** Sticky worktree name -> port assignment table from state. */
  stickyPorts: Record<string, number>;
}

export async function allocatePort(options: AllocatePortOptions): Promise<number> {
  const { worktree, portRange, stickyPorts } = options;

  const sticky = stickyPorts[worktree];
  if (sticky !== undefined && (await isPortFree(sticky))) {
    return sticky;
  }

  const reservedBySiblings = new Set(
    Object.entries(stickyPorts)
      .filter(([name]) => name !== worktree)
      .map(([, port]) => port)
  );

  for (let port = portRange[0]; port <= portRange[1]; port++) {
    if (reservedBySiblings.has(port)) {
      continue;
    }
    if (await isPortFree(port)) {
      return port;
    }
  }

  throw new Error(`No free port available in range ${portRange[0]}-${portRange[1]}`);
}
