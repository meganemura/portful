import type { Config } from './config.ts';
import { allocatePort } from './ports.ts';
import { ensureRepoState, type State } from './state.ts';

const PORT_REF_PATTERN = /\{([A-Za-z0-9_-]+)\.port\}/g;

/** Every distinct repo name referenced via `{<repo>.port}` in a serve template. */
export function parsePortRefs(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PORT_REF_PATTERN)) {
    names.add(match[1]);
  }
  return [...names];
}

/**
 * Resolves what a `{refRepoName.port}` reference expands to: the sticky
 * port for `refRepoName`'s current active worktree, allocating and
 * persisting one on the spot if it doesn't have one yet. Must be called
 * inside the same `withState` transaction as the serving repo's own port
 * allocation, so both land in a single atomic write together — otherwise a crash
 * between the two could leave the referenced repo's port assigned but the
 * server entry that depends on it never recorded, or vice versa.
 */
export async function resolvePortRef(config: Config, state: State, refRepoName: string): Promise<number> {
  const refRepoConfig = config.repos[refRepoName];
  if (!refRepoConfig) {
    const names = Object.keys(config.repos);
    throw new Error(
      `serve template references unknown repo "${refRepoName}" via {${refRepoName}.port}. ` +
        `Registered repos: ${names.length > 0 ? names.join(', ') : '(none)'}`
    );
  }

  const refState = ensureRepoState(state, refRepoName);
  const activeWorktree = refState.active;
  if (!activeWorktree) {
    throw new Error(
      `Cannot resolve {${refRepoName}.port}: repo "${refRepoName}" has no active worktree. ` +
        `Run "wtshunt use ${refRepoName}/<worktree>" or "wtshunt task use <name>" first.`
    );
  }

  const existingPort = refState.ports[activeWorktree];
  if (existingPort !== undefined) {
    return existingPort;
  }

  const port = await allocatePort({
    worktree: activeWorktree,
    portRange: refRepoConfig.portRange,
    stickyPorts: refState.ports,
  });
  refState.ports[activeWorktree] = port;
  return port;
}

/**
 * Substitutes every `{<repo>.port}` reference before the plain `{port}`
 * placeholder is substituted elsewhere: `{api.port}` does not itself
 * contain the substring `{port}`, so the two never collide, but resolving
 * references first keeps the two substitutions clearly separate.
 */
export function applyPortRefs(template: string, resolvedRefs: Record<string, number>): string {
  let result = template;
  for (const [name, port] of Object.entries(resolvedRefs)) {
    result = result.replaceAll(`{${name}.port}`, String(port));
  }
  return result;
}
