import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  expandService,
  fileTail,
  HostConfigError,
  loadCatalog,
  loadHostConfig,
  matchesPassEnv,
  offloadUrls,
  parseNvidiaSmi,
  placeholdersIn,
  planServices,
  pythonIn,
  type ResolveContext,
  workerBaseEnv,
} from "../src/index.js";
import { linkUrl, linkValues } from "../src/links.js";
import { rotatingLog } from "../src/logs.js";
import { cleanup, type TestWorkspace, workspace, writeIn } from "./fakes.js";

afterEach(cleanup);

function ctxFor(ws: TestWorkspace, over: Partial<ResolveContext> = {}): ResolveContext {
  return {
    workspace: ws.root,
    state: ws.state,
    bind: "127.0.0.1",
    configPath: join(ws.root, "miyoria.toml"),
    miyoria: ["node", "--import", "tsx", "/src/main.ts"],
    node: "/usr/bin/node",
    env: { PATH: "/bin", SECRET_KEY: "no", HF_HOME: "/hf", FOO_A: "1", FOO_B: "2" },
    platform: "linux",
    ...over,
  };
}

function descriptor(ws: TestWorkspace, name: string, body: string): void {
  writeIn(ws, `workers/${name}/service.toml`, `name = "${name}"\nkind = "worker"\n${body}\n`);
}

function plans(ws: TestWorkspace, ctx: ResolveContext) {
  return planServices(loadCatalog(ws.root), loadHostConfig(ws.hostToml), ctx);
}

const live = {
  port: 9100,
  offloadUrls: "",
  token: "tok",
  hostToken: "host-tok",
  hostdUrl: "http://127.0.0.1:5000",
};

