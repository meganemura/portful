import { accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';

/**
 * Optional `[repos.<name>.https]` table. `cert`/`key` TLS-ify the fixed-port
 * listener itself (a mkcert-style pair, typically reused as-is from the
 * worktree servers); `backend` makes the proxy connect to the worktree
 * server over https instead of http. Either can be set independently: a
 * plain-http listener can still forward to an https backend, and a
 * TLS-terminating listener can still forward to a plain-http backend.
 */
export interface RepoHttpsConfig {
  cert?: string;
  key?: string;
  backend: boolean;
}

export interface RepoConfig {
  path: string;
  fixedPort: number;
  portRange: [number, number];
  serve: string;
  https?: RepoHttpsConfig;
}

/** Optional `[ui]` section configuring how `wtshunt ui` opens serve/proxy panes. */
export interface UiConfig {
  /**
   * Shell template overriding multiplexer auto-detection (herdr, cmux, tmux),
   * e.g. `my-launcher --name {title} {cmd}`. Substitutes `{title}`, `{cmd}`,
   * and `{cwd}`, each shell-quoted, then runs the result with `sh -c`.
   */
  open?: string;
}

/** Optional `[picker]` section configuring how `use`/`task add` prompt for a worktree. */
export interface PickerConfig {
  /**
   * Shell command overriding picker auto-detection (peco, then fzf), e.g.
   * `fzf --height 40% --reverse`. Candidate lines are written to its stdin
   * and the selected line is read from its stdout, run with `sh -c`.
   */
  command?: string;
}

export interface Config {
  repos: Record<string, RepoConfig>;
  ui?: UiConfig;
  picker?: PickerConfig;
}

const SAMPLE_CONFIG = `[repos.api]
path = "~/work/api"            # path to the repo's main checkout
fixed_port = 3000               # the port other services always talk to
port_range = [3101, 3199]       # ports handed out to individual worktrees
serve = "bundle exec rails s -p {port}"

[repos.front]
path = "~/work/front"
fixed_port = 8080
port_range = [8101, 8199]
serve = "API_URL=http://127.0.0.1:{api.port} PORT={port} npm run dev"
`;

export function getConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'wtshunt', 'config.toml');
}

function expandTilde(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export async function loadConfig(): Promise<Config> {
  const configPath = getConfigPath();

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Config file not found at ${configPath}\n\n` +
          `Create one with content like this:\n\n${SAMPLE_CONFIG}`
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse config file at ${configPath}: ${(err as Error).message}`);
  }

  return validateConfig(parsed, configPath);
}

function validateConfig(parsed: unknown, configPath: string): Config {
  if (typeof parsed !== 'object' || parsed === null || !('repos' in parsed)) {
    throw new Error(
      `Config file at ${configPath} must define a [repos.<name>] table.\n\n` +
        `Example:\n\n${SAMPLE_CONFIG}`
    );
  }

  const reposRaw = (parsed as Record<string, unknown>).repos;
  if (typeof reposRaw !== 'object' || reposRaw === null) {
    throw new Error(`"repos" must be a table in ${configPath}`);
  }

  const repos: Record<string, RepoConfig> = {};
  for (const [name, value] of Object.entries(reposRaw as Record<string, unknown>)) {
    repos[name] = validateRepoConfig(name, value, configPath);
  }

  if (Object.keys(repos).length === 0) {
    throw new Error(`No repos defined in ${configPath}.\n\nExample:\n\n${SAMPLE_CONFIG}`);
  }

  validatePortCollisions(repos, configPath);

  const uiRaw = (parsed as Record<string, unknown>).ui;
  const ui = uiRaw !== undefined ? validateUiConfig(uiRaw, configPath) : undefined;

  const pickerRaw = (parsed as Record<string, unknown>).picker;
  const picker = pickerRaw !== undefined ? validatePickerConfig(pickerRaw, configPath) : undefined;

  return {
    repos,
    ...(ui !== undefined ? { ui } : {}),
    ...(picker !== undefined ? { picker } : {}),
  };
}

function validateUiConfig(value: unknown, configPath: string): UiConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`ui must be a table in ${configPath}`);
  }
  const v = value as Record<string, unknown>;

  if (v.open !== undefined && (typeof v.open !== 'string' || v.open.length === 0)) {
    throw new Error(`ui.open must be a non-empty string in ${configPath}`);
  }

  return v.open !== undefined ? { open: v.open as string } : {};
}

function validatePickerConfig(value: unknown, configPath: string): PickerConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`picker must be a table in ${configPath}`);
  }
  const v = value as Record<string, unknown>;

  if (v.command !== undefined && (typeof v.command !== 'string' || v.command.length === 0)) {
    throw new Error(`picker.command must be a non-empty string in ${configPath}`);
  }

  return v.command !== undefined ? { command: v.command as string } : {};
}

/**
 * Static cross-repo port checks, run once every repo's own fields have
 * already validated individually: no two repos may share a `fixed_port`,
 * no two `port_range`s may overlap, and no repo's `fixed_port` may fall
 * inside any repo's `port_range` (including its own) — each of those
 * would let `wtshunt serve`'s port allocator or the fixed-port proxy
 * silently collide with another repo's traffic.
 */
