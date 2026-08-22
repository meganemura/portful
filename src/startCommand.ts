import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How a worktree server gets started when the config carries no `serve`
 * template. portless reaches zero config by running the project's own dev
 * script with `PORT` in the environment, and this module is the same idea:
 * find the script, find the package manager that should run it, and hand
 * back an argv.
 *
 * Boundary: this module decides *what* to run. Allocating the port, spawning
 * the process, and recording it belong to `serve`.
 */

/** The lockfile each package manager writes, checked in this order so a repo carrying two lockfiles resolves the same way every time. */
const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

export async function detectPackageManager(dir: string): Promise<string> {
  for (const [lockfile, manager] of LOCKFILES) {
    try {
      await readFile(join(dir, lockfile));
      return manager;
    } catch {
      // Not this one; try the next.
    }
  }
  return 'npm';
}

export interface PackageScripts {
  scripts?: Record<string, string>;
}

async function readPackageScripts(dir: string): Promise<Record<string, string> | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'package.json'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as PackageScripts;
    return typeof parsed.scripts === 'object' && parsed.scripts !== null ? parsed.scripts : undefined;
  } catch {
    // A package.json that does not parse is the project's problem to fix; it
    // just means there is no script to find here.
    return undefined;
  }
}

/** The script name used when the config names none, matching portless's default. */
export const DEFAULT_SCRIPT = 'dev';

export type ScriptResolution =
  | { found: true; command: string[]; script: string; manager: string }
  | { found: false; script: string; available: string[] };

/**
 * Resolves the argv that runs a worktree's dev script. A named script that
 * the project does not define is reported with the list of scripts it does
 * define, since a typo is the likely cause.
 */
export async function resolveScriptCommand(worktreePath: string, script?: string): Promise<ScriptResolution> {
  const wanted = script ?? DEFAULT_SCRIPT;
  const scripts = (await readPackageScripts(worktreePath)) ?? {};

  if (scripts[wanted] === undefined) {
    return { found: false, script: wanted, available: Object.keys(scripts) };
  }

  const manager = await detectPackageManager(worktreePath);
  return { found: true, command: [manager, 'run', wanted], script: wanted, manager };
}
