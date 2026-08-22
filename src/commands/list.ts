import { buildOverview, type Overview } from '../overview.ts';

/**
 * `list` answers one question: for each repo, what address do clients use
 * and where does that address currently go. It is the counterpart of
 * portless's `list`, which prints the routes its proxy serves.
 *
 * `status` stays the fuller per-repo view (every worktree's server, every
 * task, stale wiring). This command deliberately prints one row per repo so
 * the answer fits on one screen.
 */
export interface ListArgs {
  json?: boolean;
}

export interface ListRoute {
  name: string;
  address: string;
  /** The worktree the address currently resolves to, or undefined when no worktree is active. */
  target?: string;
  /** The port that worktree's server listens on, or undefined when it has no server running. */
  targetPort?: number;
  proxyRunning: boolean;
}

export function buildRoutes(overview: Overview): ListRoute[] {
  return overview.repos.map((repo) => {
    // The listener terminates TLS only when the repo configures a cert/key
    // pair, so the scheme a client must type follows that pair.
    const scheme = repo.tls ? 'https' : 'http';
    const route: ListRoute = {
      name: repo.name,
      address: `${scheme}://127.0.0.1:${repo.fixedPort}`,
      proxyRunning: repo.proxy !== undefined,
    };
    if (repo.active !== undefined) {
      route.target = repo.active;
      const port = repo.servers[repo.active]?.port;
      if (port !== undefined) {
        route.targetPort = port;
      }
    }
    return route;
  });
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function formatRoutes(routes: ListRoute[]): string[] {
  if (routes.length === 0) {
    return ['No repos configured.'];
  }

  const rows = routes.map((route) => {
    let target: string;
    if (route.target === undefined) {
      target = '(no active worktree)';
    } else if (route.targetPort === undefined) {
      target = `${route.target} (no server)`;
    } else {
      target = `${route.target} :${route.targetPort}`;
    }
    return [route.name, route.address, target, route.proxyRunning ? 'running' : 'stopped'];
  });

  const header = ['NAME', 'ADDRESS', 'TARGET', 'PROXY'];
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i].length)));

  // The last column carries no trailing padding, so the line ends at the text.
  const line = (cells: string[]) => cells.map((cell, i) => (i === cells.length - 1 ? cell : pad(cell, widths[i]))).join('  ');

  return [line(header), ...rows.map(line)];
}

export async function listCommand(args: ListArgs = {}): Promise<void> {
  const overview = await buildOverview();
  const routes = buildRoutes(overview);

  if (args.json) {
    console.log(JSON.stringify({ routes }));
    return;
  }

  for (const line of formatRoutes(routes)) {
    console.log(line);
  }
}
