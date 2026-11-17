// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests use literal ${VAR} references
// `miyoria init`'s first question (what this machine is for) and what each answer writes:
// text only, text and voice, and services for somebody else's Core.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseHostConfig } from "@miyoria/hostd";
import { Config } from "@miyoria/runtime/kernel";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exampleConfig, PACKAGE_ROOT } from "../src/assets.js";
import { parseArgs } from "../src/cli.js";
import { INIT_MODES, run, VOICE_SERVICES } from "../src/commands/init.js";
import { DefaultsPrompter } from "../src/prompt.js";
import { type Output, setOutput } from "../src/ui.js";
import { Enter, No, Pick, Picks, Scripted, Text, tempDir, Yes } from "./scripted.js";

const BUNDLED = join(PACKAGE_ROOT, "..", "..", "profiles");
const NO_ENV = new Map<string, string>();

let dir: string;
let restoreOutput: () => void;

beforeEach(() => {
  dir = tempDir();
  restoreOutput = setOutput({ out: () => {}, err: () => {} } satisfies Output);
});
afterEach(() => {
  restoreOutput();
  rmSync(dir, { recursive: true, force: true });
});

const read = (path: string) => readFileSync(join(dir, path), "utf8");
const configPath = () => join(dir, "miyoria.toml");
const hostToml = () => parseHostConfig(join(dir, "host.toml"), read("host.toml"));

