import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'wtshunt.js');

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

test('serve: {<repo>.port} references resolve and get recorded as resolvedRefs on the server entry', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-serve-refs-repo-'));
  const apiMain = join(base, 'api-main');
  const frontMain = join(base, 'front-main');

  await mkdir(apiMain, { recursive: true });
  await git(apiMain, ['init', '-q', '-b', 'main']);
  await git(apiMain, ['config', 'user.email', 'test@example.com']);
  await git(apiMain, ['config', 'user.name', 'Test']);
  await writeFile(join(apiMain, 'f.txt'), 'hi');
  await git(apiMain, ['add', '.']);
  await git(apiMain, ['commit', '-q', '-m', 'init']);

  await mkdir(frontMain, { recursive: true });
  await git(frontMain, ['init', '-q', '-b', 'main']);
  await git(frontMain, ['config', 'user.email', 'test@example.com']);
  await git(frontMain, ['config', 'user.name', 'Test']);
  await writeFile(join(frontMain, 'f.txt'), 'hi');
  await git(frontMain, ['add', '.']);
  await git(frontMain, ['commit', '-q', '-m', 'init']);

  const configDir = await mkdtemp(join(tmpdir(), 'wtshunt-serve-refs-config-'));
  await mkdir(join(configDir, 'wtshunt'), { recursive: true });
  await writeFile(
    join(configDir, 'wtshunt', 'config.toml'),
    [
      '[repos.api]',
      `path = "${apiMain}"`,
      'fixed_port = 3000',
      'port_range = [41500, 41510]',
      'serve = "echo api-on-{port}; sleep 30"',
      '',
      '[repos.front]',
      `path = "${frontMain}"`,
      'fixed_port = 8080',
      'port_range = [41600, 41610]',
      'serve = "echo front-on-{port}-api-at-{api.port}; sleep 30"',
      '',
    ].join('\n')
  );

  const stateDir = await mkdtemp(join(tmpdir(), 'wtshunt-serve-refs-state-'));
  const env = { ...process.env, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir };

  let apiServe: ReturnType<typeof spawn> | undefined;
  let frontServe: ReturnType<typeof spawn> | undefined;
  try {
    await execFileAsync(process.execPath, [binPath, 'use', 'api/api-main'], { env });
    await execFileAsync(process.execPath, [binPath, 'use', 'front/front-main'], { env });

    apiServe = spawn(process.execPath, [binPath, 'serve', 'api'], { env, stdio: 'ignore' });
    await sleep(700);

    frontServe = spawn(process.execPath, [binPath, 'serve', 'front'], { env, stdio: 'ignore' });
    await sleep(700);

    const raw = await readFile(join(stateDir, 'wtshunt', 'state.json'), 'utf8');
    const state = JSON.parse(raw);

    const apiPort = state.repos.api.servers['api-main'].port;
    const frontEntry = state.repos.front.servers['front-main'];

    assert.equal(typeof apiPort, 'number');
    assert.deepEqual(frontEntry.resolvedRefs, { api: apiPort });
  } finally {
    // Plain SIGTERM to each outer `wtshunt serve` process (not a process
    // group signal): that process isn't itself detached from this test, so
    // it isn't a group leader, but it does have its own SIGTERM handler
    // that forwards to its detached child's group and then exits.
    for (const proc of [apiServe, frontServe]) {
      if (proc?.pid) {
        try {
          process.kill(proc.pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    }
    await sleep(300);
    await rm(base, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
