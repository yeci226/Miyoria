import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { workerBaseEnv } from "@miyoria/hostd";
import { Config } from "@miyoria/runtime/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli.js";
import * as update from "../src/commands/update.js";
import { freshness, parseJavaMajor } from "../src/stack/builds.js";
import { buildChecks, type DeepDeps, type DeepInput, portChecks } from "../src/stack/checks.js";
import { offloadUrls, repoRoot, stackConfig, startOrder } from "../src/stack/config.js";
import { buildPlan } from "../src/stack/plan.js";
import {
  parseDynamicPort,
  parseExcludedRanges,
  type Runner,
  type RunResult,
} from "../src/stack/system.js";
import { type Output, setOutput } from "../src/ui.js";

// Folders the tests declare to have no source checkout above them, wherever the temp folder is
// (a TMP inside the repo would otherwise find the repo's own `pnpm-workspace.yaml`).
const noSource = vi.hoisted(() => new Set<string>());
vi.mock("../src/stack/config.js", async (original) => {
  const real = await original<typeof import("../src/stack/config.js")>();
  return {
    ...real,
    repoRoot: (configPath: string) => (noSource.has(configPath) ? null : real.repoRoot(configPath)),
  };
});

const NOENV = () => undefined;
const NONE: RunResult = { code: 0, stdout: "", stderr: "", missing: false, timedOut: false };

let dir: string;
let out: string[];
let restore: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "miyoria-stack-"));
  out = [];
  const sink: Output = { out: (t) => out.push(t), err: (t) => out.push(t) };
  restore = setOutput(sink);
});
afterEach(() => {
  restore();
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text = "x", ageSecs = 0): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  if (ageSecs !== 0) {
    const t = new Date(Date.now() - ageSecs * 1000);
    utimesSync(full, t, t);
  }
  return full;
}

const WORKERS_TOML = `
[stack.workers]
asr = { venv = "workers/.venv-asr-qwen", port = 8003, env = { ASR_BACKEND = "qwen3", ASR_QWEN_SIZE = "0.6B" } }
tts = { venv = "workers/.venv-tts-faster", port = 8002 }
sing = { venv = "workers/.venv-sing", port = 8005, offload = ["tts", "asr"] }
`;

function fakeDeps(over: Partial<DeepDeps> = {}): DeepDeps {
  return {
    platform: "win32",
    run: async () => NONE,
    probe: async () => "free",
    fetchImpl: (async () => {
      throw new Error("offline");
    }) as typeof fetch,
    env: {},
    tmpdir: dir,
    version: "0.1.0",
    ...over,
  };
}

function input(toml: string, deps: DeepDeps = fakeDeps(), root: string | null = dir): DeepInput {
  const config = Config.fromToml(toml, NOENV);
  return { config, configDir: dir, root, deps };
}

describe("stack config", () => {
  it("defaults_to_core_only_and_known_worker_ports", () => {
    const empty = stackConfig(Config.fromToml("", NOENV));
    expect(empty).toMatchObject({ core: true, voiceNode: false, stage: false, workers: [] });
    const s = stackConfig(
      Config.fromToml('[stack.workers]\nasr = {}\nsing = { offload = ["asr"] }', NOENV),
    );
    expect(s.workers.map((w) => [w.name, w.port, w.venv])).toEqual([
      ["asr", 8001, "workers/.venv-asr"],
      ["sing", 8005, "workers/.venv-sing"],
    ]);
    // The optional end-of-turn worker has its port too.
    const turn = stackConfig(Config.fromToml("[stack.workers]\nturn = {}", NOENV));
    expect(turn.workers.map((w) => [w.name, w.port, w.venv])).toEqual([
      ["turn", 8006, "workers/.venv-turn"],
    ]);
  });

  it("rejects_unknown_keys_and_unknown_workers_without_a_port", () => {
    expect(() => stackConfig(Config.fromToml("[stack.workers.asr]\nbogus = 1", NOENV))).toThrow();
    expect(() => stackConfig(Config.fromToml("[stack.workers.vc]\nvenv = 'x'", NOENV))).toThrow(
      /port/,
    );
  });

  it("orders_offloaded_workers_before_the_one_that_offloads_them", () => {
    const { workers } = stackConfig(Config.fromToml(WORKERS_TOML, NOENV));
    expect(startOrder(workers).at(-1)?.name).toBe("sing");
    const sing = workers.find((w) => w.name === "sing");
    expect(offloadUrls(sing as (typeof workers)[number], workers)).toBe(
      "http://127.0.0.1:8002,http://127.0.0.1:8003",
    );
  });

  it("finds_the_repo_root_from_a_nested_config", () => {
    write("pnpm-workspace.yaml", "packages: []");
    mkdirSync(join(dir, "workers"));
    mkdirSync(join(dir, "profiles", "x"), { recursive: true });
    expect(repoRoot(join(dir, "profiles", "x", "miyoria.toml"))).toBe(dir);
  });
});

