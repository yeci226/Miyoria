import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DockerSandbox,
  SandboxConfigSchema,
  SandboxError,
  SessionClosedError,
} from "../src/index.js";
import { execTarget, FakeRunner, isKillAll, mountSource, result } from "./fake-runner.js";

let root: string;
let runner: FakeRunner;
let now: number;
const clock = { now: () => now };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "miyoria-sandbox-sessions-"));
  runner = new FakeRunner();
  now = 1_000_000;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sandbox(config: Record<string, unknown> = {}): DockerSandbox {
  return new DockerSandbox(SandboxConfigSchema.parse(config), {
    root,
    profile: "deepseek-chan",
    runner,
    clock,
    hostUser: null,
    killGraceMs: 50,
  });
}

async function errorOf(promise: Promise<unknown>): Promise<SandboxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    return error as SandboxError;
  }
  throw new Error("expected a SandboxError");
}

/** `/work` of a started container. */
function workOf(name: string): string {
  return mountSource(runner.started.get(name) ?? [], "/work") as string;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("sessions", () => {
  it("reuses_one_container_and_workspace_per_name", async () => {
    runner.onExec = async (args) => {
      const work = workOf(execTarget(args));
      const step = existsSync(join(work, "state.txt"))
        ? Number(await readFile(join(work, "state.txt"), "utf8"))
        : 0;
      await writeFile(join(work, "state.txt"), String(step + 1));
      if (step === 0) await writeFile(join(work, "first-only.txt"), "x");
      return result({ stdout: Buffer.from(`step ${step}\n`) });
    };
    const sbx = sandbox();
    const first = await sbx.run({ language: "python", code: "a", session: "weather-tool" });
    const second = await sbx.run({ language: "python", code: "b", session: "weather-tool" });

    expect(first.stdout).toBe("step 0\n");
    expect(second.stdout).toBe("step 1\n");
    expect(first.session).toEqual({ name: "weather-tool", created: true, closed: null });
    expect(second.session).toEqual({ name: "weather-tool", created: false, closed: null });
    // Only the files this run changed come back.
    expect(first.files_out.map((f) => f.path)).toEqual(["first-only.txt", "state.txt"]);
    expect(second.files_out.map((f) => f.path)).toEqual(["state.txt"]);

    // One long-lived container, same hardening, labelled as her session.
    const starts = [...runner.started.values()];
    expect(starts).toHaveLength(1);
    const start = starts[0] as string[];
    expect(start.slice(0, 3)).toEqual(["run", "--rm", "-d"]);
    for (const flag of ["--read-only", "--cap-drop", "--pids-limit", "--memory", "--init"]) {
      expect(start).toContain(flag);
    }
    expect(start[start.indexOf("--network") + 1]).toBe("none");
    expect(start).toContain("miyoria.sandbox.kind=session");
    expect(start).toContain("miyoria.sandbox.session=weather-tool");
    // The keeper runs as another uid than her programs (so the cleanup spares it).
    expect(start[start.indexOf("--user") + 1]).toBe("65533:65533");
    expect(start.slice(-2)).toEqual(["sleep", "infinity"]);
    expect(runner.calledWith("run").filter((c) => c[2] !== "-d")).toHaveLength(0);

    const execs = runner.programExecs;
    expect(execs).toHaveLength(2);
    for (const exec of execs) {
      expect(exec.slice(0, 4)).toEqual(["exec", "-i", "--user", "65534:65534"]);
      expect(exec.at(-1)).toMatch(/^\/code\/run-[0-9a-z]{26}\.py$/);
    }
    // Each run ends with every program process killed, before its files are read.
    const order = runner.calls
      .filter((c) => c[0] === "exec")
      .map((c) => (isKillAll(c) ? "killall" : "program"));
    expect(order).toEqual(["program", "killall", "program", "killall"]);
    // Programs do not pile up in /code.
    const code = mountSource(start, "/code") as string;
    expect(await readdir(code)).toEqual([]);

    expect(await sbx.listSessions()).toMatchObject([
      { name: "weather-tool", language: "python", runs: 2, busy: false },
    ]);
    expect(await sbx.closeSession("weather-tool")).toBe(true);
    expect(await sbx.closeSession("weather-tool")).toBe(false);
    expect(runner.running.size).toBe(0);
    expect(existsSync(workOf(execTarget(execs[0] as string[])))).toBe(false);
    expect(await sbx.listSessions()).toEqual([]);
  });

  it("closes_idle_and_old_sessions_and_says_so_once", async () => {
    const sbx = sandbox({ sessions: { idle_minutes: 1, lifetime_minutes: 5 } });
    await sbx.run({ language: "python", code: "x", session: "a" });
    now += 30_000;
    expect(await sbx.sweepSessions()).toBe(0);
    await sbx.run({ language: "python", code: "x", session: "a" });
    now += 61_000;
    expect(await sbx.sweepSessions()).toBe(1);
    expect(runner.running.size).toBe(0);
    expect(await sbx.listSessions()).toEqual([]);

    const gone = await errorOf(sbx.run({ language: "python", code: "x", session: "a" }));
    expect(gone).toBeInstanceOf(SessionClosedError);
    expect(gone.kind).toBe("session_closed");
    expect((gone as SessionClosedError).reason).toBe("idle");
    // Told once: the name starts a new, empty session.
    const again = await sbx.run({ language: "python", code: "x", session: "a" });
    expect(again.session?.created).toBe(true);
    expect(runner.started.size).toBe(2);

    // Lifetime: busy all along, it still closes; noticed on use even before a sweep.
    for (let i = 0; i < 5; i++) {
      now += 50_000;
      await sbx.run({ language: "python", code: "x", session: "a" });
    }
    now += 60_000;
    const old = await errorOf(sbx.run({ language: "python", code: "x", session: "a" }));
    expect((old as SessionClosedError).reason).toBe("lifetime");
    expect(runner.running.size).toBe(0);
  });

  it("caps_open_sessions_per_profile", async () => {
    const sbx = sandbox({ sessions: { max: 2 } });
    await sbx.run({ language: "python", code: "x", session: "a" });
    await sbx.run({ language: "node", code: "x", session: "b" });
    const full = await errorOf(sbx.run({ language: "python", code: "x", session: "c" }));
    expect(full.kind).toBe("limit");
    expect(full.message).toContain("a, b");
    // Fresh runs are not sessions.
    expect((await sbx.run({ language: "python", code: "x" })).session).toBeNull();
    await sbx.closeSession("a");
    expect((await sbx.run({ language: "python", code: "x", session: "c" })).session?.created).toBe(
      true,
    );
    expect((await sbx.listSessions()).map((s) => s.name)).toEqual(["b", "c"]);

    const off = sandbox({ sessions: { max: 0 } });
    expect((await errorOf(off.run({ language: "python", code: "x", session: "a" }))).kind).toBe(
      "limit",
    );
  });

  it("keeps_a_session_to_its_language_and_refuses_tools", async () => {
    const sbx = sandbox();
    await sbx.run({ language: "python", code: "x", session: "a" });
    const other = await errorOf(sbx.run({ language: "node", code: "x", session: "a" }));
    expect(other.kind).toBe("invalid_request");
    const tools = await errorOf(
      sbx.run({ language: "python", code: "x", session: "a", mount_tools: true }),
    );
    expect(tools.kind).toBe("invalid_request");
    const bad = await errorOf(sbx.run({ language: "python", code: "x", session: "../x" }));
    expect(bad.kind).toBe("invalid_request");
  });

  it("closes_a_session_over_its_disk_quota", async () => {
    runner.onExec = async (args) => {
      await writeFile(join(workOf(execTarget(args)), "big.bin"), Buffer.alloc(1024 * 1024 + 1));
      return result();
    };
    const sbx = sandbox({ sessions: { disk_mb: 1 } });
    const run = await sbx.run({ language: "python", code: "x", session: "a" });
    expect(run.session).toEqual({ name: "a", created: true, closed: "disk" });
    expect(runner.running.size).toBe(0);
    expect(await sbx.listSessions()).toEqual([]);
    // She was told in that result; the name is free again.
    runner.onExec = async () => result();
    expect((await sbx.run({ language: "python", code: "x", session: "a" })).session?.created).toBe(
      true,
    );
  });

  it("kills_only_the_program_on_timeout_and_keeps_the_session", async () => {
    let calls = 0;
    runner.onExec = async (_args, _options, r) => {
      calls++;
      if (calls > 1) return result({ stdout: Buffer.from("still here\n") });
      await r.waitForKill();
      return result({ exit_code: 137 });
    };
    const sbx = sandbox();
    const run = await sbx.run({ language: "python", code: "x", session: "a", timeout_ms: 20 });
    expect(run.killed_reason).toBe("timeout");
    // Killed inside the container (every process of her uid), not the container itself.
    expect(runner.calledWith("kill")).toHaveLength(0);
    expect(runner.killed[0]).toMatch(/^killall:miyoria-sbx-/);
    const next = await sbx.run({ language: "python", code: "x", session: "a" });
    expect(next.stdout).toBe("still here\n");
    expect(next.session?.created).toBe(false);
  });

  it("tells_her_when_the_container_went_away", async () => {
    const sbx = sandbox();
    await sbx.run({ language: "python", code: "x", session: "a" });
    runner.running.clear();
    const lost = await errorOf(sbx.run({ language: "python", code: "x", session: "a" }));
    expect((lost as SessionClosedError).reason).toBe("lost");
    expect((await sbx.run({ language: "python", code: "x", session: "a" })).session?.created).toBe(
      true,
    );
  });

  it("runs_one_at_a_time_per_session", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let running = 0;
    let peak = 0;
    runner.onExec = async () => {
      running++;
      peak = Math.max(peak, running);
      await gate;
      running--;
      return result();
    };
    const sbx = sandbox({ max_concurrent: 4 });
    const a = sbx.run({ language: "python", code: "1", session: "a" });
    const b = sbx.run({ language: "python", code: "2", session: "a" });
    await waitFor(() => running === 1);
    expect((await sbx.listSessions())[0]?.busy).toBe(true);
    release();
    await Promise.all([a, b]);
    expect(peak).toBe(1);
    expect(runner.started.size).toBe(1);
  });

  it("aborts_a_running_session_run_on_close", async () => {
    runner.onExec = async (_args, _options, r) => {
      await r.waitForKill();
      return result({ exit_code: 137 });
    };
    const sbx = sandbox();
    const pending = sbx.run({ language: "python", code: "x", session: "a" });
    await waitFor(() => runner.programExecs.length === 1);
    expect(await sbx.closeSession("a")).toBe(true);
    const run = await pending;
    expect(run.killed_reason).toBe("aborted");
    expect(run.session?.closed).toBe("closed");
    expect(runner.running.size).toBe(0);
  });

  it("never_writes_inputs_through_what_an_earlier_run_left", async () => {
    let step = 0;
    runner.onExec = async (args) => {
      const work = workOf(execTarget(args));
      if (step++ === 0) {
        await writeFile(join(work, "data"), "a file, not a directory");
        await mkdir(join(work, "real"));
        try {
          await symlink(root, join(work, "link"), "junction");
        } catch {
          // No link rights: the file case below still applies.
        }
      }
      return result();
    };
    const sbx = sandbox();
    await sbx.run({ language: "python", code: "x", session: "a" });
    for (const path of ["data/x.txt", "link/escape.txt", "real"]) {
      const error = await errorOf(
        sbx.run({ language: "python", code: "x", session: "a", files: [{ path, content: "p" }] }),
      );
      expect(error.kind, path).toBe("invalid_path");
    }
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
    // A plain file of the same name is replaced.
    const ok = await sbx.run({
      language: "python",
      code: "x",
      session: "a",
      files: [{ path: "data2.txt", content: "1" }],
    });
    expect(ok.exit_code).toBe(0);
    const again = await sbx.run({
      language: "python",
      code: "x",
      session: "a",
      files: [{ path: "data2.txt", content: "2" }],
    });
    expect(again.exit_code).toBe(0);
  });

  it("removes_sessions_on_close_and_leftover_workspaces_on_prune", async () => {
    const sbx = sandbox();
    await sbx.run({ language: "python", code: "x", session: "a" });
    await sbx.run({ language: "node", code: "x", session: "b" });
    const base = join(root, "profiles", "deepseek-chan", "sessions");
    expect(await readdir(base)).toHaveLength(2);
    await sbx.close();
    expect(runner.running.size).toBe(0);
    expect(await readdir(base)).toHaveLength(0);

    // A workspace left by an earlier process goes at the next start.
    await mkdir(join(base, "01J00000000000000000000000", "work"), { recursive: true });
    await sandbox().prune();
    expect(await readdir(base)).toHaveLength(0);
  });
});

