import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  cmuxArgs,
  cmuxMux,
  fallbackMessage,
  fallbackMux,
  herdrMux,
  renderTemplate,
  resolveMux,
  shQuote,
  templateMux,
  tmuxMux,
  wtshuntCommand,
} from '../src/mux.ts';
import type { Config } from '../src/config.ts';

const execFileAsync = promisify(execFile);

const EMPTY_CONFIG: Config = { repos: {} };

const MUX_ENV_KEYS = ['HERDR_ENV', 'HERDR_SOCKET_PATH', 'CMUX_SOCKET_PATH', 'CMUX_WORKSPACE_ID', 'TMUX'] as const;

type SavedEnv = Partial<Record<(typeof MUX_ENV_KEYS)[number], string>>;

// This dev environment genuinely runs inside both a live herdr session and a
// live cmux session (their env vars are really set), so every test below
// must explicitly clear whichever of these it doesn't want detected —
// leaving one set "by ambient accident" would silently change which
// adapter resolveMux picks.
function saveMuxEnv(): SavedEnv {
  const saved: SavedEnv = {};
  for (const key of MUX_ENV_KEYS) {
    saved[key] = process.env[key];
  }
  return saved;
}

function clearMuxEnv(): void {
  for (const key of MUX_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreMuxEnv(saved: SavedEnv): void {
  for (const key of MUX_ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

test('resolveMux: an [ui] open template always wins, even with herdr/tmux env set', () => {
  const saved = saveMuxEnv();
  try {
    process.env.HERDR_ENV = '1';
    process.env.CMUX_WORKSPACE_ID = 'workspace-1';
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
    const mux = resolveMux({ repos: {}, ui: { open: 'echo {cmd}' } });
    assert.equal(mux.name, 'template');
  } finally {
    restoreMuxEnv(saved);
  }
});

test('resolveMux: herdr wins over cmux and tmux when no template is configured', () => {
  const saved = saveMuxEnv();
  try {
    clearMuxEnv();
    process.env.HERDR_SOCKET_PATH = '/tmp/does-not-matter.sock';
    process.env.CMUX_WORKSPACE_ID = 'workspace-1';
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
    const mux = resolveMux(EMPTY_CONFIG);
    assert.equal(mux.name, 'herdr');
  } finally {
    restoreMuxEnv(saved);
  }
});

test('resolveMux: tmux wins when $TMUX is set and neither herdr nor cmux is detected', () => {
  const saved = saveMuxEnv();
  try {
    clearMuxEnv();
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
    const mux = resolveMux(EMPTY_CONFIG);
    assert.equal(mux.name, 'tmux');
  } finally {
    restoreMuxEnv(saved);
  }
});

test('resolveMux: falls back when nothing is detected and no template is configured', () => {
  const saved = saveMuxEnv();
  try {
    clearMuxEnv();
    const mux = resolveMux(EMPTY_CONFIG);
    assert.equal(mux.name, 'fallback');
  } finally {
    restoreMuxEnv(saved);
  }
});

async function realCmuxOnPath(): Promise<boolean> {
  try {
    // `which` merely checks $PATH — unlike invoking `cmux` itself, this
    // can't touch its socket.
    await execFileAsync('which', ['cmux']);
    return true;
  } catch {
    return false;
  }
}

const hasCmux = await realCmuxOnPath();

test(
  'resolveMux: cmux wins over tmux when detected and no herdr/template (never invokes the real cmux binary)',
  { skip: !hasCmux ? 'cmux is not installed' : false },
  () => {
    const saved = saveMuxEnv();
    try {
      clearMuxEnv();
      process.env.CMUX_SOCKET_PATH = '/tmp/does-not-matter.sock';
      process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
      // resolveMux() itself only calls .detect() here, never .open() — this
      // test never runs the actual cmux binary.
      const mux = resolveMux(EMPTY_CONFIG);
      assert.equal(mux.name, 'cmux');
    } finally {
      restoreMuxEnv(saved);
    }
  }
);

test('shQuote: leaves safe tokens bare, quotes and escapes everything else', () => {
  assert.equal(shQuote('api/feature-x'), 'api/feature-x');
  assert.equal(shQuote('a b'), "'a b'");
  assert.equal(shQuote("it's"), `'it'\\''s'`);
  assert.equal(shQuote(''), "''");
});

test('renderTemplate: substitutes {title}/{cmd}/{cwd}, each shell-quoted', () => {
  const rendered = renderTemplate('open --title {title} --dir {cwd} -- {cmd}', {
    title: 'a b',
    cwd: '/tmp/x y',
    command: 'echo hi',
  });
  assert.equal(rendered, `open --title 'a b' --dir '/tmp/x y' -- 'echo hi'`);
});

test('templateMux: a multi-word, shell-metacharacter-laden {cmd} survives as one token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-template-'));
  const outFile = join(dir, 'out.txt');
  try {
    // The template's own tool is stood in for by a plain `sh -c`: it takes
    // {cmd} as a single argument and runs it, exactly like a real terminal
    // multiplexer's "run this command in a new pane" entry point would.
    const mux = templateMux('sh -c {cmd}');
    await mux.open({ title: 'demo', command: `echo one && echo two > ${outFile}` });

    const content = await readFile(outFile, 'utf8');
    // If {cmd} weren't quoted as a single token, the outer `sh -c` would
    // parse "&&"/">" itself instead of handing the whole string to the
    // inner shell, and this file would end up empty or hold "one\ntwo".
    assert.equal(content.trim(), 'two');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wtshuntCommand: builds a shell-quoted invocation of node + wtshunt\'s own resolved bin path', () => {
  const command = wtshuntCommand('serve', 'api/feature x');
  assert.ok(command.startsWith(shQuote(process.execPath) + ' '));
  assert.ok(command.includes("'api/feature x'"));
});

test('fallbackMux: reports guidance via fallbackMessage rather than opening anything', async () => {
  const mux = fallbackMux();
  assert.equal(mux.name, 'fallback');
  assert.equal(mux.detect(), true);

  const options = { title: 'api/main', command: 'echo hi', cwd: '/tmp' };
  const message = fallbackMessage(options);
  assert.match(message, /No multiplexer detected/);
  assert.match(message, /api\/main/);
  assert.match(message, /echo hi/);

  // open() itself only prints the same guidance; it must not throw or hang.
  await mux.open(options);
});

test('herdrMux: detects via HERDR_ENV or HERDR_SOCKET_PATH without ever invoking herdr', () => {
  const saved = saveMuxEnv();
  try {
    clearMuxEnv();
    const mux = herdrMux();
    assert.equal(mux.detect(), false);

    process.env.HERDR_ENV = '1';
    assert.equal(herdrMux().detect(), true);

    delete process.env.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = '/tmp/whatever.sock';
    assert.equal(herdrMux().detect(), true);
  } finally {
    restoreMuxEnv(saved);
  }
  // Deliberately never calls .open() here: a real herdr session/pane must
  // never be started or opened by this test suite, per the hard constraint
  // that only a real end user verifies herdr on their own machine.
});

/**
 * Stands in for the real `herdr` binary in the `herdrMux.open()` tests
 * below (which — unlike the `.detect()` test above — do exercise `.open()`,
 * but only ever against this stand-in, never the real `herdr`). Understands
 * just enough of `pane list`/`pane split`/`pane rename`/`pane run`/`pane
 * layout`/`tab list`/`tab create` to drive `herdrMux`'s anchor-selection,
 * pane-creation, and plugin-mode dedicated-tab logic. Every invocation is
 * logged (via `$STUB_LOG`, one JSON line per call) before dispatching on its
 * subcommand, including one that matches none of the branches below — which
 * falls through to `process.exit(1)`, so `agent start`/`pane neighbor`/
 * `pane swap`/`pane focus` (the old `agent start` + swap-bubbling machinery
 * this adapter no longer uses) are all deliberately unimplemented: were
 * `herdrMux` to ever call one by mistake, that call would both show up in
 * the log and make the stub reject loudly instead of silently succeeding.
 *
 * - `pane list` prints `{"result":{"panes":[...state...]}}` (state read
 *   from `$STUB_STATE`, a JSON array of `{pane_id, tab_id?}`), or exits 1 if
 *   `$STUB_PANE_LIST_FAIL` is set.
 * - `tab list --workspace <id>` prints `{"result":{"tabs":[...state...]}}`
 *   (state read from `$STUB_TABS_STATE`, a JSON array of
 *   `{tab_id, label?}`), or exits 1 if `$STUB_TABLIST_FAIL` is set.
 * - `pane layout --pane <id>` prints
 *   `{"result":{"layout":{"panes":[...state...]}}}` (state read from
 *   `$STUB_LAYOUT_STATE`, a JSON array of `{pane_id, rect:{x}}`, the same
 *   for every `--pane` value — tests only ever need one tab's layout at a
 *   time), or exits 1 if `$STUB_LAYOUT_FAIL` is set.
 * - `pane split --pane <id> --direction right --no-focus [--cwd ...]
 *   [--env ...]` either echoes back `$STUB_SPLIT_STDOUT` verbatim (for
 *   simulating a malformed response) or, if `$STUB_NEXT_PANE_ID` is set,
 *   responds with `{"result":{"pane":{"pane_id":$STUB_NEXT_PANE_ID}}}` and
 *   records that pane as newly created in the state file (so a later `pane
 *   list` reports it), inheriting the anchor pane's `tab_id` if the anchor
 *   is itself a known pane — or otherwise `{"result":{"pane":{}}}` (no
 *   `pane_id`). Exits with `$STUB_SPLIT_EXIT` (default 0).
 * - `tab create [--workspace ...] [--label ...] [--cwd ...] [--env ...]
 *   --no-focus` mirrors `pane split` exactly (response field
 *   `result.root_pane` instead of `result.pane`, stdout/exit code from
 *   `$STUB_TABCREATE_STDOUT`/`$STUB_TABCREATE_EXIT`), except the new pane's
 *   `tab_id` comes from `$STUB_NEXT_TAB_ID` (only recorded — along with a
 *   new tab entry in `$STUB_TABS_STATE`, carrying `--label`'s value if
 *   given — when that var is set, so tests that don't care about `tab list`
 *   afterward can skip it).
 * - `pane rename <id> <label>` exits with `$STUB_RENAME_EXIT` (default 0).
 * - `pane run <id> <command>` exits with `$STUB_RUN_EXIT` (default 0).
 *
 * Tests drive scenarios by setting these env vars before each `open()` call
 * and by rewriting the state files directly (e.g. to simulate the user
 * closing a pane between two `open()` calls).
 */
async function writeHerdrStub(dir: string): Promise<string> {
  const stubPath = join(dir, 'herdr-stub.cjs');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);

if (process.env.STUB_LOG) {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv }) + '\\n');
}

