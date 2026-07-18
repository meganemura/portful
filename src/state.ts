import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ServerEntry {
  path: string;
  branch: string;
  port: number;
  pid: number;
}

export interface ProxyEntry {
  pid: number;
  port: number;
}

export interface RepoState {
  active?: string;
  ports: Record<string, number>;
  servers: Record<string, ServerEntry>;
  proxy?: ProxyEntry;
}

export interface State {
  repos: Record<string, RepoState>;
}

export function getStatePath(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'wtshunt', 'state.json');
}

function emptyState(): State {
  return { repos: {} };
}

export function ensureRepoState(state: State, repo: string): RepoState {
  let repoState = state.repos[repo];
  if (!repoState) {
    repoState = { ports: {}, servers: {} };
    state.repos[repo] = repoState;
  }
  if (!repoState.ports) {
    repoState.ports = {};
  }
  if (!repoState.servers) {
    repoState.servers = {};
  }
  return repoState;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function cleanupDeadEntries(state: State): State {
  for (const repoState of Object.values(state.repos)) {
    if (repoState.servers) {
      for (const [name, entry] of Object.entries(repoState.servers)) {
        if (!isAlive(entry.pid)) {
          delete repoState.servers[name];
        }
      }
    }
    if (repoState.proxy && !isAlive(repoState.proxy.pid)) {
      delete repoState.proxy;
    }
  }
  return state;
}

export async function readState(): Promise<State> {
  const statePath = getStatePath();

  let raw: string;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyState();
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as State;
  if (!parsed.repos) {
    parsed.repos = {};
  }
  return cleanupDeadEntries(parsed);
}

async function writeStateRaw(state: State): Promise<void> {
  const statePath = getStatePath();
  const dir = dirname(statePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.state.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmpPath, JSON.stringify(state, null, 2));
  await rename(tmpPath, statePath);
}

const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function acquireLock(lockPath: string): Promise<void> {
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // Lock file disappeared between our check and now; retry immediately.
        continue;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

/**
 * Serializes read-modify-write access to the state file across concurrent
 * wtshunt invocations using a lockfile (created with the `wx` flag).
 */
export async function withState<T>(mutator: (state: State) => T | Promise<T>): Promise<T> {
  const statePath = getStatePath();
  const dir = dirname(statePath);
  await mkdir(dir, { recursive: true });

  const lockPath = join(dir, 'state.lock');
  await acquireLock(lockPath);
  try {
    const state = await readState();
    const result = await mutator(state);
    await writeStateRaw(state);
    return result;
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * Best-effort synchronous cleanup for use in `process.on('exit', ...)`
 * handlers, where async work is not possible. Only removes the proxy entry
 * if it still belongs to this process, and is not lock-protected.
 */
export function removeProxyEntrySync(repo: string, pid: number): void {
  const statePath = getStatePath();
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch {
    return;
  }

  let state: State;
  try {
    state = JSON.parse(raw) as State;
  } catch {
    return;
  }

  const repoState = state.repos[repo];
  if (repoState?.proxy?.pid === pid) {
    delete repoState.proxy;
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch {
      // best-effort
    }
  }
}