describe("system parsing", () => {
  it("reads_excluded_port_ranges_and_dynamic_range_in_any_language", () => {
    const excluded =
      "Start Port    End Port\r\n----------    --------\r\n      7870        7890\r\n      8000        8010     *\r\n";
    expect(parseExcludedRanges(excluded)).toEqual([
      { start: 7870, end: 7890 },
      { start: 8000, end: 8010 },
    ]);
    expect(parseDynamicPort("Start Port      : 1024\nNumber of Ports : 64511\n")).toEqual({
      start: 1024,
      count: 64511,
    });
    expect(parseDynamicPort("啟動連接埠      : 49152\n連接埠數目      : 16384\n")).toEqual({
      start: 49152,
      count: 16384,
    });
    expect(parseDynamicPort("nothing")).toBeNull();
  });

  it("keeps_secrets_and_stale_asr_model_out_of_the_worker_environment", () => {
    const env = workerBaseEnv({
      PATH: "/bin",
      CUDA_VISIBLE_DEVICES: "0",
      HF_HOME: "/hf",
      DISCORD_BOT_TOKEN: "secret",
      LLM_API_KEY: "secret",
      ASR_MODEL: "/old/sensevoice",
    });
    expect(Object.keys(env).sort()).toEqual(["CUDA_VISIBLE_DEVICES", "HF_HOME", "PATH"]);
  });

  it("parses_java_versions", () => {
    expect(parseJavaMajor('openjdk version "21.0.3" 2024-04-16')).toBe(21);
    expect(parseJavaMajor('java version "1.8.0_422"')).toBe(8);
    expect(parseJavaMajor("nope")).toBeNull();
  });
});

describe("freshness", () => {
  it("compares_the_newest_source_with_the_newest_output", () => {
    const src = write("a/src/index.ts", "x", 100);
    write("a/dist/index.js", "x", 200);
    expect(freshness([dirname(src)], [join(dir, "a/dist")]).state).toBe("stale");
    write("a/dist/other.js", "x", 10);
    expect(freshness([dirname(src)], [join(dir, "a/dist")]).state).toBe("fresh");
    expect(freshness([dirname(src)], [join(dir, "missing")]).state).toBe("missing");
    expect(
      freshness([dirname(src)], [join(dir, "a/dist")], join(dir, "a/dist/index.html")).state,
    ).toBe("missing");
  });
});

describe("doctor --deep: ports", () => {
  const api = { label: "core", host: "127.0.0.1", port: 7878 };
  const link = { label: "stage", host: "127.0.0.1", port: 7882 };

  it("reports_a_windows_reserved_port_and_the_low_dynamic_range_with_fixes", async () => {
    const run: Runner = async (_c, args) =>
      args.includes("excludedportrange")
        ? { ...NONE, stdout: "Start Port    End Port\r\n      7870        7890\r\n" }
        : { ...NONE, stdout: "Start Port : 1024\r\nNumber of Ports : 64511\r\n" };
    const probe = async (port: number) => (port === 7878 ? ("denied" as const) : ("free" as const));
    const f = await portChecks(input("", fakeDeps({ run, probe })), [api, link]);
    const found = f.find((x) => x.what.includes("7878"));
    expect(found?.level).toBe("fail");
    expect(found?.detail).toContain("7870-7890");
    expect(found?.fix?.join("\n")).toContain("winnat");
    expect(f.find((x) => x.what === "動態埠範圍")?.level).toBe("warn");
    // 7882 is inside the reserved range in the netsh text, and nothing listens on it.
    expect(f.find((x) => x.what.includes("7882"))?.level).toBe("fail");
  });

  it("treats_a_healthy_miyoria_service_on_the_port_as_fine", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const f = await portChecks(
      input("", fakeDeps({ probe: async () => "in-use", fetchImpl, platform: "linux" })),
      [{ ...api, health: "http://127.0.0.1:7878/api/health" }],
    );
    expect(f[0]).toMatchObject({ level: "ok", detail: "已有 Miyoria 服務在聽" });
  });

  it("calls_a_busy_port_ours_when_hostd_runs_it_and_foreign_when_hostd_does_not", async () => {
    const probe = async () => "in-use" as const;
    const deps = fakeDeps({ probe, platform: "linux" });
    const ours = await portChecks(input("", deps), [{ ...api, ours: true }]);
    expect(ours[0]?.level).toBe("ok");
    const foreign = await portChecks(input("", deps), [{ ...api, ours: false }]);
    expect(foreign[0]?.level).toBe("warn");
    expect(foreign[0]?.fix?.join("\n")).toContain("netstat");
  });
});

