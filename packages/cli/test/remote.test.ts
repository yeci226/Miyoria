// `miyoria tail`'s client: the route table's typed client following `GET /api/events` on a real
// API module, reading the bus envelopes as the contract types them.

import { ActiveProfileKey, ApiModule } from "@miyoria/api";
import { Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import { type ContextKey, Events } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { rpcClient } from "../src/commands/remote.js";

const TOKEN = "test-token";
const TEXT: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
});

async function start() {
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  return { sup, rpc: rpcClient(base, TOKEN) };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(check()).toBe(true);
}

describe("the event stream through the typed client", () => {
  it("reads the bus envelopes of the topics asked for", async () => {
    const { sup, rpc } = await start();
    const before = sup.bus.subscriberCount;
    const stream = await rpc.events({ query: { topics: "platform.*" } });
    await until(() => sup.bus.subscriberCount === before + 1);
    sup.bus.publish("stage", Events.StageError, { message: "not asked for" });
    const typing = sup.bus.publish(
      "discord",
      Events.PlatformTyping,
      { context: TEXT, account: { platform: "discord", id: "100" } },
      { turn: "t1" },
    );
    const { value, done } = await stream.next();
    expect(done).toBe(false);
    expect(value).toEqual({
      id: typing.id,
      at: typing.at,
      type: "platform.typing",
      v: 1,
      parent: null,
      turn: "t1",
      session: null,
      space_id: null,
      room_id: null,
      person_id: null,
      account_id: null,
      key: null,
      scope: null,
      source: "discord",
      data: { context: TEXT, account: { platform: "discord", id: "100" } },
    });
    await stream.return();
    await until(() => sup.bus.subscriberCount === before);
  });

  it("ends the server's subscription when the signal aborts", async () => {
    const { sup, rpc } = await start();
    const before = sup.bus.subscriberCount;
    const controller = new AbortController();
    const stream = await rpc.events({ query: {} }, { signal: controller.signal });
    await until(() => sup.bus.subscriberCount === before + 1);
    const next = stream.next();
    controller.abort();
    await next.catch(() => undefined);
    await until(() => sup.bus.subscriberCount === before);
  });

  it("ends when the API module stops", async () => {
    const { sup, rpc } = await start();
    // A topic nobody publishes: the modules stopping say so on the bus.
    const stream = await rpc.events({ query: { topics: "test.nothing" } });
    const next = stream.next();
    await sup.stopAll();
    expect((await next).done).toBe(true);
  });
});
