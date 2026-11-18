// Pins the descriptors to the launcher they replace; deleted with `buildPlan`.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Catalog,
  type CatalogEntry,
  loadCatalog,
  offloadUrls,
  parseHostConfig,
  planServices,
  stateLayout,
} from "@miyoria/hostd";
import { Config } from "@miyoria/runtime/kernel";
import { beforeAll, describe, expect, it } from "vitest";
import { stackConfig, WORKER_DEFAULT_PORT, WORKER_DEFAULTS } from "../src/stack/config.js";
import { buildPlan, type ServiceSpec } from "../src/stack/plan.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// The config is never read: only its path is given to the plan.
const configPath = join(root, "pin-test", "miyoria.toml");
// Silero makes the machine start the turn worker too.
const toml = `[machine]
roles = ["broadcast", "core", "inference"]
[modules.voice]
vad_engine = "silero"
`;

let catalog: Catalog;
let plan: ServiceSpec[];
const stack = stackConfig(Config.fromToml(toml, () => undefined));

beforeAll(() => {
  catalog = loadCatalog(root);
  plan = buildPlan({
    config: Config.fromToml(toml, () => undefined),
    configPath,
    stack,
    root,
    platform: "win32",
    env: {},
    nodeExec: { execPath: "node", execArgv: [], script: "main.js" },
  });
});

function entry(name: string): CatalogEntry {
  const found = catalog.services.get(name);
  if (found === undefined) throw new Error(`no descriptor for ${name}`);
  return found;
}

function spec(name: string): ServiceSpec {
  const found = plan.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no plan entry for ${name}`);
  return found;
}

describe("the workers", () => {
  it.each(["asr", "tts", "sing", "turn"])("%s matches its plan entry", (name) => {
    const { descriptor, dir } = entry(name);
    const run = descriptor.run;
    const s = spec(name);
    expect(run).toBeDefined();
    if (run === undefined) return;

    expect(run.port).toBe(WORKER_DEFAULT_PORT[name]);
    expect(run.port).toBe(s.port);
    // The entry file is the last element of the command; the interpreter is a placeholder.
    expect(run.command.at(-1)).toBe(s.args.at(-1));
    expect(run.command[0]).toBe("{python}");
    expect(resolve(dir)).toBe(resolve(s.cwd));
    expect(run.host_env).toBe("HOST");
    expect(run.port_env).toBe("PORT");
    expect(s.env.HOST).toBeDefined();
    expect(s.env.PORT).toBe(String(run.port));
    expect(new URL(s.health ?? "").pathname).toBe(run.health.http);
  });

  it.each(["asr", "tts", "sing", "turn"])("%s has the default environment", (name) => {
    const { descriptor, dir } = entry(name);
    // The turn models live in the host's model folder (H6): the descriptor says where.
    const {
      VOICES_DIR,
      SING_OFFLOAD_URLS,
      SING_MODELS_DIR,
      TURN_SMART_MODEL,
      TURN_SILERO_MODEL,
      ...env
    } = descriptor.run?.env ?? {};
    if (name === "turn") {
      expect(TURN_SMART_MODEL).toBe("{models}/smart-turn/smart-turn-v3.2-cpu.onnx");
      expect(TURN_SILERO_MODEL).toBe("{models}/silero-vad/silero_vad.onnx");
    }
    // The two separation models are downloaded into the host's model folder; without hostd the
    // plan leaves it unset and the worker looks where they used to be (workers/modelpaths.py).
    expect(SING_MODELS_DIR).toBe(name === "sing" ? "{models}" : undefined);
    expect(env).toEqual(WORKER_DEFAULTS[name]?.env);
    // The plan fills SING_OFFLOAD_URLS itself; hostd fills {offload_urls} (until H7).
    expect(SING_OFFLOAD_URLS).toBe(name === "sing" ? "{offload_urls}" : undefined);
    if (name === "tts") {
      // The plan fills VOICES_DIR itself; the descriptor says it with a placeholder.
      expect(VOICES_DIR).toBe("{service}/../voices");
      expect(resolve(dir, "..", "voices")).toBe(resolve(spec(name).env.VOICES_DIR ?? ""));
    } else {
      expect(VOICES_DIR).toBeUndefined();
    }
  });

  it("sing starts after the workers it offloads, and gets their addresses in the same order", () => {
    const after = entry("sing").descriptor.run?.after ?? [];
    expect([...after].sort()).toEqual([...(WORKER_DEFAULTS.sing?.offload ?? [])].sort());
    const names = plan.map((s) => s.name);
    for (const peer of after) {
      expect(names.indexOf(peer)).toBeLessThan(names.indexOf("sing"));
    }
    const hostFile = join(root, "pin-test", "host.toml");
    const plans = planServices(
      catalog,
      {
        file: hostFile,
        workspace: dirname(hostFile),
        config: parseHostConfig(
          hostFile,
          'name = "pin"\n[services.sing]\n[services.asr]\n[services.tts]\n',
        ),
        state: stateLayout(join(root, "pin-test", "state")),
      },
      {
        workspace: dirname(hostFile),
        state: join(root, "pin-test", "state"),
        bind: "127.0.0.1",
        configPath,
        miyoria: ["node", "main.js"],
        node: "node",
        env: {},
        platform: "win32",
      },
    );
    const urls = offloadUrls(
      plans,
      (p) => (typeof p.port === "number" ? p.port : undefined),
      "127.0.0.1",
    );
    expect(urls).toBe(spec("sing").env.SING_OFFLOAD_URLS);
  });
});

describe("core, the voice node and the stage", () => {
  it("core runs the CLI's own entry with core", () => {
    const { descriptor } = entry("core");
    const s = spec("core");
    const run = descriptor.run;
    expect(run?.command[0]).toBe("{miyoria}");
    expect(run?.command.slice(1).map((p) => (p === "{config}" ? configPath : p))).toEqual(
      s.args.slice(-3),
    );
    expect(s.args.slice(-3)[0]).toBe("core");
    expect(run?.port).toBe(s.port);
    expect(new URL(s.health ?? "").pathname).toBe(run?.health.http);
  });

  it("stage runs the CLI's own entry with stage and serves the overlay on 7884", () => {
    const { descriptor } = entry("stage");
    const s = spec("stage");
    const run = descriptor.run;
    expect(run?.command[0]).toBe("{miyoria}");
    expect(run?.command.slice(1).map((p) => (p === "{config}" ? configPath : p))).toEqual(
      s.args.slice(-3),
    );
    expect(s.args.slice(-3)[0]).toBe("stage");
    expect(run?.port).toBe(7884);
    expect(s.port).toBe(7884);
    // No health URL today: the plan waits for the process to stay alive.
    expect(s.health).toBeNull();
    expect(run?.health.http).toBeUndefined();
    expect(run?.health.process).toBe(true);
  });

  it("the voice node runs pnpm start in its folder", () => {
    const { descriptor, dir } = entry("voice-node");
    const s = spec("voice-node");
    expect(descriptor.run?.command).toEqual([s.command, ...s.args]);
    expect(resolve(dir)).toBe(resolve(s.cwd));
    expect(s.health).toBeNull();
    expect(descriptor.run?.health.process).toBe(true);
    expect(s.port).toBeNull();
    expect(descriptor.run?.port).toBeUndefined();
  });

  it("the two nodes start after core, as in the plan", () => {
    const names = plan.map((s) => s.name);
    for (const name of ["voice-node", "stage"]) {
      expect(entry(name).descriptor.run?.after).toEqual(["core"]);
      expect(names.indexOf("core")).toBeLessThan(names.indexOf(name));
    }
  });
});
