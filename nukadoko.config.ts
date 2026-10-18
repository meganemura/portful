import { defineConfig, defineFixtures } from "nukadoko";
import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// Long-running portful processes (serve, proxy start) a step started. They
// run in the foreground by design, so the scenario owns stopping them.
export interface Processes {
  keep(child: ChildProcess): void;
}

const fixtures = defineFixtures({
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
    processes: Processes;
  }
}

export default defineConfig({
  fixtures,
});
