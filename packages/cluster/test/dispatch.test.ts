// Routing classes and job dispatch (docs/design/v5-hostd.md §15), on the registry fed directly
// with an injected clock: `single` conflicts, `session` stickiness, the score of `job` work (queue,
// speed, transfer, penalties), units sent together, reservations, unknown load, variants, the
// speech-host rule, the owner's controls, the host owner's limits, and the estimates kept across a
// restart. Hosts that report no routing keep the order of before.

import type { HostServiceRouting, HostServiceStatus } from "@miyoria/contracts/host";
import { describe, expect, it } from "vitest";
import {
  type ClusterActivity,
  EndpointRegistry,
  type EndpointRegistryOptions,
  memoryEstimateStore,
  RoutingConfigSchema,
} from "../src/index.js";
import { report, service } from "./helpers.js";

const T0 = 1_000_000_000;
const MB = 1024 * 1024;

function routing(fields: Partial<HostServiceRouting> = {}): HostServiceRouting {
  return {
    class: "job",
    latency: "batch",
    concurrency: 1,
    queue: true,
    yields_to: [],
    ready: true,
    accept: true,
    unit_s: 100,
    ...fields,
  };
}

/** A song worker as a new hostd reports it. */
function sing(
  host: string,
  load: { running: number; queued: number } | null,
  fields: Partial<HostServiceStatus> = {},
  route: Partial<HostServiceRouting> = {},
): HostServiceStatus {
  return service({
    name: "sing",
    url: `http://${host}:8005`,
    routing: routing(route),
    ...(load === null ? {} : { load: { ...load, age_ms: 0 } }),
    ...fields,
  });
}

function setup(
  options: Omit<EndpointRegistryOptions, "routing" | "clock"> & {
    routing?: Record<string, unknown>;
    activity?: () => ClusterActivity;
  } = {},
) {
  const clock = { t: T0 };
  const warnings: Array<{ fields: object; message: string }> = [];
  const reg = new EndpointRegistry({
    ...options,
    clock: { now: () => clock.t },
    routing: RoutingConfigSchema.parse(options.routing ?? {}),
    log: { warn: (fields, message) => warnings.push({ fields, message }) },
  });
  const host = (name: string, services: HostServiceStatus[], approved = ["sing", "tts", "asr"]) => {
    reg.setHost(name, approved);
    reg.report(name, report(services, name));
  };
  const order = (capability = "sing", o: { all?: boolean } = {}) =>
    reg.candidates(capability, o).map((e) => e.host);
  return { reg, clock, host, order, warnings };
}

describe("a capability no host declares a class for", () => {
  it("keeps the order of before: healthy, order, names, static entries last", () => {
    const { reg, order } = setup({
      order: { sing: ["b"] },
      static: { legacy: { provides: ["sing"], url: "http://legacy:8005" } },
    });
    for (const name of ["a", "b"]) {
      reg.setHost(name, ["sing"]);
      reg.report(name, report([service({ name: "sing", url: `http://${name}:8005` })], name));
    }
    expect(order()).toEqual(["b", "a", "legacy"]);
    expect(reg.routingView().find((c) => c.capability === "sing")?.class).toBeNull();
  });

  it("takes the routing of the hosts that declare it, and an older hostd's endpoint as unknown load", () => {
    const { reg, host, order } = setup();
    host("new", [sing("new", { running: 0, queued: 0 })]);
    // An older hostd: no routing, no load.
    reg.setHost("old", ["sing"]);
    reg.report("old", report([service({ name: "sing", url: "http://old:8005" })], "old"));
    expect(order()).toEqual(["new", "old"]);
    const view = reg.routingView().find((c) => c.capability === "sing");
    expect(view?.class).toBe("job");
    expect(view?.endpoints.find((e) => e.host === "old")?.parts?.penalties).toContain(
      "不知道它忙不忙",
    );
  });
});