describe("placeholders", () => {
  it("finds {env:NAME} and rejects unknown ones at load time", () => {
    expect(placeholdersIn("{env:A_B} {port} {nope}")).toEqual(["env:A_B", "port", "nope"]);
    const ws = workspace([]);
    descriptor(ws, "bad", '[run]\ncommand = ["{nope}"]');
    descriptor(
      ws,
      "good",
      '[run]\ncommand = ["x"]\nenv = { S = "{env:SECRET}", U = "{offload_urls}" }\ncwd = "{workspace}"',
    );
    const catalog = loadCatalog(ws.root);
    expect(catalog.services.has("good")).toBe(true);
    expect(catalog.problems.map((p) => p.message)).toEqual([
      "run.command[0]: unknown placeholder {nope}",
    ]);
  });

  it("expands {miyoria} into several arguments and the rest in place", () => {
    const ws = workspace([]);
    descriptor(
      ws,
      "core",
      '[run]\ncommand = ["{miyoria}", "core", "-c", "{config}", "--port={port}"]\ncwd = "{workspace}"\nport = 9100',
    );
    writeIn(ws, "host.toml", 'name = "h"\n[services.core]\n');
    const ctx = ctxFor(ws);
    const [plan] = plans(ws, ctx);
    expect(plan?.disabled).toBeNull();
    const spec = expandService(plan as NonNullable<typeof plan>, ctx, live);
    expect(spec.file).toBe("node");
    expect(spec.args).toEqual([
      "--import",
      "tsx",
      "/src/main.ts",
      "core",
      "-c",
      ctx.configPath,
      "--port=9100",
    ]);
    expect(spec.cwd).toBe(ws.root);
  });

  it("refuses {miyoria} inside a longer argument", () => {
    const ws = workspace([]);
    descriptor(ws, "x", '[run]\ncommand = ["run:{miyoria}"]');
    writeIn(ws, "host.toml", 'name = "h"\n[services.x]\n');
    expect(plans(ws, ctxFor(ws))[0]?.disabled).toMatch(/\{miyoria\}/);
  });

  it("takes {env:NAME} from the daemon and disables the service without it", () => {
    const ws = workspace([]);
    descriptor(ws, "media", '[run]\ncommand = ["m"]\nenv = { MTX_SECRET = "{env:HLS_SECRET}" }');
    writeIn(ws, "host.toml", 'name = "h"\n[services.media]\n');
    const without = plans(ws, ctxFor(ws));
    expect(without[0]?.disabled).toMatch(/HLS_SECRET/);
    const ctx = ctxFor(ws, { env: { HLS_SECRET: "s3" } });
    const [plan] = plans(ws, ctx);
    expect(plan?.disabled).toBeNull();
    expect(expandService(plan as NonNullable<typeof plan>, ctx, live).env.MTX_SECRET).toBe("s3");
  });

  it("sets {link:...} variables hostd knows, leaves out the others, and never disables for them", () => {
    const ws = workspace([]);
    descriptor(
      ws,
      "node",
      '[run]\ncommand = ["n"]\nenv = { LINK_URL = "{link:voice.url}", LINK_TOKEN = "{link:voice.token}", BOTH = "{link:voice.url}#{link:voice.token}", PLAIN = "p" }',
    );
    writeIn(ws, "host.toml", 'name = "h"\n[services.node]\n');
    const ctx = ctxFor(ws, { env: { PATH: "/bin", LINK_URL: "from the daemon" } });
    const [plan] = plans(ws, ctx);
    expect(plan?.disabled).toBeNull();
    const p = plan as NonNullable<typeof plan>;

    const none = expandService(p, ctx, live);
    expect(none.env).not.toHaveProperty("LINK_URL");
    expect(none.env).not.toHaveProperty("LINK_TOKEN");
    expect(none.env).not.toHaveProperty("BOTH");
    expect(none.env.PLAIN).toBe("p");
    expect(none.links).toEqual({ "voice.url": null, "voice.token": null });

    // Only the token known: the URL variable and the one needing both stay out.
    const half = expandService(p, ctx, { ...live, links: { "voice.token": "t1" } });
    expect(half.env.LINK_TOKEN).toBe("t1");
    expect(half.env).not.toHaveProperty("LINK_URL");
    expect(half.env).not.toHaveProperty("BOTH");

    const all = expandService(p, ctx, {
      ...live,
      links: { "voice.url": "ws://core:7879/voice-link", "voice.token": "t1" },
    });
    expect(all.env).toMatchObject({
      LINK_URL: "ws://core:7879/voice-link",
      LINK_TOKEN: "t1",
      BOTH: "ws://core:7879/voice-link#t1",
    });
    expect(all.links).toEqual({ "voice.url": "ws://core:7879/voice-link", "voice.token": "t1" });
  });

  it("builds a link's address from the cluster URL unless Core sent one", () => {
    expect(linkUrl("ws://core.tailnet:7880/cluster-link", 7879, "/voice-link")).toBe(
      "ws://core.tailnet:7879/voice-link",
    );
    expect(linkUrl("wss://core.example/cluster-link", 7882, "/stage-link")).toBe(
      "wss://core.example:7882/stage-link",
    );
    expect(linkUrl("ws://[fd7a::1]:7880/cluster-link", 7879, "/voice-link")).toBe(
      "ws://[fd7a::1]:7879/voice-link",
    );
    expect(linkUrl(undefined, 7879, "/voice-link")).toBeNull();
    expect(linkUrl("not a url", 7879, "/voice-link")).toBeNull();

    const voice = { port: 7879, path: "/voice-link", token: "v" };
    expect(linkValues({ voice }, "ws://core:7880/cluster-link")).toEqual({
      "voice.url": "ws://core:7879/voice-link",
      "voice.token": "v",
    });
    expect(
      linkValues(
        {
          voice,
          stage: { url: "wss://pub.example:7882/stage-link", port: 7882, path: "/x", token: "s" },
        },
        undefined,
      ),
    ).toEqual({
      "voice.token": "v",
      "stage.url": "wss://pub.example:7882/stage-link",
      "stage.token": "s",
    });
  });

  it("finds the Python of host.toml's environment or of the state folder", () => {
    const ws = workspace([]);
    descriptor(ws, "asr", '[run]\ncommand = ["{python}", "server.py"]');
    descriptor(ws, "tts", '[run]\ncommand = ["{python}", "server.py"]');
    writeIn(ws, "host.toml", 'name = "h"\n[services.asr]\npython = "venvs/asr"\n[services.tts]\n');
    const ctx = ctxFor(ws);
    const before = plans(ws, ctx);
    expect(before.find((p) => p.name === "asr")?.disabled).toMatch(/找不到 Python 環境/);
    expect(before.find((p) => p.name === "tts")?.disabled).toMatch(/envs/);

    for (const file of [
      pythonIn(join(ws.root, "venvs", "asr"), "linux"),
      pythonIn(join(ws.state, "envs", "tts"), "linux"),
    ]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
    const after = plans(ws, ctx);
    const asr = after.find((p) => p.name === "asr");
    expect(asr?.disabled).toBeNull();
    expect(expandService(asr as NonNullable<typeof asr>, ctx, live).file).toBe(
      join(ws.root, "venvs", "asr", "bin", "python"),
    );
    expect(pythonIn("/e", "win32")).toBe(join("/e", "Scripts", "python.exe"));
  });

  it("disables what host.toml turns off, other platforms and unknown names", () => {
    const ws = workspace([]);
    descriptor(ws, "win", 'platforms = ["win32"]\n[run]\ncommand = ["x"]');
    descriptor(ws, "off", '[run]\ncommand = ["x"]');
    writeIn(
      ws,
      "host.toml",
      'name = "h"\n[services.win]\n[services.off]\nenabled = false\n[services.ghost]\n',
    );
    const by = Object.fromEntries(plans(ws, ctxFor(ws)).map((p) => [p.name, p.disabled]));
    expect(by.win).toMatch(/win32/);
    expect(by.off).toMatch(/enabled = false/);
    expect(by.ghost).toMatch(/service\.toml/);
  });
});

describe("environment", () => {
  it("layers the allowlist, pass_env, the descriptor, host.toml and hostd's own values", () => {
    const ws = workspace([]);
    descriptor(
      ws,
      "w",
      '[run]\ncommand = ["x"]\nport = 9100\nhost_env = "HOST"\nport_env = "PORT"\npass_env = ["FOO_*"]\nenv = { A = "desc", B = "desc", MODELS = "{models}/hf" }',
    );
    writeIn(
      ws,
      "host.toml",
      'name = "h"\n[paths]\nca_bundle = "certs/ca.pem"\n[services.w]\nenv = { B = "host", HF_HOME = "/other" }\n',
    );
    const ctx = ctxFor(ws, { caBundle: join(ws.root, "certs", "ca.pem") });
    const [plan] = plans(ws, ctx);
    const env = expandService(plan as NonNullable<typeof plan>, ctx, live).env;
    expect(env).toEqual({
      PATH: "/bin",
      HF_HOME: "/other",
      FOO_A: "1",
      FOO_B: "2",
      A: "desc",
      B: "host",
      MODELS: `${join(ws.state, "models")}/hf`,
      HOST: "127.0.0.1",
      PORT: "9100",
      MIYORIA_SERVICE_TOKEN: "tok",
      MIYORIA_HOST_TOKEN: "host-tok",
      MIYORIA_HOSTD_URL: "http://127.0.0.1:5000",
      SSL_CERT_FILE: join(ws.root, "certs", "ca.pem"),
      REQUESTS_CA_BUNDLE: join(ws.root, "certs", "ca.pem"),
    });
    expect(env.SECRET_KEY).toBeUndefined();
  });

  it("gives a Python service the model cache of the state folder, which descriptor and host.toml override", () => {
    const ws = workspace([]);
    const cache = join(ws.state, "models", "hf");
    const py = '[install]\nruntime = "python"\nproject = "."\n[run]\ncommand = ["{python}"]\n';
    descriptor(ws, "py", py);
    descriptor(ws, "pyd", `${py}env = { HF_HUB_CACHE = "/from-descriptor" }`);
    descriptor(ws, "pyh", `${py}env = { HF_HUB_CACHE = "/from-descriptor" }`);
    descriptor(ws, "node", '[install]\nruntime = "node"\n[run]\ncommand = ["x"]');
    writeIn(
      ws,
      "host.toml",
      'name = "h"\n[services.py]\n[services.pyd]\n[services.pyh]\nenv = { HF_HUB_CACHE = "/from-host" }\n[services.node]\n',
    );
    for (const name of ["py", "pyd", "pyh"]) {
      const file = pythonIn(join(ws.state, "envs", name), "linux");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
    // The daemon's own variable does not win: pull and run must use one cache.
    const ctx = ctxFor(ws, { env: { PATH: "/bin", HF_HUB_CACHE: "/users-own" } });
    const envOf = (name: string) => {
      const plan = plans(ws, ctx).find((p) => p.name === name);
      return expandService(plan as NonNullable<typeof plan>, ctx, live).env;
    };
    expect(envOf("py").HF_HUB_CACHE).toBe(cache);
    expect(envOf("pyd").HF_HUB_CACHE).toBe("/from-descriptor");
    expect(envOf("pyh").HF_HUB_CACHE).toBe("/from-host");
    expect(envOf("node").HF_HUB_CACHE).toBe("/users-own");
  });

  it("keeps secrets and a stale ASR_MODEL out of the base allowlist", () => {
    expect(
      workerBaseEnv({
        PATH: "/bin",
        ASR_MODEL: "x",
        OPENAI_API_KEY: "k",
        CUDA_VISIBLE_DEVICES: "0",
      }),
    ).toEqual({
      PATH: "/bin",
      CUDA_VISIBLE_DEVICES: "0",
    });
  });

  it("matches pass_env patterns", () => {
    expect(matchesPassEnv("ANYTHING", "*")).toBe(true);
    expect(matchesPassEnv("HF_HOME", "HF_*")).toBe(true);
    expect(matchesPassEnv("XHF_HOME", "HF_*")).toBe(false);
    expect(matchesPassEnv("hf_home", "HF_*", "win32")).toBe(true);
    expect(matchesPassEnv("hf_home", "HF_*", "linux")).toBe(false);
    expect(matchesPassEnv("MTX", "MTX")).toBe(true);
  });

  it("lists the evictable services for {offload_urls}, tts first, and drops an empty value", () => {
    const ws = workspace([]);
    descriptor(ws, "asr", '[run]\ncommand = ["x"]\nport = 8003\n[gpu]\npolicy = "evictable"');
    descriptor(ws, "tts", '[run]\ncommand = ["x"]\nport = 8002\n[gpu]\npolicy = "evictable"');
    descriptor(
      ws,
      "sing",
      '[run]\ncommand = ["x"]\nport = 8005\nafter = ["asr", "tts"]\nenv = { SING_OFFLOAD_URLS = "{offload_urls}" }\n[gpu]\npolicy = "on_demand"',
    );
    writeIn(ws, "host.toml", 'name = "h"\n[services.sing]\n[services.asr]\n[services.tts]\n');
    const ctx = ctxFor(ws);
    const all = plans(ws, ctx);
    expect(all.map((p) => p.name)).toEqual(["asr", "tts", "sing"]);
    const urls = offloadUrls(
      all,
      (p) => (typeof p.port === "number" ? p.port : undefined),
      "0.0.0.0",
    );
    expect(urls).toBe("http://127.0.0.1:8002,http://127.0.0.1:8003");
    const sing = all.find((p) => p.name === "sing") as NonNullable<(typeof all)[number]>;
    expect(expandService(sing, ctx, { ...live, offloadUrls: urls }).env.SING_OFFLOAD_URLS).toBe(
      urls,
    );
    expect(expandService(sing, ctx, live).env).not.toHaveProperty("SING_OFFLOAD_URLS");
    expect(expandService(sing, ctx, { ...live, offloadUrls: urls }).env).not.toHaveProperty(
      "SING_GPU_ARBITER",
    );

    // hostd arbitrates: the holder asks it and learns no neighbour; the others are unchanged.
    const hostd = expandService(sing, ctx, { ...live, offloadUrls: urls, gpuArbiter: "hostd" });
    expect(hostd.env.SING_GPU_ARBITER).toBe("hostd");
    expect(hostd.env).not.toHaveProperty("SING_OFFLOAD_URLS");
    const tts = all.find((p) => p.name === "tts") as NonNullable<(typeof all)[number]>;
    expect(
      expandService(tts, ctx, { ...live, port: 8002, gpuArbiter: "hostd" }).env,
    ).not.toHaveProperty("SING_GPU_ARBITER");
    expect(
      expandService(sing, ctx, { ...live, offloadUrls: urls, gpuArbiter: "worker" }).env
        .SING_OFFLOAD_URLS,
    ).toBe(urls);

    // host.toml can move a service out of the evictable group.
    writeIn(
      ws,
      "host.toml",
      'name = "h"\n[services.sing]\n[services.asr]\ngpu = { policy = "pinned" }\n[services.tts]\nenabled = false\n',
    );
    expect(offloadUrls(plans(ws, ctx), () => 1, "127.0.0.1")).toBe("");
  });
});

describe("host.toml", () => {
  it("resolves the state folder against the workspace", () => {
    const ws = workspace([]);
    writeIn(ws, "host.toml", 'name = "h"\n[paths]\nstate = "var/hostd"\n');
    const host = loadHostConfig(ws.hostToml);
    expect(host.workspace).toBe(ws.root);
    expect(host.state.logs).toBe(join(ws.root, "var", "hostd", "logs"));
    expect(host.state.run).toBe(join(ws.root, "var", "hostd", "run"));
  });

  it("reports a typo with its path", () => {
    const ws = workspace([]);
    writeIn(ws, "host.toml", 'name = "h"\n[network]\nbnd = "x"\n');
    expect(() => loadHostConfig(ws.hostToml)).toThrow(HostConfigError);
    expect(() => loadHostConfig(join(ws.root, "missing.toml"))).toThrow(/does not exist/);
  });
});

describe("gpu", () => {
  it("reads nvidia-smi's CSV", () => {
    expect(parseNvidiaSmi("0, NVIDIA GeForce RTX 4070 SUPER, 12282, 10438, 1560\r\n")).toEqual({
      name: "NVIDIA GeForce RTX 4070 SUPER",
      total_mb: 12282,
      used_mb: 10722,
      free_mb: 1560,
    });
    expect(parseNvidiaSmi("")).toBeNull();
  });
});

describe("logs", () => {
  it("rotates by size and keeps five old files", async () => {
    const ws = workspace([]);
    const dir = join(ws.state, "logs");
    const stream = rotatingLog(dir, "svc.log", "1K");
    const line = `${"x".repeat(99)}\n`;
    for (let i = 0; i < 80; i++) {
      stream.write(line);
      // Let the stream rotate between writes.
      await new Promise((r) => setTimeout(r, 2));
    }
    await new Promise<void>((done) => stream.end(() => done()));
    const files = readdirSync(dir).sort();
    expect(files).toContain("svc.log");
    expect(files).toContain("svc.log.1");
    expect(files.filter((f) => f.startsWith("svc.log.")).length).toBeLessThanOrEqual(5);
    expect(fileTail(join(dir, "svc.log.1"), 2)).toHaveLength(2);
  });
});

describe("the repo's descriptors", () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

  function repoPlans(hostToml: string, env: Record<string, string> = {}) {
    const ws = workspace([]);
    writeIn(ws, "host.toml", hostToml);
    return planServices(loadCatalog(repo), loadHostConfig(ws.hostToml), {
      ...ctxFor(ws, { env, platform: "win32" }),
    });
  }

  it("runs core and stage in the workspace with the CLI's own entry", () => {
    const [core, stage] = repoPlans('name = "h"\n[services.core]\n[services.stage]\n');
    const ctx = ctxFor(workspace([]), { platform: "win32" });
    for (const plan of [core, stage]) {
      expect(plan?.disabled).toBeNull();
      const spec = expandService(plan as NonNullable<typeof plan>, ctx, live);
      expect(spec.cwd).toBe(ctx.workspace);
      expect(spec.file).toBe("node");
      expect(spec.args.slice(0, 3)).toEqual(["--import", "tsx", "/src/main.ts"]);
      expect(spec.args.slice(3, 4)).toEqual([plan?.name]);
    }
  });

  it("disables mediamtx without MIYORIA_HLS_SECRET and passes it under MediaMTX's name", () => {
    const toml = 'name = "h"\n[services.mediamtx]\n';
    expect(repoPlans(toml)[0]?.disabled).toMatch(/MIYORIA_HLS_SECRET/);
    const with_ = repoPlans(toml, { MIYORIA_HLS_SECRET: "s" });
    expect(with_[0]?.disabled).toBeNull();
  });
});
