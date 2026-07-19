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
 * just enough of `pane list`/`agent start`/`pane move` to drive
 * `herdrMux`'s placement logic, keeping the set of "live" panes in a small
 * JSON file (`$STUB_STATE`) so it can persist across the several separate
 * stub invocations one `open()` call makes:
 *
 * - `pane list` appends a log line, then prints `{"result":{"panes":
 *   [...state...]}}`, or exits 1 (simulating a herdr CLI failure) if
 *   `$STUB_PANE_LIST_FAIL` is set.
 * - `agent start ...` appends a log line, then — if `$STUB_NEXT_PANE_ID` is
 *   set — appends `{pane_id: $STUB_NEXT_PANE_ID}` to the state file (as the
 *   pane it just created), simulating the new pane showing up in the next
 *   `pane list`. Exits with `$STUB_AGENT_START_EXIT` (default 0).
 * - `pane move <id> ...` just appends a log line and exits 0.
 *
 * Tests drive scenarios by writing to the state file directly (e.g. to
 * simulate the user closing a pane between two `open()` calls) and by
 * changing `$STUB_NEXT_PANE_ID` before each `open()` call.
 */
async function writeHerdrStub(dir: string): Promise<string> {
  const stubPath = join(dir, 'herdr-stub.cjs');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);

function log() {
  if (process.env.STUB_LOG) {
    fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv }) + '\\n');
  }
}

function readState() {
  if (!process.env.STUB_STATE) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(process.env.STUB_STATE, 'utf8'));
  } catch {
    return [];
  }
}

function writeState(panes) {
  if (process.env.STUB_STATE) {
    fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(panes));
  }
}

if (argv[0] === 'pane' && argv[1] === 'list') {
  log();
  if (process.env.STUB_PANE_LIST_FAIL === '1') {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ id: 'cli:pane:list', result: { panes: readState() } }));
  process.exit(0);
}

if (argv[0] === 'agent' && argv[1] === 'start') {
  log();
  const newPaneId = process.env.STUB_NEXT_PANE_ID;
  if (newPaneId) {
    const panes = readState();
    panes.push({ pane_id: newPaneId, tab_id: 'w1:t1' });
    writeState(panes);
  }
  process.stdout.write(JSON.stringify({ id: 'cli:agent:start', result: { agent: {} } }));
  process.exit(Number(process.env.STUB_AGENT_START_EXIT ?? '0'));
}

