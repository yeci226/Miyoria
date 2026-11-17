// The GPU arbiter inside the daemon (H7): a fake card, fake speech services that speak the peer
// protocol and check their token, and a fake song worker as the holder. The arbiter's decisions
// themselves are proven in test/arbiter; this is the wiring around them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_ERROR_CODE,
  type HostClusterContext,
  type HostGpuAcquireResult,
  HostGpuAcquireResultSchema,
  type HostGpuReleaseResult,
  type HostGpuState,
  HostGpuStateSchema,
  type HostInfo,
  HostInfoSchema,
  type HostServiceList,
  type HostServiceStatus,
} from "@miyoria/contracts/host";
import { afterEach, describe, expect, it } from "vitest";
import type { Daemon, GpuSample, HostApi } from "../src/index.js";
import { cleanup, daemonFor, fake, until, workspace, writeIn } from "./fakes.js";

afterEach(cleanup);

const OP = { kind: "operator" } as const;
const CORE = { kind: "core" } as const;
const SING = { kind: "service", service: "sing" } as const;
const T = { timeout: 60_000 };

const EVICTABLE =
  '[gpu]\npolicy = "evictable"\noffload = "/offload"\nreload = "/reload"\nbusy = "/busy"';

/** TTS and ASR as evictable speech services, and the song worker as the holder. */
function services(singHost = "") {
  return [
    fake("tts", "speech.cjs", { tables: EVICTABLE }),
    fake("asr", "speech.cjs", { tables: EVICTABLE }),
    fake("sing", "health.cjs", {
      env: { SING_OFFLOAD_URLS: "{offload_urls}" },
      run: 'after = ["asr", "tts"]',
      tables: '[gpu]\npolicy = "on_demand"',
      host: singHost,
    }),
  ];
}

/** A 12 GB card whose free memory the test sets. */
function card(free: number) {
  const state = { free };
  const read = async (): Promise<GpuSample | null> => ({
    name: "Fake Card",
    total_mb: 12288,
    used_mb: 12288 - state.free,
    free_mb: state.free,
  });
  return { state, read };
}

async function list(daemon: Daemon): Promise<HostServiceStatus[]> {
  return ((await daemon.call("service.list", {}, OP)) as HostServiceList).services;
}

function running(daemon: Daemon, name: string): Promise<HostServiceStatus> {
  return until(
    async () => (await list(daemon)).find((s) => s.name === name && s.state === "running"),
    20_000,
    `${name} running`,
  );
}

async function envOf(daemon: Daemon, name: string): Promise<Record<string, string>> {
  const s = await running(daemon, name);
  return (await (await fetch(`http://127.0.0.1:${s.port}/env`)).json()) as Record<string, string>;
}

interface Call {
  path: string;
  body: unknown;
  auth: boolean;
  at: number;
}

async function callsOf(daemon: Daemon, name: string): Promise<Call[]> {
  const s = await running(daemon, name);
  return (await (await fetch(`http://127.0.0.1:${s.port}/calls`)).json()) as Call[];
}

async function rpc(port: number, token: string, method: string, params: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
}

async function startAll(daemon: Daemon): Promise<void> {
  await daemon.start();
  await daemon.startAll();
  for (const name of ["tts", "asr", "sing"]) await running(daemon, name);
}

async function gpuState(daemon: Daemon): Promise<HostGpuState> {
  return HostGpuStateSchema.parse(await daemon.call("gpu.state", {}, OP));
}

