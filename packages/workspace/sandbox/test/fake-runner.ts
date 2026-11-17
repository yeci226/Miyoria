// A scripted `DockerRunner` for unit tests: records every call and answers control commands;
// `docker run` behaviour is supplied per test.

import type { DockerRunner, ExecOptions, ExecResult } from "../src/index.js";

export function result(over: Partial<ExecResult> = {}): ExecResult {
  const stdout = over.stdout ?? Buffer.alloc(0);
  const stderr = over.stderr ?? Buffer.alloc(0);
  return {
    exit_code: 0,
    stdout,
    stderr,
    stdout_bytes: stdout.length,
    stderr_bytes: stderr.length,
    error: null,
    ...over,
  };
}

export type RunHandler = (
  args: readonly string[],
  options: ExecOptions,
  runner: FakeRunner,
) => Promise<ExecResult>;

/** Host source path of the `--mount` with `target`. */
export function mountSource(args: readonly string[], target: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--mount") continue;
    const value = args[i + 1] as string;
    if (value.endsWith(`target=${target}`) || value.includes(`target=${target},`)) {
      const match = /source=([^,]*)/.exec(value);
      return match?.[1] ?? null;
    }
  }
  return null;
}

/** The container name a `docker exec` targets (after its flags). */
export function execTarget(args: readonly string[]): string {
  let i = 1;
  while (args[i]?.startsWith("-")) i += args[i] === "--user" ? 2 : 1;
  return args[i] as string;
}

/** Whether `docker exec` args are the session cleanup (`killAllArgs`). */
export function isKillAll(args: readonly string[]): boolean {
  return args[0] === "exec" && args.includes("sh") && (args.at(-1) ?? "").includes("kill -KILL -1");
}

export class FakeRunner implements DockerRunner {
  readonly calls: string[][] = [];
  dockerUp = true;
  imagePresent = true;
  psOutput = "";
  onRun: RunHandler = async () => result({ stdout: Buffer.from("ok\n") });
  /** A program run through `docker exec` (pooled or session container). */
  onExec: RunHandler = async () => result({ stdout: Buffer.from("ok\n") });
  /** `docker run -d` fails while set. */
  startFails = false;
  /** Containers started with `docker run -d` and not killed or removed, by name. */
  readonly running = new Set<string>();
  /** Every container started with `docker run -d`, by name, with its args. */
  readonly started = new Map<string, string[]>();
  /** Docker networks created and not removed. */
  readonly networks = new Set<string>();
  /** Programs run per pooled container name. */
  readonly programs = new Map<string, number>();
  /** Ends a waiting pooled container's CLI, by name. */
  readonly #ends = new Map<string, () => void>();
  #killed = new Set<string>();
  #killWaiters: Array<() => void> = [];

  /** Every container dies (Docker restarted). */
  crash(): void {
    this.running.clear();
    for (const end of this.#ends.values()) end();
  }

  /** Names passed to `docker kill` (and `killall:<name>` for a session cleanup). */
  get killed(): string[] {
    return [...this.#killed];
  }

  /** Resolves when `docker kill` has been called for `name` (or any name). */
  waitForKill(): Promise<void> {
    if (this.#killed.size > 0) return Promise.resolve();
    return new Promise((resolve) => this.#killWaiters.push(resolve));
  }

  #kill(name: string): void {
    this.#killed.add(name);
    for (const wake of this.#killWaiters.splice(0)) wake();
  }

  calledWith(command: string): string[][] {
    return this.calls.filter((c) => c[0] === command || `${c[0]} ${c[1]}` === command);
  }

  /** `docker exec` calls of programs (not cleanups). */
  get programExecs(): string[][] {
    return this.calls.filter((c) => c[0] === "exec" && !isKillAll(c));
  }

  async exec(args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    this.calls.push([...args]);
    const [command] = args;
    const gone = (name: string) =>
      result({
        exit_code: 1,
        stderr: Buffer.from(`Error response from daemon: No such container: ${name}\n`),
      });
    if (command === "run" && args[2] === "-d") {
      const name = args[args.indexOf("--name") + 1] as string;
      if (this.startFails) {
        return result({
          exit_code: 125,
          stderr: Buffer.from("docker: Error response from daemon\n"),
        });
      }
      this.running.add(name);
      this.started.set(name, [...args]);
      return result({ stdout: Buffer.from("0123456789abcdef\n") });
    }
    if (command === "run" && options.stdinLater !== undefined) {
      // A pooled container: up, waiting for its go line, then the program (`onRun`).
      const name = args[args.indexOf("--name") + 1] as string;
      if (this.startFails) {
        return result({
          exit_code: 125,
          stderr: Buffer.from("docker: Error response from daemon\n"),
        });
      }
      this.running.add(name);
      this.started.set(name, [...args]);
      const ended = new Promise<null>((resolve) => this.#ends.set(name, () => resolve(null)));
      options.signal?.addEventListener("abort", () => this.#ends.get(name)?.());
      setTimeout(() => options.onData?.("stderr", Buffer.from([0x06])), 0);
      const stdin = await Promise.race([options.stdinLater, ended]);
      if (stdin === null || !this.running.has(name)) {
        this.running.delete(name);
        return result({ exit_code: 137, stderr: Buffer.from([0x06]) });
      }
      this.programs.set(name, (this.programs.get(name) ?? 0) + 1);
      const out = await this.onRun(args, { ...options, stdin: stdin.slice(1) }, this);
      this.running.delete(name);
      this.#ends.delete(name);
      return {
        ...out,
        stderr: Buffer.concat([Buffer.from([0x06]), out.stderr]),
        stderr_bytes: out.stderr_bytes + 1,
      };
    }
    if (command === "exec") {
      const name = execTarget(args);
      if (!this.running.has(name)) return gone(name);
      if (isKillAll(args)) {
        this.#kill(`killall:${name}`);
        return result();
      }
      return this.onExec(args, options, this);
    }
    if (command === "container") {
      const name = args.at(-1) as string;
      return this.running.has(name) ? result({ stdout: Buffer.from("true\n") }) : gone(name);
    }
    if (command === "rm") {
      for (const name of args.slice(2)) {
        this.running.delete(name);
        this.#ends.get(name)?.();
      }
      return result();
    }
    if (command === "kill") {
      const name = args[args.length - 1] as string;
      this.running.delete(name);
      this.#kill(name);
      return result();
    }
    if (command === "network") {
      const [, sub] = args;
      const name = args.at(-1) as string;
      if (sub === "inspect") return this.networks.has(name) ? result() : result({ exit_code: 1 });
      if (sub === "create") {
        this.networks.add(name);
        return result();
      }
      if (sub === "rm") {
        this.networks.delete(name);
        return result();
      }
      return result();
    }
    if (command === "version") {
      return this.dockerUp
        ? result({ stdout: Buffer.from("29.8.2\n") })
        : result({
            exit_code: 1,
            stderr: Buffer.from("error during connect: the docker daemon is not running\n"),
          });
    }
    if (command === "image") {
      return this.imagePresent ? result() : result({ exit_code: 1 });
    }
    if (command === "pull") {
      this.imagePresent = true;
      return result();
    }
    if (command === "ps") return result({ stdout: Buffer.from(this.psOutput) });
    if (command === "run") return this.onRun(args, options, this);
    return result({ exit_code: 1, stderr: Buffer.from(`unknown command ${command}`) });
  }
}
