import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  formatVersionString,
  readCommitHash,
  readPackageVersion,
  resolveRepoRootFromBin,
} from '../src/version.ts';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'wtshunt.js');
const repoRoot = join(here, '..');

test('formatVersionString: appends the hash in parens when present, else just the version', () => {
  assert.equal(formatVersionString('0.1.0', 'abc1234'), '0.1.0 (abc1234)');
  assert.equal(formatVersionString('0.1.0', undefined), '0.1.0');
});

test('resolveRepoRootFromBin: resolves one directory up from the real bin path', () => {
  const resolved = resolveRepoRootFromBin(binPath);
  // Compare basenames rather than exact string equality: repoRoot here is
  // "test/../" (unresolved), while resolveRepoRootFromBin follows the real
  // path — both should land on the same real directory.
  assert.equal(resolved && join(resolved, 'package.json'), join(repoRoot, 'package.json'));
});

test('resolveRepoRootFromBin: undefined for a missing bin arg or a nonexistent path', () => {
  assert.equal(resolveRepoRootFromBin(undefined), undefined);
  assert.equal(resolveRepoRootFromBin('/nonexistent/path/to/bin.js'), undefined);
});

test("readPackageVersion: reads this repo's own package.json version, falls back to 0.0.0 otherwise", async () => {
  const version = readPackageVersion(repoRoot);
  assert.match(version, /^\d+\.\d+\.\d+$/);

  assert.equal(readPackageVersion(undefined), '0.0.0');

  const empty = await mkdtemp(join(tmpdir(), 'wtshunt-version-nopackage-'));
  try {
    assert.equal(readPackageVersion(empty), '0.0.0');
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("readCommitHash: this repo's HEAD short hash matches [0-9a-f]+, undefined outside a git repo", async () => {
  const hash = readCommitHash(repoRoot);
  assert.match(hash ?? '', /^[0-9a-f]+$/);

  assert.equal(readCommitHash(undefined), undefined);

  const notARepo = await mkdtemp(join(tmpdir(), 'wtshunt-version-notrepo-'));
  try {
    assert.equal(readCommitHash(notARepo), undefined);
  } finally {
    await rm(notARepo, { recursive: true, force: true });
  }
});

test('wtshunt --version: prints "<semver> (<hash>)", overriding the plain package.json default', async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, '--version'], { env: process.env });
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+ \([0-9a-f]+\)$/);
});
