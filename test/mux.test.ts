import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
