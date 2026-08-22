import { accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Config lives at two levels, the way portless splits its own.
 *
 * The user-level file registers which repos exist and where their checkouts
 * are, which no file inside a repo can state about itself. It also holds
 * `ui` and `picker`, which describe the machine rather than the project.
 *
 * The repo-level file (`portful.json`, or a `"portful"` key in
 * `package.json`) holds what belongs to the project: the fixed port the team
 * agrees on, the port range, the serve command. Committing it hands a new
 * contributor a working setup.
 *
 * Precedence is one rule: the user-level entry wins over both repo-level
 * sources, and the `package.json` key wins over `portful.json`, matching
 * portless. The machine owner beats the repo's suggestion, because ports are
 * allocated per machine.
 */

/**
 * Optional `https` object. `cert`/`key` TLS-ify the fixed-port listener
 * itself (a mkcert-style pair, typically reused as-is from the worktree
 * servers); `backend` makes the proxy connect to the worktree server over
 * https instead of http. Either can be set independently: a plain-http
 * listener can still forward to an https backend, and a TLS-terminating
 * listener can still forward to a plain-http backend.
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
  /**
   * Shell template for starting a server, with `{port}` substituted.
   * Optional: a server that reads the injected `PORT` needs no template, and
   * `portful <repo> <cmd...>` supplies its own command.
   */
  serve?: string;
  https?: RepoHttpsConfig;
}

/** Optional `ui` object configuring how `portful ui` opens serve/proxy panes. */
export interface UiConfig {
  /**
   * Shell template overriding multiplexer auto-detection (herdr, cmux, tmux),
   * e.g. `my-launcher --name {title} {cmd}`. Substitutes `{title}`, `{cmd}`,
   * and `{cwd}`, each shell-quoted, then runs the result with `sh -c`.
   */
  open?: string;
}

/** Optional `picker` object configuring how `use`/`task add` prompt for a worktree. */
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

const SAMPLE_CONFIG = `{
  "repos": {
    "api":   { "path": "~/work/api" },
    "front": { "path": "~/work/front" }
  }
}

Then, in each repo's checkout, a portful.json like:

{
  "fixedPort": 3000,
  "portRange": [3101, 3199],
  "serve": "bundle exec rails s -p {port}"
}
`;

export function getConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'portful', 'config.json');
}

/** Where the TOML config lived before the move to JSON, so `migrate` and the not-found message can point at it. */
export function getLegacyConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'portful', 'config.toml');
}

