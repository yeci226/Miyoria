// The two TOML shapes and the method schemas: defaults, strictness and the examples of the design.

import { describe, expect, it } from "vitest";
import {
  HOST_ERROR_CODE,
  HOST_LINK_CLOSE,
  HOST_METHOD,
  HostConfigSchema,
  HostFetchSchema,
  HostHelloSchema,
  HostInfoSchema,
  HostLinksSchema,
  HostLlmSchema,
  HostRoutingSchema,
  HostServiceInstallResultSchema,
  HostServiceInstallSchema,
  HostServiceLogsSchema,
  HostServiceRemoveSchema,
  HostServiceSchema,
  HostServiceStatusSchema,
  HostUpgradeJobSchema,
  HostUpgradeSchema,
} from "../src/index.js";

const full = {
  name: "asr",
  kind: "worker",
  provides: ["asr"],
  platforms: ["win32", "linux"],
  summary: "語音辨識(Qwen3-ASR)",
  install: {
    runtime: "python",
    python: ">=3.11,<3.14",
    project: ".",
    extras: ["qwen3"],
    system: ["ffmpeg"],
    models: [{ repo: "Qwen/Qwen3-ASR-0.6B", revision: "abc" }],
    files: [{ url: "https://example.test/a.onnx", sha256: "0".repeat(64), path: "models/a.onnx" }],
    manual: [{ path: "voices/{voice}", what: "參考聲音的資料夾" }],
    check_imports: ["torch", "qwen_asr"],
  },
  run: {
    command: ["{python}", "server.py"],
    cwd: ".",
    port: 8003,
    host_env: "HOST",
    port_env: "PORT",
    env: { ASR_BACKEND: "qwen3" },
    pass_env: ["HF_*"],
    after: [],
    guard: [],
    health: { http: "/health", startup_s: 180, interval_s: 10, timeout_s: 3 },
    restart: {
      policy: "on-failure",
      backoff_s: [1, 5, 30],
      give_up: { failures: 5, window_s: 600 },
    },
    stop: { grace_s: 10 },
  },
  gpu: {
    policy: "evictable",
    vram_mb: { resident: 1500, peak: 2000 },
    offload: "/offload",
    reload: "/reload",
    busy: "/busy",
  },
};

describe("HostServiceSchema", () => {
  it("parses a full descriptor as the design shows it", () => {
    const parsed = HostServiceSchema.parse(full);
    expect(parsed.run?.port).toBe(8003);
    expect(parsed.gpu?.vram_mb).toEqual({ resident: 1500, peak: 2000 });
  });

  it("applies the defaults", () => {
    const parsed = HostServiceSchema.parse({
      name: "x",
      kind: "worker",
      run: { command: ["x"] },
    });
    expect(parsed.install.runtime).toBe("none");
    expect(parsed.install.check_imports).toEqual([]);
    expect(parsed.run).toMatchObject({
      cwd: ".",
      env: {},
      pass_env: [],
      after: [],
      guard: [],
      health: { startup_s: 180, interval_s: 10, timeout_s: 3 },
      restart: {
        policy: "on-failure",
        backoff_s: [1, 5, 30],
        give_up: { failures: 5, window_s: 600 },
      },
      stop: { grace_s: 10 },
    });
    expect(parsed.run?.port).toBeUndefined();
  });

  it("rejects a typo key at every level", () => {
    expect(() => HostServiceSchema.parse({ ...full, sumary: "x" })).toThrow();
    expect(() => HostServiceSchema.parse({ ...full, run: { ...full.run, comand: [] } })).toThrow();
    expect(() =>
      HostServiceSchema.parse({ ...full, run: { ...full.run, health: { htp: "/h" } } }),
    ).toThrow();
    expect(() =>
      HostServiceSchema.parse({ ...full, gpu: { policy: "pinned", offlod: "/x" } }),
    ).toThrow();
  });

  it("no longer takes the pip fields that `project` replaced", () => {
    const install = (extra: object) =>
      HostServiceSchema.safeParse({ ...full, install: { ...full.install, ...extra } }).success;
    expect(install({ requirements: ["requirements.txt"] })).toBe(false);
    expect(install({ torch: { index: "https://example.test/cu128", packages: ["torch"] } })).toBe(
      false,
    );
  });

  it("accepts a number and the literal auto for the port, nothing else", () => {
    const withPort = (port: unknown) =>
      HostServiceSchema.safeParse({ ...full, run: { ...full.run, port } }).success;
    expect(withPort(9000)).toBe(true);
    expect(withPort("auto")).toBe(true);
    expect(withPort("8003")).toBe(false);
    expect(withPort(0)).toBe(false);
  });

  it("parses an external service", () => {
    const parsed = HostServiceSchema.parse({
      name: "comfyui",
      kind: "external",
      provides: ["imagegen"],
      probe: { http: "/system_stats", port: 8188 },
      launch: { command: ["run.bat"] },
      gpu: { policy: "on_demand" },
    });
    expect(parsed.run).toBeUndefined();
    expect(parsed.launch?.cwd).toBe(".");
  });

  it("knows the guard states", () => {
    const run = { ...full.run, guard: ["singing", "live"] };
    expect(HostServiceSchema.parse({ ...full, run }).run?.guard).toEqual(["singing", "live"]);
    expect(
      HostServiceSchema.safeParse({ ...full, run: { ...full.run, guard: ["x"] } }).success,
    ).toBe(false);
  });
});

