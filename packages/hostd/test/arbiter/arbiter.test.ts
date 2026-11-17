// What the arbiter does that the recorded scenarios do not reach: a lease nobody renews, a
// share-only tenant, calls for an unknown lease, the busy poller's lifetime, tenants from
// descriptors, and its answers against the wire shapes.

import {
  HostGpuAcquireResultSchema,
  HostGpuAcquireSchema,
  HostGpuBusyResultSchema,
  HostGpuReleaseResultSchema,
  HostGpuRenewResultSchema,
  HostGpuStateSchema,
  type HostService,
  HostServiceSchema,
} from "@miyoria/contracts/host";
import { describe, expect, it } from "vitest";
import {
  Arbiter,
  holdersFrom,
  type PeerClient,
  type Tenant,
  tenantsFrom,
} from "../../src/arbiter/index.js";
import { Sim } from "./sim.js";

const tenant = (name: string): Tenant => ({
  name,
  url: `http://${name}`,
  offload: "/offload",
  reload: "/reload",
  busy: "/busy",
  health: "/health",
});

/** Speech services that answer at once and remember what they were asked. */
function speech(sim: Sim) {
  const calls: string[] = [];
  const offline = new Set<string>();
  const peers: PeerClient = {
    offload: async (t) => {
      calls.push(`${sim.now} offload ${t.name}`);
      offline.add(t.name);
      return { state: "offloaded", released_mb: 1000 };
    },
    reload: async (t) => {
      calls.push(`${sim.now} reload ${t.name}`);
      offline.delete(t.name);
      return { state: "ready" };
    },
    busy: async (t) => {
      calls.push(`${sim.now} busy ${t.name}`);
      return { busy: 0 };
    },
    health: async (t) => ({
      offloaded: offline.has(t.name),
      reason: offline.has(t.name) ? "sing" : null,
    }),
  };
  return { peers, calls, offline };
}

function setup(free = 1500) {
  const sim = new Sim();
  const s = speech(sim);
  const arbiter = new Arbiter({
    clock: sim.clock,
    timers: sim.timers,
    readDevice: async () => ({ cuda: true, total_mb: 12288, free_mb: free, name: "Card" }),
    peers: s.peers,
    tenants: [tenant("tts"), tenant("asr")],
    holders: ["sing"],
  });
  return { sim, arbiter, ...s };
}

/** Runs `fn` on the simulated clock until it returns, then `afterS` more. */
async function play(sim: Sim, fn: () => Promise<void>, afterS = 0): Promise<void> {
  let failure: unknown = null;
  sim.spawn(
    async () => {
      await fn();
      await sim.sleep(afterS);
      sim.stop();
    },
    (e) => {
      failure = e;
      sim.stop();
    },
  );
  await sim.run();
  if (failure !== null) throw failure;
}

const acquire = (over: Record<string, unknown> = {}) =>
  HostGpuAcquireSchema.parse({ job: "j1", stage: "convert", need_mb: {}, ...over });

