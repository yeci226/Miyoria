import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JsonValue, newId } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DockerSandbox,
  instanceId,
  pruneRuns,
  type SandboxConfig,
  SandboxConfigSchema,
  SandboxError,
} from "../src/index.js";
import { FakeRunner, mountSource, result } from "./fake-runner.js";

let root: string;
let runner: FakeRunner;
let events: Array<[string, unknown]>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "miyoria-sandbox-"));
  runner = new FakeRunner();
  events = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sandbox(config: Record<string, unknown> = {}): DockerSandbox {
  const cfg: SandboxConfig = SandboxConfigSchema.parse(config);
  return new DockerSandbox(cfg, {
    root,
    profile: "deepseek-chan",
    runner,
    hostUser: null,
    killGraceMs: 50,
    publisher: (definition, payload, ..._meta) => {
      events.push([definition.type, payload as JsonValue]);
    },
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

describe("DockerSandbox.run", () => {
  it("runs_with_inputs_and_returns_new_or_changed_files", async () => {
    let seen: { work: string; code: string; program: string; input: string } | null = null;
    runner.onRun = async (args, options) => {
      const work = mountSource(args, "/work") as string;
      const code = mountSource(args, "/code") as string;
      seen = {
        work,
        code,
        program: await readFile(join(code, "main.py"), "utf8"),
        input: await readFile(join(work, "data", "in.txt"), "utf8"),
      };
      expect(options.stdin).toBe("hello");
      await writeFile(join(work, "out.txt"), "result");
      await writeFile(join(work, "changed.txt"), "new");
      await writeFile(join(work, "bin.dat"), Buffer.from([0xff, 0x00, 0xfe]));
      return result({ stdout: Buffer.from("done\n"), stderr: Buffer.from("warn\n") });
    };
    const sbx = sandbox();
    const run = await sbx.run({
      language: "python",
      code: "print('done')",
      stdin: "hello",
      files: [
        { path: "data/in.txt", content: "input" },
        { path: "changed.txt", content: "old" },
      ],
    });
    expect(seen).not.toBeNull();
    const s = seen as unknown as { work: string; code: string; program: string; input: string };
    expect(s.program).toBe("print('done')");
    expect(s.input).toBe("input");
    expect(s.work.startsWith(join(root, "runs"))).toBe(true);
    expect(run).toMatchObject({
      language: "python",
      exit_code: 0,
      stdout: "done\n",
      stderr: "warn\n",
      stdout_truncated: false,
      killed_reason: null,
      files_out_truncated: false,
    });
    expect(run.files_out).toEqual([
      { path: "bin.dat", size: 3, encoding: "base64", content: "/wD+" },
      { path: "changed.txt", size: 3, encoding: "utf8", content: "new" },
      { path: "out.txt", size: 6, encoding: "utf8", content: "result" },
    ]);
    // The program is gone, the outputs are kept for retention.
    expect(existsSync(s.code)).toBe(false);
    expect(existsSync(join(s.work, "out.txt"))).toBe(true);
    expect(events.map(([t]) => t)).toEqual(["sandbox.run.finished"]);

    const runArgs = runner.calledWith("run")[0] ?? [];
    const name = runArgs[runArgs.indexOf("--name") + 1];
    expect(name).toBe(`miyoria-sbx-${run.run_id.toLowerCase()}`);
    expect(runner.calledWith("run")[0]).toContain(`miyoria.sandbox.instance=${instanceId(root)}`);
  });

  it("kills_the_container_by_name_on_timeout", async () => {
    runner.onRun = async (_args, _options, r) => {
      await r.waitForKill();
      return result({ exit_code: 137, stdout: Buffer.from("partial") });
    };
    const run = await sandbox().run({ language: "node", code: "for(;;){}", timeout_ms: 30 });
    expect(run.killed_reason).toBe("timeout");
    expect(run.exit_code).toBe(137);
    expect(run.stdout).toBe("partial");
    expect(runner.killed).toEqual([`miyoria-sbx-${run.run_id.toLowerCase()}`]);
    expect(runner.calledWith("kill")[0]?.slice(0, 3)).toEqual(["kill", "--signal", "KILL"]);
  });

  it("drops_a_hung_cli_after_the_grace_and_force_removes", async () => {
    runner.onRun = (_args, options) =>
      new Promise((resolve) => {
        // Ignores the kill; only the CLI abort ends it.
        options.signal?.addEventListener("abort", () => resolve(result({ exit_code: null })));
      });
    const run = await sandbox().run({ language: "python", code: "x", timeout_ms: 20 });
    expect(run.killed_reason).toBe("timeout");
    expect(run.exit_code).toBeNull();
    const rm = runner.calledWith("rm");
    expect(rm.at(-1)).toEqual(["rm", "-f", `miyoria-sbx-${run.run_id.toLowerCase()}`]);
  });

  it("kills_on_caller_abort_and_on_close", async () => {
    runner.onRun = async (_args, _options, r) => {
      await r.waitForKill();
      return result({ exit_code: 137 });
    };
    const controller = new AbortController();
    const sbx = sandbox();
    const pending = sbx.run({ language: "python", code: "x" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    expect((await pending).killed_reason).toBe("aborted");

    const runner2 = new FakeRunner();
    runner = runner2;
    runner2.onRun = async (_args, _options, r) => {
      await r.waitForKill();
      return result({ exit_code: 137 });
    };
    const sbx2 = sandbox();
    const running = sbx2.run({ language: "python", code: "x" });
    await new Promise((r) => setTimeout(r, 10));
    await sbx2.close();
    expect((await running).killed_reason).toBe("aborted");
    expect((await errorOf(sbx2.run({ language: "python", code: "x" }))).kind).toBe("closed");
  });

  it("truncates_output_and_kills_on_the_output_limit", async () => {
    runner.onRun = async (_args, options, r) => {
      options.outputLimit?.onExceeded();
      await r.waitForKill();
      return result({
        exit_code: 137,
        stdout: Buffer.from("x".repeat(256)),
        stdout_bytes: 10_000_000,
        stderr: Buffer.from("e"),
      });
    };
    const run = await sandbox({ caps: { max_output_bytes: 256 } }).run({
      language: "python",
      code: "while True: print('x')",
    });
    expect(run.killed_reason).toBe("output_limit");
    expect(run.stdout).toHaveLength(256);
    expect(run.stdout_truncated).toBe(true);
    expect(run.stderr_truncated).toBe(false);
  });

  it("reports_exit_137_without_a_kill_as_memory", async () => {
    runner.onRun = async () => result({ exit_code: 137 });
    expect((await sandbox().run({ language: "python", code: "x" })).killed_reason).toBe("memory");
  });

  it("returns_program_exit_codes_but_fails_on_docker_errors", async () => {
    runner.onRun = async () => result({ exit_code: 3, stderr: Buffer.from("Traceback ...") });
    expect((await sandbox().run({ language: "python", code: "x" })).exit_code).toBe(3);

    runner.onRun = async () =>
      result({
        exit_code: 125,
        stderr: Buffer.from("docker: Error response from daemon: invalid mount config.\n"),
      });
    expect((await errorOf(sandbox().run({ language: "python", code: "x" }))).kind).toBe(
      "docker_failed",
    );
    runner.onRun = async () => result({ exit_code: 125, stderr: Buffer.from("my own error") });
    expect((await sandbox().run({ language: "python", code: "x" })).exit_code).toBe(125);
  });

  it("is_degraded_without_docker", async () => {
    runner.dockerUp = false;
    const sbx = sandbox();
    const error = await errorOf(sbx.run({ language: "python", code: "x" }));
    expect(error.kind).toBe("unavailable");
    expect(error.message).toMatch(/daemon is not running/);
    expect(sbx.lastHealth).toMatchObject({ available: false, server_version: null });
    expect(runner.calledWith("run")).toHaveLength(0);

    runner.dockerUp = true;
    expect(await sbx.health({ refresh: true })).toMatchObject({
      available: true,
      server_version: "29.8.2",
      error: null,
    });
  });

  it("pulls_a_missing_image_before_the_clock_starts", async () => {
    runner.imagePresent = false;
    const sbx = sandbox();
    await sbx.run({ language: "node", code: "1" });
    expect(runner.calledWith("pull")).toEqual([["pull", "--quiet", "node:24-slim"]]);
    const order = runner.calls.map((c) => c[0]);
    expect(order.indexOf("pull")).toBeLessThan(order.indexOf("run"));
    // Cached afterwards.
    await sbx.run({ language: "node", code: "1" });
    expect(runner.calledWith("pull")).toHaveLength(1);
  });

  it("validates_requests_before_touching_docker", async () => {
    const sbx = sandbox({ caps: { max_code_bytes: 10, max_files_in: 1 }, max_timeout_ms: 1000 });
    const cases: Array<[Parameters<DockerSandbox["run"]>[0], string]> = [
      [{ language: "python", code: "x".repeat(11) }, "invalid_request"],
      [{ language: "python", code: "x", timeout_ms: 5000 }, "invalid_request"],
      [{ language: "ruby" as "python", code: "x" }, "invalid_request"],
      [{ language: "python", code: "x", network: { allow: ["pypi.org"] } }, "network_unsupported"],
    ];
    for (const [request, kind] of cases) {
      expect((await errorOf(sbx.run(request))).kind).toBe(kind);
    }
    const tooMany = await errorOf(
      sbx.run({
        language: "python",
        code: "x",
        files: [
          { path: "a", content: "" },
          { path: "b", content: "" },
        ],
      }),
    );
    expect(tooMany.kind).toBe("invalid_request");
    expect(runner.calledWith("run")).toHaveLength(0);
  });

  it("never_writes_inputs_outside_the_workspace", async () => {
    const sbx = sandbox();
    for (const path of [
      "../escape.txt",
      "../../escape.txt",
      "/abs.txt",
      "C:/x.txt",
      "a\\..\\..\\x",
    ]) {
      const error = await errorOf(
        sbx.run({ language: "python", code: "x", files: [{ path, content: "pwned" }] }),
      );
      expect(error.kind, path).toBe("invalid_path");
    }
    const dup = await errorOf(
      sbx.run({
        language: "python",
        code: "x",
        files: [
          { path: "A.txt", content: "1" },
          { path: "a.txt", content: "2" },
        ],
      }),
    );
    expect(dup.kind).toBe("invalid_path");
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
    expect(existsSync(join(root, "runs", "escape.txt"))).toBe(false);
    expect(runner.calledWith("run")).toHaveLength(0);
  });

  it("skips_symlinks_and_caps_output_files", async () => {
    runner.onRun = async (args) => {
      const work = mountSource(args, "/work") as string;
      for (let i = 0; i < 5; i++) await writeFile(join(work, `f${i}.txt`), "12345");
      await mkdir(join(work, "nested"));
      await writeFile(join(work, "nested", "deep.txt"), "d");
      try {
        await symlink(join(root, "secret.txt"), join(work, "link.txt"));
      } catch {
        // Windows without symlink rights: the cap checks below still apply.
      }
      return result();
    };
    await writeFile(join(root, "secret.txt"), "host secret");
    const run = await sandbox({ caps: { max_files_out: 3 } }).run({
      language: "python",
      code: "x",
    });
    expect(run.files_out.map((f) => f.path)).toEqual(["f0.txt", "f1.txt", "f2.txt"]);
    expect(run.files_out_truncated).toBe(true);
    expect(run.files_out.some((f) => f.content.includes("host secret"))).toBe(false);

    const run2 = await sandbox({ caps: { max_files_out_bytes: 7 } }).run({
      language: "python",
      code: "x",
    });
    expect(run2.files_out.map((f) => f.path)).toEqual(["f0.txt", "nested/deep.txt"]);
    expect(run2.files_out.some((f) => f.path === "link.txt")).toBe(false);
  });

  it("limits_concurrency", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let running = 0;
    let peak = 0;
    runner.onRun = async () => {
      running++;
      peak = Math.max(peak, running);
      await gate;
      running--;
      return result();
    };
    const sbx = sandbox({ max_concurrent: 1, max_queued: 1 });
    const a = sbx.run({ language: "python", code: "a" });
    await new Promise((r) => setTimeout(r, 20));
    const b = sbx.run({ language: "python", code: "b" });
    await new Promise((r) => setTimeout(r, 20));
    const busy = await errorOf(sbx.run({ language: "python", code: "c" }));
    expect(busy.kind).toBe("busy");
    release();
    await Promise.all([a, b]);
    expect(peak).toBe(1);
  });

  it("mounts_the_tools_workspace_read_only_on_request", async () => {
    const sbx = sandbox();
    await sbx.tools.save("helpers", "python", "def add(a, b): return a + b\n");
    await sbx.run({ language: "python", code: "x", mount_tools: true });
    await sbx.run({ language: "python", code: "x" });
    const [withTools, without] = runner.calledWith("run");
    expect(withTools).toContain(
      `type=bind,source=${join(root, "profiles", "deepseek-chan", "tools")},target=/tools,readonly`,
    );
    expect(without?.some((a) => a.includes("target=/tools"))).toBe(false);
  });

  it("reaps_leftover_containers_of_this_instance", async () => {
    runner.psOutput = "0123456789ab\nfedcba987654\n";
    const sbx = sandbox();
    expect(await sbx.reap()).toBe(2);
    expect(runner.calledWith("ps")[0]).toContain(`label=miyoria.sandbox.instance=${sbx.instance}`);
    expect(runner.calledWith("rm")).toEqual([["rm", "-f", "0123456789ab", "fedcba987654"]]);
    runner.psOutput = "";
    expect(await sbx.reap()).toBe(0);
  });

  it("keeps_only_the_newest_runs", async () => {
    const sbx = sandbox({ keep_runs: 2 });
    for (let i = 0; i < 4; i++) await sbx.run({ language: "python", code: "x" });
    expect(await readdir(join(root, "runs"))).toHaveLength(2);

    const none = sandbox({ keep_runs: 0 });
    await none.run({ language: "python", code: "x" });
    expect(await readdir(join(root, "runs"))).toHaveLength(0);
  });
});

describe("pruneRuns", () => {
  it("touches_only_ulid_dirs_and_skips_active_ones", async () => {
    const ids = [newId(), newId(), newId()];
    for (const id of ids) await mkdir(join(root, "runs", id), { recursive: true });
    await mkdir(join(root, "runs", "keep-me"), { recursive: true });
    expect(await pruneRuns(root, 0, new Set([ids[0] as string]))).toBe(2);
    expect((await readdir(join(root, "runs"))).sort()).toEqual([ids[0], "keep-me"].sort());
  });
});

describe("ToolsWorkspace", () => {
  it("saves_lists_reads_and_removes_scripts", async () => {
    const sbx = sandbox({ max_scripts: 2 });
    const tools = sbx.tools;
    expect(await tools.list()).toEqual([]);
    expect(await tools.save("stats", "python", "print(1)")).toEqual({
      name: "stats",
      language: "python",
      file: "stats.py",
      size: 8,
    });
    await tools.save("fmt", "node", "console.log(1)");
    expect((await tools.list()).map((s) => s.file)).toEqual(["fmt.mjs", "stats.py"]);
    expect((await errorOf(tools.save("third", "python", "x"))).kind).toBe("limit");
    // Same name, other language: replaces.
    await tools.save("stats", "node", "console.log(2)");
    expect((await tools.list()).map((s) => s.file)).toEqual(["fmt.mjs", "stats.mjs"]);
    expect((await tools.read("stats"))?.code).toBe("console.log(2)");
    expect(await tools.read("missing")).toBeNull();
    expect((await errorOf(tools.save("../evil", "python", "x"))).kind).toBe("invalid_path");
    expect((await errorOf(tools.read("..\\evil"))).kind).toBe("invalid_path");
    expect(await tools.remove("stats")).toBe(true);
    expect(await tools.remove("stats")).toBe(false);
    expect((await tools.list()).map((s) => s.name)).toEqual(["fmt"]);
    // Separate from per-run scratch directories.
    expect(sbx.tools.dir).toBe(join(root, "profiles", "deepseek-chan", "tools"));
  });
});
