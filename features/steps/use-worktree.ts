import { defineStep, z } from "nukadoko";
import { runPortful } from "./portful-cli.ts";
import registerRepository from "./register-repository.ts";

export default defineStep({
  description: "Runs `portful use api/<worktree>`.",
  pattern: "the agent runs portful use for {worktree:string}",
  args: z.object({ worktree: z.string(), configHome: z.string(), stateHome: z.string(), repo: z.string() }),
  returns: z.object({}),
  from: { configHome: [registerRepository, "configHome"], stateHome: [registerRepository, "stateHome"], repo: [registerRepository, "repo"] },
  mutates: true,
  rationale: "Naming the worktree skips the picker, which is how an agent runs use.",
  run({}, { worktree, configHome, stateHome, repo }) {
    const { exitCode, stderr } = runPortful(["use", `${repo}/${worktree}`], { configHome, stateHome });
    if (exitCode !== 0) throw new Error(`portful use exited ${exitCode}: ${stderr}`);
    return {};
  },
});
