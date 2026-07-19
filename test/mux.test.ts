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
 * just enough of `agent start`/`pane list`/`pane neighbor`/`pane swap`/
 * `pane layout`/`pane focus` to drive `herdrMux`'s placement and
 * focus-restore logic:
 *
 * - `agent start ...` appends a log line, then either echoes back
 *   `$STUB_AGENT_START_STDOUT` verbatim (for simulating a malformed
 *   response), or — if `$STUB_NEXT_PANE_ID` is set — responds with
 *   `{"result":{"agent":{"pane_id":$STUB_NEXT_PANE_ID,...}}}` and records
 *   that pane as newly created in the state file (`$STUB_STATE`, a JSON
 *   array of `{pane_id}`, so a later `pane list` reports it), or otherwise
 *   `{"result":{"agent":{}}}` (no `pane_id`). Exits with
 *   `$STUB_AGENT_START_EXIT` (default 0).
 * - `pane list` appends a log line, then prints `{"result":{"panes":
 *   [...state...]}}`, or exits 1 (simulating a herdr CLI failure) if
 *   `$STUB_PANE_LIST_FAIL` is set.
 * - `pane neighbor --direction <dir> --pane <id>` appends a log line, then
 *   pops the next entry off the `$STUB_NEIGHBOR_QUEUE` JSON-array file (a
 *   test-supplied script of responses, one per call, regardless of
 *   direction/pane — tests order the entries to match the calls their
 *   scenario should make) and responds with that pane id as the neighbor,
 *   or with no neighbor at all if the entry is `null` or the queue is
 *   empty. Always exits 0, per what hands-on testing confirmed of the real
 *   command.
 * - `pane swap --source-pane <a> --target-pane <b>` appends a log line,
 *   then pops the next boolean off `$STUB_SWAP_QUEUE` and exits 0 (success)
 *   or 1 (failure) accordingly — an empty queue defaults to failure, so an
 *   under-scripted test fails loudly instead of silently "succeeding".
 * - `pane layout --pane <id>` appends a log line, then pops the next entry
 *   off `$STUB_LAYOUT_QUEUE`: a string responds with that pane id as
 *   `result.layout.focused_pane_id`; `null` responds with
 *   `{"result":{"layout":{}}}` (field present in shape but missing);
 *   `"BAD_JSON"` writes non-JSON stdout instead. An empty queue exits 1
 *   (simulating a herdr CLI failure) — same under-scripted-fails-loudly
 *   convention as `pane swap`.
 * - `pane focus --direction <dir> --pane <id>` appends a log line, then
 *   pops the next boolean off `$STUB_FOCUS_QUEUE` and exits 0 (success) or 1
 *   (failure) accordingly — an empty queue defaults to failure.
 *
 * Tests drive scenarios by writing `$STUB_NEIGHBOR_QUEUE`/`$STUB_SWAP_QUEUE`/
 * `$STUB_LAYOUT_QUEUE`/`$STUB_FOCUS_QUEUE` before each `open()` call and by
 * rewriting the state file directly (e.g. to simulate the user closing a
 * pane between two `open()` calls).
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

function popQueue(envVar) {
  const path = process.env[envVar];
  if (!path) {
    return { present: false, value: undefined };
  }
  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    queue = [];
  }
  if (!Array.isArray(queue) || queue.length === 0) {
    return { present: false, value: undefined };
  }
  const [value, ...rest] = queue;
  fs.writeFileSync(path, JSON.stringify(rest));
  return { present: true, value };
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
  if (process.env.STUB_AGENT_START_STDOUT !== undefined) {
    process.stdout.write(process.env.STUB_AGENT_START_STDOUT);
    process.exit(Number(process.env.STUB_AGENT_START_EXIT ?? '0'));
  }
  const newPaneId = process.env.STUB_NEXT_PANE_ID;
  if (newPaneId) {
    const panes = readState();
    panes.push({ pane_id: newPaneId });
    writeState(panes);
    process.stdout.write(
      JSON.stringify({
        id: 'cli:agent:start',
        result: { agent: { pane_id: newPaneId, tab_id: 'w1:t1', workspace_id: 'w1' }, type: 'agent_started' },
      })
    );
  } else {
    process.stdout.write(JSON.stringify({ id: 'cli:agent:start', result: { agent: {}, type: 'agent_started' } }));
  }
  process.exit(Number(process.env.STUB_AGENT_START_EXIT ?? '0'));
}

