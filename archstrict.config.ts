import type { Config } from "./archstrict.types.js";

// Public surface: other modules may import a directory module only through
// its own surface file (named by `surface` below), or through the files its own
// package.json exports map names. An import that reaches any other file in
// the directory is a violation. A directory module with no such file is
// entirely private. A module whose glob names one file is that file, so its
// entry names the file itself as its surface.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  // Kept out of analysis entirely:
  // - archstrict's own two files, which are never module content;
  // - hidden directories at any depth (.git, tool state), which tsc's own
  //   default include also skips;
  // - common noise directories that init found on disk (test).
  //   Remove one of these entries if that directory holds module content.
  // - the nukadoko scenario, which runs the built dist/cli.js as a child
  //   process and imports nothing from src/.
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
    "features/**",
    "nukadoko.config.ts",
  ],
  // src/ is mostly flat, so most files are their own module and every import
  // between two of them is checked. commands/ and ui/ are directory modules.
  declaredModules: [
    // Each directory and TypeScript source file directly in src/.
    { name: "cli.ts", glob: "src/cli.ts", surface: "cli.ts" },
    // One file per CLI command. cli.ts imports every one of them, so each is public.
    { name: "commands", glob: "src/commands/**", surface: "*.ts" },
    { name: "config.ts", glob: "src/config.ts", surface: "config.ts" },
    { name: "dispatch.ts", glob: "src/dispatch.ts", surface: "dispatch.ts" },
    { name: "mux.ts", glob: "src/mux.ts", surface: "mux.ts" },
    { name: "overview.ts", glob: "src/overview.ts", surface: "overview.ts" },
    { name: "picker.ts", glob: "src/picker.ts", surface: "picker.ts" },
    { name: "portRefs.ts", glob: "src/portRefs.ts", surface: "portRefs.ts" },
    { name: "ports.ts", glob: "src/ports.ts", surface: "ports.ts" },
    { name: "proxy.ts", glob: "src/proxy.ts", surface: "proxy.ts" },
    { name: "prune.ts", glob: "src/prune.ts", surface: "prune.ts" },
    { name: "repo.ts", glob: "src/repo.ts", surface: "repo.ts" },
    { name: "startCommand.ts", glob: "src/startCommand.ts", surface: "startCommand.ts" },
    { name: "state.ts", glob: "src/state.ts", surface: "state.ts" },
    { name: "tasks.ts", glob: "src/tasks.ts", surface: "tasks.ts" },
    // The terminal UI's model, actions, and renderer. commands/ui.ts wires all three.
    { name: "ui", glob: "src/ui/**", surface: "*.ts" },
    { name: "version.ts", glob: "src/version.ts", surface: "version.ts" },
    // Each other top-level directory that holds TypeScript source, and each top-level TypeScript source file.
    { name: "tsup.config.ts", glob: "tsup.config.ts", surface: "tsup.config.ts" },
  ],
  strict: [
    "cli.ts", "commands", "config.ts", "dispatch.ts", "mux.ts", "overview.ts", "picker.ts", "portRefs.ts", "ports.ts",
    "proxy.ts", "prune.ts", "repo.ts", "startCommand.ts", "state.ts", "tasks.ts", "ui", "version.ts", "tsup.config.ts",
  ],
  // The layers, bottom to top. A file may import its own layer or a lower
  // one, never a higher one. The most specific glob wins, so commands/ui.ts
  // sits with the UI it drives rather than with the other commands.
  classify: [
    { glob: "src/config.ts", tags: ["layer:leaf"] },
    { glob: "src/state.ts", tags: ["layer:leaf"] },
    { glob: "src/ports.ts", tags: ["layer:leaf"] },
    { glob: "src/dispatch.ts", tags: ["layer:leaf"] },
    { glob: "src/startCommand.ts", tags: ["layer:leaf"] },
    { glob: "src/version.ts", tags: ["layer:leaf"] },
    { glob: "src/mux.ts", tags: ["layer:base"] },
    { glob: "src/picker.ts", tags: ["layer:base"] },
    { glob: "src/repo.ts", tags: ["layer:base"] },
    { glob: "src/prune.ts", tags: ["layer:base"] },
    { glob: "src/tasks.ts", tags: ["layer:base"] },
    { glob: "src/proxy.ts", tags: ["layer:base"] },
    { glob: "src/portRefs.ts", tags: ["layer:base"] },
    { glob: "src/overview.ts", tags: ["layer:view"] },
    { glob: "src/commands/**", tags: ["layer:command"] },
    { glob: "src/commands/ui.ts", tags: ["layer:screen"] },
    { glob: "src/ui/**", tags: ["layer:screen"] },
    { glob: "src/cli.ts", tags: ["layer:entry"] },
  ],
  edges: {
    order: [
      {
        tagNamespace: "layer",
        sequence: { "": ["leaf", "base", "view", "command", "screen", "entry"] },
        direction: "downward-only",
        because:
          "config, state, ports, and the other leaves import no sibling; the git, picker, proxy, and port-reference helpers build on them; overview.ts joins them into what list and status print; each command uses those; the terminal UI drives commands; cli.ts dispatches and nothing imports it",
      },
    ],
  },
  because: "src/ is mostly one file per concern, so most files are their own module, and the layer order keeps the leaves free of the commands and the UI",
} satisfies Config;