describe("doctor --deep: builds", () => {
  const sdkFiles = () => {
    write("packages/sdk/package.json", "{}", 500);
    write("packages/sdk/src/index.ts", "x", 400);
    write("packages/sdk/dist/index.js", "x", 300);
  };

  it("builds_the_contracts_before_the_sdk_and_the_sdk_again_when_they_changed", async () => {
    sdkFiles();
    write("packages/contracts/package.json", "{}", 900);
    write("packages/contracts/tsconfig.build.json", "{}", 900);
    // Changed after both builds: the checkout moved to a newer commit.
    write("packages/contracts/events/src/index.ts", "x", 10);
    write("packages/contracts/dist/events/src/index.js", "x", 300);
    const f = await buildChecks(input("", fakeDeps()));
    const contracts = f.findIndex((x) => x.what.includes("契約"));
    const sdk = f.findIndex((x) => x.what.includes("SDK"));
    expect(f[contracts]?.level).toBe("fail");
    // The SDK's own sources are older than its output; the contracts it compiles against are not.
    expect(f[sdk]?.level).toBe("fail");
    expect(contracts).toBeGreaterThanOrEqual(0);
    expect(contracts).toBeLessThan(sdk);
  });

  it("flags_a_stale_extension_dist_and_a_stale_mod_jar_with_the_update_fix", async () => {
    sdkFiles();
    write(
      "extensions/minecraft/adapter/miyoria.extension.toml",
      'id = "miyoria.minecraft"\nruntime = "node"\nentry = "dist/index.js"',
    );
    write(
      "extensions/minecraft/adapter/package.json",
      '{"name":"@miyoria/ext-minecraft","scripts":{"build":"tsc"}}',
      500,
    );
    write("extensions/minecraft/adapter/src/index.ts", "x", 10);
    write("extensions/minecraft/adapter/dist/index.js", "x", 300);
    write("extensions/minecraft/mod/build.gradle", "", 500);
    write("extensions/minecraft/mod/gradle.properties", "mod_version=0.1.0", 500);
    write("extensions/minecraft/mod/src/main/Foo.java", "x", 5);
    write("extensions/minecraft/mod/build/libs/miyoria-bridge-0.1.0.jar", "old", 200);
    const mods = join(dir, "mc", "mods");
    write("mc/mods/miyoria-bridge-0.1.0.jar", "older", 900);
    const toml = `[extensions."miyoria.minecraft"]\nminecraft_dir = '${join(dir, "mc")}'\n`;
    const jdkRun: Runner = async (cmd) =>
      cmd === "java" ? { ...NONE, stderr: 'java version "1.8.0_422"' } : NONE;
    const f = await buildChecks(input(toml, fakeDeps({ run: jdkRun })));
    const ext = f.find((x) => x.what.includes("miyoria.minecraft"));
    expect(ext?.level).toBe("fail");
    expect(ext?.fix?.[0]).toContain("miyoria update");
    expect(f.find((x) => x.what === "mod jar(建置)")?.level).toBe("fail");
    const jdk = f.find((x) => x.what === "JDK 21");
    expect(jdk?.level).toBe("fail");
    expect(jdk?.detail).toContain("8");
    expect(f.find((x) => x.what === "遊戲裡的 mod")?.level).toBe("fail");
    expect(existsSync(mods)).toBe(true);
  });
});

// ---- the old plan (kept for host migrate and the descriptor pin test) -----------------------