if (argv[0] === 'pane' && argv[1] === 'neighbor') {
  log();
  const popped = popQueue('STUB_NEIGHBOR_QUEUE');
  const neighborPaneId = popped.present ? popped.value : null;
  process.stdout.write(
    JSON.stringify({
      id: 'cli:pane:neighbor',
      result: { neighbor: neighborPaneId ? { neighbor_pane_id: neighborPaneId } : {} },
    })
  );
  process.exit(0);
}

if (argv[0] === 'pane' && argv[1] === 'swap') {
  log();
  const popped = popQueue('STUB_SWAP_QUEUE');
  const success = popped.present ? Boolean(popped.value) : false;
  if (!success) {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ id: 'cli:pane:swap', result: { type: 'pane_swap' } }));
  process.exit(0);
}

if (argv[0] === 'pane' && argv[1] === 'layout') {
  log();
  const popped = popQueue('STUB_LAYOUT_QUEUE');
  if (!popped.present) {
    process.exit(1);
  }
  const entry = popped.value;
  if (entry === 'BAD_JSON') {
    process.stdout.write('not json');
    process.exit(0);
  }
  const layout = entry === null || entry === undefined ? {} : { focused_pane_id: entry };
  process.stdout.write(JSON.stringify({ id: 'cli:pane:layout', result: { layout } }));
  process.exit(0);
}

if (argv[0] === 'pane' && argv[1] === 'focus') {
  log();
  const popped = popQueue('STUB_FOCUS_QUEUE');
  const success = popped.present ? Boolean(popped.value) : false;
  if (!success) {
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ id: 'cli:pane:focus', result: { type: 'pane_focus' } }));
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

function flagValue(call: StubCall, flag: string): string | undefined {
  const index = call.argv.indexOf(flag);
  return index === -1 ? undefined : call.argv[index + 1];
}

const targetPaneOf = (call: StubCall): string | undefined => flagValue(call, '--target-pane');
const sourcePaneOf = (call: StubCall): string | undefined => flagValue(call, '--source-pane');
const tabOf = (call: StubCall): string | undefined => flagValue(call, '--tab');
const workspaceOf = (call: StubCall): string | undefined => flagValue(call, '--workspace');
const directionOf = (call: StubCall): string | undefined => flagValue(call, '--direction');
const paneArgOf = (call: StubCall): string | undefined => flagValue(call, '--pane');

