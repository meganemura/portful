import { defineStep, z } from "nukadoko";
import { get } from "./portful-cli.ts";
import registerRepository from "./register-repository.ts";

// The proxy re-reads the active worktree on every request, so the first
// request after use must already land on the new worktree: one reading, no
// poll. Each worktree's server answers with its directory name, so the body
// names the worktree that answered.
export default defineStep({
  description: "Sends one GET to the fixed port and claims the body is the worktree's name. The status is recorded in the reading beside it.",
  pattern: "a request to the fixed port is answered by {worktree:string}",
  args: z.object({
    worktree: z.string().describe("the worktree whose server should answer, as its directory name"),
    fixedPort: registerRepository.returns.shape.fixedPort,
  }),
  from: { fixedPort: [registerRepository, "fixedPort"] },
  async observe({}, { fixedPort }) {
    const { status, body } = await get(fixedPort);
    return { status, body };
  },
  claims: [{ actual: "body", compare: "equal", expected: "worktree" }],
});
