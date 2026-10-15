import { defineStep, z } from "nukadoko";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

// A port the kernel just handed out and released, so nothing else holds it.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

export default defineStep({
  description: "Creates a scratch git repository with two worktrees, and a scratch XDG config that registers it as `api` with a fixed port, a port range, and a serve command that answers every request with its worktree's directory name.",
  pattern: "a repository with worktrees {first:string} and {second:string} registered with portful",
  args: z.object({ first: z.string(), second: z.string() }),
  returns: z.object({
    configHome: z.string().describe("XDG_CONFIG_HOME every portful call in this scenario gets"),
    stateHome: z.string().describe("XDG_STATE_HOME every portful call in this scenario gets"),
    repo: z.string().describe("the name the repository is registered under"),
    fixedPort: z.number().int().describe("the port the client holds"),
  }),
  mutates: true,
  rationale: "The serve command is node itself, so the scenario needs no framework. portful names a worktree by its directory's basename, which is what the server prints.",
  async run({ scratch }, { first, second }) {
    const base = scratch.dir("portful-scenario-repo");
    const main = join(base, "api-main");
    mkdirSync(main);
    git(main, ["init", "-q", "-b", "main"]);
    git(main, ["-c", "user.email=scenario@example.com", "-c", "user.name=Scenario", "commit", "-q", "--allow-empty", "-m", "init"]);
    for (const name of [first, second]) git(main, ["worktree", "add", "-q", join(base, name), "-b", name]);

    const fixedPort = await freePort();
    const low = await freePort();
    const server = `require('node:http').createServer((q, s) => s.end(require('node:path').basename(process.cwd()))).listen({port}, '127.0.0.1')`;
    const configHome = scratch.dir("portful-scenario-config");
    mkdirSync(join(configHome, "portful"));
    writeFileSync(join(configHome, "portful", "config.json"), JSON.stringify({
      repos: {
        api: {
          path: main,
          fixedPort,
          portRange: [low, Math.min(low + 50, 65535)],
          serve: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(server)}`,
        },
      },
    }));
    return { configHome, stateHome: scratch.dir("portful-scenario-state"), repo: "api", fixedPort };
  },
});
