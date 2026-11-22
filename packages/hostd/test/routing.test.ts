// What a host reports of a service's [routing] (v5-hostd §15): readiness with the reason, the
// variant hash, the owner's limits from host.toml that Core cannot change, and the load the
// service's health answer reports.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostServiceList, HostServiceStatus } from "@miyoria/contracts/host";
import { afterEach, describe, expect, it } from "vitest";
import type { Daemon } from "../src/index.js";
import { loadOf, VariantHasher } from "../src/routing.js";
import { cleanup, daemonFor, fake, TMP, until, workspace, writeIn } from "./fakes.js";

afterEach(cleanup);

const OP = { kind: "operator" } as const;
const T = { timeout: 40_000 };

async function one(daemon: Daemon, name: string): Promise<HostServiceStatus> {
  const { services } = (await daemon.call("service.list", {}, OP)) as HostServiceList;
  const found = services.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
}

describe("the load in a health answer", () => {
  it("reads running or busy, and queued; nothing when it says neither", () => {
    expect(loadOf({ status: "ok", busy: true, queued: 2 })).toEqual({ running: 1, queued: 2 });
    expect(loadOf({ status: "ok", busy: false })).toEqual({ running: 0, queued: 0 });
    expect(loadOf({ running: 3, queued: 0 })).toEqual({ running: 3, queued: 0 });
    expect(loadOf({ status: "ok" })).toBeNull();
    expect(loadOf({ queued: -1, busy: "yes" })).toBeNull();
    expect(loadOf(null)).toBeNull();
    expect(loadOf([1])).toBeNull();
  });
});

describe("the variant hash", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = () => {
    const d = join(TMP, `variant-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(d, "model"), { recursive: true });
    dirs.push(d);
    return d;
  };

  it("is the same for the same model and settings, and differs when either differs", () => {
    const a = dir();
    const b = dir();
    for (const d of [a, b]) {
      writeFileSync(join(d, "model", "voice.pth"), Buffer.alloc(3 * 1024 * 1024, 7));
      writeFileSync(join(d, "model", "voice.index"), "index");
    }
    const hasher = new VariantHasher();
    const env = [["SING_VOICE", "rvc"]] as const;
    const ha = hasher.hash(env, [join(a, "model")]);
    expect(hasher.hash(env, [join(b, "model")])).toBe(ha);
    expect(hasher.hash([["SING_VOICE", "seedvc"]], [join(a, "model")])).not.toBe(ha);
    // Another model of the same size: the sampled bytes differ.
    writeFileSync(join(b, "model", "voice.pth"), Buffer.alloc(3 * 1024 * 1024, 8));
    expect(new VariantHasher().hash(env, [join(b, "model")])).not.toBe(ha);
    // A missing file is a variant of its own, not an error.
    expect(hasher.hash(env, [join(a, "nothing")])).toMatch(/^[0-9a-f]{16}$/u);
  });
});

describe("a service's [routing] in the report", () => {
  it("says ready or why not, its variant, the owner's limits and its load", T, async () => {
    const ws = workspace([
      fake("a", "health.cjs", {
        env: { HEALTH_EXTRA: JSON.stringify({ busy: true, queued: 2 }) },
        tables: [
          "[routing]",
          'class = "job"',
          "concurrency = 3",
          "queue = true",
          'yields_to = ["tts"]',
          "[routing.needs]",
          'files = ["workers/a/weights.bin"]',
          "[routing.variant]",
          'env = ["FAKE_NAME"]',
        ].join("\n"),
        host: "accept = false\nconcurrency = 1",
      }),
    ]);
    const daemon = daemonFor(ws);
    await daemon.start();
    await daemon.call("service.start", { service: "a" }, OP);
    const status = await until(async () => {
      const s = await one(daemon, "a");
      return s.state === "running" && s.load !== undefined ? s : undefined;
    });
    expect(status.routing).toMatchObject({
      class: "job",
      latency: "interactive",
      concurrency: 1,
      owner_concurrency: 1,
      queue: true,
      yields_to: ["tts"],
      ready: false,
      reason: "缺少 workers/a/weights.bin",
      accept: false,
    });
    expect(status.routing?.variant).toMatch(/^[0-9a-f]{16}$/u);
    expect(status.load).toMatchObject({ running: 1, queued: 2 });
    expect(status.load?.outside).toBeUndefined();

    // The file appears: ready from the next report on, no restart.
    writeIn(ws, "workers/a/weights.bin", "w");
    const ready = await one(daemon, "a");
    expect(ready.routing?.ready).toBe(true);
    expect(ready.routing?.reason).toBeUndefined();
  });

  it("reports no routing and no load for a service without the table", T, async () => {
    const daemon = daemonFor(
      workspace([fake("b", "health.cjs", { env: { HEALTH_EXTRA: '{"busy":true}' } })]),
    );
    await daemon.start();
    await daemon.call("service.start", { service: "b" }, OP);
    const status = await until(async () => {
      const s = await one(daemon, "b");
      return s.state === "running" ? s : undefined;
    });
    expect(status.routing).toBeUndefined();
    expect(status.load).toBeUndefined();
  });

  it(
    "says a card too small is not ready, and does not hold back one it cannot read",
    T,
    async () => {
      const tables = ["[routing]", 'class = "job"', "[routing.needs]", "vram_gb = 8"].join("\n");
      const unread = daemonFor(workspace([fake("c", "health.cjs", { tables })]));
      await unread.start();
      expect((await one(unread, "c")).routing?.ready).toBe(true);
      const small = daemonFor(workspace([fake("c", "health.cjs", { tables })]), {
        readGpu: async () => ({ name: "small", total_mb: 6144, used_mb: 0 }),
      });
      await small.start();
      await small.call("host.info", {}, OP);
      expect((await one(small, "c")).routing).toMatchObject({
        ready: false,
        reason: "顯卡只有 6.0 GB,需要 8 GB",
      });
    },
  );
});
