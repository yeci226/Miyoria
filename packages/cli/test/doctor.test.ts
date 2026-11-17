// `miyoria doctor` for the services of host.toml: what each descriptor needs, checked against a
// temporary workspace with injected system seams (no real program, port or GPU is touched).

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandRunner, pythonIn, type RunSpec } from "@miyoria/hostd";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as doctor from "../src/commands/doctor.js";
import * as host from "../src/commands/host.js";
import * as servicesCmd from "../src/commands/services.js";
import type { DeepDeps } from "../src/stack/checks.js";
import type { Runner, RunResult } from "../src/stack/system.js";
import { type Output, setOutput } from "../src/ui.js";

const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-test");
const NONE: RunResult = { code: 0, stdout: "", stderr: "", missing: false, timedOut: false };

let dir: string;
let out: string[];
let restore: () => void;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  dir = mkdtempSync(join(TMP, "doc-"));
  write("pnpm-workspace.yaml", "packages: []\n");
  write("miyoria.toml", "");
  out = [];
  const sink: Output = { out: (t) => out.push(t), err: (t) => out.push(t) };
  restore = setOutput(sink);
});
afterEach(() => {
  restore();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function write(path: string, text: string): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

const text = () => out.join("");
const config = () => join(dir, "miyoria.toml");
const target = () => host.hostTarget(config());

/** A Python service; `install` and `top` add lines to `[install]` and to the top of the file. */
function service(options: { install?: string; top?: string; port?: number } = {}): void {
  write(
    "workers/py/service.toml",
    `name = "py"
kind = "worker"
summary = "A fake Python worker"
${options.top ?? ""}
[install]
runtime = "python"
project = "."
${options.install ?? ""}
[run]
command = ["{python}", "{service}/server.py"]
port = ${options.port ?? 18123}
port_env = "PORT"
[run.health]
http = "/health"
`,
  );
  write("workers/py/pyproject.toml", '[project]\nname = "py"\n');
  write("workers/py/uv.lock", "lock one\n");
}

const GPU = (resident: number, policy = "pinned") =>
  `[gpu]\npolicy = "${policy}"\nvram_mb = { resident = ${resident}, peak = ${resident} }\n`;

function fakeUv(): { runner: CommandRunner; calls: RunSpec[] } {
  const calls: RunSpec[] = [];
  const runner: CommandRunner = async (spec) => {
    calls.push(spec);
    const python = pythonIn(spec.env.UV_PROJECT_ENVIRONMENT as string, "linux");
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "");
    return { code: 0, missing: false, tail: [] };
  };
  return { runner, calls };
}

const bin = () => {
  const path = join(dir, "bin");
  mkdirSync(path, { recursive: true });
  return path;
};

function deepDeps(over: Partial<DeepDeps> = {}): DeepDeps {
  return {
    platform: "linux",
    run: (async () => NONE) as Runner,
    probe: async () => "free",
    fetchImpl: (async () => {
      throw new Error("offline");
    }) as typeof fetch,
    env: { PATH: bin() },
    tmpdir: dir,
    version: "0.1.0",
    ...over,
  };
}

async function install(uv: ReturnType<typeof fakeUv>): Promise<void> {
  await servicesCmd.add(
    target(),
    { services: ["py"] },
    { install: { runner: uv.runner, platform: "linux", env: { PATH: bin() } } },
  );
  out.length = 0;
}

/** The plain command: host.toml without core, so only the install checks run. */
const run = (options: doctor.DoctorOptions) => doctor.run(config(), options);

/**
 * `--deep` as well checks the build outputs of the checkout, which this temporary one does not
 * have: the tests read the lines and do not depend on the exit.
 */
async function deep(options: doctor.DoctorOptions): Promise<void> {
  try {
    await doctor.run(config(), { ...options, deep: true });
  } catch (error) {
    if (!(error instanceof doctor.DoctorError)) throw error;
  }
}

describe("doctor: the services of host.toml", () => {
  it("says_what_is_ready", async () => {
    service();
    const uv = fakeUv();
    await install(uv);
    await run({ deps: deepDeps() });
    expect(text()).toMatch(/✓ py\s+環境/);
    expect(text()).toContain("這台電腦需要的都齊了");
  });

  it("fails_for_a_missing_environment_and_names_the_command", async () => {
    service();
    write("host.toml", 'name = "pc"\n[services.py]\n');
    await expect(run({ deps: deepDeps() })).rejects.toThrow(/1 項檢查失敗/);
    expect(text()).toMatch(/✗ py\s+環境\s+還沒建立/);
    expect(text()).toContain("miyoria add py");
  });

  it("fails_for_a_stale_environment_with_the_reason", async () => {
    service();
    await install(fakeUv());
    write("workers/py/uv.lock", "lock two\n");
    await expect(run({ deps: deepDeps() })).rejects.toThrow();
    expect(text()).toContain("uv.lock changed");
    expect(text()).toContain("doctor --fix");
  });

  it("warns_for_a_missing_manual_item_without_failing", async () => {
    service({
      install: '[[install.manual]]\npath = "data/voice.wav"\nwhat = "a voice sample"\n',
    });
    await install(fakeUv());
    await run({ deps: deepDeps() });
    expect(text()).toMatch(/! py\s+手動項目\s+缺 a voice sample/);
    write("data/voice.wav", "x");
    out.length = 0;
    await run({ deps: deepDeps() });
    expect(text()).toMatch(/✓ py\s+手動項目/);
  });

  it("fails_for_a_system_program_that_is_not_on_path_and_says_how_to_get_it", async () => {
    service({ install: 'system = ["ffmpeg"]' });
    await install(fakeUv());
    await expect(run({ deps: deepDeps() })).rejects.toThrow();
    expect(text()).toMatch(/✗ py\s+系統程式 ffmpeg/);
    expect(text()).toMatch(/ffmpeg/);
  });

  it("notes_a_missing_host_toml_and_a_user_managed_environment_is_left_alone", async () => {
    service();
    await doctor.run(config(), { stackOnly: true, deps: deepDeps() }).catch(() => undefined);
    expect(text()).toContain("沒有");
    expect(text()).toContain("host.toml");

    write("host.toml", 'name = "pc"\n[services.py]\npython = "envs/mine"\n');
    await expect(run({ deps: deepDeps() })).rejects.toThrow();
    expect(text()).toContain("host.toml 指定的環境不存在");
    const python = pythonIn(join(dir, "envs", "mine"), "linux");
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "");
    out.length = 0;
    await run({ deps: deepDeps() });
    expect(text()).toContain("Miyoria 不會動它");
  });

  it("reports_hostd_not_running_and_a_cluster_without_a_host_key", async () => {
    service();
    write(
      "host.toml",
      'name = "pc"\n[cluster]\nurl = "http://core:7878"\n[services.py]\npython = "envs/mine"\n',
    );
    const python = pythonIn(join(dir, "envs", "mine"), "linux");
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "");
    await expect(run({ deps: deepDeps() })).rejects.toThrow(/1 項/);
    expect(text()).toMatch(/! hostd\s+沒有在執行/);
    expect(text()).toMatch(/✗ host\.key/);
    expect(text()).toContain("miyoria host join");
    write("data/host/host.key", JSON.stringify({ id: "h1", key: "k" }));
    out.length = 0;
    await run({ deps: deepDeps() });
    expect(text()).toMatch(/✓ host\.key\s+已加入 Core/);
  });
});