export function repoConfigPath(repoPath: string): string {
  return join(repoPath, 'portful.json');
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

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

/** Every place a repo's settings can come from, named in error messages so the reader knows where to look. */
function sourceList(userPath: string, repoPath: string): string {
  return `${userPath}, ${repoConfigPath(repoPath)}, or the "portful" key of ${join(repoPath, 'package.json')}`;
}

export async function loadConfig(): Promise<Config> {
  const configPath = getConfigPath();

  const userRaw = await readJsonFile(configPath);
  if (userRaw === undefined) {
    const legacy = getLegacyConfigPath();
    let legacyHint = '';
    try {
      accessSync(legacy, constants.R_OK);
      legacyHint = `\n\nA TOML config still exists at ${legacy}. Run "portful migrate" to convert it.`;
    } catch {
      // No legacy config either, so the sample above is the whole answer.
    }
    throw new Error(
      `Config file not found at ${configPath}\n\nCreate one with content like this:\n\n${SAMPLE_CONFIG}${legacyHint}`
    );
  }

  const reposRaw = userRaw.repos;
  if (typeof reposRaw !== 'object' || reposRaw === null || Array.isArray(reposRaw)) {
    throw new Error(`"repos" must be an object in ${configPath}`);
  }

  const entries = Object.entries(reposRaw as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(`No repos defined in ${configPath}.\n\nExample:\n\n${SAMPLE_CONFIG}`);
  }

  const repos: Record<string, RepoConfig> = {};
  for (const [name, value] of entries) {
    repos[name] = await loadRepoConfig(name, value, configPath);
  }

  validatePortCollisions(repos, configPath);

  const ui = userRaw.ui !== undefined ? validateUiConfig(userRaw.ui, configPath) : undefined;
  const picker = userRaw.picker !== undefined ? validatePickerConfig(userRaw.picker, configPath) : undefined;

  return {
    repos,
    ...(ui !== undefined ? { ui } : {}),
    ...(picker !== undefined ? { picker } : {}),
  };
}

/**
 * Merges one repo's three possible sources and validates the result. `path`
 * comes from the user-level entry alone, since a file inside a checkout
 * cannot say where that checkout is.
 */
async function loadRepoConfig(name: string, value: unknown, configPath: string): Promise<RepoConfig> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`repos.${name} must be an object in ${configPath}`);
  }
  const userEntry = value as Record<string, unknown>;

  if (typeof userEntry.path !== 'string' || userEntry.path.length === 0) {
    throw new Error(`repos.${name}.path is required and must be a string in ${configPath}`);
  }
  const repoPath = resolve(expandTilde(userEntry.path));

  const repoFile = (await readJsonFile(repoConfigPath(repoPath))) ?? {};

  const packageJson = await readJsonFile(join(repoPath, 'package.json'));
  let packageKey: Record<string, unknown> = {};
  if (packageJson?.portful !== undefined) {
    const key = packageJson.portful;
    if (typeof key !== 'object' || key === null || Array.isArray(key)) {
      throw new Error(`The "portful" key of ${join(repoPath, 'package.json')} must be an object.`);
    }
    packageKey = key as Record<string, unknown>;
  }

  // One rule: the user-level entry wins, then the package.json key, then the
  // repo file. `path` is excluded, since only the user level sets it.
  const { path: _path, ...userOverrides } = userEntry;
  const merged: Record<string, unknown> = { ...repoFile, ...packageKey, ...userOverrides };

  const where = sourceList(configPath, repoPath);

  if (merged.name !== undefined && merged.name !== name) {
    throw new Error(
      `Repo "${name}" is registered under that name in ${configPath}, but "name" is set to ` +
        `"${String(merged.name)}" in ${repoConfigPath(repoPath)}. Use the same name in both, or drop one.`
    );
  }

  if (typeof merged.fixedPort !== 'number' || !Number.isInteger(merged.fixedPort)) {
    throw new Error(`repos.${name}: "fixedPort" is required and must be an integer. Set it in ${where}.`);
  }
  if (
    !Array.isArray(merged.portRange) ||
    merged.portRange.length !== 2 ||
    typeof merged.portRange[0] !== 'number' ||
    typeof merged.portRange[1] !== 'number' ||
    merged.portRange[0] > merged.portRange[1]
  ) {
    throw new Error(
      `repos.${name}: "portRange" is required and must be [min, max] with min <= max. Set it in ${where}.`
    );
  }

  let serve: string | undefined;
  if (merged.serve !== undefined) {
    if (typeof merged.serve !== 'string' || merged.serve.length === 0) {
      throw new Error(`repos.${name}: "serve" must be a non-empty string. Set it in ${where}.`);
    }
    if (!merged.serve.includes('{port}')) {
      throw new Error(
        `repos.${name}: "serve" must contain the literal placeholder "{port}". Set in ${where}. ` +
          `Without it, the server binds whatever port its framework defaults to, while "portful status" and ` +
          `the proxy keep believing it is on the assigned one. A server that reads the PORT environment ` +
          `variable instead can omit "serve" entirely.`
      );
    }
    serve = merged.serve;
  }

  const https = merged.https !== undefined ? validateHttpsConfig(name, merged.https, where) : undefined;

  return {
    path: repoPath,
    fixedPort: merged.fixedPort,
    portRange: [merged.portRange[0], merged.portRange[1]],
    ...(serve !== undefined ? { serve } : {}),
    ...(https !== undefined ? { https } : {}),
  };
}