/** Takes the card for job `j1` with speech offline (announce, then announced). */
async function takeWindow(
  daemon: Daemon,
  meanwhile: () => void = () => {},
): Promise<HostGpuAcquireResult> {
  const first = HostGpuAcquireResultSchema.parse(
    await daemon.call("gpu.acquire", { job: "j1", stage: "convert" }, SING),
  );
  expect(first).toMatchObject({ type: "wait", code: "no_room", announce: true });
  const tts = await running(daemon, "tts");
  const asr = await running(daemon, "asr");
  expect(first.type === "wait" && first.evict).toEqual([
    `http://127.0.0.1:${tts.port}`,
    `http://127.0.0.1:${asr.port}`,
  ]);
  meanwhile();
  return HostGpuAcquireResultSchema.parse(
    await daemon.call("gpu.acquire", { job: "j1", stage: "convert", announced: true }, SING),
  );
}

describe("the switch in host.toml", () => {
  it(
    'arbiter = "worker" makes no arbiter and the song worker keeps its neighbours',
    T,
    async () => {
      const ws = workspace(services());
      const daemon = daemonFor(ws, { readGpu: card(10_000).read });
      await startAll(daemon);
      const env = await envOf(daemon, "sing");
      const tts = await running(daemon, "tts");
      const asr = await running(daemon, "asr");
      expect(env.SING_OFFLOAD_URLS).toBe(
        `http://127.0.0.1:${tts.port},http://127.0.0.1:${asr.port}`,
      );
      expect(env.SING_GPU_ARBITER).toBeUndefined();
      await expect(
        daemon.call("gpu.acquire", { job: "j1", stage: "convert" }, SING),
      ).rejects.toMatchObject({ code: HOST_ERROR_CODE.Unavailable });
      await expect(daemon.call("gpu.state", {}, OP)).rejects.toMatchObject({
        code: HOST_ERROR_CODE.Unavailable,
      });
      const info = HostInfoSchema.parse(await daemon.call("host.info", {}, OP));
      expect(info.arbiter).toEqual({ mode: "worker", active: false, leases: [], last: null });
    },
  );

  it(
    'arbiter = "hostd" switches the song worker over and grants the card through the local API',
    T,
    async () => {
      const ws = workspace(
        services('env = { SING_GPU_POLICY = "share", SING_GPU_CHECK_S = "0.5" }'),
        '[gpu]\narbiter = "hostd"',
      );
      const daemon = daemonFor(ws, { readGpu: card(10_000).read });
      await startAll(daemon);
      const env = await envOf(daemon, "sing");
      expect(env.SING_GPU_ARBITER).toBe("hostd");
      expect(env.SING_OFFLOAD_URLS).toBeUndefined();
      expect((await envOf(daemon, "tts")).SING_GPU_ARBITER).toBeUndefined();

      // The holder is who its token says, whatever it sends.
      const token = env.MIYORIA_SERVICE_TOKEN as string;
      const granted = await rpc(daemon.port, token, "gpu.acquire", {
        job: "j1",
        stage: "convert",
        holder: "someone-else",
      });
      expect(granted.error).toBeUndefined();
      expect(HostGpuAcquireResultSchema.parse(granted.result)).toMatchObject({
        type: "granted",
        mode: "share",
        lease: "j1",
        evicted: [],
      });
      const state = await gpuState(daemon);
      expect(state).toMatchObject({ policy: "share", policy_source: "SING_GPU_POLICY" });
      expect(state.jobs).toMatchObject([{ lease: "j1", holder: "sing", stage: "convert" }]);
      expect(state.total_mb).toBe(12288);
      expect(await daemon.call("gpu.state", {}, CORE)).toMatchObject({ policy: "share" });

      const info = HostInfoSchema.parse(await daemon.call("host.info", {}, OP));
      expect(info.gpu).toMatchObject({ name: "Fake Card", total_mb: 12288, free_mb: 10_000 });
      expect(info.arbiter).toMatchObject({
        mode: "hostd",
        active: true,
        policy: "share",
        leases: [{ lease: "j1", holder: "sing", mode: "share", code: "policy_share", evicted: [] }],
        last: { lease: "j1", mode: "share", code: "policy_share" },
      });
      expect(info.services.find((s) => s.name === "sing")?.gpu).toMatchObject({
        policy: "on_demand",
        leased: true,
      });

      const busy = await rpc(daemon.port, token, "gpu.busy", { lease: "j1" });
      expect(busy.result).toMatchObject({ busy: false });
      const released = await rpc(daemon.port, token, "gpu.release", { lease: "j1", done: true });
      expect((released.result as HostGpuReleaseResult).summary).toMatchObject({ policy: "share" });
      expect((await gpuState(daemon)).jobs).toEqual([]);
    },
  );
});

