// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests use literal ${VAR} references
// Roles and services: `[machine]`, `miyoria start` / `install`, the init question and the checks.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Config } from "@miyoria/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exampleConfig, exampleEnv } from "../src/assets.js";
import { parseArgs } from "../src/cli.js";
import { run as initRun } from "../src/commands/init.js";
import * as install from "../src/commands/install.js";
import * as start from "../src/commands/start.js";
import { buildPlan } from "../src/commands/up.js";
import { machineStep } from "../src/machine-step.js";
import { DefaultsPrompter } from "../src/prompt.js";
import type { DeepDeps, DeepInput } from "../src/stack/checks.js";
import { repoRoot, stackConfig } from "../src/stack/config.js";
import { cmdArg, type LaunchDeps, openTab, scriptText, wtArgs } from "../src/stack/launch.js";
import { addressChecks, manualItems, roleChecks } from "../src/stack/role-checks.js";
import {
  expandTargets,
  machineConfig,
  ROLE_NAMES,
  ROLES,
  servicesOfRoles,
} from "../src/stack/roles.js";
import type { Runner, RunResult } from "../src/stack/system.js";
import { type Output, setOutput } from "../src/ui.js";
import { Workspace } from "../src/workspace.js";
import { Enter, Pick, Scripted, Text, Yes } from "./scripted.js";

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
const OK: RunResult = { code: 0, stdout: "", stderr: "", missing: false, timedOut: false };