describe("plan", () => {
  function plan(toml: string, env: Record<string, string> = {}) {
    write("pnpm-workspace.yaml", "packages: []");
    mkdirSync(join(dir, "workers"), { recursive: true });
    const config = Config.fromToml(toml, NOENV);
    return buildPlan({
      config,
      configPath: join(dir, "miyoria.toml"),
      stack: stackConfig(config),
      root: dir,
      nodeExec: { execPath: "node", execArgv: ["--import", "tsx"], script: "main.ts" },
      platform: "win32",
      env,
    });
  }

  it("builds_the_ordered_plan_with_offload_urls_and_no_secrets", () => {
    const specs = plan(WORKERS_TOML, {
      PATH: "/bin",
      DISCORD_BOT_TOKEN: "hunter2",
      ASR_MODEL: "/old",
    });
    expect(specs.map((s) => s.name)).toEqual(["asr", "tts", "sing", "core"]);
    expect(specs.map((s) => s.name).at(-2)).toBe("sing");
    expect(specs.at(-1)?.name).toBe("core");
    const sing = specs.find((s) => s.name === "sing");
    expect(sing?.env.SING_OFFLOAD_URLS).toBe("http://127.0.0.1:8002,http://127.0.0.1:8003");
    expect(sing?.env.PORT).toBe("8005");
    expect(sing?.command).toContain(join(".venv-sing", "Scripts", "python.exe"));
    expect(sing?.cwd).toBe(join(dir, "workers", "sing"));
    const asr = specs.find((s) => s.name === "asr");
    expect(asr?.env).toMatchObject({ ASR_BACKEND: "qwen3", PORT: "8003" });
    for (const w of specs.filter((s) => s.kind === "worker")) {
      expect(w.env.DISCORD_BOT_TOKEN).toBeUndefined();
      expect(w.env.ASR_MODEL).toBeUndefined();
    }
    expect(JSON.stringify(specs.map((s) => s.envKeys))).not.toContain("hunter2");
    expect(specs.at(-1)?.args).toEqual([
      "--import",
      "tsx",
      "main.ts",
      "core",
      "-c",
      join(dir, "miyoria.toml"),
    ]);
  });

  it("plans_the_optional_turn_worker_on_its_own_port_with_a_health_check", () => {
    const specs = plan('[stack.workers]\nturn = { venv = "workers/.venv-turn" }', { PATH: "/bin" });
    const turn = specs.find((s) => s.name === "turn");
    expect(turn?.health).toBe("http://127.0.0.1:8006/health");
    expect(turn?.env.PORT).toBe("8006");
    expect(turn?.cwd).toBe(join(dir, "workers", "turn"));
  });

  it("without_a_stack_section_plans_only_the_core", () => {
    expect(plan("").map((s) => s.name)).toEqual(["core"]);
  });
});

// ---- update --------------------------------------------------------------------------------