describe("who may call gpu.*", () => {
  it("only a holder service takes leases; the operator and Core read gpu.state", T, async () => {
    const ws = workspace(services(), '[gpu]\narbiter = "hostd"');
    const daemon = daemonFor(ws, { readGpu: card(10_000).read });
    await daemon.start();
    const tts = { kind: "service", service: "tts" } as const;
    for (const method of ["gpu.acquire", "gpu.renew", "gpu.release", "gpu.busy"]) {
      const params = { job: "j1", stage: "convert", lease: "j1" };
      await expect(daemon.call(method, params, OP)).rejects.toMatchObject({
        code: HOST_ERROR_CODE.NotAllowed,
      });
      await expect(daemon.call(method, params, CORE)).rejects.toMatchObject({
        code: HOST_ERROR_CODE.NotAllowed,
      });
      await expect(daemon.call(method, params, tts)).rejects.toMatchObject({
        code: HOST_ERROR_CODE.NotAllowed,
      });
    }
    await expect(daemon.call("gpu.state", {}, tts)).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
    });
    expect(HostGpuStateSchema.parse(await daemon.call("gpu.state", {}, CORE)).jobs).toEqual([]);
    await expect(daemon.call("gpu.acquire", { job: "" }, SING)).rejects.toMatchObject({
      code: -32602,
    });
    expect(await daemon.call("gpu.acquire", { job: "j1", stage: "convert" }, SING)).toMatchObject({
      type: "granted",
      mode: "share",
      code: "fits",
    });
  });

  it("a machine without a readable card has no arbiter and says why", T, async () => {
    const ws = workspace(services(), '[gpu]\narbiter = "hostd"');
    const daemon = daemonFor(ws, { readGpu: async () => null });
    await daemon.start();
    const error = await daemon
      .call("gpu.acquire", { job: "j1", stage: "convert" }, SING)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: HOST_ERROR_CODE.Unavailable });
    expect((error as Error).message).toMatch(/顯卡/);
    const info = (await daemon.call("host.info", {}, OP)) as HostInfo;
    expect(info.gpu).toBeNull();
    expect(info.arbiter).toMatchObject({ mode: "hostd", active: false, leases: [] });
    expect(info.arbiter?.reason).toMatch(/顯卡/);
    expect((await list(daemon)).map((s) => s.state)).toEqual(["stopped", "stopped", "stopped"]);
  });
});

