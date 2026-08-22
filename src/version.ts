import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * portful's own repo root, resolved from the *real* path of the running
 * bin script (following the symlink `npm link` creates) rather than
 * `argv[1]` as typed — so `--version` finds the right package.json/.git
 * regardless of how it was installed. `undefined` if `binArg` is missing
 * or doesn't resolve to a real file.
 */
export function resolveRepoRootFromBin(binArg: string | undefined): string | undefined {
  if (!binArg) {
    return undefined;
  }
  try {
    const real = realpathSync(binArg);
    // bin/portful.js -> repo root is one directory up from bin/.
    return join(dirname(real), '..');
  } catch {
    return undefined;
  }
}

/** package.json's version field, or "0.0.0" if it can't be read (never throws). */
export function readPackageVersion(repoRoot: string | undefined): string {
  if (!repoRoot) {
    return '0.0.0';
  }
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The short commit hash of `repoRoot`'s HEAD, or `undefined` if git isn't
 * available, `repoRoot` isn't a git checkout, or anything else goes wrong
 * — this is purely cosmetic for `--version`, never an error. Fully local
 * (`git rev-parse`), no network access.
 */
export function readCommitHash(repoRoot: string | undefined): string | undefined {
  if (!repoRoot) {
    return undefined;
  }
  try {
    const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return hash.length > 0 ? hash : undefined;
  } catch {
    return undefined;
  }
}

export function formatVersionString(version: string, commitHash: string | undefined): string {
  return commitHash ? `${version} (${commitHash})` : version;
}

/** The full `--version` string, e.g. `0.1.0 (abc1234)`, or just `0.1.0` if the commit hash can't be determined. */
export function computeVersionString(binArg: string | undefined = process.argv[1]): string {
  const repoRoot = resolveRepoRootFromBin(binArg);
  return formatVersionString(readPackageVersion(repoRoot), readCommitHash(repoRoot));
}
