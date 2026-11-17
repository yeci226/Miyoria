// One service process: spawned with execa (an argument list, no shell; execa resolves `.cmd`
// shims such as `pnpm` on Windows and quotes their arguments itself), its output into the
// service's log, and a stop that ends the whole process tree.
//
// Stopping: a polite request first, then `run.stop.grace_s`, then the tree is killed.
// - Unix: the service runs in its own process group (execa `killDescendants`), so SIGTERM and
//   then SIGKILL go to the group; SIGKILL is sent even when the direct child already left, for
//   descendants that ignored SIGTERM.
// - Windows: there are no signals. The polite request is `taskkill /T` without `/F`, which only
//   closes processes that have a window; a console program refuses it, and then the tree is
//   killed at once with `taskkill /T /F` (execa `killDescendants`). That needs the direct child
//   alive: taskkill cannot find the descendants of a process that already exited.

import { join } from "node:path";
import { execa } from "execa";
import type { ServiceLog } from "./logs.js";
import type { SpawnSpec } from "./resolve.js";

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** Why it could not be started at all (a missing program). */
  error?: string;
}

export interface ServiceProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<ExitInfo>;
  hasExited(): boolean;
  /** Polite request, `graceMs`, then the tree. Resolves once the process is gone. */
  stop(graceMs: number): Promise<void>;
  /** The whole tree, now. */
  kill(): void;
}

/** How long the last output of an exited process may take to arrive. */
const OUTPUT_DRAIN_MS = 500;

/** How long to wait for the process after the tree was killed. */
const KILL_WAIT_MS = 10_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskkill(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return join(root, "System32", "taskkill.exe");
}

/** Starts a service process; its output goes to `log`. Never throws for a missing program. */
export function spawnService(spec: SpawnSpec, log: ServiceLog): ServiceProcess {
  let exitInfo: ExitInfo | null = null;
  let settle: (info: ExitInfo) => void = () => {};
  const exited = new Promise<ExitInfo>((resolve) => {
    settle = (info) => {
      if (exitInfo !== null) return;
      exitInfo = info;
      log.flush();
      resolve(info);
    };
  });

  const launch = () =>
    execa(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      extendEnv: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      buffer: false,
      reject: false,
      // The tree on kill: its own process group on Unix, `taskkill /T` on Windows.
      killDescendants: true,
      // hostd decides when to escalate (`run.stop.grace_s`).
      forceKillAfterDelay: false,
      // Killed when the daemon exits.
      cleanup: true,
      windowsHide: true,
    });
  let subprocess: ReturnType<typeof launch>;
  try {
    subprocess = launch();
  } catch (error) {
    settle({
      code: null,
      signal: null,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      pid: undefined,
      exited,
      hasExited: () => true,
      stop: async () => {},
      kill: () => {},
    };
  }

  subprocess.stdout?.on("data", (chunk: Buffer) => log.write(chunk, "out"));
  subprocess.stderr?.on("data", (chunk: Buffer) => log.write(chunk, "err"));
  const drained = Promise.all(
    [subprocess.stdout, subprocess.stderr].map(
      (stream) =>
        new Promise<void>((done) => {
          if (stream === null || stream === undefined || stream.readableEnded) done();
          else {
            stream.once("end", () => done());
            stream.once("close", () => done());
          }
        }),
    ),
  );
  // The child's own exit. Its last output (a traceback) may still be in the pipes: wait for them
  // a moment, not for ever, since a descendant may keep them open. execa's promise waits for them
  // without a limit.
  let processExited = false;
  subprocess.nodeChildProcess.on("exit", (code, signal) => {
    processExited = true;
    void Promise.race([drained, wait(OUTPUT_DRAIN_MS)]).then(() => settle({ code, signal }));
  });
  void subprocess.then((result) => {
    settle({
      code: result.exitCode ?? null,
      signal: result.signal ?? null,
      ...(result.failed && result.exitCode === undefined && result.signal === undefined
        ? { error: result.shortMessage }
        : {}),
    });
  });

  const hasExited = () => processExited || exitInfo !== null;
  const gone = (ms: number) => Promise.race([exited.then(() => true), wait(ms).then(() => false)]);

  const kill = () => {
    try {
      subprocess.kill("SIGKILL");
    } catch {
      // already gone
    }
  };

  const stop = async (graceMs: number) => {
    if (process.platform === "win32") {
      if (hasExited()) return;
      const polite = await execa(taskkill(), ["/pid", String(subprocess.pid), "/T"], {
        reject: false,
        timeout: 5000,
        windowsHide: true,
        stdin: "ignore",
      });
      if (!polite.failed && (await gone(graceMs))) return;
      kill();
      await gone(KILL_WAIT_MS);
      return;
    }
    if (!hasExited()) {
      try {
        subprocess.kill("SIGTERM");
      } catch {
        // already gone
      }
      await gone(graceMs);
    }
    kill();
    await gone(KILL_WAIT_MS);
  };

  return { pid: subprocess.pid, exited, hasExited, stop, kill };
}