describe("the arbiter", () => {
  it("takes speech offline only after the holder announced it, and answers in the wire shapes", async () => {
    const { sim, arbiter, calls } = setup();
    await play(sim, async () => {
      const first = HostGpuAcquireResultSchema.parse(await arbiter.acquire("sing", acquire()));
      expect(first).toMatchObject({
        type: "wait",
        code: "no_room",
        announce: true,
        evict: ["http://tts", "http://asr"],
      });
      expect(calls.filter((c) => !c.includes("busy"))).toEqual([]);
      const granted = HostGpuAcquireResultSchema.parse(
        await arbiter.acquire("sing", acquire({ announced: true })),
      );
      expect(granted).toMatchObject({
        type: "granted",
        mode: "exclusive",
        evicted: ["http://tts", "http://asr"],
        released_mb: 2000,
      });
      HostGpuRenewResultSchema.parse(
        await arbiter.renew({
          lease: "j1",
          own_mb: 0,
          queued: [],
          step: { recent_s: [1, 1, 1], normal_s: {} },
          end: null,
        }),
      );
      HostGpuBusyResultSchema.parse(arbiter.busy({ lease: "j1" }));
      HostGpuStateSchema.parse(arbiter.state());
      const released = HostGpuReleaseResultSchema.parse(
        await arbiter.release({ lease: "j1", window: "close", done: true }),
      );
      expect(released).toMatchObject({ reloaded: ["http://tts", "http://asr"], closed: true });
      // The real silence (offload asked to reload done) next to the work time the limit bounds;
      // no context and no `ack`: nobody listened, so no limit applied.
      expect(released.window).toEqual({
        offload_s: 0,
        work_s: 0,
        reload_s: 0,
        silence_s: 0,
        limit_s: null,
      });
      expect(released.summary?.windows).toEqual([released.window]);
      expect(released.summary?.decisions.map((d) => d.code)).toEqual(["no_room"]);
    });
    expect(calls.filter((c) => !c.includes("busy"))).toEqual([
      "0 offload tts",
      "0 offload asr",
      "0 reload tts",
      "0 reload asr",
    ]);
  });

  it("brings speech back when a holder stops renewing for longer than its lease", async () => {
    const { sim, arbiter, calls, offline } = setup();
    await play(
      sim,
      async () => {
        await arbiter.acquire("sing", acquire({ max_s: 30 }));
        await arbiter.acquire("sing", acquire({ max_s: 30, announced: true }));
      },
      45,
    );
    const work = calls.filter((c) => !c.includes("busy"));
    // The speech services' own lease is renewed every 20 s while the job's lease lives; at 30 s
    // without a word from the holder it is over.
    expect(work).toEqual([
      "0 offload tts",
      "0 offload asr",
      "20 offload tts",
      "20 offload asr",
      "30 reload tts",
      "30 reload asr",
    ]);
    expect(offline.size).toBe(0);
    expect(arbiter.state().jobs).toEqual([]);
  });

  it("brings speech back at once when the holder's process exits", async () => {
    const { sim, arbiter, calls } = setup();
    await play(sim, async () => {
      await arbiter.acquire("sing", acquire());
      await arbiter.acquire("sing", acquire({ announced: true }));
      await sim.sleep(5);
      await arbiter.holderGone("sing");
    });
    expect(calls.filter((c) => !c.includes("busy"))).toEqual([
      "0 offload tts",
      "0 offload asr",
      "5 reload tts",
      "5 reload asr",
    ]);
  });

  it("never takes speech offline for a share-only tenant", async () => {
    const { sim, arbiter } = setup();
    await play(sim, async () => {
      const r = await arbiter.acquire("comfyui", acquire({ mode: "share" }));
      expect(r).toMatchObject({ type: "wait", announce: false, evict: [] });
    });
  });

  it("answers calls for a lease it does not know", async () => {
    const { arbiter } = setup();
    expect(
      await arbiter.renew({ lease: "nope", own_mb: 0, queued: [], step: null, end: null }),
    ).toMatchObject({ ok: false });
    expect(await arbiter.release({ lease: "nope", window: "close", done: true })).toEqual({
      reloaded: [],
      errors: [],
      reload_s: null,
      closed: false,
      summary: null,
      window: null,
    });
  });

  it("asks speech whether it is busy only while a job holds a lease", async () => {
    const { sim, arbiter, calls } = setup(20000);
    await play(
      sim,
      async () => {
        await sim.sleep(1);
        expect(calls).toEqual([]);
        expect(await arbiter.acquire("sing", acquire())).toMatchObject({
          type: "granted",
          mode: "share",
        });
        await sim.sleep(0.25);
        expect(calls.filter((c) => c.includes("busy tts")).length).toBe(3); // at 1.0, 1.1, 1.2
        await arbiter.release({ lease: "j1", window: "close", done: true });
      },
      1,
    );
    expect(calls.filter((c) => c.includes("busy tts")).length).toBe(3);
  });

  it("reloads at start what a holder left offline for itself, and nothing else", async () => {
    const { arbiter, calls, offline } = setup();
    offline.add("tts");
    expect(await arbiter.recover()).toEqual(["http://tts"]);
    expect(calls).toEqual(["0 reload tts"]);
  });

  it("finds its tenants and holders in the descriptors", () => {
    const service = (name: string, gpu: Record<string, unknown>): HostService =>
      HostServiceSchema.parse({
        name,
        kind: "worker",
        run: { command: ["x"], port: 1, health: { http: "/healthz" } },
        gpu,
      });
    const running = [
      {
        service: service("tts", {
          policy: "evictable",
          offload: "/offload",
          reload: "/reload",
          busy: "/busy",
        }),
        url: "http://127.0.0.1:8002/",
      },
      { service: service("obs", { policy: "reserve" }), url: "http://127.0.0.1:4455" },
      { service: service("sing", { policy: "on_demand" }), url: "http://127.0.0.1:8005" },
      {
        service: service("asr", { policy: "evictable", offload: "/offload", reload: "/reload" }),
        url: "http://127.0.0.1:8003",
      },
    ];
    expect(tenantsFrom(running)).toEqual([
      {
        name: "tts",
        url: "http://127.0.0.1:8002",
        offload: "/offload",
        reload: "/reload",
        busy: "/busy",
        health: "/healthz",
      },
      {
        name: "asr",
        url: "http://127.0.0.1:8003",
        offload: "/offload",
        reload: "/reload",
        busy: "/busy",
        health: "/healthz",
      },
    ]);
    expect(holdersFrom(running)).toEqual(["sing"]);
  });
});