describe("single", () => {
  it("uses only the instance that was there first and reports the other as a conflict", () => {
    const { reg, clock, warnings } = setup();
    const node = (host: string) =>
      service({
        name: "voice-node",
        provides: ["voice-room"],
        url: `http://${host}:1`,
        routing: routing({ class: "single", latency: "realtime" }),
      });
    reg.setHost("main", ["voice-room"]);
    reg.report("main", report([node("main")], "main"));
    clock.t += 1000;
    reg.setHost("second", ["voice-room"]);
    reg.report("second", report([node("second")], "second"));
    expect(reg.candidates("voice-room").map((e) => e.host)).toEqual(["main"]);
    expect(reg.pick("voice-room")?.host).toBe("main");
    expect(reg.candidates("voice-room", { all: true }).map((e) => e.host)).toEqual([
      "main",
      "second",
    ]);
    const view = reg.routingView().find((c) => c.capability === "voice-room");
    expect(view?.conflict).toEqual({ used: "main/voice-node", others: ["second/voice-node"] });
    // Logged once, not on every question.
    reg.candidates("voice-room");
    expect(warnings.filter((w) => w.message.includes("single"))).toHaveLength(1);
    // The first goes: the other is the one now, and no conflict is left.
    reg.removeHost("main");
    expect(reg.pick("voice-room")?.host).toBe("second");
    expect(reg.routingView().find((c) => c.capability === "voice-room")?.conflict).toBeNull();
  });
});

describe("session", () => {
  const tts = (host: string) =>
    service({
      name: "tts",
      url: `http://${host}:8002`,
      routing: routing({ class: "session", latency: "realtime", queue: false }),
    });

  it("starts on the nearest host, stays there, and moves only for the next session", () => {
    const { reg, host } = setup({ order: { tts: ["far"] } });
    host("far", [tts("far")]);
    host("near", [tts("near")]);
    reg.setLink("far", { local: false, rttMs: 40 });
    reg.setLink("near", { local: true });
    // `candidates` keeps the order of before for a session capability.
    expect(reg.candidates("tts").map((e) => e.host)).toEqual(["far", "near"]);
    // A realtime session starts on Core's own machine, whatever `order` says.
    expect(reg.openSession("tts", "call-1")?.host).toBe("near");
    expect(reg.session("tts", "call-1")?.host).toBe("near");
    reg.setLink("far", { local: true });
    expect(reg.session("tts", "call-1")?.host).toBe("near");
    expect(reg.routingView().find((c) => c.capability === "tts")?.sessions).toEqual([
      expect.objectContaining({ key: "call-1", host: "near", service: "tts" }),
    ]);
    // Its host goes: the session is over there; the next one starts elsewhere.
    reg.removeHost("near");
    expect(reg.session("tts", "call-1")).toBeNull();
    expect(reg.openSession("tts", "call-2")?.host).toBe("far");
    reg.closeSession("tts", "call-2");
    expect(reg.session("tts", "call-2")).toBeNull();
  });

  it("prefers the lowest round trip when no host is Core's", () => {
    const { reg, host } = setup();
    host("a", [tts("a")]);
    host("b", [tts("b")]);
    reg.setLink("a", { rttMs: 90 });
    reg.setLink("b", { rttMs: 12 });
    expect(reg.openSession("tts", "x")?.host).toBe("b");
  });
});