if (argv[0] === 'pane' && argv[1] === 'move') {
  log();
  process.stdout.write(JSON.stringify({ id: 'cli:pane:move', result: {} }));
  process.exit(0);
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

function targetPaneOf(call: StubCall): string | undefined {
  const index = call.argv.indexOf('--target-pane');
  return index === -1 ? undefined : call.argv[index + 1];
}

function tabOf(call: StubCall): string | undefined {
  const index = call.argv.indexOf('--tab');
  return index === -1 ? undefined : call.argv[index + 1];
}

const HERDR_OPEN_TEST_ENV_KEYS = [
  'HERDR_PANE_ID',
  'HERDR_TAB_ID',
  'STUB_LOG',
  'STUB_STATE',
  'STUB_NEXT_PANE_ID',
  'STUB_AGENT_START_EXIT',
  'STUB_PANE_LIST_FAIL',
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

/** Sets up a fresh stub binary, log file, and empty pane-list state file; returns everything a test needs to drive `herdrMux.open()`. */
async function setUpHerdrOpenTest(dir: string): Promise<{ herdrBin: string; logFile: string; stateFile: string }> {
  const herdrBin = await writeHerdrStub(dir);
  const logFile = join(dir, 'log.jsonl');
  const stateFile = join(dir, 'state.json');
  await writeFile(stateFile, '[]');
  process.env.STUB_LOG = logFile;
  process.env.STUB_STATE = stateFile;
  return { herdrBin, logFile, stateFile };
}

test('herdrMux.open: (a) a first open with an order calls pane list, agent start, pane list, then pane move onto wtshunt ui\'s own pane', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1'; // wtshunt ui's own pane
    process.env.HERDR_TAB_ID = 'w1:t1'; // wtshunt ui's own tab
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'api/feature-x', command: 'echo hi', cwd: '/tmp', order: 0 });

    const calls = await readStubLog(logFile);
    assert.deepEqual(
      calls.map((c) => `${c.argv[0]} ${c.argv[1]}`),
      ['pane list', 'agent start', 'pane list', 'pane move']
    );

    const move = calls[3];
    assert.equal(move.argv[2], 'w1:p2', 'moves the pane agent start just created');
    assert.equal(targetPaneOf(move), 'w1:p1', 'targets wtshunt ui\'s own pane, the only anchor available yet');
    assert.equal(tabOf(move), 'w1:t1');
    assert.ok(move.argv.includes('--no-focus'));
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (b) a second open with a larger order anchors on the pane the smaller-order open created', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_TAB_ID = 'w1:t1';

    const mux = herdrMux({ herdrBin });
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });
    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    await mux.open({ title: 'second', command: 'echo 2', order: 5 });

    const moves = callsMatching(await readStubLog(logFile), 'pane', 'move');
    assert.equal(moves.length, 2);
    assert.equal(moves[0].argv[2], 'w1:p2');
    assert.equal(targetPaneOf(moves[0]), 'w1:p1');
    assert.equal(moves[1].argv[2], 'w1:p3');
    assert.equal(targetPaneOf(moves[1]), 'w1:p2', 'order 5 anchors on order 0\'s pane, not the ui pane');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (c) an open with a smaller order than any tracked pane still anchors on wtshunt ui\'s own pane, inserting to its left', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_TAB_ID = 'w1:t1';

    const mux = herdrMux({ herdrBin });
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await mux.open({ title: 'first', command: 'echo 1', order: 5 });
    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    await mux.open({ title: 'second', command: 'echo 2', order: 0 });

    const moves = callsMatching(await readStubLog(logFile), 'pane', 'move');
    assert.equal(moves.length, 2);
    assert.equal(moves[1].argv[2], 'w1:p3');
    assert.equal(targetPaneOf(moves[1]), 'w1:p1', 'no tracked order is smaller than 0, so it falls back to the ui pane');
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
    process.env.HERDR_TAB_ID = 'w1:t1';

    const mux = herdrMux({ herdrBin });
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    // The user closes the pane the first open created — herdr's own pane
    // list no longer reports it.
    await writeFile(stateFile, '[]');

    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    await mux.open({ title: 'second', command: 'echo 2', order: 5 });

    const moves = callsMatching(await readStubLog(logFile), 'pane', 'move');
    assert.equal(moves.length, 2);
    assert.equal(moves[1].argv[2], 'w1:p3');
    assert.equal(targetPaneOf(moves[1]), 'w1:p1', 'the closed pane must not be used as an anchor');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (e) with neither $HERDR_PANE_ID nor $HERDR_TAB_ID set, pane move is never called and agent start keeps its original form', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    delete process.env.HERDR_PANE_ID; // wtshunt ui wasn't itself started from a herdr pane
    delete process.env.HERDR_TAB_ID;
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', cwd: '/tmp', order: 0 });

    const calls = await readStubLog(logFile);
    const starts = callsMatching(calls, 'agent', 'start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].argv.includes('--split'), false, 'agent start never takes --split in the new design');
    assert.equal(callsMatching(calls, 'pane', 'move').length, 0);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (f) when the pane-list diff is not exactly one new pane, move and tracking are both skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_TAB_ID = 'w1:t1';
    delete process.env.STUB_NEXT_PANE_ID; // agent start creates nothing the stub can report back — a 0-pane diff

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    assert.equal(callsMatching(await readStubLog(logFile), 'pane', 'move').length, 0);

    // A follow-up open must still anchor on wtshunt ui's own pane, proving
    // the ambiguous first open was never tracked as order 0's pane.
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await mux.open({ title: 'second', command: 'echo 2', order: 5 });

    const moves = callsMatching(await readStubLog(logFile), 'pane', 'move');
    assert.equal(moves.length, 1);
    assert.equal(targetPaneOf(moves[0]), 'w1:p1');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: when `pane list` itself fails, placement control is abandoned but agent start still runs in its original form', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_TAB_ID = 'w1:t1';
    process.env.STUB_PANE_LIST_FAIL = '1';
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    const calls = await readStubLog(logFile);
    const starts = callsMatching(calls, 'agent', 'start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].argv.includes('--split'), false);
    assert.equal(callsMatching(calls, 'pane', 'move').length, 0);
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
