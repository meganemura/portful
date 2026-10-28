import { defineProgram } from "nukadoko";

// The steps run the built CLI, dist/cli.js, which git ignores. Building it
// here gives each tree of `nuka run --base` its own, from its own source.
export default defineProgram({
  build: ["npm run build"],
});