describe("job: the score", () => {
  it("sends a unit where the queue is shorter", () => {
    const { host, order } = setup();
    host("busy", [sing("busy", { running: 1, queued: 1 })]);
    host("idle", [sing("idle", { running: 0, queued: 0 })]);
    expect(order()).toEqual(["idle", "busy"]);
  });

  it("weighs a host's measured speed against its queue", () => {
    const store = memoryEstimateStore();
    const { reg, host, order } = setup({ estimates: store });
    host("fast", [sing("fast", { running: 1, queued: 0 })]);
    host("slow", [sing("slow", { running: 0, queued: 0 })]);
    // Learn: a unit takes 30 s on `fast` and 400 s on `slow`.
    for (const [name, ms] of [
      ["fast", 30_000],
      ["slow", 400_000],
    ] as const) {
      const ep = reg.candidates("sing", { all: true }).find((e) => e.host === name);
      reg.reserve(ep as NonNullable<typeof ep>).done({ run_ms: ms });
    }
    // fast: 30 s waiting + 30 s running; slow: 0 + 400 s.
    expect(order()).toEqual(["fast", "slow"]);
    const view = reg.routingView().find((c) => c.capability === "sing");
    expect(view?.endpoints.find((e) => e.host === "fast")?.score_s).toBeCloseTo(60, 0);
  });

  it("counts the transfer of the results back to Core", () => {
    const store = memoryEstimateStore([
      {
        host: "near",
        capability: "sing",
        unit_ms: 100_000,
        unit_n: 1,
        rate_bps: 100 * MB,
        rate_n: 1,
        size_bytes: null,
        size_n: 0,
        updated_at: 0,
      },
      {
        host: "far",
        capability: "sing",
        unit_ms: 90_000,
        unit_n: 1,
        rate_bps: 0.5 * MB,
        rate_n: 1,
        size_bytes: null,
        size_n: 0,
        updated_at: 0,
      },
    ]);
    const { host, order } = setup({ estimates: store });
    host("near", [sing("near", { running: 0, queued: 0 }, {}, { result_mb: 90 })]);
    host("far", [sing("far", { running: 0, queued: 0 }, {}, { result_mb: 90 })]);
    // far runs 10 s quicker but 90 MB at 0.5 MB/s take 180 s.
    expect(order()).toEqual(["near", "far"]);
  });

  it("puts a resting host, one held up from outside, and one further down `order` behind", () => {
    const { reg, host, order } = setup({ order: { sing: ["first", "second"] } });
    host("first", [sing("first", { running: 0, queued: 0 })]);
    host("second", [sing("second", { running: 0, queued: 0 })]);
    expect(order()).toEqual(["first", "second"]);
    reg.failed(reg.pick("sing") as NonNullable<ReturnType<typeof reg.pick>>);
    expect(order()).toEqual(["second", "first"]);
    // A caller with failover of its own ranks without the rest penalty.
    expect(reg.candidates("sing", { ignoreResting: true }).map((e) => e.host)).toEqual([
      "first",
      "second",
    ]);
    host("second", [
      service({
        ...sing("second", null),
        load: { running: 0, queued: 0, age_ms: 0, outside: "comfyui 正在用顯卡(gen)" },
      }),
    ]);
    const second = reg.routingView()[0]?.endpoints.find((e) => e.host === "second");
    expect(second?.parts?.penalties).toEqual(["comfyui 正在用顯卡(gen)", "order 第 2 位"]);
  });

  it("ranks a host with unknown load after one known to be idle, before one known to be busy", () => {
    const { host, order } = setup();
    host("idle", [sing("idle", { running: 0, queued: 0 })]);
    host("unknown", [sing("unknown", null)]);
    host("busy", [sing("busy", { running: 1, queued: 3 })]);
    expect(order()).toEqual(["idle", "unknown", "busy"]);
  });

  it("puts unhealthy endpoints last whatever their score", () => {
    const { host, order } = setup();
    host("sick", [sing("sick", { running: 0, queued: 0 }, { healthy: false })]);
    host("busy", [sing("busy", { running: 2, queued: 2 })]);
    expect(order()).toEqual(["busy", "sick"]);
  });

  it("divides a score by the host's weight", () => {
    const { host, order } = setup({ routing: { weights: { big: 3 } } });
    host("big", [sing("big", { running: 1, queued: 0 })]);
    host("small", [sing("small", { running: 0, queued: 0 })]);
    // big: (100 + 100) / 3 < small: 100.
    expect(order()).toEqual(["big", "small"]);
  });
});