let dir: string;
let out: string[];
let restore: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "miyoria-machine-"));
  out = [];
  const sink: Output = { out: (t) => out.push(t), err: (t) => out.push(t) };
  restore = setOutput(sink);
});
afterEach(() => {
  restore();
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text = "x"): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

/** A minimal repo checkout: workspace file, workers folder, config. */
function repo(toml: string): string {
  write("pnpm-workspace.yaml", "packages: []\n");
  mkdirSync(join(dir, "workers"), { recursive: true });
  return write("miyoria.toml", toml);
}

const ALL = `[machine]\nroles = ["broadcast", "core", "inference"]\n[modules.voice]\nvad_engine = "silero"\n`;
const cfg = (toml: string) => Config.fromToml(toml, NOENV);

function deps(over: Partial<DeepDeps> = {}): DeepDeps {
  return {
    platform: "win32",
    run: async () => OK,
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

describe("roles", () => {
  it("lists_every_role_with_its_services_in_start_order", () => {
    expect(ROLE_NAMES).toEqual(["broadcast", "core", "inference"]);
    expect(ROLES.inference.services).toEqual(["asr", "tts", "sing"]);
    expect(servicesOfRoles(["broadcast", "core", "inference"])).toEqual([
      "asr",
      "tts",
      "sing",
      "turn",
      "core",
      "voice-node",
      "stage",
    ]);
  });

  it("expands_roles_all_and_service_names", () => {
    expect(expandTargets(["inference"])).toEqual(["asr", "tts", "sing"]);
    expect(expandTargets(["core,stage"])).toEqual(["turn", "core", "stage"]);
    expect(expandTargets(["all"])).toHaveLength(7);
    expect(() => expandTargets(["nope"])).toThrow(/不認得/);
  });

  it("reads_machine_roles_hosts_and_custom_services", () => {
    expect(machineConfig(cfg("[core]\nprofile='x'\n"))).toBeNull();
    const m = machineConfig(
      cfg(`[machine]\nroles = ["core"]\n[machine.hosts]\ncore = "192.168.1.10"\n`),
    );
    expect(m?.services).toEqual(["core"]); // turn only when the voice module uses it
    const withTurn = machineConfig(
      cfg(`[machine]
roles = ["core"]
[modules.voice]
turn_engine = "smart-turn"
`),
    );
    expect(withTurn?.services).toEqual(["turn", "core"]);
    expect(m?.hosts).toEqual({ core: "192.168.1.10", inference: "127.0.0.1" });
    const custom = machineConfig(cfg(`[machine]\nservices = ["tts", "asr"]\n`));
    expect(custom?.custom).toBe(true);
    expect(custom?.services).toEqual(["asr", "tts"]);
  });
});

describe("stack from [machine]", () => {
  it("gives_the_inference_workers_the_verified_defaults", () => {
    const s = stackConfig(cfg(`[machine]\nroles = ["inference"]\n`));
    expect(s.core).toBe(false);
    const by = Object.fromEntries(s.workers.map((w) => [w.name, w]));
    expect(by.asr).toMatchObject({ port: 8003, venv: "workers/.venv-asr-qwen" });
    expect(by.asr?.env).toEqual({ ASR_BACKEND: "qwen3", ASR_QWEN_SIZE: "0.6B" });
    expect(by.tts).toMatchObject({ port: 8002, venv: "workers/.venv-tts-faster" });
    expect(by.tts?.env.TTS_DEFAULT_VOICE).toBe("deepseek-chan");
    expect(by.sing).toMatchObject({ port: 8005, offload: ["tts", "asr"] });
    expect(by.turn).toBeUndefined();
  });

  it("lets_stack_workers_override_field_by_field", () => {
    const s = stackConfig(
      cfg(
        `[machine]\nroles = ["inference"]\n[stack.workers]\nasr = { env = { ASR_QWEN_SIZE = "1.7B" } }\n`,
      ),
    );
    const asr = s.workers.find((w) => w.name === "asr");
    expect(asr?.env).toEqual({ ASR_BACKEND: "qwen3", ASR_QWEN_SIZE: "1.7B" });
    expect(asr?.port).toBe(8003);
  });

  it("drops_offload_targets_that_run_on_another_computer", () => {
    const s = stackConfig(cfg(`[machine]\nservices = ["sing", "tts"]\n`));
    expect(s.workers.find((w) => w.name === "sing")?.offload).toEqual(["tts"]);
  });

  it("binds_workers_to_the_inference_address_when_it_is_not_loopback", () => {
    const s = stackConfig(
      cfg(`[machine]\nroles = ["inference"]\n[machine.hosts]\ninference = "192.168.1.20"\n`),
    );
    expect(s.workers.every((w) => w.host === "192.168.1.20")).toBe(true);
  });

  it("starts_other_roles_when_asked_even_if_machine_says_otherwise", () => {
    const s = stackConfig(cfg(`[machine]\nroles = ["core"]\n`), ["asr", "stage"]);
    expect(s.core).toBe(false);
    expect(s.stage).toBe(true);
    expect(s.workers.map((w) => w.name)).toEqual(["asr"]);
  });

  it("keeps_the_old_stack_behavior_without_machine", () => {
    const s = stackConfig(cfg("[stack]\nvoice_node = true\n"));
    expect(s.machine).toBeNull();
    expect(s.voiceNode).toBe(true);
    expect(s.core).toBe(true);
    expect(s.workers).toEqual([]);
  });

  it("plans_inference_before_core_before_broadcast_with_tts_voices_and_offload", () => {
    const configPath = repo(ALL);
    const config = cfg(ALL);
    const plan = buildPlan({
      config,
      configPath,
      stack: stackConfig(config),
      root: repoRoot(configPath),
      platform: "win32",
      env: {},
      nodeExec: { execPath: "node", execArgv: [], script: "main.js" },
    });
    expect(plan.map((p) => p.name)).toEqual([
      "asr",
      "tts",
      "sing",
      "turn",
      "core",
      "voice-node",
      "stage",
    ]);
    const tts = plan.find((p) => p.name === "tts");
    expect(tts?.env.VOICES_DIR).toBe(join(dir, "workers", "voices"));
    expect(tts?.env.PORT).toBe("8002");
    expect(plan.find((p) => p.name === "sing")?.env.SING_OFFLOAD_URLS).toBe(
      "http://127.0.0.1:8002,http://127.0.0.1:8003",
    );
  });

  it("gives_the_voice_node_the_core_address_only_when_core_is_elsewhere", () => {
    const toml = `[machine]\nroles = ["broadcast"]\n[machine.hosts]\ncore = "192.168.1.10"\n`;
    const configPath = repo(toml);
    const config = cfg(toml);
    const plan = buildPlan({
      config,
      configPath,
      stack: stackConfig(config),
      root: repoRoot(configPath),
      platform: "win32",
      env: {},
      nodeExec: { execPath: "node", execArgv: [], script: "main.js" },
    });
    expect(plan.find((p) => p.name === "voice-node")?.env.VOICE_LINK_URL).toBe(
      "ws://192.168.1.10:7879/voice-link",
    );
  });
});

describe("launch scripts", () => {
  const spec = {
    name: "tts",
    cwd: "C:\\a b\\workers\\tts",
    command: "C:\\a b\\.venv\\Scripts\\python.exe",
    args: ["server.py"],
    env: { PORT: "8002", VOICES_DIR: "C:\\a b\\voices", OTHER: "x" },
    envKeys: ["PORT", "VOICES_DIR"],
  };

  it("sets_only_the_listed_variables_and_quotes_paths", () => {
    const text = scriptText(spec as never);
    expect(text).toContain('cd /d "C:\\a b\\workers\\tts"');
    expect(text).toContain('set "PORT=8002"');
    expect(text).toContain('set "VOICES_DIR=C:\\a b\\voices"');
    expect(text).not.toContain("OTHER");
    expect(text).toContain('call "C:\\a b\\.venv\\Scripts\\python.exe" server.py');
    expect(text).toContain("pause");
  });

  it("escapes_percent_signs_and_quotes", () => {
    expect(cmdArg("100%")).toBe("100%%");
    expect(cmdArg('a "b"')).toBe('"a ""b"""');
  });

  it("adds_a_tab_to_the_named_window", () => {
    expect(wtArgs({ title: "Miyoria tts", script: "x.cmd", cwd: "C:\\w" })).toEqual([
      "-w",
      "miyoria",
      "new-tab",
      "--title",
      "Miyoria tts",
      "--suppressApplicationTitle",
      "-d",
      "C:\\w",
      "cmd",
      "/c",
      "x.cmd",
    ]);
  });

  function launchDeps(hasWt: boolean, calls: Array<[string, string[]]>): LaunchDeps {
    const run: Runner = async (command) =>
      command === "where" && !hasWt ? { ...OK, code: 1 } : OK;
    return {
      platform: "win32",
      run,
      writeScript: () => {},
      spawnDetached: async (c, a) => {
        calls.push([c, a]);
        return true;
      },
    };
  }

  it("falls_back_to_a_console_window_without_windows_terminal", async () => {
    const calls: Array<[string, string[]]> = [];
    await openTab(spec as never, "x.cmd", launchDeps(false, calls));
    expect(calls[0]?.[0]).toBe("cmd");
    expect(calls[0]?.[1].slice(0, 3)).toEqual(["/c", "start", "Miyoria tts"]);
    const wt: Array<[string, string[]]> = [];
    await openTab(spec as never, "x.cmd", launchDeps(true, wt));
    expect(wt[0]?.[0]).toBe("wt");
  });

  it("refuses_tabs_outside_windows", async () => {
    await expect(
      openTab(spec as never, "x.cmd", { ...launchDeps(true, []), platform: "linux" }),
    ).rejects.toThrow(/Windows/);
  });
});

describe("miyoria start", () => {
  /** What the fakes saw. */
  function harness(
    opts: {
      healthy?: string[];
      ports?: Record<number, "in-use" | "denied">;
      tabs?: string[];
      /** What the process list says about the voice node: running, not running, unreadable. */
      voiceNode?: "yes" | "no" | "unknown";
      /** Health URLs that answer 200 with a body that is not ours. */
      foreign?: string[];
    } = {},
  ) {
    const opened: string[] = [];
    const healthy = new Set(opts.healthy ?? []);
    let t = 0;
    const run: Runner = async (command, args) => {
      if (command === "powershell") {
        const text = args.join(" ");
        if (text.includes("node.exe")) {
          const v = opts.voiceNode ?? "no";
          return v === "unknown" ? { ...OK, code: 1 } : { ...OK, stdout: v === "yes" ? "2" : "0" };
        }
        return {
          ...OK,
          stdout: (opts.tabs ?? []).some((n) => text.includes(`${n}.cmd`)) ? "1" : "0",
        };
      }
      return OK;
    };
    const d: start.StartDeps = {
      fetchImpl: (async (url: string) => {
        const ok = healthy.has(url) || opened.some((n) => url.includes(PORTS[n] ?? "no"));
        if (!ok) throw new Error("down");
        const ours = !(opts.foreign ?? []).includes(url);
        return { ok: true, json: async () => (ours ? { status: "ok" } : { hello: 1 }) } as Response;
      }) as typeof fetch,
      probe: async (port) => opts.ports?.[port] ?? "free",
      run,
      sleep: async () => {
        t += 1000;
      },
      now: () => t,
      launch: {
        platform: "win32",
        run,
        writeScript: () => {},
        spawnDetached: async (_c, a) => {
          const script = a.at(-1) as string;
          opened.push(script.replace(/^.*[\\/]/, "").replace(".cmd", ""));
          return true;
        },
      },
      deep: deps({ run }),
      pollMs: 1000,
    };
    return { d, opened };
  }
  const PORTS: Record<string, string> = {
    asr: ":8003",
    tts: ":8002",
    sing: ":8005",
    turn: ":8006",
  };

  it("opens_asr_and_tts_before_sing_and_waits_for_each", async () => {
    const configPath = repo(`[machine]\nroles = ["inference"]\n`);
    const { d, opened } = harness();
    await start.run(configPath, { targets: [], noCheck: true }, d);
    expect(opened).toEqual(["asr", "tts", "sing"]);
  });

  it("never_starts_a_service_that_is_already_healthy_or_has_a_tab_open", async () => {
    const configPath = repo(`[machine]\nroles = ["inference"]\n`);
    const { d, opened } = harness({ healthy: ["http://127.0.0.1:8003/health"], tabs: ["tts"] });
    await start.run(configPath, { targets: [], noCheck: true }, d);
    expect(opened).toEqual(["sing"]);
    expect(out.join("\n")).toContain("已在執行");
    expect(out.join("\n")).toContain("分頁還開著");
  });

  it("refuses_a_port_held_by_something_else_and_a_reserved_port", async () => {
    const configPath = repo(`[machine]\nroles = ["inference"]\n`);
    const a = harness({ ports: { 8003: "in-use" } });
    await expect(start.run(configPath, { targets: [], noCheck: true }, a.d)).rejects.toThrow(
      /被別的程式佔用/,
    );
    expect(a.opened).toEqual([]);
    const b = harness({ ports: { 8002: "denied" } });
    await expect(start.run(configPath, { targets: [], noCheck: true }, b.d)).rejects.toThrow(
      /被 Windows 保留/,
    );
    expect(b.opened).toEqual(["asr"]);
  });

  it("never_starts_a_second_voice_node_and_says_why", async () => {
    const configPath = repo(`[machine]\nroles = ["broadcast"]\n`);
    const running = harness({ voiceNode: "yes", ports: { 7884: "in-use" } });
    await start.run(configPath, { targets: [], noCheck: true }, running.d);
    expect(running.opened).toEqual([]);
    expect(out.join("\n")).toContain("不會再開第二個");
    out.length = 0;
    const unknown = harness({ voiceNode: "unknown", ports: { 7884: "in-use" } });
    await start.run(configPath, { targets: [], noCheck: true }, unknown.d);
    expect(unknown.opened).toEqual([]);
    expect(out.join("\n")).toContain("無法確認");
    const none = harness({ voiceNode: "no", ports: { 7884: "in-use" } });
    await start.run(configPath, { targets: ["voice-node"], noCheck: true, noWait: true }, none.d);
    expect(none.opened).toEqual(["voice-node"]);
  });

  it("does_not_take_another_programs_200_for_a_healthy_service", async () => {
    const configPath = repo(`[machine]\nroles = ["inference"]\n`);
    const h = harness({
      healthy: ["http://127.0.0.1:8003/health"],
      foreign: ["http://127.0.0.1:8003/health"],
      ports: { 8003: "in-use" },
    });
    await expect(start.run(configPath, { targets: [], noCheck: true }, h.d)).rejects.toThrow(
      /被別的程式佔用/,
    );
    expect(h.opened).toEqual([]);
  });

  it("opens_nothing_on_a_dry_run", async () => {
    const configPath = repo(ALL);
    const { d, opened } = harness({ healthy: ["http://127.0.0.1:8002/health"] });
    await start.run(configPath, { targets: [], dryRun: true, noCheck: true }, d);
    expect(opened).toEqual([]);
    const text = out.join("\n");
    expect(text).toContain("tts");
    expect(text).toContain("會略過");
    expect(text).toContain("會開新分頁");
  });

  it("starts_a_role_by_name_and_complains_when_nothing_is_selected", async () => {
    const configPath = repo(`[core]\nprofile = "x"\n`);
    const { d } = harness();
    await expect(start.run(configPath, { targets: [], noCheck: true }, d)).rejects.toThrow(
      /還沒選/,
    );
    await expect(start.run(configPath, { targets: ["bogus"], noCheck: true }, d)).rejects.toThrow(
      /不認得/,
    );
    const { opened, d: d2 } = harness();
    await start.run(configPath, { targets: ["inference"], noCheck: true, noWait: true }, d2);
    expect(opened).toEqual(["asr", "tts", "sing"]);
  });

  it("stops_before_opening_anything_when_a_venv_is_missing", async () => {
    const configPath = repo(`[machine]\nroles = ["inference"]\n`);
    const { d, opened } = harness();
    await expect(start.run(configPath, { targets: [] }, d)).rejects.toThrow(/先修正/);
    expect(opened).toEqual([]);
  });

  it("parses_the_command_line", () => {
    const p = parseArgs(["start", "core", "stage", "--dry-run"]);
    expect(p.path.at(-1)?.name).toBe("start");
    expect(p.ctx.args).toEqual(["core", "stage"]);
    expect(p.ctx.options["dry-run"]).toBe(true);
    expect(
      parseArgs(["init", "--roles", "core", "--core-host", "1.2.3.4"]).ctx.options["core-host"],
    ).toBe("1.2.3.4");
  });
});

describe("miyoria install", () => {
  it("chooses_pip_steps_per_worker", () => {
    const s = stackConfig(cfg(`[machine]\nroles = ["inference"]\n`));
    const steps = (n: string) => install.pipSteps(s.workers.find((w) => w.name === n) as never);
    expect(steps("asr").map((x) => x.args[0])).toEqual(["torch", "-r"]);
    expect(steps("asr")[1]?.args[1]).toBe("asr/requirements-qwen3.txt");
    expect(steps("tts")[1]?.args[1]).toBe("tts/requirements-faster.txt");
    expect(steps("sing")[0]?.args.slice(0, 2)).toEqual(["torch==2.11.0", "torchaudio==2.11.0"]);
  });

  it("plans_nothing_for_node_on_the_inference_computer", async () => {
    const configPath = repo(`[machine]\nroles = ["inference"]\n`);
    const calls: string[] = [];
    const run: Runner = async (c, a) => {
      calls.push([c, ...a].join(" "));
      return c === "python" ? { ...OK, stdout: "Python 3.11.9" } : OK;
    };
    await install.run(
      configPath,
      { targets: [], dryRun: true },
      { run, platform: "win32", confirm: async () => true },
    );
    const text = out.join("\n");
    expect(text).toContain("建立 workers/.venv-asr-qwen");
    expect(text).toContain("requirements-qwen3.txt");
    expect(calls.some((c) => c.includes("pnpm"))).toBe(false);
    expect(text).toContain("workers/voices/deepseek-chan/ref.wav");
  });

  it("needs_the_source_folder", async () => {
    const configPath = join(dir, "x", "miyoria.toml");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, ALL);
    noSource.add(configPath);
    await expect(
      install.run(
        configPath,
        { targets: [] },
        { run: async () => OK, platform: "win32", confirm: async () => true },
      ),
    ).rejects.toThrow(/原始碼資料夾/);
  });
});

describe("role checks", () => {
  function input(toml: string, d: DeepDeps = deps()): DeepInput {
    const config = cfg(toml);
    return { config, configDir: dir, root: dir, stack: stackConfig(config), deps: d };
  }

  it("lists_the_files_that_are_downloaded_by_hand", () => {
    const s = stackConfig(cfg(ALL));
    const items = manualItems(s).map((m) => `${m.service}:${m.path}`);
    expect(items).toContain("tts:workers/voices/deepseek-chan/ref.wav");
    expect(items).toContain("voice-node:apps/voice-node/.env");
    expect(items).toContain("turn:workers/models/silero-vad/silero_vad.onnx");
  });

  it("fails_for_a_missing_voice_and_node_packages", async () => {
    repo("");
    const f = await roleChecks(input(`[machine]\nroles = ["core", "inference"]\n`));
    const failed = f.filter((x) => x.level === "fail").map((x) => x.what);
    expect(failed).toContain("node 套件");
    expect(failed.some((w) => w.includes("聲音參考音"))).toBe(true);
  });

  it("needs_docker_only_when_the_sandbox_is_on", async () => {
    repo("");
    const off = await roleChecks(input(`[machine]\nroles = ["core"]\n`));
    expect(off.find((x) => x.what === "Docker")?.level).toBe("ok");
    const missing: Runner = async (c) =>
      c === "docker" ? { ...OK, code: null, missing: true } : OK;
    const on = await roleChecks(
      input(
        `[machine]\nroles = ["core"]\n[modules.sandbox]\nenabled = true\n`,
        deps({ run: missing }),
      ),
    );
    expect(on.find((x) => x.what === "Docker")?.level).toBe("fail");
  });

  it("warns_when_core_binds_loopback_for_a_broadcast_computer_elsewhere", async () => {
    const toml = `[machine]\nroles = ["core"]\n[machine.hosts]\ncore = "192.168.1.10"\n`;
    const f = await addressChecks(input(toml), ["core", "turn"]);
    expect(f.map((x) => x.what)).toEqual(
      expect.arrayContaining(["voice.link 綁定位址", "stage.link 綁定位址"]),
    );
    const fixed = await addressChecks(
      input(
        `${toml}[modules."voice.link"]\nbind = "192.168.1.10:7879"\n[modules."stage.link"]\nbind = "192.168.1.10:7882"\n`,
      ),
      ["core", "turn"],
    );
    expect(fixed).toEqual([]);
  });

  it("fails_when_asr_url_still_points_at_this_computer_but_inference_is_elsewhere", async () => {
    const toml = `[machine]\nroles = ["core"]\n[machine.hosts]\ninference = "192.168.1.20"\n[speech.asr.local]\nkind = "http-worker"\nurl = "http://127.0.0.1:8003"\n`;
    const f = await addressChecks(input(toml), ["core", "turn"]);
    expect(f.some((x) => x.level === "fail" && x.what.includes("speech.asr.local.url"))).toBe(true);
  });

  it("checks_the_stage_core_url_and_reachability_on_the_broadcast_computer", async () => {
    const toml = `[machine]\nroles = ["broadcast"]\n[machine.hosts]\ncore = "192.168.1.10"\n[stage]\ncore_url = "ws://127.0.0.1:7882/stage-link"\n`;
    const d = deps({ connect: async () => false });
    const f = await addressChecks(input(toml, d), ["voice-node", "stage"]);
    expect(f.some((x) => x.level === "fail" && x.what === "設定不一致:stage.core_url")).toBe(true);
    expect(f.filter((x) => x.level === "warn" && x.what.startsWith("連線 core"))).toHaveLength(2);
  });
});

describe("init: which services run here", () => {
  function workspace(): Workspace {
    return Workspace.openOrCreate(join(dir, "miyoria.toml"), exampleConfig(), exampleEnv());
  }

  it("writes_roles_and_loopback_hosts_for_a_single_pc", async () => {
    const ws = workspace();
    await machineStep(new Scripted([Pick(0), Enter, Enter]), ws);
    expect(ws.item("machine.roles")).toEqual(["broadcast", "core", "inference"]);
    expect(ws.item("machine.hosts.core")).toBe("127.0.0.1");
    expect(ws.effective("stage.core_url")).toBe("ws://127.0.0.1:7882/stage-link");
    expect(ws.lookup("ASR_URL")?.[0]).toBe("http://127.0.0.1:8003");
  });

  it("splits_the_roles_and_fills_the_lan_addresses", async () => {
    const ws = workspace();
    // role: only core (index 2), core address, inference address
    const r = await machineStep(
      new Scripted([Pick(2), Text("192.168.1.10"), Text("192.168.1.20")]),
      ws,
    );
    expect(r.services).toEqual(["turn", "core"]);
    expect(ws.item("machine.roles")).toEqual(["core"]);
    expect(ws.effective("modules.api.bind")).toBe("192.168.1.10:7878");
    expect(ws.effective('modules."voice.link".bind')).toBe("192.168.1.10:7879");
    expect(ws.effective('modules."stage.link".bind')).toBe("192.168.1.10:7882");
    expect(ws.lookup("ASR_URL")?.[0]).toBe("http://192.168.1.20:8003");
    expect(ws.lookup("TTS_URL")?.[0]).toBe("http://192.168.1.20:8002");
    expect(ws.effective("modules.sing.url")).toBe("http://192.168.1.20:8005");
  });

  it("points_stage_at_core_on_the_broadcast_computer", async () => {
    const ws = workspace();
    await machineStep(new Scripted([Pick(1), Text("192.168.1.10"), Text("192.168.1.20")]), ws);
    expect(ws.effective("stage.core_url")).toBe("ws://192.168.1.10:7882/stage-link");
    expect(ws.item("machine.roles")).toEqual(["broadcast"]);
    expect(ws.effective("modules.api.bind")).toBe("127.0.0.1:7878");
  });

  it("takes_a_custom_service_pick", async () => {
    const ws = workspace();
    // custom: asr yes, tts yes, sing no, turn no, core no, voice-node no, stage no
    const answers = [
      Pick(4),
      Yes,
      Yes,
      "no",
      "no",
      "no",
      "no",
      "no",
      Text("127.0.0.1"),
      Text("127.0.0.1"),
    ] as never[];
    const r = await machineStep(new Scripted(answers), ws);
    expect(r.custom).toBe(true);
    expect(ws.item("machine.services")).toEqual(["asr", "tts"]);
  });

  it("applies_the_roles_flag_without_asking_in_a_script", async () => {
    const configPath = join(dir, "miyoria.toml");
    await initRun(configPath, new DefaultsPrompter({ ...noopReporter }), {
      yes: true,
      bundledProfiles: null,
      processEnv: new Map(),
      machine: { ask: false, roles: "inference", inferenceHost: "192.168.1.20" },
    });
    const text = readFileSync(configPath, "utf8");
    expect(text).toMatch(/\[machine\][\s\S]*roles = \["inference"\]/);
    expect(text).toContain('inference = "192.168.1.20"');
    // no core here: no LLM questions, no tokens generated
    expect(readFileSync(join(dir, ".env"), "utf8")).not.toMatch(/MIYORIA_API_TOKEN=\w{20}/);
  });
});

const noopReporter = {
  intro() {},
  outro() {},
  section() {},
  note() {},
  ok() {},
  warn() {},
  fail() {},
  box() {},
};

describe("doctor: Discord intents", () => {
  const reply = (flags: number) =>
    (async () => ({
      ok: true,
      json: async () => ({ name: "bot", flags }),
    })) as unknown as typeof fetch;
  const MESSAGE_CONTENT = 1 << 18;
  const PRESENCE = 1 << 12;
  const MEMBERS = 1 << 14;

  it("asks_for_presence_and_members_only_when_the_bot_wants_them", async () => {
    const { checkDiscord } = await import("../src/commands/doctor.js");
    await expect(checkDiscord("t", reply(MESSAGE_CONTENT), false)).resolves.toContain("bot");
    await expect(checkDiscord("t", reply(MESSAGE_CONTENT), true)).rejects.toThrow(
      /Presence Intent、Server Members Intent/,
    );
    await expect(
      checkDiscord("t", reply(MESSAGE_CONTENT | PRESENCE | MEMBERS), true),
    ).resolves.toContain("bot");
  });
});
