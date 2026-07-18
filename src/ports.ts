import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface BindAttempt {
  ok: boolean;
  code?: string;
}

function tryListen(port: number, host: string): Promise<BindAttempt> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', (err) => {
      resolvePromise({ ok: false, code: (err as NodeJS.ErrnoException).code });
    });
    server.listen({ port, host }, () => {
      server.close(() => resolvePromise({ ok: true }));
    });
  });
}

/**
 * A single bind test on `127.0.0.1` lets a process listening on `0.0.0.0` or
 * on an IPv6-only address slip past undetected, leaving two processes bound
 * to what wtshunt thinks is one free port. Binding the IPv4 and IPv6
 * wildcard addresses instead catches both; only a genuine "IPv6 isn't
 * available on this machine at all" error (EAFNOSUPPORT) is excused, since
 * that isn't evidence the port itself is taken.
 */
export async function isPortFree(port: number): Promise<boolean> {
  const ipv4 = await tryListen(port, '0.0.0.0');
  if (!ipv4.ok) {
    return false;
  }

  const ipv6 = await tryListen(port, '::');
  if (ipv6.ok) {
    return true;
  }

  return ipv6.code === 'EAFNOSUPPORT';
}

/** Describes whatever process is listening on `port` (via `lsof`), if any. */
export async function findPortOccupant(port: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
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