describe("job: units sent together", () => {
  it("spreads two units over two idle hosts before either reports", () => {
    const { reg, host } = setup();
    host("a", [sing("a", { running: 0, queued: 0 })]);
    host("b", [sing("b", { running: 0, queued: 0 })]);
    const first = reg.pick("sing");
    expect(first?.host).toBe("a");
    reg.reserve(first as NonNullable<typeof first>, { what: "song one" });
    const second = reg.pick("sing");
    expect(second?.host).toBe("b");
    reg.reserve(second as NonNullable<typeof second>);
    // The decision of each, with the scores it saw.
    const decisions = reg.routingView()[0]?.decisions ?? [];
    expect(decisions.map((d) => d.host)).toEqual(["b", "a"]);
    expect(decisions[1]).toMatchObject({ what: "song one" });
    expect(decisions[0]?.scores.map((s) => s.host)).toEqual(["b", "a"]);
  });

  it("forgets a reservation once a report shows the unit, or when it expires", () => {
    const { reg, clock, host, order } = setup({ routing: { reserve_secs: 30 } });
    host("a", [sing("a", { running: 0, queued: 0 })]);
    host("b", [sing("b", { running: 0, queued: 0 })]);
    const unit = reg.reserve(reg.pick("sing") as NonNullable<ReturnType<typeof reg.pick>>);
    unit.accepted();
    expect(order()).toEqual(["b", "a"]);
    // A reading taken after it was accepted counts it itself: not twice.
    clock.t += 1000;
    host("a", [sing("a", { running: 1, queued: 0 })]);
    const a = reg.routingView()[0]?.endpoints.find((e) => e.host === "a");
    expect(a?.pending).toBe(0);
    expect(a?.load?.running).toBe(1);
    // Without a report it counts until `reserve_secs` pass.
    const other = reg.reserve(reg.candidates("sing").find((e) => e.host === "b") as never);
    expect(reg.routingView()[0]?.endpoints.find((e) => e.host === "b")?.pending).toBe(1);
    clock.t += 31_000;
    expect(reg.routingView()[0]?.endpoints.find((e) => e.host === "b")?.pending).toBe(0);
    other.done({ ok: false });
  });

  it("holds a unit on a host that reports no load until it is done", () => {
    const { reg, clock, host } = setup({ routing: { reserve_secs: 30 } });
    host("old", [sing("old", null)]);
    const unit = reg.reserve(reg.pick("sing") as NonNullable<ReturnType<typeof reg.pick>>);
    clock.t += 600_000;
    expect(reg.routingView()[0]?.endpoints[0]?.pending).toBe(1);
    unit.done({ run_ms: 500_000 });
    expect(reg.routingView()[0]?.endpoints[0]?.pending).toBe(0);
    expect(reg.estimates()).toEqual([
      expect.objectContaining({ host: "old", capability: "sing", unit_ms: 500_000 }),
    ]);
  });
});

describe("job: who takes no new work", () => {
  it("leaves out another variant, a host not ready, and one whose owner said accept = false", () => {
    const { reg, host, order } = setup();
    host("a", [sing("a", { running: 0, queued: 0 }, {}, { variant: "v1" })]);
    host("b", [sing("b", { running: 0, queued: 0 }, {}, { variant: "v1" })]);
    host("odd", [sing("odd", { running: 0, queued: 0 }, {}, { variant: "v2" })]);
    host("unready", [
      sing("unready", { running: 0, queued: 0 }, {}, { ready: false, reason: "缺少 x" }),
    ]);
    host("closed", [sing("closed", { running: 0, queued: 0 }, {}, { accept: false })]);
    expect(order()).toEqual(["a", "b"]);
    // Still listed for work it holds already, last.
    expect(order("sing", { all: true }).slice(2).sort()).toEqual(["closed", "odd", "unready"]);
    const view = reg.routingView()[0];
    expect(view?.variant).toBe("v1");
    const why = (h: string) => view?.endpoints.find((e) => e.host === h)?.reason;
    expect(why("odd")).toMatch(/v2/);
    expect(why("unready")).toBe("缺少 x");
    expect(why("closed")).toMatch(/accept = false/);
  });

  it("uses the configured variant over the majority", () => {
    const { host, order } = setup({ routing: { capabilities: { sing: { variant: "v2" } } } });
    host("a", [sing("a", { running: 0, queued: 0 }, {}, { variant: "v1" })]);
    host("b", [sing("b", { running: 0, queued: 0 }, {}, { variant: "v1" })]);
    host("c", [sing("c", { running: 0, queued: 0 }, {}, { variant: "v2" })]);
    expect(order()).toEqual(["c"]);
  });

  it("takes the host owner's concurrency into the wait", () => {
    const { host, order } = setup();
    // Two at once there, one running: the next waits half a unit.
    host("wide", [sing("wide", { running: 1, queued: 0 }, {}, { concurrency: 2 })]);
    host("narrow", [sing("narrow", { running: 1, queued: 0 }, {}, { concurrency: 1, unit_s: 80 })]);
    expect(order()).toEqual(["wide", "narrow"]);
  });

  it("follows the owner's pin, exclusion and drain, from the config and the panel", () => {
    const { reg, host, order } = setup({
      routing: { capabilities: { sing: { exclude: ["c"] } }, drain: ["d"] },
    });
    for (const h of ["a", "b", "c", "d"]) host(h, [sing(h, { running: 0, queued: 0 })]);
    expect(order()).toEqual(["a", "b"]);
    reg.setPanelControls({ pins: { sing: "b" }, excludes: {}, weights: {}, drained: [] });
    expect(order()).toEqual(["b"]);
    reg.setPanelControls({ pins: {}, excludes: { sing: ["a"] }, weights: {}, drained: ["b"] });
    expect(order()).toEqual([]);
    expect(reg.pick("sing")).toBeNull();
    const hosts = reg.hostRouting();
    expect(hosts.find((h) => h.host === "b")?.drained).toBe("擁有者在面板設定清空");
    expect(hosts.find((h) => h.host === "d")?.drained).toBe("設定檔設定清空");
  });

  it("drains a host while its remote update runs", () => {
    const { reg, host, order } = setup();
    host("a", [sing("a", { running: 0, queued: 0 })]);
    host("b", [sing("b", { running: 0, queued: 0 })]);
    const updating = {
      ...report([sing("a", { running: 1, queued: 0 })], "a"),
      upgrade: {
        id: "u1",
        target: "a".repeat(40),
        from: "b".repeat(40),
        state: "waiting" as const,
        step: "wait" as const,
        steps: [],
        started_at: 1,
      },
    };
    reg.report("a", updating);
    expect(order()).toEqual(["b"]);
    expect(reg.hostRouting().find((h) => h.host === "a")?.drained).toBe("正在更新,不接新工作");
    reg.report("a", {
      ...updating,
      upgrade: { ...updating.upgrade, state: "done", finished_at: 2 },
    });
    // Back to work: still behind `b`, which is idle while `a` runs one.
    expect(order()).toEqual(["b", "a"]);
  });
});

