// The module on a real supervisor and store: it only listens, it survives a broken log, and a
// restart brings the projections and the open game back.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "@miyoria/kernel";
import { type EventLogStore, SqliteStore } from "@miyoria/store";
import {
  ActivityRecoveryKey,
  customEvent,
  DeliveryLedgerKey,
  EventLogKey,
  type JsonValue,
  type LogEvent,
  SYSTEM_SHUTDOWN_TOPIC,
  toTimestamp,
  WorkingContextKey,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observationBody, toReplayLines } from "../src/index.js";
import { FactsModule } from "../src/module.js";

const P = "miyoria";
const VOICE = { platform: "discord", scope: "g", channel: "v", kind: "voice" } as const;
const CONFIG = { flush_ms: 5, compact_every_mins: 0.001 };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "miyoria-facts-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(store: { events?: EventLogStore } | null, config: object = CONFIG) {
  const sup = new Supervisor();
  await sup.register(
    new FactsModule(store, P, { names: ["米優"] }),
    config as unknown as JsonValue,
    true,
  );
  await sup.startAll();
  return sup;
}

/** Lets the module's tasks run. */
const settle = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));

const session = (state: "started" | "stopped", extra: object = {}) =>
  customEvent("game.director.session", {
    state,
    game: "minecraft",
    game_name: "Minecraft",
    context: { ...VOICE },
    ...extra,
  });

function utterance(text: string, id: string) {
  const at = toTimestamp(Date.now());
  return {
    type: "voice_utterance" as const,
    data: {
      id,
      context: VOICE,
      speaker: {
        account: { platform: "discord", id: "100" },
        display_name: "Owen",
        is_bot: false,
      },
      text,
      language: null,
      emotion: null,
      audio_events: [],
      started_at: at,
      ended_at: at,
      asr_ms: 1,
    },
  };
}

describe("beside V2", () => {
  it("writes what goes over the bus to the store", async () => {
    const store = await SqliteStore.open(join(dir, "a.db"));
    const sup = await run(store);
    const env = sup.bus.publish("voice.link", utterance("大家好", "u1"));
    await settle();
    const event = await store.events.get(P, env.id);
    expect(event).toMatchObject({ kind: "observation", source: "voice.asr", person: "Owen" });
    await sup.stopAll();
    await store.close();
  });

  it("publishes nothing on the bus", async () => {
    const store = await SqliteStore.open(":memory:");
    const sup = await run(store);
    const seen: string[] = [];
    const sub = sup.bus.subscribe("*");
    sup.bus.publish("voice.link", utterance("嗨", "u1"));
    await settle();
    for (let env = sub.tryRecv(); env !== null; env = sub.tryRecv()) seen.push(env.source);
    expect(seen).toEqual(["voice.link"]);
    await sup.stopAll();
    await store.close();
  });

  it("works without an event log in the store", async () => {
    const sup = await run(null);
    sup.bus.publish("voice.link", utterance("嗨", "u1"));
    await settle();
    const log = sup.services.require(EventLogKey);
    expect((await log.query({ sources: ["voice.asr"] })).length).toBe(1);
    await sup.stopAll();
  });

  it("a store that fails costs nothing but the log", async () => {
    const store = await SqliteStore.open(":memory:");
    const failing: EventLogStore = Object.create(store.events);
    failing.append = () => Promise.reject(new Error("disk full"));
    const sup = await run({ events: failing });
    for (let i = 0; i < 50; i++) sup.bus.publish("voice.link", utterance(`第 ${i} 句`, `u${i}`));
    await settle(40);
    const status = sup.list().find((s) => s.id === "facts");
    expect(status?.state).toBe("running");
    const log = sup.services.require(EventLogKey);
    expect(log.recent(100).filter((e) => e.source === "voice.asr")).toHaveLength(50);
    await sup.stopAll();
    await store.close();
  });

  it("never waits for the store on the way in", async () => {
    const store = await SqliteStore.open(":memory:");
    const slow: EventLogStore = Object.create(store.events);
    let release = () => {};
    slow.append = () =>
      new Promise((resolve) => {
        release = () => resolve();
      });
    const sup = await run({ events: slow });
    sup.bus.publish("voice.link", utterance("一", "u1"));
    await settle();
    sup.bus.publish("voice.link", utterance("二", "u2"));
    await settle();
    const log = sup.services.require(EventLogKey);
    expect(log.recent(100).filter((e) => e.source === "voice.asr")).toHaveLength(2);
    release();
    await settle();
    release();
    await sup.stopAll();
    await store.close();
  });

  it("gets what is still in the queue into the store when it stops", async () => {
    const store = await SqliteStore.open(":memory:");
    const sup = await run(store, { flush_ms: 60_000 });
    const env = sup.bus.publish("voice.link", utterance("最後一句", "u1"));
    await sup.stopAll();
    expect(await store.events.get(P, env.id)).not.toBeNull();
    await store.close();
  });

  it("compacts on its own", async () => {
    const store = await SqliteStore.open(":memory:");
    const compact = vi.spyOn(store.events, "compact");
    const sup = await run(store);
    await vi.waitFor(() => expect(compact).toHaveBeenCalled());
    await sup.stopAll();
    await store.close();
  });

  it("reports a store that cannot be reached in its health", async () => {
    const store = await SqliteStore.open(":memory:");
    const failing: EventLogStore = Object.create(store.events);
    failing.append = () => Promise.reject(new Error("disk full"));
    const module = new FactsModule({ events: failing }, P);
    expect((await module.health()).status).toBe("healthy");
    const sup = new Supervisor();
    await sup.register(module, CONFIG as unknown as JsonValue, true);
    await sup.startAll();
    sup.bus.publish("voice.link", utterance("嗨", "u1"));
    await vi.waitFor(async () => expect((await module.health()).status).toBe("degraded"));
    await sup.stopAll();
    await store.close();
  });
});

