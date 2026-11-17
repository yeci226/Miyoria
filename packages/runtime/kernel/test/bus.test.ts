import { type Envelope, Events, eventEnvelope, is, serviceKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  EventBus,
  exemptFromBusCheck,
  ServiceRegistry,
  ServiceUnavailableError,
  TopicFilter,
} from "../src/index.js";

// These tests publish made-up topics.
exemptFromBusCheck(["ext.custom.a", "ext.custom.b", "ext.x.1", "ext.x.2", "ext.y.1", "ext.t"]);

// A made-up topic is published under the extension namespace (`ext.**`).
const ext = (type: string) => ({ type });

describe("TopicFilter", () => {
  it("topic_filter", () => {
    const f = new TopicFilter(["platform.*", "agent.decision"]);
    expect(f.matches("platform.message.created")).toBe(true);
    expect(f.matches("agent.decision")).toBe(true);
    expect(f.matches("platformx.y")).toBe(false);
    expect(f.matches("platform")).toBe(false);
    expect(f.matches("agent.turn.started")).toBe(false);
    expect(TopicFilter.all().matches("anything")).toBe(true);
    expect(TopicFilter.from("voice.*").matches("voice.joined")).toBe(true);
  });
});

describe("EventBus", () => {
  it("subscription_filters", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe(new TopicFilter(["ext.custom.b"]));
    for (const topic of ["ext.custom.a", "ext.custom.b"]) {
      bus.publish("test", Events.ExtensionEvent, null, ext(topic));
    }
    const env = await sub.recv();
    expect(env).toMatchObject({ type: "ext.custom.b", data: null });
  });

  it("delivers in order to every subscriber, also to a waiting one", async () => {
    const bus = new EventBus();
    const a = bus.subscribe("*");
    const b = bus.subscribe(["ext.x.*"]);
    const waiting = b.recv();
    bus.publish("m", Events.ExtensionEvent, 1, ext("ext.x.1"));
    bus.publish("m", Events.ExtensionEvent, 2, {
      type: "ext.y.1",
      turn: "01JC0000000000000000000000",
    });
    bus.publish("m", Events.ExtensionEvent, 3, ext("ext.x.2"));
    expect((await waiting)?.type).toBe("ext.x.1");
    expect((await b.recv())?.type).toBe("ext.x.2");
    const seen = [];
    for (let i = 0; i < 3; i++) seen.push((await a.recv())?.turn);
    expect(seen).toEqual([null, "01JC0000000000000000000000", null]);
  });

  it("drops the oldest events of a lagging subscriber", async () => {
    const bus = new EventBus({ capacity: 2 });
    const sub = bus.subscribe("*");
    for (const n of [1, 2, 3]) bus.publish("m", Events.ExtensionEvent, n, ext("ext.t"));
    const first = await sub.recv();
    expect(first).toMatchObject({ type: "ext.t", data: 2 });
  });

  it("closing ends iteration; an aborted signal closes the subscription", async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const sub = bus.subscribe("*", { signal: controller.signal });
    const seen: unknown[] = [];
    const loop = (async () => {
      for await (const env of sub) seen.push(env.data);
    })();
    bus.publish("m", Events.ExtensionEvent, 1, ext("ext.t"));
    await Promise.resolve();
    controller.abort();
    await loop;
    expect(seen).toHaveLength(1);
    expect(await sub.recv()).toBeNull();
    expect(bus.subscriberCount).toBe(0);

    const late = bus.subscribe("*", { signal: controller.signal });
    expect(late.closed).toBe(true);
  });
});

describe("publishing by definition", () => {
  const context = { platform: "discord", scope: "g", channel: "c", kind: "channel" } as const;
  it("stamps the source, the turn and the parent, and hands the payload over as it is", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe(["stage.error", "worklane.task.*"]);
    const data = { message: "x" };
    const published = bus.publish("stage", Events.StageError, data, { turn: "t1", parent: "p1" });
    const viaPublisher = bus.publisher("worklane");
    const failed = {
      type: "failed" as const,
      task: "k1",
      code: "internal" as const,
      detail: "d",
      at: "2026-11-15T00:00:00.000Z",
    };
    viaPublisher(Events.TaskFailed, failed, { type: "worklane.task.failed" });
    const a = await sub.recv();
    const b = await sub.recv();
    expect(a).toBe(published);
    expect(a?.data).toBe(data);
    expect(a).toMatchObject({ type: "stage.error", source: "stage", turn: "t1", parent: "p1" });
    expect(b).toMatchObject({ type: "worklane.task.failed", source: "worklane", data: failed });
    expect(is(Events.TaskFailed, b as Envelope)).toBe(true);
    expect(is(Events.PlatformTyping, a as Envelope)).toBe(false);
  });

  it("delivers an envelope made elsewhere as it is", async () => {
    const bus = new EventBus();
    const sub = bus.subscribe("platform.typing");
    const envelope = eventEnvelope(
      "test",
      Events.PlatformTyping,
      { context, account: { platform: "discord", id: "1" } },
      { turn: "t" },
    );
    const delivered = bus.publishEnvelope(envelope);
    expect(delivered).toBe(envelope);
    expect(await sub.recv()).toBe(envelope);
  });
});

describe("ServiceRegistry", () => {
  interface Greeter {
    greet(): string;
  }
  const GreeterKey = serviceKey<Greeter>("Greeter");

  it("provide_get_remove", () => {
    const reg = new ServiceRegistry();
    expect(reg.get(GreeterKey)).toBeUndefined();
    reg.provide("m", GreeterKey, { greet: () => "hi" });
    expect(reg.require(GreeterKey).greet()).toBe("hi");
    expect(reg.ownerOf(GreeterKey)).toBe("m");
    reg.removeOwnedBy("m");
    expect(reg.get(GreeterKey)).toBeUndefined();
    expect(() => reg.require(GreeterKey)).toThrow(ServiceUnavailableError);
    expect(() => reg.require(GreeterKey)).toThrow("service `Greeter` is not available");
  });
});
