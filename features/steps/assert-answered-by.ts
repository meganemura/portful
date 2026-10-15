import { defineStep, z } from "nukadoko";
import { get } from "./portful-cli.ts";
import registerRepository from "./register-repository.ts";

export default defineStep({
  description: "Sends one GET to the fixed port and asserts a 200 whose body is the worktree's name.",
  pattern: "a request to the fixed port is answered by {worktree:string}",
  args: z.object({ worktree: z.string(), fixedPort: z.number().int() }),
  returns: z.object({}),
  from: { fixedPort: [registerRepository, "fixedPort"] },
  mutates: false,
  rationale: "The proxy re-reads the active worktree on every request, so the first request after use must already land on the new worktree, with no retry.",
  async run({}, { worktree, fixedPort }) {
    const { status, body } = await get(fixedPort);
    if (status !== 200 || body !== worktree) throw new Error(`the fixed port answered ${status} ${JSON.stringify(body)}, expected 200 ${JSON.stringify(worktree)}`);
    return {};
  },
});