const HERDR_OPEN_TEST_ENV_KEYS = [
  'HERDR_PANE_ID',
  'HERDR_TAB_ID',
  'HERDR_WORKSPACE_ID',
  'STUB_LOG',
  'STUB_STATE',
  'STUB_NEXT_PANE_ID',
  'STUB_AGENT_START_EXIT',
  'STUB_AGENT_START_STDOUT',
  'STUB_PANE_LIST_FAIL',
  'STUB_NEIGHBOR_QUEUE',
  'STUB_SWAP_QUEUE',
  'STUB_LAYOUT_QUEUE',
  'STUB_FOCUS_QUEUE',
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

/** Sets up a fresh stub binary, log file, empty pane-list state, and empty neighbor/swap/layout/focus response queues; returns everything a test needs to drive `herdrMux.open()`. */
async function setUpHerdrOpenTest(dir: string): Promise<{
  herdrBin: string;
  logFile: string;
  stateFile: string;
  neighborQueueFile: string;
  swapQueueFile: string;
  layoutQueueFile: string;
  focusQueueFile: string;
}> {
  const herdrBin = await writeHerdrStub(dir);
  const logFile = join(dir, 'log.jsonl');
  const stateFile = join(dir, 'state.json');
  const neighborQueueFile = join(dir, 'neighbor-queue.json');
  const swapQueueFile = join(dir, 'swap-queue.json');
  const layoutQueueFile = join(dir, 'layout-queue.json');
  const focusQueueFile = join(dir, 'focus-queue.json');
  await writeFile(stateFile, '[]');
  await writeFile(neighborQueueFile, '[]');
  await writeFile(swapQueueFile, '[]');
  await writeFile(layoutQueueFile, '[]');
  await writeFile(focusQueueFile, '[]');
  process.env.STUB_LOG = logFile;
  process.env.STUB_STATE = stateFile;
  process.env.STUB_NEIGHBOR_QUEUE = neighborQueueFile;
  process.env.STUB_SWAP_QUEUE = swapQueueFile;
  process.env.STUB_LAYOUT_QUEUE = layoutQueueFile;
  process.env.STUB_FOCUS_QUEUE = focusQueueFile;
  return { herdrBin, logFile, stateFile, neighborQueueFile, swapQueueFile, layoutQueueFile, focusQueueFile };
}

/** Scripts the stub's next `pane neighbor` (or `pane swap`) responses, in call order. */
async function writeQueue(path: string, entries: readonly unknown[]): Promise<void> {
  await writeFile(path, JSON.stringify(entries));
}

test('herdrMux.open: (a) agent start\'s args include --workspace/--tab from env, --split right, --no-focus, and the `-- sh -c <cmd>` form', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, neighborQueueFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1'; // wtshunt ui's own pane
    process.env.HERDR_TAB_ID = 'w1:t1'; // wtshunt ui's own tab
    process.env.HERDR_WORKSPACE_ID = 'w1';
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await writeQueue(neighborQueueFile, ['w1:p1']); // already left of nothing but the anchor — no swaps needed

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'api/feature-x', command: 'echo hi', cwd: '/tmp', order: 0 });

    const calls = await readStubLog(logFile);
    const starts = callsMatching(calls, 'agent', 'start');
    assert.equal(starts.length, 1);
    const start = starts[0];
    assert.equal(workspaceOf(start), 'w1');
    assert.equal(tabOf(start), 'w1:t1');
    const splitIndex = start.argv.indexOf('--split');
    assert.equal(start.argv[splitIndex + 1], 'right');
    assert.ok(start.argv.includes('--no-focus'));
    assert.deepEqual(start.argv.slice(-4), ['--', 'sh', '-c', 'echo hi'], 'command runs as `-- sh -c <cmd>`');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (b) a first open whose new pane\'s left neighbor is already wtshunt ui\'s own pane needs no swaps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, neighborQueueFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_TAB_ID = 'w1:t1';
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await writeQueue(neighborQueueFile, ['w1:p1']);

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'swap').length, 0);
    const neighbors = callsMatching(calls, 'pane', 'neighbor');
    assert.equal(neighbors.length, 1);
    assert.equal(directionOf(neighbors[0]), 'left');
    assert.equal(paneArgOf(neighbors[0]), 'w1:p2');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (c) a second open with a larger order swaps once past ui\'s pane onto the first open\'s pane, then stops', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, neighborQueueFile, swapQueueFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_TAB_ID = 'w1:t1';

    const mux = herdrMux({ herdrBin });

    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await writeQueue(neighborQueueFile, ['w1:p1']); // first open: already in place, right of ui
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    // `--split right` always lands the new pane right of ui, i.e. between
    // ui (w1:p1) and the first open's pane (w1:p2): left(w1:p1) != base
    // (w1:p2) -> right(w1:p2) -> swap -> now left(w1:p2) == base -> stop.
    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    await writeQueue(neighborQueueFile, ['w1:p1', 'w1:p2', 'w1:p2']);
    await writeQueue(swapQueueFile, [true]);
    await mux.open({ title: 'second', command: 'echo 2', order: 5 });

    const calls = await readStubLog(logFile);
    const swaps = callsMatching(calls, 'pane', 'swap');
    assert.equal(swaps.length, 1);
    assert.equal(sourcePaneOf(swaps[0]), 'w1:p3');
    assert.equal(targetPaneOf(swaps[0]), 'w1:p2', 'order 5 anchors on order 0\'s pane, not the ui pane');

    const neighbors = callsMatching(calls, 'pane', 'neighbor');
    assert.equal(neighbors.length, 4, '1 from the first open + 3 (left, right, left) from the second');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (d) an open with a smaller order than any tracked pane anchors on wtshunt ui\'s own pane and needs no swaps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, neighborQueueFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_TAB_ID = 'w1:t1';

    const mux = herdrMux({ herdrBin });

    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await writeQueue(neighborQueueFile, ['w1:p1']);
    await mux.open({ title: 'first', command: 'echo 1', order: 5 });

    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    // No tracked order is smaller than 0, so it falls back to the ui pane —
    // already in place, right of ui.
    await writeQueue(neighborQueueFile, ['w1:p1']);
    await mux.open({ title: 'second', command: 'echo 2', order: 0 });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'swap').length, 0);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (e) with no HERDR_PANE_ID/HERDR_TAB_ID/HERDR_WORKSPACE_ID, agent start omits --workspace/--tab and neighbor/swap are never called', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile } = await setUpHerdrOpenTest(dir);
    delete process.env.HERDR_PANE_ID; // wtshunt ui wasn't itself started from a herdr pane
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_WORKSPACE_ID;
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', cwd: '/tmp', order: 0 });

    const calls = await readStubLog(logFile);
    const starts = callsMatching(calls, 'agent', 'start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].argv.includes('--workspace'), false);
    assert.equal(starts[0].argv.includes('--tab'), false);
    assert.equal(callsMatching(calls, 'pane', 'neighbor').length, 0);
    assert.equal(callsMatching(calls, 'pane', 'swap').length, 0);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (f) an unparseable or pane_id-less agent start response skips placement entirely and is never tracked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, neighborQueueFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_TAB_ID = 'w1:t1';

    const mux = herdrMux({ herdrBin });

    // stdout isn't JSON at all.
    process.env.STUB_AGENT_START_STDOUT = 'not json';
    await mux.open({ title: 'bad-stdout', command: 'echo 1', order: 0 });

    // stdout is valid JSON, but result.agent.pane_id is missing.
    delete process.env.STUB_AGENT_START_STDOUT;
    delete process.env.STUB_NEXT_PANE_ID;
    await mux.open({ title: 'no-pane-id', command: 'echo 2', order: 1 });

    let calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'list').length, 0, 'neither failure reaches the pane list cleanup step');
    assert.equal(callsMatching(calls, 'pane', 'neighbor').length, 0);
    assert.equal(callsMatching(calls, 'pane', 'swap').length, 0);

    // A later, successful open with a higher order must still fall back to
    // wtshunt ui's own pane rather than anchoring on anything left behind
    // by either failed attempt above — proof neither one was tracked. If it
    // had been, the left-neighbor check below wouldn't immediately match
    // and a second (right-neighbor) call would follow.
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await writeQueue(neighborQueueFile, ['w1:p1']);
    await mux.open({ title: 'third', command: 'echo 3', order: 2 });

    calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'swap').length, 0);
    assert.equal(callsMatching(calls, 'pane', 'neighbor').length, 1);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (g) a tracked pane no longer reported by pane list is dropped and never used as an anchor again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, stateFile, neighborQueueFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_TAB_ID = 'w1:t1';

    const mux = herdrMux({ herdrBin });

    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await writeQueue(neighborQueueFile, ['w1:p1']);
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    // The user closes the pane the first open created — herdr's own pane
    // list no longer reports it.
    await writeFile(stateFile, '[]');

    // Order 5 would normally anchor on order 0's pane (w1:p2), but it's
    // gone, so this falls back to the ui pane — already in place.
    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    await writeQueue(neighborQueueFile, ['w1:p1']);
    await mux.open({ title: 'second', command: 'echo 2', order: 5 });

    const calls = await readStubLog(logFile);
    // 1 neighbor call from the first open + exactly 1 from the second — if
    // the closed pane had wrongly stayed the anchor, the left-neighbor
    // check ('w1:p1') wouldn't match it and a second (right-neighbor) call
    // would follow.
    assert.equal(callsMatching(calls, 'pane', 'neighbor').length, 2);
    assert.equal(callsMatching(calls, 'pane', 'swap').length, 0);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: (h) bubbling stops at the 16-swap cap when the left neighbor never becomes the anchor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, neighborQueueFile, swapQueueFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1'; // the anchor — scripted to never actually be reached
    process.env.HERDR_TAB_ID = 'w1:t1';
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';

    const neighborEntries: string[] = [];
    for (let i = 0; i < 16; i++) {
      neighborEntries.push('w1:pnever'); // left neighbor: never the anchor
      neighborEntries.push('w1:pright'); // right neighbor: always present
    }
    await writeQueue(neighborQueueFile, neighborEntries);
    await writeQueue(swapQueueFile, Array(16).fill(true));

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    const calls = await readStubLog(logFile);
    const neighbors = callsMatching(calls, 'pane', 'neighbor');
    assert.equal(neighbors.filter((c) => directionOf(c) === 'left').length, 16);
    assert.equal(neighbors.filter((c) => directionOf(c) === 'right').length, 16);
    assert.equal(callsMatching(calls, 'pane', 'swap').length, 16);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: when `pane list` fails, only its cleanup is skipped — agent start and swap-based placement still run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, neighborQueueFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_TAB_ID = 'w1:t1';
    process.env.STUB_PANE_LIST_FAIL = '1';
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await writeQueue(neighborQueueFile, ['w1:p1']);

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'agent', 'start').length, 1);
    assert.equal(callsMatching(calls, 'pane', 'list').length, 1, 'still attempted, even though it fails');
    const neighbors = callsMatching(calls, 'pane', 'neighbor');
    assert.equal(neighbors.length, 1, 'placement still proceeds off HERDR_PANE_ID despite the failed cleanup call');
    assert.equal(callsMatching(calls, 'pane', 'swap').length, 0);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Sets up a two-`open()`-call scenario in which the second call's
 * `bubbleIntoPlace` swaps exactly once, so `herdrMux.open` should follow up
 * with a `restoreFocus` walk. Callers script `layoutQueueFile`/
 * `focusQueueFile` afterward to drive that walk, then invoke the returned
 * `runSecondOpen` to perform it and inspect the log.
 */
