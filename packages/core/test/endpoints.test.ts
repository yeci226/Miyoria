// Core's wiring of the endpoint registry: exactly the address keys the config file sets become
// static entries (none for an absent key), in order, once per registry; without the cluster
// module a registry of Core's own is used; a restarted cluster module is picked up, watchers
// included.

import { ClusterKey, type ClusterService, EndpointRegistry } from "@miyoria/cluster";
import { Config, ServiceRegistry } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { CoreEndpoints, legacyEndpoints } from "../src/endpoints.js";

function toml(text: string): Config {
  return Config.fromToml(text, () => "x");
}

const FULL = `
[speech.asr.local]
kind = "http-worker"
url = "http://127.0.0.1:8003"

[speech.asr.shared]
kind = "http-worker"

[speech.asr.groq]
kind = "openai"
base_url = "https://api.groq.com/openai/v1"

[speech.tts.qwen]
kind = "http-worker"
url = "http://127.0.0.1:8002"

[speech.tts.cloud]
kind = "vllm-omni"
base_url = "http://127.0.0.1:8091/v1"

[modules.voice]
turn_url = "http://127.0.0.1:8006"

[modules.sing]
url = "http://100.83.26.41:8005"
fallback_urls = ["http://100.83.26.41:8005/", "http://127.0.0.1:8005"]

[modules.imagegen]
enabled = true
url = "http://127.0.0.1:8188"
headers = { authorization = "Bearer proxy" }
`;

describe("legacyEndpoints", () => {
  it("makes one static entry per address key the file sets, in order", () => {
    expect(legacyEndpoints(toml(FULL))).toEqual([
      { name: "speech.asr.local", provides: ["asr"], url: "http://127.0.0.1:8003" },
      { name: "speech.tts.qwen", provides: ["tts"], url: "http://127.0.0.1:8002" },
      { name: "voice.turn", provides: ["turn", "vad"], url: "http://127.0.0.1:8006" },
      { name: "sing", provides: ["sing"], url: "http://100.83.26.41:8005" },
      { name: "sing.fallback.1", provides: ["sing"], url: "http://127.0.0.1:8005" },
      {
        name: "imagegen",
        provides: ["imagegen"],
        url: "http://127.0.0.1:8188",
        headers: { authorization: "Bearer proxy" },
      },
    ]);
  });

  it("makes none for keys the file leaves out: there are no default addresses", () => {
    expect(legacyEndpoints(toml(""))).toEqual([]);
    expect(
      legacyEndpoints(
        toml(`
[modules.voice]
turn_engine = "smart-turn"
vad_engine = "silero"

[modules.sing]
start = "auto"

[modules.imagegen]
enabled = true
`),
      ),
    ).toEqual([]);
  });

  it("numbers the sing fallbacks after `url`, also without it", () => {
    expect(
      legacyEndpoints(toml(`[modules.sing]\nfallback_urls = ["http://a:8005", "http://b:8005"]`)),
    ).toEqual([
      { name: "sing.fallback.1", provides: ["sing"], url: "http://a:8005" },
      { name: "sing.fallback.2", provides: ["sing"], url: "http://b:8005" },
    ]);
  });
});

function withCluster(registry: EndpointRegistry, services = new ServiceRegistry()) {
  services.provide("cluster", ClusterKey, { registry } as unknown as ClusterService);
  return services;
}

describe("CoreEndpoints", () => {
  it("adds the entries once to the cluster module's registry, in order", () => {
    const registry = new EndpointRegistry();
    const services = withCluster(registry);
    const core = new CoreEndpoints(legacyEndpoints(toml(FULL)));
    const speech = core.option(services);
    const sing = core.option(services);
    expect(speech.candidates("asr").map((e) => e.host)).toEqual(["speech.asr.local"]);
    expect(sing.candidates("sing").map((e) => e.url)).toEqual([
      "http://100.83.26.41:8005",
      "http://127.0.0.1:8005",
    ]);
    expect(speech.pick("vad", { direct: true })?.host).toBe("voice.turn");
    expect(sing.pick("imagegen")?.headers).toEqual({ authorization: "Bearer proxy" });
    // Asked again: nothing is added twice.
    expect(core.registry(services).candidates("sing")).toHaveLength(2);
  });

  it("a reported endpoint at a key's address stands for it, with its token", () => {
    const registry = new EndpointRegistry();
    const services = withCluster(registry);
    const source = new CoreEndpoints(legacyEndpoints(toml(FULL))).option(services);
    source.candidates("asr");
    registry.setHost("main-pc", ["asr"]);
    registry.report("main-pc", {
      name: "main-pc",
      version: "0.1.0",
      platform: "win32",
      protocol: 1,
      gpu: null,
      services: [
        {
          name: "asr",
          kind: "worker",
          provides: ["asr"],
          state: "running",
          since: 0,
          healthy: true,
          restarts: 0,
          url: "http://127.0.0.1:8003",
          advertised: "http://127.0.0.1:8003",
          token: "service-token",
        },
      ],
    });
    expect(source.candidates("asr", { entry: "speech.asr.local" })).toMatchObject([
      { host: "main-pc", headers: { authorization: "Bearer service-token" } },
    ]);
  });

  it("uses a registry of its own while the cluster module is not running, and moves watchers", () => {
    const services = new ServiceRegistry();
    const core = new CoreEndpoints(legacyEndpoints(toml(FULL)));
    const source = core.option(services);
    let changes = 0;
    source.watch("sing", () => changes++);
    // No cluster module: the static entries still work.
    expect(source.pick("tts")?.url).toBe("http://127.0.0.1:8002");

    // It starts: the next call finds it, the entries are added there, the watcher is told.
    const registry = new EndpointRegistry();
    withCluster(registry, services);
    expect(source.candidates("sing").map((e) => e.host)).toEqual(["sing", "sing.fallback.1"]);
    expect(changes).toBe(1);
    // And the watcher now follows that registry.
    registry.setHost("pc", ["sing"]);
    registry.report("pc", {
      name: "pc",
      version: "0.1.0",
      platform: "win32",
      protocol: 1,
      gpu: null,
      services: [
        {
          name: "sing",
          kind: "worker",
          provides: ["sing"],
          state: "running",
          since: 0,
          healthy: true,
          restarts: 0,
          url: "http://10.0.0.5:8005",
        },
      ],
    });
    expect(changes).toBe(2);
  });

  it("an entry whose name is taken is left out, the others are added", () => {
    const registry = new EndpointRegistry({
      static: { sing: { provides: ["sing"], url: "http://friend:8005" } },
    });
    const services = withCluster(registry);
    const source = new CoreEndpoints(legacyEndpoints(toml(FULL))).option(services);
    expect(source.candidates("sing").map((e) => e.host)).toEqual(["sing", "sing.fallback.1"]);
    expect(source.candidates("sing")[0]?.url).toBe("http://friend:8005");
    expect(source.pick("asr")?.host).toBe("speech.asr.local");
  });
});