describe("warm pool", () => {
  it("serves_each_container_exactly_once", async () => {
    runner.onRun = async (args, options) => {
      const work = mountSource(args, "/work") as string;
      const code = await readFile(join(mountSource(args, "/code") as string, "main.py"), "utf8");
      const seen = existsSync(join(work, "marker"));
      await writeFile(join(work, "marker"), "used");
      return result({
        stdout: Buffer.from(`${seen ? "dirty" : "clean"} ${code} ${options.stdin}\n`),
        stderr: Buffer.from("warn"),
      });
    };
    const sbx = sandbox({ pool_size: 1 });
    sbx.warm();
    await waitFor(() => sbx.pool.ready.python === 1 && sbx.pool.ready.node === 1);
    const pooled = [...runner.started.keys()];

    for (let i = 0; i < 4; i++) {
      await waitFor(() => sbx.pool.ready.python === 1);
      const run = await sbx.run({ language: "python", code: `p${i}`, stdin: `in${i}` });
      // Its program, its stdin; the ready byte is not part of the program's stderr.
      expect(run.stdout).toBe(`clean p${i} in${i}\n`);
      expect(run.stderr).toBe("warn");
      expect(run.session).toBeNull();
      expect(run.files_out.map((f) => f.path)).toEqual(["marker"]);
    }
    // Every pooled container ran at most one program, then ended with it.
    expect(sbx.pool.served).toBe(4);
    expect([...runner.programs.values()]).toEqual([1, 1, 1, 1]);
    for (const name of runner.programs.keys()) expect(runner.running.has(name)).toBe(false);
    // The same hardened `docker run` as a fresh run, waiting for its go line.
    const args = pooled
      .map((name) => runner.started.get(name) as string[])
      .find((a) => a.includes("python3")) as string[];
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "-i"]);
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    for (const flag of ["--read-only", "--cap-drop", "--pids-limit", "--memory", "--init"]) {
      expect(args).toContain(flag);
    }
    expect(args).toContain("miyoria.sandbox.kind=pool");
    expect(args.slice(-6, -5)).toEqual(["sh"]);
    expect(args.slice(-5)).toEqual(["python3", "-I", "-B", "-u", "/code/main.py"]);
    // No container was started for a run.
    expect(runner.calledWith("run").some((c) => c.includes("miyoria.sandbox.kind=run"))).toBe(
      false,
    );
    await waitFor(() => sbx.pool.ready.python === 1);

    await sbx.close();
    expect(runner.running.size).toBe(0);
    expect(sbx.pool.ready).toEqual({ python: 0, node: 0 });
    expect(await readdir(join(root, "runs"))).toHaveLength(4);
  });

  it("kills_a_pooled_run_by_name_and_falls_back_to_fresh", async () => {
    runner.onRun = async (args, _options, r) => {
      if (args.includes("miyoria.sandbox.kind=run"))
        return result({ stdout: Buffer.from("fresh\n") });
      await r.waitForKill();
      return result({ exit_code: 137 });
    };
    const sbx = sandbox({ pool_size: 1 });
    sbx.warm();
    await waitFor(() => sbx.pool.ready.python === 1);
    const spin = await sbx.run({ language: "python", code: "x", timeout_ms: 30 });
    expect(spin.killed_reason).toBe("timeout");
    expect(runner.killed).toHaveLength(1);

    // The pooled container died (e.g. Docker restarted): the run still happens, fresh.
    await waitFor(() => sbx.pool.ready.python === 1);
    runner.crash();
    await waitFor(() => sbx.pool.ready.python === 0);
    expect((await sbx.run({ language: "python", code: "x" })).stdout).toBe("fresh\n");

    // The tools workspace is never in a pooled container: such runs start their own.
    await waitFor(() => sbx.pool.ready.python === 1);
    await sbx.run({ language: "python", code: "x", mount_tools: true });
    expect(
      runner.calledWith("run").filter((c) => c.includes("miyoria.sandbox.kind=run")),
    ).toHaveLength(2);
    expect(sbx.pool.ready.python).toBe(1);

    // A bad request still uses up (and removes) the container it took.
    const taken = await errorOf(
      sbx.run({ language: "python", code: "x", files: [{ path: "../x", content: "" }] }),
    );
    expect(taken.kind).toBe("invalid_path");
    await waitFor(() => sbx.pool.ready.python === 1);
    expect([...runner.programs.values()].every((n) => n <= 1)).toBe(true);
    await sbx.close();
    expect(runner.running.size).toBe(0);
  });

  it("starts_nothing_without_docker_or_before_warm", async () => {
    const cold = sandbox({ pool_size: 2 });
    await cold.run({ language: "python", code: "x" });
    expect(runner.started.size).toBe(0);

    runner.startFails = true;
    const sbx = sandbox({ pool_size: 1 });
    sbx.warm();
    await waitFor(() => sbx.pool.starting === 0);
    expect(sbx.pool.ready).toEqual({ python: 0, node: 0 });
    // Runs still work without a pool.
    runner.startFails = false;
    expect((await sbx.run({ language: "python", code: "x" })).stdout).toBe("ok\n");
    await sbx.close();

    const off = sandbox({ pool_size: 0 });
    off.warm();
    expect(off.pool.starting).toBe(0);

    // Off by default: the default config pre-starts nothing, even after `warm()`.
    expect(SandboxConfigSchema.parse({}).pool_size).toBe(0);
    const before = runner.started.size;
    const byDefault = sandbox();
    byDefault.warm();
    await byDefault.run({ language: "python", code: "x" });
    expect(byDefault.pool).toMatchObject({ starting: 0, started: 0, served: 0 });
    expect(runner.started.size).toBe(before);
  });
});