function readJsonState(envVar) {
  if (!process.env[envVar]) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(process.env[envVar], 'utf8'));
  } catch {
    return [];
  }
}

function writeJsonState(envVar, value) {
  if (process.env[envVar]) {
    fs.writeFileSync(process.env[envVar], JSON.stringify(value));
  }
}

function flagValue(flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function respondWithNewPane(resultKey, stdoutEnvVar, exitEnvVar, tabId) {
  if (process.env[stdoutEnvVar] !== undefined) {
    process.stdout.write(process.env[stdoutEnvVar]);
    process.exit(Number(process.env[exitEnvVar] ?? '0'));
  }
  const newPaneId = process.env.STUB_NEXT_PANE_ID;
  if (newPaneId) {
    const panes = readJsonState('STUB_STATE');
    panes.push(tabId ? { pane_id: newPaneId, tab_id: tabId } : { pane_id: newPaneId });
    writeJsonState('STUB_STATE', panes);
    process.stdout.write(JSON.stringify({ result: { [resultKey]: { pane_id: newPaneId } } }));
  } else {
    process.stdout.write(JSON.stringify({ result: { [resultKey]: {} } }));
  }
  process.exit(Number(process.env[exitEnvVar] ?? '0'));
}

if (argv[0] === 'pane' && argv[1] === 'list') {
  if (process.env.STUB_PANE_LIST_FAIL === '1') {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ result: { panes: readJsonState('STUB_STATE') } }));
  process.exit(0);
}

