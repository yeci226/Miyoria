// How the sandbox talks to Docker: one CLI invocation per call, as an argument array. Tests
// inject a fake `DockerRunner`; the real one spawns the CLI without a shell.

import { spawn } from "node:child_process";
import { errorMessage } from "@miyoria/runtime/kernel";
import { dockerCliEnv } from "./args.js";

export interface ExecOptions {
  /** Written to the process's stdin, which is then closed. */
  stdin?: string | null;
  /**
   * Instead of `stdin`: written once it resolves (a pooled container waits for it), then stdin
   * is closed; `null` just closes it.
   */
  stdinLater?: Promise<string | null>;
  /** Sees each chunk of output as it arrives (before the caps). */
  onData?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
  /** Kills the CLI process (not the container: the sandbox does that by name). */
  signal?: AbortSignal;
  /** Bytes of stdout and of stderr kept; the rest is counted and dropped. */
  maxOutputBytes: number;
  /** Called once when stdout + stderr pass this many bytes. */
  outputLimit?: { bytes: number; onExceeded: () => void };
}

export interface ExecResult {
  /** `null` when the process did not exit normally (killed, or never started). */
  exit_code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  /** Total bytes seen, including the dropped ones. */
  stdout_bytes: number;
  stderr_bytes: number;
  /** Spawn failure (e.g. the executable is missing), else `null`. */
  error: string | null;
}

/** Runs the Docker CLI. */
export interface DockerRunner {
  exec(args: readonly string[], options: ExecOptions): Promise<ExecResult>;
}

/** Keeps the first `limit` bytes of a stream and counts the rest. */
class Capped {
  readonly #chunks: Buffer[] = [];
  #kept = 0;
  total = 0;

  constructor(readonly limit: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    const room = this.limit - this.#kept;
    if (room <= 0) return;
    const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.#chunks.push(part);
    this.#kept += part.length;
  }

  get buffer(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

/** The real runner: `spawn(docker, args)` with `shell: false` and a filtered environment. */
export class ProcessDockerRunner implements DockerRunner {
  constructor(
    readonly executable: string,
    readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  exec(args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const stdout = new Capped(options.maxOutputBytes);
      const stderr = new Capped(options.maxOutputBytes);
      let limitHit = false;
      let spawnError: string | null = null;
      const child = spawn(this.executable, [...args], {
        shell: false,
        windowsHide: true,
        env: dockerCliEnv(this.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const onAbort = () => child.kill("SIGKILL");
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      const checkLimit = () => {
        const limit = options.outputLimit;
        if (!limit || limitHit || stdout.total + stderr.total <= limit.bytes) return;
        limitHit = true;
        limit.onExceeded();
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        options.onData?.("stdout", chunk);
        checkLimit();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        options.onData?.("stderr", chunk);
        checkLimit();
      });
      // The program may exit without reading stdin (EPIPE); that is not an error of the run.
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        spawnError = errorMessage(error);
      });
      child.on("close", (code) => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve({
          // A failed spawn closes with a negative errno, not an exit code.
          exit_code: spawnError === null ? code : null,
          stdout: stdout.buffer,
          stderr: stderr.buffer,
          stdout_bytes: stdout.total,
          stderr_bytes: stderr.total,
          error: spawnError,
        });
      });
      if (options.stdinLater !== undefined) {
        void options.stdinLater.then((text) => {
          if (!child.stdin.writable) return;
          if (text) child.stdin.end(text);
          else child.stdin.end();
        });
      } else if (options.stdin) child.stdin.end(options.stdin);
      else child.stdin.end();
    });
  }
}
