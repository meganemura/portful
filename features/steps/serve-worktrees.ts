import { defineStep, z } from "nukadoko";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startPortful, waitForAnswer } from "./portful-cli.ts";
import registerRepository from "./register-repository.ts";

// Polls state.json until portful has recorded the worktree's server, for at most 10 s.
async function recordedPort(stateHome: string, repo: string, worktree: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const state = JSON.parse(readFileSync(join(stateHome, "portful", "state.json"), "utf8"));
      const port = state.repos?.[repo]?.servers?.[worktree]?.port;
      if (typeof port === "number") return port;
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error(`portful never recorded a server for ${repo}/${worktree}`);
    await sleep(100);
  }
}

// serve runs in the foreground, one per worktree, as the README's quick start
// does in separate tabs. The two serves start one after the other so they
// never race for the same port.
export default defineStep({
  description: "Starts `portful serve api/<worktree>` for both worktrees, then waits until each worktree's own port answers.",
  pattern: "portful serves {first:string} and {second:string}, each on its own port",
  args: z.object({ first: z.string(), second: z.string(), configHome: z.string(), stateHome: z.string(), repo: z.string() }),
  returns: z.object({ ports: z.array(z.number().int()).describe("the port portful gave each worktree, in order") }),
  from: { configHome: [registerRepository, "configHome"], stateHome: [registerRepository, "stateHome"], repo: [registerRepository, "repo"] },
  mutates: true,
  async run({ processes }, { first, second, configHome, stateHome, repo }) {
    const home = { configHome, stateHome };
    const ports: number[] = [];
    for (const worktree of [first, second]) {
      const child = startPortful(["serve", `${repo}/${worktree}`], home);
      processes.keep(child);
      const port = await recordedPort(stateHome, repo, worktree);
      await waitForAnswer(port, child, `portful serve ${repo}/${worktree}`);
      ports.push(port);
    }
    if (ports[0] === ports[1]) throw new Error(`both worktrees got port ${ports[0]}`);
    return { ports };
  },
});