describe("taking speech offline", () => {
  it(
    "announces, offloads TTS then ASR with their tokens, and reloads them on release",
    T,
    async () => {
      const ws = workspace(services(), '[gpu]\narbiter = "hostd"');
      const c = card(1500);
      const daemon = daemonFor(ws, { readGpu: c.read });
      await startAll(daemon);

      // Offloading frees 6200 MB on the card: learned in the profile file.
      const granted = await takeWindow(daemon, () => {
        c.state.free = 7700;
      });
      expect(granted).toMatchObject({ type: "granted", mode: "exclusive", errors: [] });
      expect(granted.type === "granted" && granted.evicted).toHaveLength(2);
      const info = HostInfoSchema.parse(await daemon.call("host.info", {}, OP));
      expect(info.arbiter?.leases).toMatchObject([
        { lease: "j1", holder: "sing", window: true, evicted: ["tts", "asr"] },
      ]);
      expect((await gpuState(daemon)).jobs[0]).toMatchObject({ window: true, eviction: "active" });

      const released = (await daemon.call(
        "gpu.release",
        { lease: "j1", window: "close", done: true },
        SING,
      )) as HostGpuReleaseResult;
      expect(released).toMatchObject({ closed: true, errors: [] });
      expect(released.reloaded).toHaveLength(2);

      const tts = await callsOf(daemon, "tts");
      const asr = await callsOf(daemon, "asr");
      for (const calls of [tts, asr]) {
        expect(calls.map((c) => [c.path, c.body, c.auth])).toEqual([
          ["/offload", { reason: "sing", max_s: 60 }, true],
          ["/reload", {}, true],
        ]);
      }
      const at = (calls: Call[], path: string) => calls.find((c) => c.path === path)?.at ?? 0;
      expect(at(tts, "/offload")).toBeLessThanOrEqual(at(asr, "/offload"));
      expect(at(asr, "/offload")).toBeLessThanOrEqual(at(tts, "/reload"));
      expect(at(tts, "/reload")).toBeLessThanOrEqual(at(asr, "/reload"));
      expect((await gpuState(daemon)).jobs).toEqual([]);
      const profile = JSON.parse(readFileSync(join(ws.state, "gpu-profile.json"), "utf8"));
      expect(profile.devices["Fake Card/12288"]).toMatchObject({ freed_mb: 6200 });
      expect(typeof profile.devices["Fake Card/12288"].reload_s).toBe("number");
    },
  );

  it("brings speech back at once when the holder's process exits mid-window", T, async () => {
    const ws = workspace(services(), '[gpu]\narbiter = "hostd"');
    const daemon = daemonFor(ws, { readGpu: card(1500).read });
    await startAll(daemon);
    expect(await takeWindow(daemon)).toMatchObject({ type: "granted", mode: "exclusive" });
    const pid = (await running(daemon, "sing")).pid as number;

    process.kill(pid);
    for (const name of ["tts", "asr"]) {
      await until(
        async () => (await callsOf(daemon, name)).some((c) => c.path === "/reload"),
        10_000,
        `${name} reloaded`,
      );
    }
    expect((await callsOf(daemon, "tts")).map((c) => c.path)).toEqual(["/offload", "/reload"]);
    expect((await gpuState(daemon)).jobs).toEqual([]);
    // It is restarted by its policy, and holds nothing.
    const again = await until(
      async () =>
        (await list(daemon)).find(
          (s) => s.name === "sing" && s.pid !== pid && s.state === "running",
        ),
      20_000,
      "sing restarted",
    );
    expect(again.gpu?.leased).toBe(false);
  });
});

describe("cluster.context", () => {
  it("reaches the arbiter through the control link", T, async () => {
    const ws = workspace(services(), '[gpu]\narbiter = "hostd"');
    writeIn(ws, "data/host/host.key", JSON.stringify({ id: "h1", key: "k1" }));
    writeIn(
      ws,
      "host.toml",
      [
        'name = "test-host"',
        "[cluster]",
        'url = "ws://core:7880/cluster-link"',
        "[gpu]",
        'arbiter = "hostd"',
        ...["tts", "asr", "sing"].map((n) => `[services.${n}]\nenabled = true`),
      ].join("\n"),
    );
    let api: HostApi | null = null;
    const daemon = daemonFor(ws, {
      readGpu: card(10_000).read,
      linkFactory: (a) => {
        api = a;
        return { state: "connected", start: () => {}, stop: async () => {} };
      },
    });
    await daemon.start();
    expect((await gpuState(daemon)).audience).toMatchObject({ age_s: null, fresh: false });
    const context: HostClusterContext = {
      in_voice: true,
      listeners: 2,
      live: false,
      urgent: ["j1"],
    };
    (api as unknown as HostApi).setContext?.(context);
    expect((await gpuState(daemon)).audience).toMatchObject({
      in_voice: true,
      listeners: 2,
      live: false,
      fresh: true,
    });
  });
});
