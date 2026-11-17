// `GET /api/events`: the exact bytes the admin event stream writes for a bus envelope (the panel's
// event list and `miyoria tail` read them): `event: message`, the envelope's id, and the bus
// envelope itself (`BusEnvelopeSchema` in @miyoria/contracts/events) with every key present, in
// the schema's order.

import { Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import { type ContextKey, Events, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";

const TOKEN = "test-token";
const TEXT: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const T0 = Date.UTC(2026, 10, 15, 6, 0, 0, 123);

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
});

async function harness() {
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  return { sup, base };
}

/** Reads SSE frames (comments skipped) until `count` events have arrived. */
async function frames(body: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const out: string[] = [];
  try {
    while (out.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      for (let end = text.indexOf("\n\n"); end >= 0; end = text.indexOf("\n\n")) {
        const frame = text.slice(0, end + 2);
        text = text.slice(end + 2);
        if (!frame.startsWith(":")) out.push(frame);
      }
    }
  } finally {
    await reader.cancel();
  }
  return out;
}

/** The keys an envelope has besides its id, time, type, source and payload, all unset. */
const UNSET =
  '"session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":null,"scope":null';

describe("the admin event stream", () => {
  it("writes each bus envelope as it is, filtered by topic", async () => {
    const { sup, base } = await harness();
    const res = await fetch(`${base}/api/events?topics=platform.*,agent.turn.completed,stage.*`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    if (res.body === null) throw new Error("no body");
    const first = sup.bus.publish(
      "discord",
      Events.PlatformTyping,
      { context: TEXT, account: { platform: "discord", id: "100" } },
      { now: T0 },
    );
    const second = sup.bus.publish(
      "agent",
      Events.AgentTurnCompleted,
      { turn: "01JC0000000000000000000000", context: TEXT, text: '嗨\n"你好"' },
      { now: T0 + 1, turn: "01JC0000000000000000000000", parent: first.id },
    );
    // Not asked for: filtered out by the stream.
    sup.bus.publish("core", Events.SystemShutdown, {}, { now: T0 + 2 });
    const third = sup.bus.publish(
      "stage",
      Events.StageError,
      { message: "斷線" },
      { now: T0 + 3, turn: "01JC0000000000000000000000", parent: second.id },
    );
    const got = await frames(res.body, 3);
    const at = (ms: number) => toTimestamp(ms);
    expect(got).toEqual([
      `event: message\nid: ${first.id}\ndata: {"id":"${first.id}","at":"${at(T0)}","type":"platform.typing","v":1,"parent":null,"turn":null,${UNSET},"source":"discord","data":{"context":{"platform":"discord","scope":"g1","channel":"c1","kind":"channel"},"account":{"platform":"discord","id":"100"}}}\n\n`,
      `event: message\nid: ${second.id}\ndata: {"id":"${second.id}","at":"${at(T0 + 1)}","type":"agent.turn.completed","v":1,"parent":"${first.id}","turn":"01JC0000000000000000000000",${UNSET},"source":"agent","data":{"turn":"01JC0000000000000000000000","context":{"platform":"discord","scope":"g1","channel":"c1","kind":"channel"},"text":"嗨\\n\\"你好\\""}}\n\n`,
      `event: message\nid: ${third.id}\ndata: {"id":"${third.id}","at":"${at(T0 + 3)}","type":"stage.error","v":1,"parent":"${second.id}","turn":"01JC0000000000000000000000",${UNSET},"source":"stage","data":{"message":"斷線"}}\n\n`,
    ]);
  });
});