async function setUpOneSwapScenario(dir: string): Promise<{
  logFile: string;
  layoutQueueFile: string;
  focusQueueFile: string;
  runSecondOpen: () => Promise<void>;
}> {
  const { herdrBin, logFile, neighborQueueFile, swapQueueFile, layoutQueueFile, focusQueueFile } = await setUpHerdrOpenTest(dir);
  process.env.HERDR_PANE_ID = 'w1:p1';
  process.env.HERDR_TAB_ID = 'w1:t1';

  const mux = herdrMux({ herdrBin });

  // First open: lands in place with no swaps, tracked as order 0's pane.
  process.env.STUB_NEXT_PANE_ID = 'w1:p2';
  await writeQueue(neighborQueueFile, ['w1:p1']);
  await mux.open({ title: 'first', command: 'echo 1', order: 0 });

  // Second open: anchors on order 0's pane (w1:p2), one position further
  // right than where `--split right` actually landed it — exactly one swap,
  // same as test (c) above.
  return {
    logFile,
    layoutQueueFile,
    focusQueueFile,
    runSecondOpen: async () => {
      process.env.STUB_NEXT_PANE_ID = 'w1:p3';
      await writeQueue(neighborQueueFile, ['w1:p1', 'w1:p2', 'w1:p2']);
      await writeQueue(swapQueueFile, [true]);
      await mux.open({ title: 'second', command: 'echo 2', order: 5 });
    },
  };
}