describe("job: Core's speech host", () => {
  const voiceHost = (name: string) => [
    sing(name, { running: 0, queued: 0 }, {}, { yields_to: ["tts", "asr"] }),
    service({
      name: "tts",
      url: `http://${name}:8002`,
      routing: routing({ class: "session", latency: "realtime", queue: false }),
    }),
  ];

  function speech(mode: string, activity: ClusterActivity) {
    const now = { activity };
    const s = setup({
      routing: { allow_on_speech_host: mode, idle_minutes: 10 },
      activity: () => now.activity,
    });
    s.host("main", voiceHost("main"));
    s.host("friend", [
      sing("friend", { running: 2, queued: 2 }, {}, { yields_to: ["tts", "asr"] }),
    ]);
    return { ...s, now };
  }

  const quiet = { in_voice: false, live: false, last_spoke_at: null };

  it("never: the host whose tts carries her voice gets no job, however idle", () => {
    const { reg, order } = speech("never", quiet);
    expect(order()).toEqual(["friend"]);
    const main = reg
      .routingView()
      .find((c) => c.capability === "sing")
      ?.endpoints.find((e) => e.host === "main");
    expect(main?.speech).toBe(true);
    expect(main?.reason).toMatch(/她的語音\(tts\)在這台/);
  });

  it("when_idle: only while she is not in voice, not live and nobody spoke lately", () => {
    const { order, now, clock } = speech("when_idle", quiet);
    expect(order()).toEqual(["main", "friend"]);
    now.activity = { ...quiet, in_voice: true };
    expect(order()).toEqual(["friend"]);
    now.activity = { ...quiet, live: true };
    expect(order()).toEqual(["friend"]);
    now.activity = { ...quiet, last_spoke_at: clock.t - 5 * 60_000 };
    expect(order()).toEqual(["friend"]);
    now.activity = { ...quiet, last_spoke_at: clock.t - 11 * 60_000 };
    expect(order()).toEqual(["main", "friend"]);
  });

  it("always: allowed, with the penalty while she is active", () => {
    const { order, now } = speech("always", quiet);
    expect(order()).toEqual(["main", "friend"]);
    now.activity = { ...quiet, in_voice: true };
    // friend: 4 ahead × 100 s + 100 s = 500 s; main: 100 s + 900 s.
    expect(order()).toEqual(["friend", "main"]);
  });

  it("does not let a host kept out for her voice decide the variant", () => {
    const s = setup();
    s.host("main", [
      sing("main", { running: 0, queued: 0 }, {}, { yields_to: ["tts", "asr"], variant: "owner" }),
      service({
        name: "tts",
        url: "http://main:8002",
        routing: routing({ class: "session", latency: "realtime", queue: false }),
      }),
    ]);
    s.host("friend", [
      sing(
        "friend",
        { running: 0, queued: 0 },
        {},
        { yields_to: ["tts", "asr"], variant: "friend" },
      ),
    ]);
    expect(s.order()).toEqual(["friend"]);
    expect(s.reg.routingView().find((c) => c.capability === "sing")?.variant).toBe("friend");
  });

  it("keeps a song from a config address on Core's own machine when her voice is there", () => {
    const s = setup({
      static: { "sing.fallback.1": { provides: ["sing"], url: "http://127.0.0.1:8005" } },
    });
    s.host("main", [
      service({
        name: "tts",
        url: "http://127.0.0.1:8002",
        routing: routing({ class: "session", latency: "realtime", queue: false }),
      }),
    ]);
    s.reg.setLink("main", { local: true });
    s.host("friend", [
      sing("friend", { running: 0, queued: 0 }, {}, { yields_to: ["tts", "asr"] }),
    ]);
    expect(s.order()).toEqual(["friend"]);
    expect(s.order("sing", { all: true })).toEqual(["friend", "sing.fallback.1"]);
  });

  it("is per capability, and only a host whose such service is the one in use counts", () => {
    const s = setup({
      routing: { capabilities: { sing: { allow_on_speech_host: "always" } } },
      order: { tts: ["other"] },
    });
    s.host("main", voiceHost("main"));
    expect(s.order()).toEqual(["main"]);
    // Her tts runs on `other` now: `main` does not carry her voice any more.
    const s2 = setup({ order: { tts: ["other"] } });
    s2.host("main", voiceHost("main"));
    s2.host("other", [
      service({
        name: "tts",
        url: "http://other:8002",
        routing: routing({ class: "session", latency: "realtime", queue: false }),
      }),
    ]);
    expect(s2.order()).toEqual(["main"]);
  });
});

