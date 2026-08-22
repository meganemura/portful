import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickOne, resolvePickerKind } from '../src/picker.ts';
import type { Config } from '../src/config.ts';

const EMPTY_CONFIG: Config = { repos: {} };

// `pecoBin`/`fzfBin` stand in for the real binaries throughout: 'ls' is a
// real, always-on-PATH executable used as a harmless "found" stand-in, and a
// made-up name simulates "not found" — the same injection pattern already
// used for the mux adapters, so these tests never depend on whether peco or
// fzf actually happen to be installed on the machine running them.
const MISSING_BIN = 'portful-definitely-not-a-real-binary-xyz';

test('resolvePickerKind: an explicit [picker].command always wins', async () => {
  const config: Config = { repos: {}, picker: { command: 'fzf' } };
  const kind = await resolvePickerKind({ config, pecoBin: 'ls', fzfBin: 'ls' });
  assert.equal(kind, 'config');
});

test('resolvePickerKind: peco wins over fzf when no config command is set', async () => {
  const kind = await resolvePickerKind({ config: EMPTY_CONFIG, pecoBin: 'ls', fzfBin: 'ls' });
  assert.equal(kind, 'peco');
});

test('resolvePickerKind: fzf wins when peco is not on $PATH', async () => {
  const kind = await resolvePickerKind({ config: EMPTY_CONFIG, pecoBin: MISSING_BIN, fzfBin: 'ls' });
  assert.equal(kind, 'fzf');
});

test('resolvePickerKind: falls back to the numbered prompt when neither peco nor fzf is found', async () => {
  const kind = await resolvePickerKind({ config: EMPTY_CONFIG, pecoBin: MISSING_BIN, fzfBin: MISSING_BIN });
  assert.equal(kind, 'numbered');
});

test('resolvePickerKind: works with no config at all, not just an empty one', async () => {
  const kind = await resolvePickerKind({ pecoBin: MISSING_BIN, fzfBin: 'ls' });
  assert.equal(kind, 'fzf');
});

async function withConfig<T>(picker: { command?: string } | undefined, fn: () => Promise<T>): Promise<T> {
  const configDir = await mkdtemp(join(tmpdir(), 'portful-picker-config-'));
  await mkdir(join(configDir, 'portful'), { recursive: true });
  await writeFile(
    join(configDir, 'portful', 'config.json'),
    JSON.stringify({
      repos: {
        b: { path: '/tmp/b', fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' },
      },
      ...(picker ? { picker } : {}),
    })
  );

  const original = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configDir;
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = original;
    }
    await rm(configDir, { recursive: true, force: true });
  }
}

const CANDIDATES = [
  { columns: ['main', 'main', '3101'] },
  { columns: ['feature-x', 'feature/x', '3102'] },
];

test('pickOne: an external [picker] command receives candidates via stdin and returns the selected value', async () => {
  await withConfig({ command: 'head -n 1' }, async () => {
    const chosen = await pickOne(CANDIDATES);
    assert.equal(chosen, 'main');
  });
});

test('pickOne: a non-zero exit from the [picker] command is treated as a cancellation', async () => {
  await withConfig({ command: 'false' }, async () => {
    const chosen = await pickOne(CANDIDATES);
    assert.equal(chosen, undefined);
  });
});

test('pickOne: empty output from the [picker] command is treated as a cancellation', async () => {
  // Exits 0 but never prints anything — the empty-output half of the
  // cancellation check, distinct from the non-zero-exit half above.
  await withConfig({ command: 'true' }, async () => {
    const chosen = await pickOne(CANDIDATES);
    assert.equal(chosen, undefined);
  });
});

test('pickOne: with no [picker] section, falls through to auto-detection (no candidates returns undefined regardless)', async () => {
  await withConfig(undefined, async () => {
    const chosen = await pickOne([]);
    assert.equal(chosen, undefined);
  });
});