test('herdrMux.open: restoreFocus (a) walks focus left one step at a time until `pane layout` reports the ui pane', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { logFile, layoutQueueFile, focusQueueFile, runSecondOpen } = await setUpOneSwapScenario(dir);

    // The swap left focus on the newly-opened pane (w1:p3): first layout
    // call reports it, so `pane focus --direction left --pane w1:p3` moves
    // focus one step further left; the next layout call reports the ui pane
    // (w1:p1) itself, so the walk stops there.
    await writeQueue(layoutQueueFile, ['w1:p3', 'w1:p1']);
    await writeQueue(focusQueueFile, [true]);
    await runSecondOpen();

    const calls = await readStubLog(logFile);
    const layouts = callsMatching(calls, 'pane', 'layout');
    assert.equal(layouts.length, 2);
    assert.equal(paneArgOf(layouts[0]), 'w1:p1', 'layout is always queried against the ui pane, not the focused one');
    assert.equal(paneArgOf(layouts[1]), 'w1:p1');

    const focuses = callsMatching(calls, 'pane', 'focus');
    assert.equal(focuses.length, 1);
    assert.equal(directionOf(focuses[0]), 'left');
    assert.equal(paneArgOf(focuses[0]), 'w1:p3', 'focus steps left of whichever pane layout reported as focused');
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: restoreFocus (b) is never invoked when bubbling needed no swaps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, neighborQueueFile } = await setUpHerdrOpenTest(dir);
    process.env.HERDR_PANE_ID = 'w1:p1';
    process.env.HERDR_TAB_ID = 'w1:t1';
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await writeQueue(neighborQueueFile, ['w1:p1']); // already in place, right of ui — no swap

    const mux = herdrMux({ herdrBin });
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'swap').length, 0);
    assert.equal(callsMatching(calls, 'pane', 'layout').length, 0);
    assert.equal(callsMatching(calls, 'pane', 'focus').length, 0);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: restoreFocus (c) is skipped when HERDR_PANE_ID is unset, even if a swap ran', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { herdrBin, logFile, neighborQueueFile, swapQueueFile } = await setUpHerdrOpenTest(dir);
    delete process.env.HERDR_PANE_ID; // wtshunt ui wasn't itself started from a herdr pane
    process.env.HERDR_TAB_ID = 'w1:t1';

    const mux = herdrMux({ herdrBin });

    // First open: nothing tracked yet and no HERDR_PANE_ID, so basePaneId is
    // undefined — bubbleIntoPlace is skipped entirely, no swap.
    process.env.STUB_NEXT_PANE_ID = 'w1:p2';
    await mux.open({ title: 'first', command: 'echo 1', order: 0 });

    // Second open anchors on order 0's tracked pane (w1:p2) — an anchor that
    // comes from `openedPanes`, not HERDR_PANE_ID — and swaps once to get
    // there.
    process.env.STUB_NEXT_PANE_ID = 'w1:p3';
    await writeQueue(neighborQueueFile, ['w1:pother', 'w1:pright', 'w1:p2']);
    await writeQueue(swapQueueFile, [true]);
    await mux.open({ title: 'second', command: 'echo 2', order: 5 });

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'swap').length, 1, 'sanity check: a swap really did happen');
    assert.equal(callsMatching(calls, 'pane', 'layout').length, 0, 'no ui pane to walk focus back to');
    assert.equal(callsMatching(calls, 'pane', 'focus').length, 0);
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: restoreFocus (d) gives up at the 8-step cap when layout never reports the ui pane', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { logFile, layoutQueueFile, focusQueueFile, runSecondOpen } = await setUpOneSwapScenario(dir);

    await writeQueue(layoutQueueFile, Array(8).fill('w1:pstuck')); // never the ui pane
    await writeQueue(focusQueueFile, Array(8).fill(true));
    await runSecondOpen();

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'layout').length, 8);
    const focuses = callsMatching(calls, 'pane', 'focus');
    assert.equal(focuses.length, 8);
    assert.ok(focuses.every((c) => directionOf(c) === 'left' && paneArgOf(c) === 'w1:pstuck'));
  } finally {
    restoreHerdrOpenTestEnv(saved);
    await rm(dir, { recursive: true, force: true });
  }
});

test('herdrMux.open: restoreFocus (e) stops without calling focus when `pane layout`\'s stdout is not JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-mux-herdr-'));
  const saved = saveHerdrOpenTestEnv();
  try {
    const { logFile, layoutQueueFile, runSecondOpen } = await setUpOneSwapScenario(dir);

    await writeQueue(layoutQueueFile, ['BAD_JSON']);
    await runSecondOpen();

    const calls = await readStubLog(logFile);
    assert.equal(callsMatching(calls, 'pane', 'layout').length, 1);
    assert.equal(callsMatching(calls, 'pane', 'focus').length, 0);
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
