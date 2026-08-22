import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { getConfigPath, getLegacyConfigPath, repoConfigPath } from '../config.ts';

/**
 * Converts the TOML config this tool read before the move to JSON.
 *
 * Everything lands in the user-level JSON file, including the per-repo
 * settings that could now live inside each repo. Writing one file is the
 * conversion with the fewest ways to go wrong, and the printed hint tells
 * the reader how to move settings into a repo afterwards.
 */
export interface MigrateArgs {
  force?: boolean;
}

/** Renames the snake_case TOML keys to the camelCase the JSON config uses. Unknown keys pass through untouched, so a hand-added key is not silently dropped. */
export function convertRepoTable(table: Record<string, unknown>): Record<string, unknown> {
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(table)) {
    if (key === 'fixed_port') {
      renamed.fixedPort = value;
    } else if (key === 'port_range') {
      renamed.portRange = value;
    } else {
      renamed[key] = value;
    }
  }
  return renamed;
}

export function convertConfig(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const repos = parsed.repos;
  if (typeof repos === 'object' && repos !== null && !Array.isArray(repos)) {
    const converted: Record<string, unknown> = {};
    for (const [name, table] of Object.entries(repos as Record<string, unknown>)) {
      converted[name] =
        typeof table === 'object' && table !== null && !Array.isArray(table)
          ? convertRepoTable(table as Record<string, unknown>)
          : table;
    }
    out.repos = converted;
  }

  for (const key of ['ui', 'picker']) {
    if (parsed[key] !== undefined) {
      out[key] = parsed[key];
    }
  }

  return out;
}

export async function migrateCommand(args: MigrateArgs = {}): Promise<void> {
  const legacyPath = getLegacyConfigPath();
  const configPath = getConfigPath();

  let raw: string;
  try {
    raw = await readFile(legacyPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No TOML config to convert at ${legacyPath}.`);
    }
    throw err;
  }

  if (!args.force) {
    try {
      await readFile(configPath, 'utf8');
      throw new Error(`${configPath} already exists. Move it aside, or rerun with --force to overwrite it.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${legacyPath}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${legacyPath} does not contain a TOML table.`);
  }

  const converted = convertConfig(parsed as Record<string, unknown>);
  await writeFile(configPath, `${JSON.stringify(converted, null, 2)}\n`, 'utf8');

  const repoNames = Object.keys((converted.repos as Record<string, unknown>) ?? {});
  console.log(`Converted ${legacyPath} to ${configPath}.`);
  console.log(`Repos carried over: ${repoNames.length > 0 ? repoNames.join(', ') : '(none)'}`);
  console.log('');
  console.log('The old TOML file is left in place. Delete it once the new config works.');
  if (repoNames.length > 0) {
    const example = (converted.repos as Record<string, Record<string, unknown>>)[repoNames[0]];
    const examplePath = typeof example?.path === 'string' ? example.path : '<repo>';
    console.log(
      `Per-repo settings (fixedPort, portRange, serve, https) can move into each repo, ` +
        `for example ${repoConfigPath(examplePath)}, so contributors get them from the checkout.`
    );
  }
}