function validatePortCollisions(repos: Record<string, RepoConfig>, configPath: string): void {
  const names = Object.keys(repos);

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      const ra = repos[a];
      const rb = repos[b];

      if (ra.fixedPort === rb.fixedPort) {
        throw new Error(
          `repos.${a}.fixed_port and repos.${b}.fixed_port both use port ${ra.fixedPort} in ${configPath}. ` +
            `Each repo needs its own fixed_port.`
        );
      }

      if (ra.portRange[0] <= rb.portRange[1] && rb.portRange[0] <= ra.portRange[1]) {
        throw new Error(
          `repos.${a}.port_range (${ra.portRange[0]}-${ra.portRange[1]}) and repos.${b}.port_range ` +
            `(${rb.portRange[0]}-${rb.portRange[1]}) overlap in ${configPath}. Each repo needs its own range.`
        );
      }
    }
  }

  for (const a of names) {
    const ra = repos[a];
    for (const b of names) {
      const rb = repos[b];
      if (ra.fixedPort < rb.portRange[0] || ra.fixedPort > rb.portRange[1]) {
        continue;
      }
      if (a === b) {
        throw new Error(
          `repos.${a}.fixed_port (${ra.fixedPort}) falls inside its own port_range ` +
            `(${rb.portRange[0]}-${rb.portRange[1]}) in ${configPath}. Pick a fixed_port outside that range.`
        );
      }
      throw new Error(
        `repos.${a}.fixed_port (${ra.fixedPort}) falls inside repos.${b}.port_range ` +
          `(${rb.portRange[0]}-${rb.portRange[1]}) in ${configPath}. Pick a fixed_port outside every port_range.`
      );
    }
  }
}

function validateRepoConfig(name: string, value: unknown, configPath: string): RepoConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`repos.${name} must be a table in ${configPath}`);
  }
  const v = value as Record<string, unknown>;

  if (typeof v.path !== 'string' || v.path.length === 0) {
    throw new Error(`repos.${name}.path is required and must be a string in ${configPath}`);
  }
  if (typeof v.fixed_port !== 'number' || !Number.isInteger(v.fixed_port)) {
    throw new Error(`repos.${name}.fixed_port is required and must be an integer in ${configPath}`);
  }
  if (
    !Array.isArray(v.port_range) ||
    v.port_range.length !== 2 ||
    typeof v.port_range[0] !== 'number' ||
    typeof v.port_range[1] !== 'number' ||
    v.port_range[0] > v.port_range[1]
  ) {
    throw new Error(
      `repos.${name}.port_range is required and must be [min, max] with min <= max in ${configPath}`
    );
  }
  if (typeof v.serve !== 'string' || v.serve.length === 0) {
    throw new Error(`repos.${name}.serve is required and must be a string in ${configPath}`);
  }
  if (!v.serve.includes('{port}')) {
    throw new Error(
      `repos.${name}.serve must contain the literal placeholder "{port}" in ${configPath}. ` +
        `Without it, the server won't bind the port wtshunt assigned, and "wtshunt status" and the proxy ` +
        `will have no way to know which port it actually ended up on.`
    );
  }

  const httpsRaw = v.https;
  const https = httpsRaw !== undefined ? validateHttpsConfig(name, httpsRaw, configPath) : undefined;

  return {
    path: resolve(expandTilde(v.path)),
    fixedPort: v.fixed_port,
    portRange: [v.port_range[0], v.port_range[1]],
    serve: v.serve,
    ...(https !== undefined ? { https } : {}),
  };
}

/**
 * `cert`/`key` must be set together or not at all — one without the other
 * is almost certainly a typo, so fail fast rather than silently falling
 * back to plain http. Existence (not readability of content, which happens
 * at proxy start) is checked here so a bad path surfaces at config-load
 * time rather than mid-`wtshunt proxy`.
 */
function validateHttpsConfig(name: string, value: unknown, configPath: string): RepoHttpsConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`repos.${name}.https must be a table in ${configPath}`);
  }
  const v = value as Record<string, unknown>;

  const hasCert = v.cert !== undefined;
  const hasKey = v.key !== undefined;
  if (hasCert !== hasKey) {
    throw new Error(
      `repos.${name}.https.cert and repos.${name}.https.key must both be set, or both omitted, in ${configPath}.`
    );
  }

  if (v.backend !== undefined && typeof v.backend !== 'boolean') {
    throw new Error(`repos.${name}.https.backend must be a boolean in ${configPath}`);
  }
  const backend = v.backend === true;

  if (!hasCert) {
    return { backend };
  }

  if (typeof v.cert !== 'string' || v.cert.length === 0) {
    throw new Error(`repos.${name}.https.cert must be a non-empty string in ${configPath}`);
  }
  if (typeof v.key !== 'string' || v.key.length === 0) {
    throw new Error(`repos.${name}.https.key must be a non-empty string in ${configPath}`);
  }

  const cert = resolve(expandTilde(v.cert));
  const key = resolve(expandTilde(v.key));

  for (const [label, filePath] of [
    ['cert', cert],
    ['key', key],
  ] as const) {
    try {
      accessSync(filePath, constants.R_OK);
    } catch {
      throw new Error(
        `repos.${name}.https.${label} at ${filePath} does not exist or is not readable, set in ${configPath}.`
      );
    }
  }

  return { cert, key, backend };
}
