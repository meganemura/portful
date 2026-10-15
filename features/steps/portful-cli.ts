// Runs the built CLI, the file npm installs as `portful`, with XDG config and
// state directories of the scenario's own, so the person's repos and state
// are never read.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

export interface PortfulHome {
  configHome: string;
  stateHome: string;
}

function env(home: PortfulHome): NodeJS.ProcessEnv {
  return { ...process.env, XDG_CONFIG_HOME: home.configHome, XDG_STATE_HOME: home.stateHome };
}

export function runPortful(args: string[], home: PortfulHome): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: env(home) });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

// For the foreground commands (serve, proxy start): the caller keeps the
// child and stops it when the scenario ends.
export function startPortful(args: string[], home: PortfulHome): ChildProcess {
  return spawn(process.execPath, [CLI, ...args], { env: env(home), stdio: "ignore" });
}

export function get(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Polls until the port answers an HTTP request, for at most 10 s.
export async function waitForAnswer(port: number, child: ChildProcess, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${what} exited with code ${child.exitCode} before port ${port} answered`);
    try {
      await get(port);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`${what}: port ${port} did not answer within 10 s`);
      await sleep(100);
    }
  }
}