function validateUiConfig(value: unknown, configPath: string): UiConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`ui must be an object in ${configPath}`);
  }
  const v = value as Record<string, unknown>;

  if (v.open !== undefined && (typeof v.open !== 'string' || v.open.length === 0)) {
    throw new Error(`ui.open must be a non-empty string in ${configPath}`);
  }

  return v.open !== undefined ? { open: v.open as string } : {};
}

function validatePickerConfig(value: unknown, configPath: string): PickerConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`picker must be an object in ${configPath}`);
  }
  const v = value as Record<string, unknown>;

  if (v.command !== undefined && (typeof v.command !== 'string' || v.command.length === 0)) {
    throw new Error(`picker.command must be a non-empty string in ${configPath}`);
  }

  return v.command !== undefined ? { command: v.command as string } : {};
}

/**
 * Static cross-repo port checks, run once every repo's own fields have
 * already validated individually: no two repos may share a `fixedPort`,
 * no two `portRange`s may overlap, and no repo's `fixedPort` may fall
 * inside any repo's `portRange` (including its own) — each of those
 * would let `portful serve`'s port allocator or the fixed-port proxy
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
          `repos.${a} and repos.${b} both resolve to fixedPort ${ra.fixedPort} (see ${configPath} and each ` +
            `repo's own portful.json). Each repo needs its own fixedPort.`
        );
      }

      if (ra.portRange[0] <= rb.portRange[1] && rb.portRange[0] <= ra.portRange[1]) {
        throw new Error(
          `repos.${a}.portRange (${ra.portRange[0]}-${ra.portRange[1]}) and repos.${b}.portRange ` +
            `(${rb.portRange[0]}-${rb.portRange[1]}) overlap. Each repo needs its own range.`
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
          `repos.${a}.fixedPort (${ra.fixedPort}) falls inside its own portRange ` +
            `(${rb.portRange[0]}-${rb.portRange[1]}). Pick a fixedPort outside that range.`
        );
      }
      throw new Error(
        `repos.${a}.fixedPort (${ra.fixedPort}) falls inside repos.${b}.portRange ` +
          `(${rb.portRange[0]}-${rb.portRange[1]}). Pick a fixedPort outside every portRange.`
      );
    }
  }
}

/**
 * `cert`/`key` must be set together or not at all — one without the other
 * is almost certainly a typo, so fail fast rather than silently falling
 * back to plain http. Existence (not readability of content, which happens
 * at proxy start) is checked here so a bad path surfaces at config-load
 * time rather than mid-`portful proxy start`.
 */
function validateHttpsConfig(name: string, value: unknown, where: string): RepoHttpsConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`repos.${name}: "https" must be an object. Set in ${where}.`);
  }
  const v = value as Record<string, unknown>;

  const hasCert = v.cert !== undefined;
  const hasKey = v.key !== undefined;
  if (hasCert !== hasKey) {
    throw new Error(
      `repos.${name}: "https.cert" and "https.key" must both be set, or both omitted. Set in ${where}.`
    );
  }

  if (v.backend !== undefined && typeof v.backend !== 'boolean') {
    throw new Error(`repos.${name}: "https.backend" must be a boolean. Set in ${where}.`);
  }
  const backend = v.backend === true;

  if (!hasCert) {
    return { backend };
  }

  if (typeof v.cert !== 'string' || v.cert.length === 0) {
    throw new Error(`repos.${name}: "https.cert" must be a non-empty string. Set in ${where}.`);
  }
  if (typeof v.key !== 'string' || v.key.length === 0) {
    throw new Error(`repos.${name}: "https.key" must be a non-empty string. Set in ${where}.`);
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
        `repos.${name}: "https.${label}" at ${filePath} does not exist or is not readable. Set in ${where}.`
      );
    }
  }

  return { cert, key, backend };
}