describe("after a restart", () => {
  it("brings the ledger and Working Context back", async () => {
    const path = join(dir, "restart.db");
    let store = await SqliteStore.open(path);
    let sup = await run(store);
    const before = sup.services.require(DeliveryLedgerKey);
    const line = before.open({
      attention_key: "game:craft:stone_pickaxe",
      revision: 1,
      channel: "voice",
      context: VOICE,
      said: "石鎬好了",
    });
    before.ack(line);
    const lost = before.open({
      attention_key: "game:night_started",
      revision: 1,
      channel: "voice",
      context: VOICE,
      said: "天黑了",
    });
    sup.bus.publish("game", session("started"));
    await settle();
    // Killed: nothing stops in order, what was flushed is all there is.
    await sup.services.require(EventLogKey).flush();
    await sup.stopAll();
    await store.close();

    store = await SqliteStore.open(path);
    sup = await run(store);
    const ledger = sup.services.require(DeliveryLedgerKey);
    expect(ledger.delivered("game:craft:stone_pickaxe", 1)?.said).toBe("石鎬好了");
    expect(ledger.line(lost)).toMatchObject({ state: "failed", reason: "the core restarted" });
    expect(ledger.retryable().map((l) => l.line)).toEqual([lost]);
    // It was never stopped: she still knows it, from before this start.
    const context = sup.services.require(WorkingContextKey);
    expect(context.bucket("game.session")?.entries[0]).toMatchObject({
      text: "正在玩 Minecraft",
      restored: true,
    });
    await sup.stopAll();
    await store.close();
  });

  it("marks what it remembers as from before this start", async () => {
    const path = join(dir, "context.db");
    let store = await SqliteStore.open(path);
    const first = await run(store);
    const log = first.services.require(EventLogKey);
    log.observe(
      {
        source: "x",
        silent: true,
        salience: "ambient",
        attention_key: "x",
        revision: 1,
        summary: "舊的",
        addressed_to_her: false,
        from: null,
        context: null,
      },
      { buckets: [{ op: "replace-self", writer: "x", owner: null, untrusted: false }] },
    );
    await first.stopAll();
    await store.close();
    store = await SqliteStore.open(path);
    const sup = await run(store);
    const entry = sup.services.require(WorkingContextKey).bucket("x")?.entries[0];
    expect(entry).toMatchObject({ text: "舊的", restored: true });
    await sup.stopAll();
    await store.close();
  });

  it("finds the game a clean shutdown left open, but not one that was closed", async () => {
    const path = join(dir, "game.db");
    let store = await SqliteStore.open(path);
    let sup = await run(store);
    expect(sup.services.require(ActivityRecoveryKey).game()).toBeNull();
    sup.bus.publish("game", session("started"));
    await settle();
    // What `Core.stop` publishes, then the extension and the director going down.
    sup.bus.publish("kernel", customEvent(SYSTEM_SHUTDOWN_TOPIC, {}));
    sup.bus.publish("game", session("stopped", { code: "crashed", reason: "擴充套件停止了" }));
    sup.bus.publish("game", session("stopped"));
    await sup.stopAll();
    await store.close();

    store = await SqliteStore.open(path);
    sup = await run(store);
    expect(sup.services.require(ActivityRecoveryKey).game()).toMatchObject({
      game: "minecraft",
      name: "Minecraft",
      context: VOICE,
    });
    sup.bus.publish("game", session("started"));
    await settle();
    sup.bus.publish("game", session("stopped"));
    await settle();
    await sup.stopAll();
    await store.close();

    store = await SqliteStore.open(path);
    sup = await run(store);
    expect(sup.services.require(ActivityRecoveryKey).game()).toBeNull();
    await sup.stopAll();
    await store.close();
  });

  it("carries revisions on", async () => {
    const path = join(dir, "revisions.db");
    let store = await SqliteStore.open(path);
    let sup = await run(store);
    const craft = customEvent("game.minecraft.craft_finished", {
      type: "craft_finished",
      data: { item: "stone_pickaxe" },
    });
    sup.bus.publish("ext.minecraft", craft);
    await settle();
    await sup.stopAll();
    await store.close();
    store = await SqliteStore.open(path);
    sup = await run(store);
    sup.bus.publish("ext.minecraft", craft);
    await settle();
    const log = sup.services.require(EventLogKey);
    const seen = await log.query({ attention_key: "game:craft:stone_pickaxe", order: "asc" });
    const salience = seen.map((e: LogEvent) => observationBody(e)?.observation.salience);
    expect(salience).toEqual(["notable", "ambient"]);
    await sup.stopAll();
    await store.close();
  });
});

describe("for the replay", () => {
  it("gives the bus events back, in order", async () => {
    const store = await SqliteStore.open(":memory:");
    const sup = await run(store);
    const first = sup.bus.publish("voice.link", utterance("一", "u1"));
    sup.bus.publish("voice.link", utterance("二", "u2"));
    await settle();
    const log = sup.services.require(EventLogKey);
    const lines = toReplayLines(await log.query({ sources: ["voice.asr"] }));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ at: first.ts, source: "voice.link", event: first.event });
    await sup.stopAll();
    await store.close();
  });
});
