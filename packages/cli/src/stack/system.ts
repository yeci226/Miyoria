// Side-effect seams of the stack commands: running a program, probing a port, reading Windows port
// reservations. Tests replace them; nothing here changes system settings.

import { type SpawnOptions, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program could not be started (not installed). */
  missing: boolean;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Pass output through to the terminal instead of capturing it. */
  inherit?: boolean;
}

/** Runs a program to completion. `.cmd` shims (pnpm, gradlew.bat) go through the shell. */
export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

/** Programs resolved through `cmd.exe` on Windows; arguments here are always fixed strings. */
export function needsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /^(pnpm|npm|npx|gradlew)(\.bat|\.cmd)?$/i.test(command);
}

/**
 * `spawn` arguments for a program: shim programs become one command line for the shell (Node
 * deprecates passing an argument list together with `shell: true`).
 */
export function spawnTarget(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
  if (!needsShell(command, platform)) return { command, args: [...args], shell: false };
  const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);
  return { command: [command, ...args.map(quote)].join(" "), args: [], shell: true };
}

export const defaultRunner: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const target = spawnTarget(command, args);
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      shell: target.shell,
      windowsHide: true,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    };
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(target.command, target.args, spawnOptions);
    } catch {
      resolve({ code: null, stdout, stderr, missing: true, timedOut });
      return;
    }
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : null;
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr, missing: error.code === "ENOENT", timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, missing: false, timedOut });
    });
  });

// ---- ports -------------------------------------------------------------------------------

/** `denied` is Windows refusing the bind although nothing listens: a reserved port range. */
export type PortState = "free" | "in-use" | "denied" | "error";

export type PortProbe = (port: number, host?: string) => Promise<PortState>;

/** Tries to bind the port briefly. No data is sent. */
export const probePort: PortProbe = (port, host = "127.0.0.1") =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve("in-use");
      else if (error.code === "EACCES" || error.code === "EPERM") resolve("denied");
      else resolve("error");
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve("free"));
    });
  });

export interface PortRange {
  start: number;
  end: number;
}

/** `netsh interface ipv4 show excludedportrange protocol=tcp`: rows of `start end`. */
export function parseExcludedRanges(text: string): PortRange[] {
  const ranges: PortRange[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*\*?\s*$/.exec(line);
    if (m) ranges.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  return ranges;
}

/**
 * `netsh int ipv4 show dynamicport tcp`: start port and count. Labels are localized, so the first
 * two numbers after a colon are taken in order.
 */
export function parseDynamicPort(text: string): { start: number; count: number } | null {
  const numbers: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /[:：]\s*(\d+)\s*$/.exec(line);
    if (m) numbers.push(Number(m[1]));
  }
  const [start, count] = numbers;
  return start === undefined || count === undefined ? null : { start, count };
}

export function inRanges(port: number, ranges: readonly PortRange[]): PortRange | undefined {
  return ranges.find((r) => port >= r.start && port <= r.end);
}

// ---- environment for child processes -----------------------------------------------------

const ENV_ALLOW =
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|USERNAME|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMPUTERNAME|NUMBER_OF_PROCESSORS|PROCESSOR_\w+|OS|LANG|LC_\w+|TZ|CUDA_\w+|NVIDIA_\w+|HF_\w+|HUGGINGFACE_\w+|TRANSFORMERS_\w+|TORCH\w*|XDG_\w+|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|LOG_LEVEL)$/i;

/**
 * What a worker inherits: the system basics, CUDA and model-cache variables, proxies. Not the rest
 * of the shell (API keys, tokens), and not a stale `ASR_MODEL` left from an older setup.
 */
export function workerBaseEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOW.test(key)) out[key] = value;
  }
  return out;
}

/** Last lines of a log text, for a failed start. */
export function tailLines(text: string, count: number): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-count);
}

/** Whether a TCP connection to host:port succeeds within the timeout. */
export function tcpConnect(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
