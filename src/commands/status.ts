import { loadConfig } from '../config.ts';
import { readState } from '../state.ts';

export async function statusCommand(): Promise<void> {
  const config = await loadConfig();
  const state = await readState();

  for (const [repoName, repoConfig] of Object.entries(config.repos)) {
    const rs = state.repos[repoName];
    console.log(`${repoName} (${repoConfig.path})`);
    console.log(`  active: ${rs?.active ?? '(none)'}`);

    const servers = rs?.servers ?? {};
    const serverNames = Object.keys(servers);
    if (serverNames.length === 0) {
      console.log('  servers: (none running)');
    } else {
      console.log('  servers:');
      for (const name of serverNames) {
        const entry = servers[name];
        console.log(`    ${name}\t${entry.branch}\tport ${entry.port}\tpid ${entry.pid}`);
      }
    }

    if (rs?.proxy) {
      const activeName = rs.active;
      const activePort = activeName ? servers[activeName]?.port : undefined;
      const destination =
        activeName === undefined
          ? '(no active worktree)'
          : activePort !== undefined
            ? `${activeName} (port ${activePort})`
            : `${activeName} (not running)`;
      console.log(`  proxy: running (pid ${rs.proxy.pid}) ${repoConfig.fixedPort} -> ${destination}`);
    } else {
      console.log(`  proxy: not running (fixed port ${repoConfig.fixedPort})`);
    }

    console.log('');
  }
}
