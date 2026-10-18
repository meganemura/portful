import { defineStep, z } from "nukadoko";
import { startPortful, waitForAnswer } from "./portful-cli.ts";
import registerRepository from "./register-repository.ts";

// Any HTTP answer means the proxy is listening; which worktree answers is the
// later steps' question.
export default defineStep({
  description: "Starts `portful proxy start api` and waits until the fixed port answers.",
  pattern: "the portful proxy holds the repository's fixed port",
  args: z.object({ configHome: z.string(), stateHome: z.string(), repo: z.string(), fixedPort: z.number().int() }),
  from: {
    configHome: [registerRepository, "configHome"],
    stateHome: [registerRepository, "stateHome"],
    repo: [registerRepository, "repo"],
    fixedPort: [registerRepository, "fixedPort"],
  },
  mutates: true,
  async run({ processes }, { configHome, stateHome, repo, fixedPort }) {
    const child = startPortful(["proxy", "start", repo], { configHome, stateHome });
    processes.keep(child);
    await waitForAnswer(fixedPort, child, `portful proxy start ${repo}`);
  },
});