describe("doctor --deep", () => {
  const smi = (total: number, used = 500): Runner =>
    (async (cmd: string) =>
      cmd === "nvidia-smi"
        ? { ...NONE, stdout: `NVIDIA Test GPU, ${total}, ${used}\n` }
        : NONE) as Runner;

  it("imports_the_modules_of_check_imports_with_the_environment_python", async () => {
    service({ install: 'check_imports = ["torch", "numpy"]' });
    await install(fakeUv());
    const calls: Array<{ file: string; args: string[] }> = [];
    const okRun: Runner = async (file, args) => {
      calls.push({ file, args });
      return NONE;
    };
    await deep({ deps: deepDeps({ run: okRun }) });
    const call = calls.find((c) => c.args[0] === "-c");
    expect(call?.file).toBe(pythonIn(join(dir, "data", "host", "envs", "py"), "linux"));
    expect(call?.args[1]).toBe("import torch, numpy");
    expect(text()).toMatch(/✓ py\s+匯入檢查\s+torch、numpy/);

    out.length = 0;
    const broken: Runner = async (_file, args) =>
      args[0] === "-c"
        ? { ...NONE, code: 1, stderr: "Traceback\nModuleNotFoundError: No module named 'torch'\n" }
        : NONE;
    await deep({ deps: deepDeps({ run: broken }) });
    expect(text()).toMatch(/✗ py\s+匯入檢查\s+import torch, numpy 失敗:ModuleNotFoundError/);
  });

  it("does_not_import_without_deep", async () => {
    service({ install: 'check_imports = ["torch"]' });
    await install(fakeUv());
    const calls: string[][] = [];
    await run({
      deps: deepDeps({
        run: (async (_f: string, args: string[]) => {
          calls.push(args);
          return NONE;
        }) as Runner,
      }),
    });
    expect(calls.some((a) => a[0] === "-c")).toBe(false);
  });

  it("warns_when_the_resident_memory_is_over_92_percent_of_the_card_minus_the_reserve", async () => {
    service({ top: GPU(9000) });
    await install(fakeUv());
    write("host.toml", 'name = "pc"\n[gpu]\nreserve_mb = 4000\n[services.py]\n');
    await deep({ deps: deepDeps({ run: smi(12288) }) });
    expect(text()).toMatch(/! 顯存預算.*超過 8288 MB 的 92%/);

    out.length = 0;
    write("host.toml", 'name = "pc"\n[services.py]\n');
    await deep({ deps: deepDeps({ run: smi(12288) }) });
    expect(text()).toMatch(/✓ 顯存預算.*保留 0 MB.*尖峰 9000 MB/);
  });

  it("counts_an_on_demand_service_at_its_own_work_not_on_top_of_what_it_evicts", async () => {
    service({ top: GPU(7500, "on_demand") });
    await install(fakeUv());
    await deep({ deps: deepDeps({ run: smi(12288) }) });
    expect(text()).toMatch(/✓ 顯存預算.*尖峰 7500 MB/);
  });

  it("skips_the_gpu_budget_without_nvidia_smi", async () => {
    service({ top: GPU(9000) });
    await install(fakeUv());
    const noSmi: Runner = async (cmd) => (cmd === "nvidia-smi" ? { ...NONE, missing: true } : NONE);
    await deep({ deps: deepDeps({ run: noSmi }) });
    expect(text()).toContain("沒有 nvidia-smi");
  });

  it("tells_a_foreign_listener_from_a_windows_reservation_on_the_services_port", async () => {
    service({ port: 18123 });
    await install(fakeUv());
    await deep({ deps: deepDeps({ probe: async () => "in-use" }) });
    expect(text()).toMatch(/! 埠 18123\(py\)\s+已有程式在聽/);
    expect(text()).toContain("netstat");

    out.length = 0;
    await deep({ deps: deepDeps({ probe: async () => "denied" }) });
    expect(text()).toMatch(/✗ 埠 18123\(py\)/);
    expect(text()).toContain("winnat");
  });

  it("calls_a_port_ours_when_the_health_url_answers_and_hostd_is_not_running", async () => {
    service({ port: 18123 });
    await install(fakeUv());
    const answer = (async () => new Response('{"status":"ok"}', { status: 200 })) as typeof fetch;
    await deep({
      deps: deepDeps({ probe: async () => "in-use", fetchImpl: answer }),
    });
    expect(text()).toMatch(/✓ 埠 18123\(py\)\s+已有 Miyoria 服務在聽/);
    expect(text()).toMatch(/hostd\s+沒有在執行/);
  });
});

describe("doctor --fix", () => {
  it("syncs_a_missing_environment_and_leaves_everything_else_alone", async () => {
    service();
    write("host.toml", 'name = "pc"\n[services.py]\n');
    const uv = fakeUv();
    await expect(run({ deps: deepDeps() })).rejects.toThrow();
    out.length = 0;
    await run({
      fix: true,
      deps: deepDeps(),
      services: { install: { runner: uv.runner, platform: "linux", env: { PATH: bin() } } },
    });
    expect(uv.calls).toHaveLength(1);
    expect(existsSync(pythonIn(join(dir, "data", "host", "envs", "py"), "linux"))).toBe(true);
    expect(text()).toContain("修復 py");
    expect(text()).toMatch(/✓ py\s+環境/);
  });

  it("does_nothing_when_nothing_needs_fixing", async () => {
    service();
    const uv = fakeUv();
    await install(uv);
    uv.calls.length = 0;
    await run({
      fix: true,
      deps: deepDeps(),
      services: { install: { runner: uv.runner, platform: "linux", env: { PATH: bin() } } },
    });
    expect(uv.calls).toHaveLength(0);
    expect(text()).toContain("沒有可以自動修的項目");
  });
});
