import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';

export interface RepoConfig {
  path: string;
  fixedPort: number;
  portRange: [number, number];
  serve: string;
}

export interface Config {
  repos: Record<string, RepoConfig>;
}

const SAMPLE_CONFIG = `[repos.api]
path = "~/work/api"
fixed_port = 3000
port_range = [3101, 3199]
serve = "bundle exec rails s -p {port}"
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

  return { repos };
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

  return {
    path: resolve(expandTilde(v.path)),
    fixedPort: v.fixed_port,
    portRange: [v.port_range[0], v.port_range[1]],
    serve: v.serve,
  };
}
