// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests use literal ${VAR} references
// Roles and services: `[machine]`, `miyoria start` / `install` (the old setup `host migrate` converts) and the checks.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Config } from "@miyoria/runtime/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli.js";
import { repoRoot, stackConfig } from "../src/stack/config.js";
import { buildPlan } from "../src/stack/plan.js";
import {
  expandTargets,
  machineConfig,
  ROLE_NAMES,
  ROLES,
  servicesOfRoles,
} from "../src/stack/roles.js";
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

describe("command line", () => {
  it("has_no_start_command_any_more", () => {
    const p = parseArgs(["start", "core"]);
    expect(p.path).toHaveLength(1);
    expect(p.ctx.args).toEqual(["start", "core"]);
  });
});

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
