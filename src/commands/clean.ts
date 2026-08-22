import { rm } from 'node:fs/promises';
import { getStatePath, readState } from '../state.ts';

/**
 * Removes the state file: sticky port assignments, active pointers, and task
 * definitions. portless's `clean` also drops its CA trust and its /etc/hosts
 * block; this tool installs neither, so state is the whole of what it owns.
 *
 * Refuses while a server or proxy is still recorded as running. Deleting the
 * file would leave those processes alive with nothing tracking them, and the
 * list printed here is more useful than a silent orphaning.
 */
export interface CleanArgs {
  force?: boolean;
}

export async function cleanCommand(args: CleanArgs = {}): Promise<void> {
  const statePath = getStatePath();
  const state = await readState();

  const running: string[] = [];
  for (const [repoName, repoState] of Object.entries(state.repos)) {
    for (const [worktree, entry] of Object.entries(repoState.servers ?? {})) {
      running.push(`server ${repoName}/${worktree} (pid ${entry.pid})`);
    }
    if (repoState.proxy) {
      running.push(`proxy ${repoName} (pid ${repoState.proxy.pid})`);
    }
  }

  if (running.length > 0 && !args.force) {
    console.error(
      `Still running:\n${running.map((line) => `  ${line}`).join('\n')}\n\n` +
        `Stop these first, or rerun with --force to remove the state anyway. ` +
        `Forcing leaves those processes running with nothing tracking them.`
    );
    process.exitCode = 1;
    return;
  }

  await rm(statePath, { force: true });
  console.log(`Removed ${statePath}.`);
  if (running.length > 0) {
    console.log(`${running.length} process(es) were still recorded as running and are now untracked.`);
  }
}
