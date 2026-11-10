// Module `live` on a real supervisor and bus: it serves the feed, writes pat Observations to the
// EventLog and nothing else, and publishes nothing.

import { EventBus, ServiceRegistry, Supervisor } from "@miyoria/kernel";
import { PeopleStoreKey } from "@miyoria/store";
import {
  type ContextKey,
  type Envelope,
  type EventLog,
  EventLogKey,
  type JsonObject,
  type LiveEvent,
  type LiveFeed,
  LiveFeedKey,
  ModerationKey,
  type NewLogEvent,
  type Observation,
  type ObserveOptions,
  SocialSignalsKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { LiveModule, PAT_WRITER } from "../src/index.js";

const OPEN: ContextKey = { platform: "discord", scope: "9", channel: "100", kind: "channel" };

let sup: Supervisor | null = null;
afterEach(async () => {
  await sup?.stopAll();
  sup = null;
});

async function boot(config: JsonObject) {
  const services = new ServiceRegistry();
  const observed: Array<{ observation: Observation; options: ObserveOptions | undefined }> = [];
  const log = {
    observe: (observation: Observation, options?: ObserveOptions) => {
      observed.push({ observation, options });
      return {} as never;
    },
    append: (_e: NewLogEvent) => ({}) as never,
  } as unknown as EventLog;
  services.provide("facts", EventLogKey, log);
  services.provide("moderation", ModerationKey, {
    screen: () => ({ ok: true, visible: null, voice: null, blocked: [] }),
  } as never);
  services.provide("social", SocialSignalsKey, { attitude: () => null });
  services.provide("store", PeopleStoreKey, {
    personByAccount: async () => null,
    all: async () => [],
  } as never);
  const bus = new EventBus();
  const published: Envelope[] = [];
  const all = bus.subscribe("*");
  void (async () => {
    for await (const env of all) published.push(env);
  })();
  sup = new Supervisor({ bus, services });
  await sup.register(new LiveModule({ names: ["Miyoria"] }), config, true);
  await sup.startAll();
  const feed = services.get(LiveFeedKey) as LiveFeed;
  return { bus, feed, observed, published };
}

describe("module live", () => {
  it("serves the feed: a line in a listed channel reaches a page", async () => {
    const { bus, feed } = await boot({ channels: ["100"] });
    const seen: LiveEvent[] = [];
    feed.follow((e) => seen.push(e));
    bus.publish("agent", { type: "agent_turn_started", data: { turn: "t", context: OPEN } });
    bus.publish("agent", {
      type: "agent_turn_completed",
      data: { turn: "t", context: OPEN, text: "大家晚安" },
    });
    await expect.poll(() => feed.snapshot().line?.text).toBe("大家晚安");
    expect(seen.some((e) => e.type === "line")).toBe(true);
  });

  it("keeps pats closed unless configured", async () => {
    const { feed } = await boot({});
    expect(feed.snapshot().pats.open).toBe(false);
    expect(await feed.pat({ account: { platform: "discord", id: "1" }, name: "x" })).toEqual({
      status: "closed",
    });
  });

  it("writes a batch of pats to her working context as data, and publishes nothing", async () => {
    const { feed, observed, published } = await boot({ pats: true, coalesce_secs: 2 });
    const outcome = await feed.pat({ account: { platform: "discord", id: "1" }, name: "Dave" });
    expect(outcome.status).toBe("ok");
    await expect.poll(() => observed.length, { timeout: 5_000 }).toBe(1);
    expect(observed[0]?.options?.buckets).toEqual([
      { op: "append-self", writer: PAT_WRITER, owner: "live", untrusted: true, max_entries: 3 },
    ]);
    expect(observed[0]?.observation.summary).toContain("1 個你不認識的人");
    expect(published.filter((e) => e.source === "live")).toEqual([]);
  });
});