function write(path: string, text: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

/** A catalog of descriptors in `dir`: name, summary, optional GPU table. */
function catalog(
  entries: Array<{ name: string; kind?: string; gpu?: string; summary?: string }>,
): void {
  for (const e of entries) {
    write(
      `workers/${e.name}/service.toml`,
      `name = "${e.name}"\nkind = "${e.kind ?? "worker"}"\nprovides = ["${e.name}"]\nsummary = "${e.summary ?? e.name}"\n[run]\ncommand = ["x"]\n${e.gpu ?? ""}`,
    );
  }
}

const quiet = {
  intro() {},
  outro() {},
  section() {},
  note() {},
  ok() {},
  warn() {},
  fail() {},
  box() {},
};

/** The answers of the questions after the first one, taking every default (key typed once). */
const AFTER_MODE = [
  Enter,
  Enter,
  Enter,
  Text("sk-test-1234567890"),
  Enter,
  Enter,
  Enter,
  Enter,
  No,
];
// profile, kind, base URL, API key, model, bot token, owner, database, OAuth?

describe("the first question", () => {
  it("offers three choices and starts on text only", async () => {
    const p = new Scripted([Enter, ...AFTER_MODE, Yes]);
    await run(configPath(), p, {
      bundledProfiles: BUNDLED,
      processEnv: NO_ENV,
      command: "miyoria",
    });
    expect(p.asked[0]).toContain("這台電腦要做什麼");
    expect(INIT_MODES).toEqual(["text", "voice", "service"]);
  });

  it("is skipped by --mode and --services on the command line", () => {
    const parsed = parseArgs(["init", "--mode", "service", "--services", "asr,tts", "-y"]);
    expect(parsed.ctx.options).toMatchObject({ mode: "service", services: "asr,tts", yes: true });
    // The flags that wrote [machine] and addresses are gone.
    expect(() => parseArgs(["init", "--roles", "core"])).toThrow(/未知的選項/);
  });
});

describe("text only", () => {
  it("writes host.toml with core, and no [machine], [stack] or worker address anywhere", async () => {
    const p = new Scripted([Enter, ...AFTER_MODE, Yes]);
    await run(configPath(), p, {
      bundledProfiles: BUNDLED,
      processEnv: NO_ENV,
      command: "miyoria",
    });

    const host = hostToml();
    expect(host.name).not.toBe("");
    expect(Object.keys(host.services)).toEqual(["core"]);
    expect(host.services.core?.enabled).toBe(true);
    expect(host.cluster).toBeUndefined();
    expect(read("host.toml")).not.toMatch(/127\.0\.0\.1|8003|8002|8005/);

    const toml = parseToml(read("miyoria.toml")) as Record<string, unknown>;
    expect(toml.machine).toBeUndefined();
    expect(toml.stack).toBeUndefined();
    const dump = JSON.stringify(toml) + read(".env");
    // No address of a worker: not the speech workers' ports, not their variables.
    expect(dump).not.toMatch(/:(8001|8002|8003|8005|8006|8007)\b/);
    expect(dump).not.toMatch(/ASR_URL|TTS_URL|SING_URL|OFFLOAD/);
    const speech = toml.speech as { asr: { local: Record<string, unknown> } };
    expect(speech.asr.local.url).toBeUndefined();

    // It still loads like Core loads it.
    const env = new Map(
      read(".env")
        .split("\n")
        .flatMap((l) => (/^[A-Z_]+=/.test(l) ? [l.split("=", 2) as [string, string]] : [])),
    );
    const loaded = await Config.load(configPath(), (n) => env.get(n));
    expect(loaded.module("api").config).toMatchObject({ token: env.get("MIYORIA_API_TOKEN") });
  });

  it("ends with `up` and where the panel is", async () => {
    const p = new Scripted([Enter, ...AFTER_MODE, Yes]);
    await run(configPath(), p, {
      bundledProfiles: BUNDLED,
      processEnv: NO_ENV,
      command: "miyoria",
    });
    const outro = p.printed.at(-1) ?? "";
    expect(outro).toMatch(/miyoria up\s+啟動她/);
    expect(outro).toContain("http://127.0.0.1:7878/");
    expect(outro).not.toContain("miyoria add");
  });

  it("changes nothing in a config that exists, and adds only core to a host.toml that exists", async () => {
    write("miyoria.toml", exampleConfig());
    write("host.toml", 'name = "mine"\n\n# keep me\n[services.asr]\nenabled = true\n');
    // A host.toml without core starts the question on "services for somebody else's Core": pick text.
    const p = new Scripted([Pick(0), ...AFTER_MODE, Yes]);
    await run(configPath(), p, { bundledProfiles: BUNDLED, processEnv: NO_ENV });
    // A config that exists is not touched.
    expect(read("miyoria.toml")).toBe(exampleConfig());
    const text = read("host.toml");
    expect(text).toContain("# keep me");
    expect(text).toContain('name = "mine"');
    const host = hostToml();
    expect(Object.keys(host.services).sort()).toEqual(["asr", "core"]);
  });

  it("with --yes and no terminal picks text only", async () => {
    await run(configPath(), new DefaultsPrompter(quiet), {
      yes: true,
      bundledProfiles: BUNDLED,
      processEnv: NO_ENV,
    });
    expect(Object.keys(hostToml().services)).toEqual(["core"]);
    // Running it again writes nothing new.
    const before = read("host.toml");
    await run(configPath(), new DefaultsPrompter(quiet), {
      yes: true,
      bundledProfiles: BUNDLED,
      processEnv: NO_ENV,
    });
    expect(read("host.toml")).toBe(before);
  });
});

describe("text and voice", () => {
  it("adds asr, tts and turn, and says to `add` them and then `up`", async () => {
    const p = new Scripted([Pick(1), ...AFTER_MODE, Yes]);
    await run(configPath(), p, {
      bundledProfiles: BUNDLED,
      processEnv: NO_ENV,
      command: "miyoria",
    });
    expect(Object.keys(hostToml().services).sort()).toEqual(["asr", "core", "tts", "turn"]);
    expect([...VOICE_SERVICES]).toEqual(["asr", "tts", "turn"]);
    const outro = p.printed.at(-1) ?? "";
    expect(outro.indexOf("miyoria add asr tts turn")).toBeGreaterThan(-1);
    expect(outro.indexOf("miyoria up")).toBeGreaterThan(outro.indexOf("miyoria add asr tts turn"));
    expect(outro).toContain("docs/SETUP.md");
    // Still no address and no machine section.
    const toml = parseToml(read("miyoria.toml")) as Record<string, unknown>;
    expect(toml.machine).toBeUndefined();
    expect(JSON.stringify(toml)).not.toMatch(/:(8002|8003|8006)\b/);
  });
});

describe("services for somebody else's Core", () => {
  beforeEach(() => {
    catalog([
      {
        name: "asr",
        summary: "語音辨識",
        gpu: '[gpu]\npolicy = "evictable"\nvram_mb = { resident = 1500, peak = 1500 }\n',
      },
      { name: "lyrics", summary: "歌詞" },
      { name: "core", summary: "Core" },
      { name: "obs", kind: "external", summary: "OBS" },
    ]);
    // `obs` is external: it needs a probe.
    write(
      "workers/obs/service.toml",
      'name = "obs"\nkind = "external"\nsummary = "OBS"\n[probe]\nport = 4455\n',
    );
  });

  it("writes only host.toml, with the chosen services, and ends with the join command", async () => {
    // Offered: asr and lyrics (core and external ones are not).
    const p = new Scripted([Pick(2), Picks(0, 1), Yes]);
    await run(configPath(), p, { catalogRoot: dir, command: "miyoria" });
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect(existsSync(join(dir, "profiles"))).toBe(false);
    expect(Object.keys(hostToml().services).sort()).toEqual(["asr", "lyrics"]);

    const choices = p.asked.find((q) => q.includes("提供哪些服務")) ?? "";
    expect(choices).toBeDefined();
    const outro = p.printed.at(-1) ?? "";
    expect(outro).toContain("miyoria add asr lyrics");
    expect(outro).toContain("miyoria host join <位址> --code <代碼>");
    expect(outro).toContain("miyoria host invite");
    expect(outro).toContain(`miyoria host approve ${hostToml().name}`);
  });

  it("marks the services that need the graphics card", async () => {
    const labels: string[] = [];
    const p = new Scripted([Pick(2), Picks(0), Yes]);
    const original = p.multiSelect.bind(p);
    p.multiSelect = async (message, options, initial) => {
      labels.push(...options);
      return original(message, options, initial);
    };
    await run(configPath(), p, { catalogRoot: dir, command: "miyoria" });
    expect(labels.find((l) => l.startsWith("asr"))).toContain("需要顯卡,約 1500 MB");
    expect(labels.find((l) => l.startsWith("lyrics"))).not.toContain("顯卡");
    expect(labels.some((l) => l.startsWith("core") || l.startsWith("obs"))).toBe(false);
  });

  it("takes --services without a terminal, and refuses an unknown or an empty list", async () => {
    await run(configPath(), new DefaultsPrompter(quiet), {
      yes: true,
      mode: "service",
      services: ["lyrics"],
      catalogRoot: dir,
    });
    expect(Object.keys(hostToml().services)).toEqual(["lyrics"]);
    await expect(
      run(configPath(), new DefaultsPrompter(quiet), {
        yes: true,
        mode: "service",
        services: ["nope"],
        catalogRoot: dir,
      }),
    ).rejects.toThrow(/沒有可以提供的服務 nope/);
    rmSync(join(dir, "host.toml"));
    await expect(
      run(configPath(), new DefaultsPrompter(quiet), {
        yes: true,
        mode: "service",
        catalogRoot: dir,
      }),
    ).rejects.toThrow(/沒有選任何服務/);
    expect(existsSync(join(dir, "host.toml"))).toBe(false);
  });

  it("writes nothing when the summary is declined", async () => {
    const p = new Scripted([Pick(2), Picks(0), No]);
    await run(configPath(), p, { catalogRoot: dir });
    expect(existsSync(join(dir, "host.toml"))).toBe(false);
  });

  it("explains an empty catalog", async () => {
    rmSync(join(dir, "workers"), { recursive: true });
    await expect(run(configPath(), new Scripted([Pick(2)]), { catalogRoot: dir })).rejects.toThrow(
      /找不到服務目錄/,
    );
  });
});
