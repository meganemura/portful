import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SCRIPT, detectPackageManager, resolveScriptCommand } from '../src/startCommand.ts';

async function withDir<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'portful-start-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('detectPackageManager: each lockfile selects its own manager', async () => {
  for (const [lockfile, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ] as const) {
    await withDir({ [lockfile]: '' }, async (dir) => {
      assert.equal(await detectPackageManager(dir), manager, `${lockfile} should select ${manager}`);
    });
  }
});

test('detectPackageManager: no lockfile falls back to npm', async () => {
  await withDir({}, async (dir) => {
    assert.equal(await detectPackageManager(dir), 'npm');
  });
});

test('detectPackageManager: two lockfiles resolve the same way every time', async () => {
  await withDir({ 'pnpm-lock.yaml': '', 'package-lock.json': '' }, async (dir) => {
    assert.equal(await detectPackageManager(dir), 'pnpm');
  });
});

test('resolveScriptCommand: finds the default dev script and pairs it with the detected manager', async () => {
  await withDir(
    { 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }), 'pnpm-lock.yaml': '' },
    async (dir) => {
      const result = await resolveScriptCommand(dir);
      assert.deepEqual(result, { found: true, command: ['pnpm', 'run', 'dev'], script: DEFAULT_SCRIPT, manager: 'pnpm' });
    }
  );
});

test('resolveScriptCommand: a named script overrides the default', async () => {
  await withDir({ 'package.json': JSON.stringify({ scripts: { dev: 'vite', start: 'node server.js' } }) }, async (dir) => {
    const result = await resolveScriptCommand(dir, 'start');
    assert.equal(result.found && result.command.join(' '), 'npm run start');
  });
});

test('resolveScriptCommand: a missing script reports the scripts the project does define', async () => {
  await withDir({ 'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' } }) }, async (dir) => {
    const result = await resolveScriptCommand(dir, 'dev');
    assert.equal(result.found, false);
    assert.equal(!result.found && result.script, 'dev');
    assert.deepEqual(!result.found && result.available, ['build', 'test']);
  });
});

test('resolveScriptCommand: no package.json at all reports nothing available', async () => {
  await withDir({}, async (dir) => {
    const result = await resolveScriptCommand(dir);
    assert.equal(result.found, false);
    assert.deepEqual(!result.found && result.available, []);
  });
});

test('resolveScriptCommand: a package.json that does not parse reports nothing available', async () => {
  await withDir({ 'package.json': '{ "scripts": ' }, async (dir) => {
    const result = await resolveScriptCommand(dir);
    assert.equal(result.found, false);
  });
});