if (argv[0] === 'tab' && argv[1] === 'list') {
  if (process.env.STUB_TABLIST_FAIL === '1') {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ result: { tabs: readJsonState('STUB_TABS_STATE') } }));
  process.exit(0);
}

if (argv[0] === 'pane' && argv[1] === 'layout') {
  if (process.env.STUB_LAYOUT_FAIL === '1') {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ result: { layout: { panes: readJsonState('STUB_LAYOUT_STATE') } } }));
  process.exit(0);
}

if (argv[0] === 'pane' && argv[1] === 'split') {
  const anchorId = flagValue('--pane');
  const anchorPane = readJsonState('STUB_STATE').find((p) => p.pane_id === anchorId);
  respondWithNewPane('pane', 'STUB_SPLIT_STDOUT', 'STUB_SPLIT_EXIT', anchorPane && anchorPane.tab_id);
}

if (argv[0] === 'tab' && argv[1] === 'create') {
  const newTabId = process.env.STUB_NEXT_TAB_ID;
  if (newTabId && process.env.STUB_TABCREATE_STDOUT === undefined && process.env.STUB_NEXT_PANE_ID) {
    const tabs = readJsonState('STUB_TABS_STATE');
    const label = flagValue('--label');
    tabs.push(label ? { tab_id: newTabId, label } : { tab_id: newTabId });
    writeJsonState('STUB_TABS_STATE', tabs);
  }
  respondWithNewPane('root_pane', 'STUB_TABCREATE_STDOUT', 'STUB_TABCREATE_EXIT', newTabId);
}

if (argv[0] === 'pane' && argv[1] === 'rename') {
  process.exit(Number(process.env.STUB_RENAME_EXIT ?? '0'));
}

if (argv[0] === 'pane' && argv[1] === 'run') {
  process.exit(Number(process.env.STUB_RUN_EXIT ?? '0'));
}

