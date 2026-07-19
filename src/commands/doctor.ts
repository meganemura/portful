import { stat } from 'node:fs/promises';
import { getConfigPath, loadConfig, type Config } from '../config.ts';
import { resolveMux } from '../mux.ts';
import { findPortOccupant } from '../ports.ts';
import { resolvePickerKind } from '../picker.ts';
import { describeStaleReport, detectStaleEntries, isStaleReportEmpty } from '../prune.ts';
import { listWorktrees } from '../repo.ts';
import { getStatePath, readState } from '../state.ts';
import { formatVersionString, readCommitHash, readPackageVersion, resolveRepoRootFromBin } from '../version.ts';

type PortConsistency = 'match' | 'unexpected-listener' | 'not-listening';

function classifyPort(expectedRunning: boolean, actuallyListening: boolean): PortConsistency {
  if (expectedRunning === actuallyListening) {
    return 'match';
  }
  return actuallyListening ? 'unexpected-listener' : 'not-listening';
}

/**
 * Read-only diagnostic dump, plain text (safe to paste into Slack): a
 * version/environment banner, config validity and per-repo checks, port
 * consistency (lsof vs. what state expects to be listening), stale state
 * entries (the same detector `prune` acts on, report-only here), and
 * which picker/multiplexer would be auto-detected. Never throws — a
 * broken config is reported as a finding, not a crash — and always exits
 * non-zero if anything looks off, so it's usable from a script.
 */
export async function doctorCommand(): Promise<void> {
  const lines: string[] = [];
  let hasProblem = false;

  const repoRoot = resolveRepoRootFromBin(process.argv[1]);
  const versionString = formatVersionString(readPackageVersion(repoRoot), readCommitHash(repoRoot));
  lines.push(`wtshunt ${versionString}`);
  lines.push(`Node ${process.version}`);
  lines.push(`Platform: ${process.platform}`);
  lines.push('');

  const configPath = getConfigPath();
  lines.push(`Config: ${configPath}`);

  let config: Config | undefined;
  try {
    config = await loadConfig();
    lines.push('  loads OK');
  } catch (err) {
    hasProblem = true;
    lines.push(`  FAILED to load: ${(err as Error).message.split('\n')[0]}`);
  }

  const actualWorktreesByRepo: Record<string, Set<string>> = {};

  if (config) {
    for (const [name, repoConfig] of Object.entries(config.repos)) {
      let pathOk = true;
      try {
        await stat(repoConfig.path);
      } catch {
        pathOk = false;
      }
      if (!pathOk) {
        hasProblem = true;
        lines.push(`  repos.${name}: path does not exist (${repoConfig.path})`);
        actualWorktreesByRepo[name] = new Set();
        continue;
      }
      try {
        const worktrees = await listWorktrees(repoConfig.path);
        actualWorktreesByRepo[name] = new Set(worktrees.map((w) => w.name));
        lines.push(`  repos.${name}: OK, ${worktrees.length} worktree(s) (${repoConfig.path})`);
      } catch {
        hasProblem = true;
        lines.push(`  repos.${name}: path exists but is not a git repo (${repoConfig.path})`);
        actualWorktreesByRepo[name] = new Set();
      }
    }
  }
  lines.push('');

  const state = await readState();

  lines.push('Ports:');
  if (!config) {
    lines.push('  (skipped: config failed to load)');
  } else {
    for (const [name, repoConfig] of Object.entries(config.repos)) {
      const rs = state.repos[name];
      const proxyRunning = Boolean(rs?.proxy);
      const fixedListening = Boolean(await findPortOccupant(repoConfig.fixedPort));
      const fixedStatus = classifyPort(proxyRunning, fixedListening);
      if (fixedStatus !== 'match') {
        hasProblem = true;
      }
      lines.push(
        `  ${name} fixed_port ${repoConfig.fixedPort}: ${fixedListening ? 'listening' : 'not listening'}, ` +
          `proxy ${proxyRunning ? 'running' : 'not running'} in state -- ` +
          `${fixedStatus === 'match' ? 'OK' : 'MISMATCH'}`
      );

      for (const [wtName, port] of Object.entries(rs?.ports ?? {})) {
        const expectedRunning = Boolean(rs?.servers[wtName]);
        const listening = Boolean(await findPortOccupant(port));
        const status = classifyPort(expectedRunning, listening);
        if (status !== 'match') {
          hasProblem = true;
        }
        lines.push(
          `  ${name}/${wtName} port ${port}: ${listening ? 'listening' : 'not listening'}, ` +
            `server ${expectedRunning ? 'recorded' : 'not recorded'} in state -- ` +
            `${status === 'match' ? 'OK' : 'MISMATCH'}`
        );
      }
    }
  }
  lines.push('');

  const statePath = getStatePath();
  lines.push(`State: ${statePath}`);
  if (!config) {
    lines.push('  (skipped: config failed to load)');
  } else {
    const staleReport = detectStaleEntries(state, actualWorktreesByRepo);
    if (isStaleReportEmpty(staleReport)) {
      lines.push('  no stale entries');
    } else {
      hasProblem = true;
      lines.push('  stale entries found (run "wtshunt prune" to clean up):');
      for (const line of describeStaleReport(staleReport)) {
        lines.push(`    ${line}`);
      }
    }
  }
  lines.push('');

  lines.push('Environment:');
  if (!config) {
    lines.push('  (skipped: config failed to load)');
  } else {
    const pickerKind = await resolvePickerKind({ config });
    lines.push(`  Picker: ${pickerKind}`);
    const mux = resolveMux(config);
    lines.push(`  Multiplexer: ${mux.name}`);
  }

  console.log(lines.join('\n'));
  process.exitCode = hasProblem ? 1 : 0;
}
