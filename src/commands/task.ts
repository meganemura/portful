import { loadConfig, type Config } from '../config.ts';
import { pickOne } from '../picker.ts';
import { findWorktree, listWorktrees, parseRepoArg } from '../repo.ts';
import { ensureRepoState, readState, withState, type State } from '../state.ts';
import { detectWiringMismatches, taskMatchesCurrentActive, type WiringMismatch } from '../tasks.ts';

const SKIP = '(skip)';

export interface TaskAddArgs {
  name: string;
  members: string[];
}

export async function taskAddCommand(args: TaskAddArgs): Promise<void> {
  const config = await loadConfig();
  const preState = await readState();
  if (preState.tasks[args.name]) {
    throw new Error(`Task "${args.name}" already exists. Remove it first with "wtshunt task rm ${args.name}".`);
  }

  const members: Record<string, string> = {};
  const explicitRepos = new Set<string>();

  for (const token of args.members) {
    const { repo, worktreeName } = parseRepoArg(token);
    if (!config.repos[repo]) {
      throw unknownRepoError(config, repo, token);
    }
    if (!worktreeName) {
      throw new Error(`"${token}" must be in repo/worktree form (e.g. "${repo}/main").`);
    }
    const worktrees = await listWorktrees(config.repos[repo].path);
    const worktree = findWorktree(worktrees, worktreeName);
    if (!worktree) {
      throw new Error(
        `Worktree "${worktreeName}" not found in repo "${repo}". Available: ${worktrees.map((w) => w.name).join(', ') || '(none)'}`
      );
    }
    members[repo] = worktree.name;
    explicitRepos.add(repo);
  }

  for (const [repoName, repoConfig] of Object.entries(config.repos)) {
    if (explicitRepos.has(repoName)) {
      continue;
    }
    const worktrees = await listWorktrees(repoConfig.path);
    const options = [
      { columns: [SKIP, `do not include "${repoName}" in this task`] },
      ...worktrees.map((wt) => ({ columns: [wt.name, wt.branch] })),
    ];
    const chosen = await pickOne(options, `Select worktree for "${repoName}" (or ${SKIP}): `);
    if (chosen !== undefined && chosen !== SKIP) {
      members[repoName] = chosen;
    }
  }

  if (Object.keys(members).length === 0) {
    throw new Error(`Task "${args.name}" would have no members. Include at least one repo/worktree.`);
  }

  await withState((state) => {
    if (state.tasks[args.name]) {
      throw new Error(`Task "${args.name}" already exists. Remove it first with "wtshunt task rm ${args.name}".`);
    }
    state.tasks[args.name] = { members };
  });

  const memberList = Object.entries(members)
    .map(([repo, wt]) => `${repo}/${wt}`)
    .join(', ');
  console.log(`Task "${args.name}" created with members: ${memberList}`);
}

function unknownRepoError(config: Config, repo: string, token: string): Error {
  const names = Object.keys(config.repos);
  return new Error(`Unknown repo "${repo}" in "${token}". Registered repos: ${names.length > 0 ? names.join(', ') : '(none)'}`);
}

export interface TaskUseArgs {
  name: string;
}

export interface TaskUseResult {
  members: Record<string, string>;
  needsServe: string[];
  proxying: { repo: string; active: string }[];
  mismatches: WiringMismatch[];
}

/**
 * The bare validate-and-switch logic behind `task use`, with no console
 * output — reused as-is by `wtshunt ui`'s "use task" action, which
 * summarizes the result in its own message line instead.
 */
export async function applyTask(name: string): Promise<TaskUseResult> {
  const config = await loadConfig();

  return withState(async (state) => {
    const task = state.tasks[name];
    if (!task) {
      throw unknownTaskError(state, name);
    }

    // Validate every member up front so a stale one can't leave the switch
    // half-applied: if anything is missing, nothing gets changed.
    const missing: string[] = [];
    for (const [repoName, worktreeName] of Object.entries(task.members)) {
      const repoConfig = config.repos[repoName];
      if (!repoConfig) {
        missing.push(`${repoName}/${worktreeName} (repo "${repoName}" is no longer registered)`);
        continue;
      }
      const worktrees = await listWorktrees(repoConfig.path);
      if (!findWorktree(worktrees, worktreeName)) {
        missing.push(`${repoName}/${worktreeName} (worktree no longer exists)`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Cannot apply task "${name}": some members no longer exist:\n` +
          missing.map((line) => `  - ${line}`).join('\n')
      );
    }

    for (const [repoName, worktreeName] of Object.entries(task.members)) {
      ensureRepoState(state, repoName).active = worktreeName;
    }

    const memberRepoNames = Object.keys(task.members);
    const needsServe: string[] = [];
    const proxying: { repo: string; active: string }[] = [];
    for (const repoName of memberRepoNames) {
      const rs = ensureRepoState(state, repoName);
      const active = rs.active!;
      if (!rs.servers[active]) {
        needsServe.push(repoName);
      }
      if (rs.proxy) {
        proxying.push({ repo: repoName, active });
      }
    }
    // Scanned across *every* configured repo, not just this task's members:
    // a repo left out of the task (its own server kept running, wired to a
    // repo that the task just moved) is exactly the case this warning
    // exists to catch.
    const mismatches = detectWiringMismatches(state, Object.keys(config.repos));

    return { members: task.members, needsServe, proxying, mismatches };
  });
}

export async function taskUseCommand(args: TaskUseArgs): Promise<void> {
  const result = await applyTask(args.name);

  const memberList = Object.entries(result.members)
    .map(([repo, wt]) => `${repo}/${wt}`)
    .join(', ');
  console.log(`Task "${args.name}" applied: ${memberList}`);

  if (result.needsServe.length > 0) {
    console.log('Servers not running yet:');
    for (const repoName of result.needsServe) {
      console.log(`  [ ] wtshunt serve ${repoName}`);
    }
  }

  for (const mismatch of result.mismatches) {
    console.warn(
      `Warning: the server for "${mismatch.repo}" is still wired to "${mismatch.refRepo}"'s old port ` +
        `${mismatch.recordedPort}. Run "wtshunt stop ${mismatch.repo} && wtshunt serve ${mismatch.repo}" to rewire it.`
    );
  }

  for (const { repo, active } of result.proxying) {
    console.log(`${repo}: proxy now routes to ${active}`);
  }
}

function unknownTaskError(state: State, name: string): Error {
  const names = Object.keys(state.tasks);
  return new Error(`Unknown task "${name}". Registered tasks: ${names.length > 0 ? names.join(', ') : '(none)'}`);
}

export async function taskListCommand(): Promise<void> {
  const state = await readState();
  const names = Object.keys(state.tasks);

  if (names.length === 0) {
    console.log('No tasks defined.');
    return;
  }

  for (const name of names) {
    const task = state.tasks[name];
    const marker = taskMatchesCurrentActive(state, task) ? ' *' : '';
    const memberList = Object.entries(task.members)
      .map(([repo, wt]) => `${repo}/${wt}`)
      .join(', ');
    console.log(`${name}${marker}\t${memberList}`);
  }
}

export interface TaskRmArgs {
  name: string;
}

export async function taskRmCommand(args: TaskRmArgs): Promise<void> {
  await withState((state) => {
    if (!state.tasks[args.name]) {
      throw unknownTaskError(state, args.name);
    }
    delete state.tasks[args.name];
  });
  console.log(`Task "${args.name}" removed.`);
}