process.exit(1);
`;
  await writeFile(stubPath, script);
  await chmod(stubPath, 0o755);
  return stubPath;
}

interface StubCall {
  argv: string[];
}

async function readStubLog(logFile: string): Promise<StubCall[]> {
  const content = await readFile(logFile, 'utf8').catch(() => '');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StubCall);
}

function callsMatching(calls: StubCall[], subcommand: string, verb: string): StubCall[] {
  return calls.filter((c) => c.argv[0] === subcommand && c.argv[1] === verb);
}

function flagValue(call: StubCall, flag: string): string | undefined {
  const index = call.argv.indexOf(flag);
  return index === -1 ? undefined : call.argv[index + 1];
}

/** Every value passed for a repeatable flag like `--env`, in call order. */
function flagValues(call: StubCall, flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < call.argv.length; i++) {
    if (call.argv[i] === flag) {
      values.push(call.argv[i + 1]);
    }
  }
  return values;
}

const workspaceOf = (call: StubCall): string | undefined => flagValue(call, '--workspace');
const directionOf = (call: StubCall): string | undefined => flagValue(call, '--direction');
const paneArgOf = (call: StubCall): string | undefined => flagValue(call, '--pane');

const HERDR_OPEN_TEST_ENV_KEYS = [
  'HERDR_PANE_ID',
  'HERDR_WORKSPACE_ID',
  'HERDR_PLUGIN_ID',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'STUB_LOG',
  'STUB_STATE',
  'STUB_TABS_STATE',
  'STUB_LAYOUT_STATE',
  'STUB_NEXT_PANE_ID',
  'STUB_NEXT_TAB_ID',
  'STUB_SPLIT_EXIT',
  'STUB_SPLIT_STDOUT',
  'STUB_TABCREATE_EXIT',
  'STUB_TABCREATE_STDOUT',
  'STUB_RENAME_EXIT',
  'STUB_RUN_EXIT',
  'STUB_PANE_LIST_FAIL',
  'STUB_TABLIST_FAIL',
  'STUB_LAYOUT_FAIL',
] as const;

type HerdrOpenTestEnv = Partial<Record<(typeof HERDR_OPEN_TEST_ENV_KEYS)[number], string>>;

function saveHerdrOpenTestEnv(): HerdrOpenTestEnv {
  const saved: HerdrOpenTestEnv = {};
  for (const key of HERDR_OPEN_TEST_ENV_KEYS) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreHerdrOpenTestEnv(saved: HerdrOpenTestEnv): void {
  for (const key of HERDR_OPEN_TEST_ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

/**
 * Sets up a fresh stub binary, log file, and empty pane-list/tab-list/layout
 * state; returns everything a test needs to drive `herdrMux.open()`. Also
 * clears `HERDR_PLUGIN_ID` — this dev environment can genuinely be a live
 * herdr session (`HERDR_ENV`/`HERDR_PANE_ID`/`HERDR_WORKSPACE_ID` really are
 * set), but never as a plugin pane, so this is just future-proofing to keep
 * every non-plugin-mode test on the ordinary flow regardless; plugin-mode
 * tests set `HERDR_PLUGIN_ID` themselves afterward.
 */
async function setUpHerdrOpenTest(
  dir: string
): Promise<{ herdrBin: string; logFile: string; stateFile: string; tabsStateFile: string; layoutStateFile: string }> {
  const herdrBin = await writeHerdrStub(dir);
  const logFile = join(dir, 'log.jsonl');
  const stateFile = join(dir, 'state.json');
  const tabsStateFile = join(dir, 'tabs-state.json');
  const layoutStateFile = join(dir, 'layout-state.json');
  await writeFile(stateFile, '[]');
  await writeFile(tabsStateFile, '[]');
  await writeFile(layoutStateFile, '[]');
  process.env.STUB_LOG = logFile;
  process.env.STUB_STATE = stateFile;
  process.env.STUB_TABS_STATE = tabsStateFile;
  process.env.STUB_LAYOUT_STATE = layoutStateFile;
  delete process.env.HERDR_PLUGIN_ID;
  return { herdrBin, logFile, stateFile, tabsStateFile, layoutStateFile };
}

test('herdrMux.open: (a) a first open with order splits off HERDR_PANE_ID, forwarding --cwd and XDG_* via --env, then renames and runs the command verbatim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1'; // wtshunt ui's own pane
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    process.env.XDG_CONFIG_HOME = '/tmp/wtshunt-test-config';
    process.env.XDG_STATE_HOME = '/tmp/wtshunt-test-state';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'api/feature-x', command: 'echo hi', cwd: '/tmp', order: 0 });

    const calls = await readStubLog(logFile);
    assert.deepEqual(
      calls.map((c) => `${c.argv[0]} ${c.argv[1]}`),
      ['pane list', 'pane split', 'pane rename', 'pane run'],
      'called in exactly this order'
    );

    const split = calls[1];
    assert.equal(paneArgOf(split), 'w1:p1');
    assert.equal(directionOf(split), 'right');
    assert.ok(split.argv.includes('--no-focus'));
    assert.equal(flagValue(split, '--cwd'), '/tmp');
    assert.deepEqual(flagValues(split, '--env'), [
      'XDG_CONFIG_HOME=/tmp/wtshunt-test-config',
      'XDG_STATE_HOME=/tmp/wtshunt-test-state',
    ]);

    const rename = calls[2];
    assert.deepEqual(rename.argv, ['pane', 'rename', 'w1:p2', 'api/feature-x']);

    const run = calls[3];
    assert.deepEqual(run.argv, ['pane', 'run', 'w1:p2', 'exec echo hi'], 'the command runs via exec so the pane closes when it exits');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test("herdrMux.open: (b) a second open with a larger order splits off the first open's pane, not HERDR_PANE_ID", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';

    const mux = herdrMux({ herdrBin });

    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    await mux.open({ title: 'second', command: 'echo 2', order: 5 });

    const calls = await readStubLog(logFile);
    const splits = callsMatching(calls, 'pane', 'split');
    assert.equal(splits.length, 2);
    assert.equal(paneArgOf(splits[0]), 'w1:p1');
    assert.equal(paneArgOf(splits[1]), 'w1:p2', "order 5 anchors on order 0's pane, not the ui pane");
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (c) an open with a smaller order than any tracked pane splits off HERDR_PANE_ID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';

    const mux = herdrMux({ herdrBin });

    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await mux.open({ title: 'first', command: 'echo 1', order: 5 });

    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    // No tracked order is smaller than 0, so it falls back to the ui pane.
    await mux.open({ title: 'second', command: 'echo 2', order: 0 });

    const calls = await readStubLog(logFile);
    const splits = callsMatching(calls, 'pane', 'split');
    assert.equal(splits.length, 2);
    assert.equal(paneArgOf(splits[1]), 'w1:p1');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (d) a tracked pane no longer reported by pane list is dropped and never used as an anchor again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, stateFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';

    const mux = herdrMux({ herdrBin });

    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    // The user closes the pane the first open created — herdr's own pane
    // list no longer reports it.
    await writeFile(stateFile, '[]');

    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    // Order 5 would normally anchor on order 0's pane (w1:p2), but it's
    // gone, so this falls back to the ui pane instead.
    await mux.open({ title: 'second', command: 'echo 2', order: 5 });

    const calls = await readStubLog(logFile);
    const splits = callsMatching(calls, 'pane', 'split');
    assert.equal(splits.length, 2);
    assert.equal(paneArgOf(splits[1]), 'w1:p1', 'falls back to HERDR_PANE_ID since the tracked pane is gone');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (e) with no anchor available, open falls back to tab create, forwarding --workspace only when HERDR_WORKSPACE_ID is set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    delete process.env.HERDR_PANE_ID; // wtshunt ui wasn't itself started from a herdr pane
    delete process.env.HERDR_WORKSPACE_ID;

    const mux = herdrMux({ herdrBin });

    // Neither call passes `order`, so nothing ever gets tracked and both
    // stay anchor-less.
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await mux.open({ title: 'no-workspace', command: 'echo 1' });

    process.env.HERDR_WORKSPACE_ID = 'w1';
    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    await mux.open({ title: 'with-workspace', command: 'echo 2' });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'split').length, 0, 'no anchor ever existed, so split is never used');
    const tabCreates = callsMatching(calls, 'tab', 'create');
    assert.equal(tabCreates.length, 2);
    assert.equal(workspaceOf(tabCreates[0]), undefined);
    assert.equal(workspaceOf(tabCreates[1]), 'w1');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (f) a nonzero-exit or pane_id-less pane split response makes open throw, and rename/run never run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';

    const mux = herdrMux({ herdrBin });

    process.env.STUB_SPLIT_EXIT = '1';
    await assert.rejects(() => mux.open({ title: 'bad-exit', command: 'echo 1', order: 0 }));

    delete process.env.STUB_SPLIT_EXIT;
    delete process.env.STUB_NEXT_PANE_ID; // exit 0, but the response has no pane_id
    await assert.rejects(() => mux.open({ title: 'no-pane-id', command: 'echo 2', order: 1 }));

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'rename').length, 0, 'rename never runs after a failed split');
    assert.equal(callsMatching(calls, 'pane', 'run').length, 0, 'run never runs after a failed split');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: a nonzero-exit or pane_id-less tab create response also makes open throw', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    delete process.env.HERDR_PANE_ID; // no anchor -> tab create path

    const mux = herdrMux({ herdrBin });

    process.env.STUB_TABCREATE_EXIT = '1';
    await assert.rejects(() => mux.open({ title: 'bad-exit', command: 'echo 1' }));

    delete process.env.STUB_TABCREATE_EXIT;
    delete process.env.STUB_NEXT_PANE_ID; // exit 0, but the response has no pane_id
    await assert.rejects(() => mux.open({ title: 'no-pane-id', command: 'echo 2' }));

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'rename').length, 0);
    assert.equal(callsMatching(calls, 'pane', 'run').length, 0);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (g) a failed pane rename is ignored, and pane run still runs the exec-wrapped command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    process.env.STUB_RENAME_EXIT = '1';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo hi', order: 0 });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'rename').length, 1, 'rename was attempted despite always failing');
    const runs = callsMatching(calls, 'pane', 'run');
    assert.equal(runs.length, 1, 'run still reached rename\'s failure notwithstanding');
    assert.deepEqual(runs[0].argv, ['pane', 'run', 'w1:p2', 'exec echo hi']);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (h) agent start / pane neighbor / pane swap / pane layout / pane focus are never invoked, across split, tab-create, and rename-failure scenarios', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';

    const mux = herdrMux({ herdrBin });
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    await mux.open({ title: 'second', command: 'echo 2', order: 5 });

    process.env.STUB_RENAME_EXIT = '1';
    process.env.STUB_NEXT_PANE_ID = 'w1:p4';
    await mux.open({ title: 'third', command: 'echo 3', order: -1 });
    delete process.env.STUB_RENAME_EXIT;

    // A fresh adapter instance with no HERDR_PANE_ID exercises the tab
    // create fallback path too.
    delete process.env.HERDR_PANE_ID;
    const muxNoAnchor = herdrMux({ herdrBin });
    process.env.STUB_NEXT_PANE_ID = 'w1:p5';
    await muxNoAnchor.open({ title: 'fourth', command: 'echo 4' });

    const calls = await readStubLog(logFile);
    for (const [subcommand, verb] of [
      ['agent', 'start'],
      ['pane', 'neighbor'],
      ['pane', 'swap'],
      ['pane', 'layout'],
      ['pane', 'focus'],
    ]) {
      assert.equal(callsMatching(calls, subcommand, verb).length, 0, `${subcommand} ${verb} must never be called`);
    }
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: when pane list fails, only its cleanup is skipped — pane split still proceeds off HERDR_PANE_ID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.STUB_PANE_LIST_FAIL = '1';
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'list').length, 1, 'still attempted, even though it fails');
    const splits = callsMatching(calls, 'pane', 'split');
    assert.equal(splits.length, 1);
    assert.equal(paneArgOf(splits[0]), 'w1:p1', 'placement still proceeds off HERDR_PANE_ID despite the failed cleanup call');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Plugin mode: HERDR_PLUGIN_ID set, dedicated "wtshunt" tab flow. ---
//
// wtshunt ships as a herdr plugin whose `ui` pane is an `overlay` — it
// floats over whichever tab the user was actually working in rather than
// living inside it, so splitting off it (HERDR_PANE_ID, used above) would
// insert serve/proxy panes into that tab instead. These tests drive
// `herdrMux.open()` with `HERDR_PLUGIN_ID` set (confirmed by hands-on
// testing to be how herdr marks a plugin-pane command) to exercise the
// dedicated-tab flow that avoids that.

test('herdrMux.open (plugin mode): creates a dedicated "wtshunt" tab when none exists yet, then renames and runs its root pane directly (no split)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-plugin-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PLUGIN_ID = 'wtshunt';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    process.env.HERDR_PANE_ID = 'overlay-pane'; // wtshunt ui's own overlay pane — must never be split off
    process.env.STUB_NEXT_PANE_ID = 'w1:p9';
    process.env.XDG_CONFIG_HOME = '/tmp/wtshunt-test-config';
    process.env.XDG_STATE_HOME = '/tmp/wtshunt-test-state';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'api/feature-x', command: 'echo hi', cwd: '/tmp', order: 0 });

    const calls = await readStubLog(logFile);
    assert.deepEqual(
      calls.map((c) => `${c.argv[0]} ${c.argv[1]}`),
      ['tab list', 'tab create', 'pane rename', 'pane run'],
      'no pane list/split — the tab is created fresh and its root pane used directly'
    );

    assert.deepEqual(calls[0].argv, ['tab', 'list', '--workspace', 'w1']);

    const tabCreate = calls[1];
    assert.equal(workspaceOf(tabCreate), 'w1');
    assert.equal(flagValue(tabCreate, '--label'), 'wtshunt');
    assert.ok(tabCreate.argv.includes('--no-focus'));
    assert.equal(flagValue(tabCreate, '--cwd'), '/tmp');
    assert.deepEqual(flagValues(tabCreate, '--env'), [
      'XDG_CONFIG_HOME=/tmp/wtshunt-test-config',
      'XDG_STATE_HOME=/tmp/wtshunt-test-state',
    ]);

    const rename = calls[2];
    assert.deepEqual(rename.argv, ['pane', 'rename', 'w1:p9', 'api/feature-x']);

    const run = calls[3];
    assert.deepEqual(run.argv, ['pane', 'run', 'w1:p9', 'exec echo hi']);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test("herdrMux.open (plugin mode): once the tab exists, a tracked pane with a lower order anchors the split, and pane layout is never consulted", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-plugin-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PLUGIN_ID = 'wtshunt';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    process.env.HERDR_PANE_ID = 'overlay-pane';

    const mux = herdrMux({ herdrBin });

    // First open creates the "wtshunt" tab (STUB_NEXT_TAB_ID makes the stub
    // record it, so the next `tab list` call reports it as already there).
    process.env.STUB_NEXT_TAB_ID = 'w1:t9';
    process.env.STUB_NEXT_PANE_ID = 'w1:p9';
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    process.env.STUB_NEXT_PANE_ID = 'w1:p10';
    await mux.open({ title: 'second', command: 'echo 2', order: 5 });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'tab', 'list').length, 2, 'checked again on the second open');
    assert.equal(callsMatching(calls, 'tab', 'create').length, 1, 'only the first open needed to create the tab');

    const splits = callsMatching(calls, 'pane', 'split');
    assert.equal(splits.length, 1);
    assert.equal(paneArgOf(splits[0]), 'w1:p9', "order 5 anchors on order 0's tracked pane");
    assert.equal(callsMatching(calls, 'pane', 'layout').length, 0, 'a tracked anchor short-circuits the leftmost-pane lookup');
    assert.ok(!calls.some((c) => paneArgOf(c) === 'overlay-pane'), 'the overlay pane itself is never used as an anchor');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test("herdrMux.open (plugin mode): with no tracked anchor, finds the wtshunt tab's leftmost pane via pane layout", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-plugin-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, stateFile, tabsStateFile, layoutStateFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PLUGIN_ID = 'wtshunt';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    process.env.HERDR_PANE_ID = 'overlay-pane';

    // A "wtshunt" tab already exists (from an earlier wtshunt ui session,
    // say) with two panes in it, but this fresh herdrMux() instance has
    // nothing tracked in memory for it yet.
    await writeFile(tabsStateFile, JSON.stringify([{ tab_id: 'w1:t9', label: 'wtshunt' }]));
    await writeFile(
      stateFile,
      JSON.stringify([
        { pane_id: 'w1:p1', tab_id: 'w1:t9' },
        { pane_id: 'w1:p2', tab_id: 'w1:t9' },
      ])
    );
    await writeFile(
      layoutStateFile,
      JSON.stringify([
        { pane_id: 'w1:p1', rect: { x: 40 } },
        { pane_id: 'w1:p2', rect: { x: 0 } },
      ])
    );
    process.env.STUB_NEXT_PANE_ID = 'w1:p3';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'third', command: 'echo 3' });

    const calls = await readStubLog(logFile);
    const layoutCalls = callsMatching(calls, 'pane', 'layout');
    assert.equal(layoutCalls.length, 1);
    assert.equal(paneArgOf(layoutCalls[0]), 'w1:p1', 'layout is queried off whichever tab pane pane list reported first');

    const splits = callsMatching(calls, 'pane', 'split');
    assert.equal(splits.length, 1);
    assert.equal(paneArgOf(splits[0]), 'w1:p2', 'the pane with the smallest rect.x is chosen as the anchor');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open (plugin mode): a "wtshunt" tab with zero live panes is treated the same as no tab at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-plugin-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, tabsStateFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PLUGIN_ID = 'wtshunt';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    process.env.HERDR_PANE_ID = 'overlay-pane';

    // `tab list` reports a "wtshunt" tab, but `pane list` (left at its
    // default empty state) has nothing belonging to it — e.g. it was closed
    // moments after `tab list` ran.
    await writeFile(tabsStateFile, JSON.stringify([{ tab_id: 'w1:t9', label: 'wtshunt' }]));
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1' });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'split').length, 0, 'no anchor pane existed, so a fresh tab is created instead');
    const tabCreates = callsMatching(calls, 'tab', 'create');
    assert.equal(tabCreates.length, 1);
    assert.equal(flagValue(tabCreates[0], '--label'), 'wtshunt');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open (plugin mode): if pane layout fails, falls back to the first pane pane list reported for the tab', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-plugin-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, stateFile, tabsStateFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PLUGIN_ID = 'wtshunt';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    process.env.HERDR_PANE_ID = 'overlay-pane';
    process.env.STUB_LAYOUT_FAIL = '1';

    await writeFile(tabsStateFile, JSON.stringify([{ tab_id: 'w1:t9', label: 'wtshunt' }]));
    await writeFile(
      stateFile,
      JSON.stringify([
        { pane_id: 'w1:p1', tab_id: 'w1:t9' },
        { pane_id: 'w1:p2', tab_id: 'w1:t9' },
      ])
    );
    process.env.STUB_NEXT_PANE_ID = 'w1:p3';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1' });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'layout').length, 1, 'still attempted, even though it fails');
    const splits = callsMatching(calls, 'pane', 'split');
    assert.equal(splits.length, 1);
    assert.equal(
      paneArgOf(splits[0]),
      'w1:p1',
      "falls back to pane list's first reported pane for the tab, not necessarily the leftmost"
    );
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: without HERDR_PLUGIN_ID, the plugin dedicated-tab flow never runs even if HERDR_WORKSPACE_ID is set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_WORKSPACE_ID = 'w1'; // set, but HERDR_PLUGIN_ID is not — must not matter
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'tab', 'list').length, 0, 'the plugin gate is never even entered');
    const splits = callsMatching(calls, 'pane', 'split');
    assert.equal(splits.length, 1);
    assert.equal(paneArgOf(splits[0]), 'w1:p1', 'ordinary flow still splits off HERDR_PANE_ID');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open (plugin mode): falls back to the ordinary flow when HERDR_WORKSPACE_ID is unset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-plugin-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PLUGIN_ID = 'wtshunt';
    delete process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_PANE_ID = 'overlay-pane';
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'tab', 'list').length, 0, 'never even attempted without a workspace id');
    const splits = callsMatching(calls, 'pane', 'split');
    assert.equal(splits.length, 1);
    assert.equal(paneArgOf(splits[0]), 'overlay-pane', 'falls back to splitting off HERDR_PANE_ID, same as non-plugin mode');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open (plugin mode): falls back to the ordinary flow when tab list fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-plugin-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PLUGIN_ID = 'wtshunt';
    process.env.HERDR_WORKSPACE_ID = 'w1';
    process.env.HERDR_PANE_ID = 'overlay-pane';
    process.env.STUB_TABLIST_FAIL = '1';
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'tab', 'list').length, 1, 'attempted, even though it fails');
    assert.equal(callsMatching(calls, 'tab', 'create').length, 0, 'no plugin-tab creation attempted after the failure');
    const splits = callsMatching(calls, 'pane', 'split');
    assert.equal(splits.length, 1);
    assert.equal(paneArgOf(splits[0]), 'overlay-pane', 'falls back to splitting off HERDR_PANE_ID');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('cmuxArgs: builds new-workspace with --name/--cwd/--command and --focus false', () => {
  assert.deepEqual(cmuxArgs({ title: 'api/feature-x', command: 'echo hi', cwd: '/tmp/x' }), [
    'new-workspace',
    '--name',
    'api/feature-x',
    '--cwd',
    '/tmp/x',
    '--command',
    'echo hi',
    '--focus',
    'false',
  ]);
});

test('cmuxArgs: omits --cwd when none is given', () => {
  assert.deepEqual(cmuxArgs({ title: 'demo', command: 'echo hi' }), [
    'new-workspace',
    '--name',
    'demo',
    '--command',
    'echo hi',
    '--focus',
    'false',
  ]);
});

test('cmuxMux: detects only when a CMUX_* env var is set AND the binary resolves on $PATH, never invokes it', () => {
  const saved = saveMuxEnv();
  try {
    clearMuxEnv();

    // No env vars at all, even with a real, always-on-PATH binary standing
    // in for cmux.
    assert.equal(cmuxMux({ cmuxBin: 'ls' }).detect(), false);

    // Env var set, but the "binary" doesn't resolve on $PATH.
    process.env.CMUX_SOCKET_PATH = '/tmp/whatever.sock';
    assert.equal(cmuxMux({ cmuxBin: 'wtshunt-definitely-not-a-real-binary-xyz' }).detect(), false);

    // Env var set and the stand-in binary does resolve.
    assert.equal(cmuxMux({ cmuxBin: 'ls' }).detect(), true);

    delete process.env.CMUX_SOCKET_PATH;
    process.env.CMUX_WORKSPACE_ID = 'workspace-1';
    assert.equal(cmuxMux({ cmuxBin: 'ls' }).detect(), true);
  } finally {
    restoreMuxEnv(saved);
  }
  // Deliberately never calls .open() with the real 'cmux' binary anywhere in
  // this suite: this dev environment is a genuine, live cmux session (its
  // CMUX_SOCKET_PATH/CMUX_WORKSPACE_ID are really set), and a sandboxed
  // invocation of the real binary is known to fail against its socket
  // ("Failed to write to socket (Broken pipe)") — never opening a real
  // workspace is a hard requirement, not just an artifact to avoid.
});

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

const hasTmux = await tmuxAvailable();

test(
  'tmuxMux: opens a new window in a private, isolated tmux server (never the real one)',
  { skip: !hasTmux ? 'tmux is not installed' : false },
  async () => {
    const socketName = `wtshunt-test-${process.pid}-${Date.now()}`;
    const sessionName = 'wtshunt-test-session';

    await execFileAsync('tmux', [
      '-L',
      socketName,
      '-f',
      '/dev/null',
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-x',
      '80',
      '-y',
      '24',
    ]);

    try {
      const mux = tmuxMux({ socketName, targetSession: sessionName });
      assert.equal(mux.name, 'tmux');

      const before = await execFileAsync('tmux', ['-L', socketName, 'list-windows', '-t', sessionName]);
      const beforeCount = before.stdout.trim().split('\n').filter(Boolean).length;

      await mux.open({ title: 'my/title with spaces!', command: 'sleep 5', cwd: '/tmp' });

      const after = await execFileAsync('tmux', ['-L', socketName, 'list-windows', '-t', sessionName]);
      const afterLines = after.stdout.trim().split('\n').filter(Boolean);
      assert.equal(afterLines.length, beforeCount + 1);
      // Title sanitized down to safe characters (spaces/"!" replaced; "/" is
      // kept, since our own titles are typically "repo/worktree").
      assert.ok(afterLines.some((line) => line.includes('my/title-with-spaces-')));
    } finally {
      await execFileAsync('tmux', ['-L', socketName, 'kill-server']).catch(() => {
        // Already gone.
      });
    }
  }
);

test(
  'tmuxMux: forwards XDG_CONFIG_HOME/XDG_STATE_HOME via -e, since new-window does not inherit this process\'s env',
  { skip: !hasTmux ? 'tmux is not installed' : false },
  async () => {
    const socketName = `wtshunt-test-env-${process.pid}-${Date.now()}`;
    const sessionName = 'wtshunt-test-env-session';

    // Created before we set the XDG_* vars below, so the private server's
    // own stored environment never has them — anything the new window
    // sees must have arrived via the adapter's own -e flags, not simply
    // because the server inherited them at creation time.
    await execFileAsync('tmux', [
      '-L',
      socketName,
      '-f',
      '/dev/null',
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-x',
      '80',
      '-y',
      '24',
    ]);

    const outFile = join(await mkdtemp(join(tmpdir(), 'wtshunt-mux-tmux-env-')), 'out.txt');
    const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
    process.env.XDG_CONFIG_HOME = '/tmp/wtshunt-test-config';
    process.env.XDG_STATE_HOME = '/tmp/wtshunt-test-state';

    try {
      const mux = tmuxMux({ socketName, targetSession: sessionName });
      await mux.open({
        title: 'env-check',
        command: `echo "$XDG_CONFIG_HOME|$XDG_STATE_HOME" > ${outFile}`,
        cwd: '/tmp',
      });

      // The spawned shell needs a beat to actually run and write the file.
      await new Promise((r) => setTimeout(r, 500));
      const content = await readFile(outFile, 'utf8');
      assert.equal(content.trim(), '/tmp/wtshunt-test-config|/tmp/wtshunt-test-state');
    } finally {
      if (saved.XDG_CONFIG_HOME === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
      }
      if (saved.XDG_STATE_HOME === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = saved.XDG_STATE_HOME;
      }
      await execFileAsync('tmux', ['-L', socketName, 'kill-server']).catch(() => {
        // Already gone.
      });
    }
  }
);
