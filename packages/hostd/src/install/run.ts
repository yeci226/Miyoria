// Running a program for the installer: an argument list, no shell, its output as lines. The
// runner is a seam: tests pass a fake, the real one is execa.

import { existsSync } from "node:fs";
import { execa } from "execa";
import { onPath } from "./uv.js";

/** One program to run. `env` is the whole environment (nothing is inherited). */
export interface RunSpec {
  file: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

export interface RunOutcome {
  /** Exit code; `null` when the program could not run or was cancelled. */
  code: number | null;
  /** The program does not exist (not on PATH). */
  missing: boolean;
  /** The last lines of its output, for an error message. */
  tail: string[];
}

export interface RunHooks {
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export type CommandRunner = (spec: RunSpec, hooks?: RunHooks) => Promise<RunOutcome>;

/** Lines kept for `tail`. */
const TAIL = 20;

/** Splits on newlines and on the carriage returns of progress bars. */
function lineSplitter(emit: (line: string) => void): { push(chunk: string): void; end(): void } {
  let rest = "";
  return {
    push(chunk) {
      const parts = (rest + chunk).split(/\r\n|\n|\r/);
      rest = parts.pop() ?? "";
      for (const part of parts) if (part.trim() !== "") emit(part);
    },
    end() {
      if (rest.trim() !== "") emit(rest);
      rest = "";
    },
  };
}

/** The real runner. Never throws: a program that cannot start is `missing`. */
export const execaRunner: CommandRunner = async (spec, hooks = {}) => {
  // On Windows execa falls back to cmd.exe for a program it cannot find, which answers with a
  // localized message and exit code 1: so look for the program first.
  const found = /[\\/]/.test(spec.file)
    ? existsSync(spec.file)
    : onPath(spec.file, spec.env, process.platform);
  if (!found) return { code: null, missing: true, tail: [] };
  const tail: string[] = [];
  const emit = (line: string) => {
    tail.push(line);
    if (tail.length > TAIL) tail.shift();
    hooks.onLine?.(line);
  };
  let subprocess: ReturnType<typeof execa>;
  try {
    subprocess = execa(spec.file, spec.args, {
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      env: spec.env,
      extendEnv: false,
      stdin: "ignore",
      all: true,
      buffer: false,
      reject: false,
      windowsHide: true,
      cleanup: true,
      ...(hooks.signal !== undefined ? { cancelSignal: hooks.signal } : {}),
    });
  } catch (error) {
    return {
      code: null,
      missing: true,
      tail: [error instanceof Error ? error.message : String(error)],
    };
  }
  const splitter = lineSplitter(emit);
  subprocess.all?.on("data", (chunk: Buffer) => splitter.push(chunk.toString("utf8")));
  const result = await subprocess;
  splitter.end();
  return {
    code: typeof result.exitCode === "number" ? result.exitCode : null,
    missing: false,
    tail,
  };
};