describe("HostConfigSchema", () => {
  it("parses the host.toml of the design", () => {
    const parsed = HostConfigSchema.parse({
      name: "main-pc",
      cluster: { url: "ws://127.0.0.1:7880/cluster-link" },
      paths: { state: "data/host" },
      gpu: { reserve_mb: 2500 },
      services: {
        asr: {
          enabled: true,
          python: "workers/.venv-asr-qwen",
          env: { HF_HUB_OFFLINE: "1" },
        },
        sing: { enabled: true, python: "workers/.venv-sing", gpu: { policy: "on_demand" } },
      },
    });
    expect(parsed.services.sing?.gpu?.policy).toBe("on_demand");
    expect(parsed.gpu).toEqual({ reserve_mb: 2500, arbiter: "worker" });
    expect(HostConfigSchema.parse({ name: "m", gpu: { arbiter: "hostd" } }).gpu).toEqual({
      reserve_mb: 0,
      arbiter: "hostd",
    });
    expect(HostConfigSchema.safeParse({ name: "m", gpu: { arbiter: "self" } }).success).toBe(false);
  });

  it("needs only a name, and defaults the rest", () => {
    expect(HostConfigSchema.parse({ name: "m" })).toEqual({
      name: "m",
      paths: { state: "data/host" },
      network: { bind: "127.0.0.1" },
      gpu: { reserve_mb: 0, arbiter: "worker" },
      update: { allow_remote: true },
      services: {},
    });
    // On without the table and with an empty one; `false` opts out.
    expect(HostConfigSchema.parse({ name: "m", update: {} }).update).toEqual({
      allow_remote: true,
    });
    expect(HostConfigSchema.parse({ name: "m", update: { allow_remote: false } }).update).toEqual({
      allow_remote: false,
    });
    expect(HostConfigSchema.safeParse({ name: "m", update: { allow: true } }).success).toBe(false);
    expect(HostConfigSchema.parse({ name: "m", services: { a: {} } }).services.a).toEqual({
      enabled: true,
      env: {},
    });
  });

  it("rejects a typo key", () => {
    expect(() => HostConfigSchema.parse({ name: "m", clustr: {} })).toThrow();
    expect(() =>
      HostConfigSchema.parse({ name: "m", services: { a: { enable: true } } }),
    ).toThrow();
  });
});

