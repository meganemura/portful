import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  cwdActiveMismatchWarning,
  findWorktree,
  listWorktrees,
  parseWorktreePorcelain,
  resolveRepoFromCwd,
  resolveWorktreeFromCwd,
} from '../src/repo.ts';
import type { Config } from '../src/config.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function makeGitRepoWithWorktree(): Promise<{ base: string; main: string; worktree: string }> {
  const base = await mkdtemp(join(tmpdir(), 'wtshunt-repo-'));
  const main = join(base, 'main');
  await mkdir(main, { recursive: true });
  await git(main, ['init', '-q', '-b', 'main']);
  await git(main, ['config', 'user.email', 'test@example.com']);
  await git(main, ['config', 'user.name', 'Test']);
  await writeFile(join(main, 'file.txt'), 'hello');
  await git(main, ['add', '.']);
  await git(main, ['commit', '-q', '-m', 'init']);

  const worktree = join(base, 'feature-auth');
  await git(main, ['worktree', 'add', '-q', '-b', 'feature/auth', worktree]);

  return { base, main, worktree };
}

test('repo: parses git worktree list --porcelain output', () => {
  const output =
    'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
    'worktree /repo-wt/feature\nHEAD def456\nbranch refs/heads/feature/x\n\n';
  const worktrees = parseWorktreePorcelain(output);
  assert.equal(worktrees.length, 2);
  assert.equal(worktrees[0].name, 'repo');
  assert.equal(worktrees[0].branch, 'main');
  assert.equal(worktrees[1].name, 'feature');
  assert.equal(worktrees[1].branch, 'feature/x');
});

test('repo: lists worktrees from a real git repo', async () => {
  const { main, base } = await makeGitRepoWithWorktree();
  try {
    const worktrees = await listWorktrees(main);
    const names = worktrees.map((w) => w.name).sort();
    assert.deepEqual(names, ['feature-auth', 'main']);
    assert.ok(findWorktree(worktrees, 'feature-auth'));
    assert.equal(findWorktree(worktrees, 'feature-auth')?.branch, 'feature/auth');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('repo: resolves repo from cwd through a symlink into a worktree subdirectory', async () => {
  const { main, base, worktree } = await makeGitRepoWithWorktree();
  try {
    const appDir = join(worktree, 'app');
    await mkdir(appDir);

    const linkPath = join(base, 'link-to-wt-app');
    await symlink(appDir, linkPath, 'dir');

    const config: Config = {
      repos: {
        b: { path: main, fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' },
      },
    };

    const repoName = await resolveRepoFromCwd(config, linkPath);
    assert.equal(repoName, 'b');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('resolveWorktreeFromCwd: resolves repo and worktree separately for the main checkout and a linked worktree', async () => {
  const { main, base, worktree } = await makeGitRepoWithWorktree();
  try {
    const config: Config = {
      repos: {
        b: { path: main, fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' },
      },
    };

    const inMain = await resolveWorktreeFromCwd(config, main);
    assert.equal(inMain.repoName, 'b');
    assert.equal(inMain.worktree.name, 'main');

    const inWorktree = await resolveWorktreeFromCwd(config, worktree);
    assert.equal(inWorktree.repoName, 'b');
    assert.equal(inWorktree.worktree.name, 'feature-auth');
    assert.equal(inWorktree.worktree.branch, 'feature/auth');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('resolveWorktreeFromCwd: throws with the list of registered repos when cwd matches nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-unrelated-'));
  try {
    const config: Config = {
      repos: {
        b: { path: '/nonexistent/repo', fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' },
      },
    };
    await assert.rejects(
      () => resolveWorktreeFromCwd(config, dir),
      (err: Error) => {
        assert.match(err.message, /Registered repos: b/);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cwdActiveMismatchWarning: warns only when cwd is in a different worktree of the same repo than active', async () => {
  const { main, base, worktree } = await makeGitRepoWithWorktree();
  try {
    const config: Config = {
      repos: {
        b: { path: main, fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' },
      },
    };

    // cwd (feature-auth) differs from active (main): warns.
    const warning = await cwdActiveMismatchWarning(config, worktree, 'b', 'main');
    assert.match(warning ?? '', /cwd is in b\/feature-auth/);
    assert.match(warning ?? '', /active worktree b\/main/);

    // cwd matches active: no warning.
    assert.equal(await cwdActiveMismatchWarning(config, main, 'b', 'main'), undefined);

    // cwd isn't in any registered worktree at all: no warning.
    const outside = await mkdtemp(join(tmpdir(), 'wtshunt-unrelated-'));
    try {
      assert.equal(await cwdActiveMismatchWarning(config, outside, 'b', 'main'), undefined);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('repo: throws with the list of registered repos when cwd matches nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wtshunt-unrelated-'));
  try {
    const config: Config = {
      repos: {
        b: { path: '/nonexistent/repo', fixedPort: 3000, portRange: [3101, 3199], serve: 'echo {port}' },
      },
    };
    await assert.rejects(
      () => resolveRepoFromCwd(config, dir),
      (err: Error) => {
        assert.match(err.message, /Registered repos: b/);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
