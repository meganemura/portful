import { defineConfig, defineFixtures } from "nukadoko";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Scratch directories a step can write into freely, removed after the
// scenario whether it passed or failed.
export interface Scratch {
  dir(prefix: string): string;
}

// Long-running portful processes (serve, proxy start) a step started. They
// run in the foreground by design, so the scenario owns stopping them.
export interface Processes {
  keep(child: ChildProcess): void;
}

const fixtures = defineFixtures({
  scratch: async ({}, use) => {
    const dirs: string[] = [];
    await use({
      dir(prefix: string): string {
        const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
        dirs.push(dir);
        return dir;
      },
    });
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  },
  processes: async ({}, use) => {
    const children: ChildProcess[] = [];
    await use<Processes>({ keep: (child) => void children.push(child) });
    // SIGTERM only the pids this scenario started. portful serve forwards it
    // to its server's process group before it exits.
    const running = children.filter((child) => child.exitCode === null && child.signalCode === null);
    for (const child of running) child.kill("SIGTERM");
    const deadline = Date.now() + 5_000;
    while (running.some((child) => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) await sleep(50);
    for (const child of running) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  },
});

declare module "nukadoko" {
  interface StepFixtures {
    scratch: Scratch;
    processes: Processes;
  }
}

export default defineConfig({
  fixtures,
});