describe("estimates", () => {
  it("are kept across a restart, and a large answer is a sample of the transfer rate", async () => {
    const store = memoryEstimateStore();
    const clock = { t: T0 };
    const body = new Uint8Array(4 * MB);
    const fetcher: typeof fetch = async () => {
      clock.t += 2000;
      return new Response(body);
    };
    const first = new EndpointRegistry({
      clock: { now: () => clock.t },
      estimates: store,
      fetch: fetcher,
    });
    first.setHost("a", ["sing"]);
    first.report("a", report([sing("a", { running: 0, queued: 0 })], "a"));
    const ep = first.pick("sing") as NonNullable<ReturnType<typeof first.pick>>;
    first.reserve(ep).done({ run_ms: 120_000, bytes: 80 * MB });
    const res = await first.request(ep, "/songs/x/files/a");
    clock.t += 2000;
    expect((await res.arrayBuffer()).byteLength).toBe(4 * MB);
    const row = first.estimates().find((r) => r.host === "a");
    expect(row?.unit_ms).toBe(120_000);
    expect(row?.rate_bps).toBeCloseTo((4 * MB) / 2, -3);

    // A new registry over the same store knows them.
    const second = new EndpointRegistry({ clock: { now: () => clock.t }, estimates: store });
    second.setHost("a", ["sing"]);
    second.report("a", report([sing("a", { running: 0, queued: 0 })], "a"));
    const view = second.routingView()[0];
    expect(view?.endpoints[0]?.estimate).toMatchObject({ unit_s: 120, units: 1, transfers: 1 });
    expect(view?.result_mb).toBeCloseTo(80, 5);
  });

  it("decay towards new samples", () => {
    const { reg, host } = setup();
    host("a", [sing("a", { running: 0, queued: 0 })]);
    const ep = reg.pick("sing") as NonNullable<ReturnType<typeof reg.pick>>;
    reg.reserve(ep).done({ run_ms: 100_000 });
    reg.reserve(ep).done({ run_ms: 200_000 });
    expect(reg.estimates()[0]?.unit_ms).toBeCloseTo(130_000, 0);
    // A failed unit teaches nothing.
    reg.reserve(ep).done({ ok: false, run_ms: 1 });
    expect(reg.estimates()[0]?.unit_n).toBe(2);
  });
});
