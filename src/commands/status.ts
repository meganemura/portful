import { buildOverview, type Overview, type OverviewServer } from '../overview.ts';

export interface StatusArgs {
  json?: boolean;
}

export async function statusCommand(args: StatusArgs = {}): Promise<void> {
  const overview = await buildOverview();

  if (args.json) {
    console.log(JSON.stringify(overview));
    return;
  }

  printHumanReadable(overview);
}

/** The trailing parenthetical note on a server row, e.g. " (worktree gone; stale wiring: api)". Empty string if there's nothing to flag. */
function serverNote(entry: OverviewServer): string {
  const notes: string[] = [];
  if (entry.worktreeGone) {
    notes.push('worktree gone');
  }
  if (entry.staleWiring && entry.staleWiring.length > 0) {
    notes.push(`stale wiring: ${entry.staleWiring.map((s) => s.repo).join(', ')}`);
  }
  return notes.length > 0 ? ` (${notes.join('; ')})` : '';
}

function printHumanReadable(overview: Overview): void {
  let anyWorktreeGone = false;

  for (const repo of overview.repos) {
    console.log(`${repo.name} (${repo.path})`);
    console.log(`  active: ${repo.active ?? '(none)'}`);

    const serverNames = Object.keys(repo.servers);
    if (serverNames.length === 0) {
      console.log('  servers: (none running)');
    } else {
      console.log('  servers:');
      for (const name of serverNames) {
        const entry = repo.servers[name];
        if (entry.worktreeGone) {
          anyWorktreeGone = true;
        }
        console.log(`    ${name}\t${entry.branch}\tport ${entry.port}\tpid ${entry.pid}${serverNote(entry)}`);
      }
    }

    if (repo.proxy) {
      const activeName = repo.active;
      const activePort = activeName ? repo.servers[activeName]?.port : undefined;
      const destination =
        activeName === undefined
          ? '(no active worktree)'
          : activePort !== undefined
            ? `${activeName} (port ${activePort})`
            : `${activeName} (not running)`;
      console.log(`  proxy: running (pid ${repo.proxy.pid}) ${repo.fixedPort} -> ${destination}`);
    } else {
      console.log(`  proxy: not running (fixed port ${repo.fixedPort})`);
    }

    console.log('');
  }

  if (overview.tasks.length === 0) {
    console.log('Tasks: (none defined)');
  } else {
    console.log('Tasks:');
    for (const task of overview.tasks) {
      const marker = task.matchesCurrentActive ? ' *' : '';
      const memberList = Object.entries(task.members)
        .map(([repo, wt]) => `${repo}/${wt}`)
        .join(', ');
      console.log(`  ${task.name}${marker}\t${memberList}`);
    }
  }

  if (anyWorktreeGone) {
    console.log('');
    console.log('Run "wtshunt prune" to clean up entries for worktrees that no longer exist.');
  }
}