describe("update", () => {
  interface Call {
    command: string;
    args: string[];
    env?: Record<string, string | undefined>;
  }

  function repo(extra = "") {
    write("pnpm-workspace.yaml", "packages: []");
    write("pnpm-lock.yaml", "x", 1000);
    write("node_modules/.modules.yaml", "x", 10);
    mkdirSync(join(dir, "workers"), { recursive: true });
    write("packages/sdk/package.json", "{}", 900);
    write("packages/sdk/src/index.ts", "x", 800);
    write("packages/sdk/dist/index.js", "x", 700);
    write("apps/panel/package.json", "{}", 900);
    write("apps/panel/index.html", "x", 900);
    write("apps/panel/src/main.tsx", "x", 800);
    write("apps/panel/dist/index.html", "OLD", 700);
    write("miyoria.toml", extra);
    return join(dir, "miyoria.toml");
  }

  function deps(
    handler: (c: Call) => RunResult | undefined,
    confirm: update.UpdateDeps["confirm"] = async () => true,
  ): { d: update.UpdateDeps; calls: Call[] } {
    const calls: Call[] = [];
    const run: Runner = async (command, args, o) => {
      const call = { command, args, env: o?.env };
      calls.push(call);
      return handler(call) ?? NONE;
    };
    return {
      calls,
      d: {
        run,
        confirm,
        env: { PATH: "/bin" },
        platform: "win32",
        now: () => new Date(2026, 10, 7, 12, 0, 0),
      },
    };
  }

  it("does_nothing_when_everything_is_fresh", async () => {
    const config = repo();
    const { d, calls } = deps(() => undefined);
    await update.run(config, { noPull: true }, d);
    expect(calls).toEqual([]);
    expect(out.join("")).toContain("與原始碼一致");
  });

  it("rebuilds_only_the_stale_panel_with_a_plain_vite_build_and_swaps_dist", async () => {
    const config = repo();
    write("apps/panel/src/main.tsx", "changed", 5);
    const { d, calls } = deps((c) => {
      if (c.args.includes("vite")) write("apps/panel/dist.next/index.html", "NEW");
      return undefined;
    });
    await update.run(config, { noPull: true }, d);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("pnpm");
    expect(calls[0]?.args.join(" ")).toBe(
      "--filter @miyoria/panel exec vite build --outDir dist.next --emptyOutDir",
    );
    expect(readFileSync(join(dir, "apps/panel/dist/index.html"), "utf8")).toBe("NEW");
    expect(existsSync(join(dir, "apps/panel/dist.next"))).toBe(false);
    expect(existsSync(join(dir, "apps/panel/dist.prev"))).toBe(false);
  });

  it("retries_the_panel_without_the_minifier_when_the_plain_build_fails", async () => {
    const config = repo();
    write("apps/panel/src/main.tsx", "changed", 5);
    const { d, calls } = deps((c) => {
      if (!c.args.includes("vite")) return undefined;
      if (c.args.includes("--minify")) {
        write("apps/panel/dist.next/index.html", "NEW");
        return undefined;
      }
      return { ...NONE, code: 1, stderr: "esbuild: Access is denied" };
    });
    await update.run(config, { noPull: true }, d);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args.join(" ")).toContain("--minify false --target esnext");
    expect(readFileSync(join(dir, "apps/panel/dist/index.html"), "utf8")).toBe("NEW");
  });

  it("keeps_the_old_dist_when_the_build_fails", async () => {
    const config = repo();
    write("apps/panel/src/main.tsx", "changed", 5);
    const { d } = deps((c) => {
      if (!c.args.includes("vite")) return undefined;
      write("apps/panel/dist.next/partial.js", "half");
      return { ...NONE, code: 1, stderr: "esbuild: Access is denied" };
    });
    await expect(update.run(config, { noPull: true }, d)).rejects.toThrow(/1 項沒有完成/);
    expect(readFileSync(join(dir, "apps/panel/dist/index.html"), "utf8")).toBe("OLD");
    expect(existsSync(join(dir, "apps/panel/dist.next"))).toBe(false);
    expect(out.join("")).toContain("Access is denied");
  });

  it("installs_when_the_lockfile_is_newer_and_force_rebuilds_everything", async () => {
    const config = repo();
    write("pnpm-lock.yaml", "newer", 1);
    const { d, calls } = deps((c) => {
      if (c.args.includes("vite")) write("apps/panel/dist.next/index.html", "NEW");
      return undefined;
    });
    await update.run(config, { noPull: true, force: true, skipMod: true }, d);
    expect(calls[0]?.args).toEqual(["install"]);
    expect(calls.map((c) => c.args.join(" "))).toEqual(
      expect.arrayContaining(["--filter @miyoria/sdk build"]),
    );
    expect(calls.some((c) => c.args.includes("@miyoria/panel"))).toBe(true);
  });

  it("dry_run_lists_work_and_runs_nothing", async () => {
    const config = repo();
    write("apps/panel/src/main.tsx", "changed", 5);
    const { d, calls } = deps(() => undefined);
    await update.run(config, { dryRun: true, noPull: true }, d);
    expect(calls).toEqual([]);
    expect(out.join("")).toContain("會建置 管理面板");
  });

  function modRepo() {
    const config = repo(`[extensions."miyoria.minecraft"]\nminecraft_dir = '${join(dir, "mc")}'\n`);
    write("extensions/minecraft/mod/build.gradle", "", 900);
    write("extensions/minecraft/mod/gradle.properties", "mod_version=0.1.0", 900);
    write("extensions/minecraft/mod/src/Foo.java", "x", 800);
    write("extensions/minecraft/mod/build/libs/miyoria-bridge-0.1.0.jar", "NEWJAR", 100);
    write("mc/mods/miyoria-bridge-0.0.9.jar", "OLDJAR", 5000);
    write("mc/mods/other-mod.jar", "KEEP", 5000);
    return config;
  }

  it("asks_before_replacing_the_mod_jar_and_backs_the_old_one_up", async () => {
    const config = modRepo();
    const asked: string[] = [];
    const { d } = deps(
      () => undefined,
      async (m) => {
        asked.push(m);
        return true;
      },
    );
    await update.run(config, { noPull: true }, d);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("備份");
    const mods = join(dir, "mc", "mods");
    expect(readdirSync(mods).sort()).toEqual(["miyoria-bridge-0.1.0.jar", "other-mod.jar"]);
    expect(readFileSync(join(mods, "miyoria-bridge-0.1.0.jar"), "utf8")).toBe("NEWJAR");
    const backup = join(dir, "mc", "miyoria-backup", "20261107-120000");
    expect(readFileSync(join(backup, "miyoria-bridge-0.0.9.jar"), "utf8")).toBe("OLDJAR");
  });

  it("leaves_the_installed_jar_alone_without_confirmation", async () => {
    const config = modRepo();
    const { d } = deps(
      () => undefined,
      async () => false,
    );
    await update.run(config, { noPull: true }, d);
    expect(readdirSync(join(dir, "mc", "mods")).sort()).toEqual([
      "miyoria-bridge-0.0.9.jar",
      "other-mod.jar",
    ]);
    expect(existsSync(join(dir, "mc", "miyoria-backup"))).toBe(false);
    expect(out.join("")).toContain("--yes");
  });

  it("builds_a_stale_mod_with_the_jdk_21_it_found_and_not_with_the_default_java", async () => {
    const config = modRepo();
    write("extensions/minecraft/mod/src/Foo.java", "changed", 2);
    const jdk = join(dir, "jdk21");
    write("jdk21/bin/java.exe", "");
    const { d, calls } = deps((c) => {
      if (c.command.endsWith("java.exe")) return { ...NONE, stderr: 'openjdk version "21.0.3"' };
      if (c.command === "java") return { ...NONE, stderr: 'java version "1.8.0_422"' };
      return undefined;
    });
    d.env = { PATH: "/bin", JAVA_HOME: jdk };
    await update.run(config, { noPull: true }, d);
    const gradle = calls.find((c) => c.command === "gradlew.bat");
    expect(gradle?.args).toEqual(["build"]);
    expect(gradle?.env?.JAVA_HOME).toBe(jdk);
  });

  it("explains_a_missing_jdk_instead_of_building_with_java_8", async () => {
    const config = modRepo();
    write("extensions/minecraft/mod/src/Foo.java", "changed", 2);
    const { d, calls } = deps((c) =>
      c.command === "java" ? { ...NONE, stderr: 'java version "1.8.0_422"' } : undefined,
    );
    await expect(update.run(config, { noPull: true }, d)).rejects.toThrow(/沒有完成/);
    expect(calls.some((c) => c.command === "gradlew.bat")).toBe(false);
    expect(out.join("")).toContain("JDK 21");
  });

  it("points_a_packaged_install_at_the_package_manager_and_still_runs_the_services_part", async () => {
    const lone = mkdtempSync(join(tmpdir(), "miyoria-lone-"));
    try {
      writeFileSync(join(lone, "miyoria.toml"), "");
      noSource.add(join(lone, "miyoria.toml"));
      await update.run(join(lone, "miyoria.toml"), {}, deps(() => undefined).d);
      const text = out.join("");
      expect(text).toContain("npm update -g miyoria");
      expect(text).toContain("host.toml");
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  });
});

describe("command line", () => {
  it("parses_up_update_and_doctor_options", () => {
    const upArgs = parseArgs(["up", "asr", "core", "--foreground", "--timeout", "30"]);
    expect(upArgs.ctx.args).toEqual(["asr", "core"]);
    expect(upArgs.ctx.options).toMatchObject({ foreground: true, timeout: "30" });
    expect(parseArgs(["up", "--no-wait"]).ctx.options["no-wait"]).toBe(true);
    expect(parseArgs(["update", "--no-pull", "--force", "--skip-mod"]).ctx.options).toMatchObject({
      "no-pull": true,
      force: true,
      "skip-mod": true,
    });
    expect(parseArgs(["doctor", "--deep"]).ctx.options.deep).toBe(true);
    expect(parseArgs(["doctor"]).ctx.options.deep).toBeUndefined();
  });
});