describe("methods and constants", () => {
  const status = {
    name: "asr",
    kind: "worker",
    provides: ["asr"],
    state: "running",
    since: 1,
    healthy: true,
    restarts: 0,
  };

  it("parses a service status and a host.info result", () => {
    expect(HostServiceStatusSchema.parse(status).state).toBe("running");
    const info = {
      name: "main-pc",
      version: "0.1.0",
      platform: "win32",
      protocol: 1,
      gpu: null,
      services: [status],
    };
    expect(HostInfoSchema.parse(info).gpu).toBeNull();
  });

  it("parses the install, remove and update shapes", () => {
    expect(HostServiceInstallSchema.parse({ service: "asr", extras: ["sensevoice"] })).toEqual({
      service: "asr",
      extras: ["sensevoice"],
    });
    expect(() => HostServiceInstallSchema.parse({})).toThrow();
    expect(HostServiceRemoveSchema.parse({ service: "asr", keep_env: true }).keep_env).toBe(true);
    const result = HostServiceInstallResultSchema.parse({
      service: "asr",
      ok: true,
      runtime: { state: "synced", dir: "/x", extras: ["qwen3"] },
      system: [{ program: "ffmpeg", found: false, hint: "winget install" }],
      files: [],
      manual: [],
      models: [{ repo: "a/b", present: false }],
    });
    expect(result.runtime.state).toBe("synced");
    expect(() =>
      HostServiceInstallResultSchema.parse({ ...result, runtime: { state: "bogus" } }),
    ).toThrow();
  });

  it("bounds the log request", () => {
    expect(HostServiceLogsSchema.parse({ service: "a" })).toEqual({
      service: "a",
      lines: 100,
      follow: false,
    });
    expect(HostServiceLogsSchema.safeParse({ service: "a", lines: 2001 }).success).toBe(false);
  });

  it("needs every field of hello", () => {
    expect(HostHelloSchema.safeParse({ protocol: 1, host: "h" }).success).toBe(false);
  });

  it("keeps method names and error codes unique", () => {
    const methods = Object.values(HOST_METHOD);
    expect(new Set(methods).size).toBe(methods.length);
    const codes = Object.values(HOST_ERROR_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    expect(HOST_LINK_CLOSE.UNAUTHORIZED).toBe(4401);
  });

  it("reads cluster.llm and cluster.fetch params", () => {
    const llm = HostLlmSchema.parse({
      purpose: "fast",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      json: true,
    });
    expect(llm.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(HostLlmSchema.safeParse({ purpose: "fast", messages: [] }).success).toBe(false);
    expect(
      HostLlmSchema.safeParse({ purpose: "fast", messages: [{ role: "tool", content: "x" }] })
        .success,
    ).toBe(false);
    const fetch = { capability: "asr", method: "POST", path: "/asr", body: "AAEC" };
    expect(HostFetchSchema.parse(fetch)).toEqual(fetch);
    expect(HostFetchSchema.safeParse({ ...fetch, path: "asr" }).success).toBe(false);
    expect(HostFetchSchema.safeParse({ ...fetch, path: "//evil/asr" }).success).toBe(false);
    expect(HostFetchSchema.safeParse({ ...fetch, method: "post" }).success).toBe(false);
  });

  it("reads an update request and job, and an old report without them", () => {
    const sha = "a".repeat(40);
    expect(HostUpgradeSchema.parse({ commit: sha })).toEqual({ commit: sha });
    expect(HostUpgradeSchema.safeParse({ commit: "abc123" }).success).toBe(false);
    expect(HostUpgradeSchema.safeParse({ commit: sha.toUpperCase() }).success).toBe(false);
    expect(HostUpgradeSchema.safeParse({ commit: sha, wait_s: -1 }).success).toBe(false);
    const job = HostUpgradeJobSchema.parse({
      id: "u1",
      target: sha,
      from: null,
      state: "waiting",
      step: "wait",
      steps: [{ step: "check", state: "done", at: 1 }],
      waiting_for: "sing 正在做歌",
      started_at: 1,
    });
    expect(job.state).toBe("waiting");
    const old = {
      name: "m",
      version: "0",
      platform: "linux",
      protocol: 1,
      gpu: null,
      services: [],
    };
    const parsed = HostInfoSchema.parse(old);
    expect(parsed.checkout).toBeUndefined();
    expect(parsed.remote_update).toBeUndefined();
  });

  it("reads cluster.links: each link optional, a port in range", () => {
    const voice = { port: 7879, path: "/voice-link", token: "t" };
    expect(HostLinksSchema.parse({ links: { voice } })).toEqual({ links: { voice } });
    expect(HostLinksSchema.parse({ links: {} })).toEqual({ links: {} });
    expect(HostLinksSchema.safeParse({ links: { voice: { ...voice, port: 0 } } }).success).toBe(
      false,
    );
    expect(HostLinksSchema.safeParse({}).success).toBe(false);
  });
});

describe("routing (v5-hostd §15)", () => {
  const status = {
    name: "sing",
    kind: "worker",
    provides: ["sing"],
    state: "running",
    since: 1,
    healthy: true,
    restarts: 0,
  };

  it("takes [routing] in a descriptor with its defaults, and refuses an unknown key", () => {
    const base = { name: "sing", kind: "worker", run: { command: ["x"] } };
    const parsed = HostServiceSchema.parse({ ...base, routing: { class: "job" } });
    expect(parsed.routing).toEqual({
      class: "job",
      latency: "interactive",
      concurrency: 1,
      queue: false,
      needs: { files: [] },
      yields_to: [],
    });
    expect(HostServiceSchema.parse(base).routing).toBeUndefined();
    expect(
      HostServiceSchema.safeParse({ ...base, routing: { class: "job", weight: 2 } }).success,
    ).toBe(false);
    expect(HostRoutingSchema.safeParse({ class: "pool" }).success).toBe(false);
  });

  it("reads a status with routing and load, and one from an older hostd without them", () => {
    const routing = {
      class: "job",
      latency: "batch",
      concurrency: 1,
      queue: true,
      yields_to: ["tts", "asr"],
      ready: true,
      variant: "0123456789abcdef",
      accept: true,
    };
    const load = { running: 1, queued: 2, age_ms: 300 };
    const parsed = HostServiceStatusSchema.parse({ ...status, routing, load });
    expect(parsed.routing).toEqual(routing);
    expect(parsed.load).toEqual(load);
    const old = HostServiceStatusSchema.parse(status);
    expect(old.routing).toBeUndefined();
    expect(old.load).toBeUndefined();
  });

  it("keeps a host.toml without accept and concurrency as before", () => {
    const parsed = HostConfigSchema.parse({ name: "h", services: { sing: { enabled: true } } });
    expect(parsed.services.sing?.accept).toBeUndefined();
    const limited = HostConfigSchema.parse({
      name: "h",
      services: { sing: { accept: false, concurrency: 1 } },
    });
    expect(limited.services.sing).toMatchObject({ accept: false, concurrency: 1 });
    expect(
      HostConfigSchema.safeParse({ name: "h", services: { sing: { concurrency: 0 } } }).success,
    ).toBe(false);
  });
});
