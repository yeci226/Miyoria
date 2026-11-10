// `GET /api/facts/*` against a real EventLog.

import { DeliveryLedgerView, EventLogService, WorkingContextView } from "@miyoria/facts";
import { Supervisor, SupervisorKey } from "@miyoria/kernel";
import {
  type ContextKey,
  DeliveryLedgerKey,
  EventLogKey,
  type LogEvent,
  WorkingContextKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { raw } from "./support/http.js";

const TOKEN = "test-token";
const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };

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
  const get = (path: string) => raw(base, "GET", path, { token: TOKEN });
  return { sup, base, get };
}

async function withFacts(h: Awaited<ReturnType<typeof harness>>) {
  const log = new EventLogService({ profile: "p", store: null });
  const ledger = new DeliveryLedgerView(log);
  const context = new WorkingContextView();
  await log.project(ledger);
  await log.project(context);
  h.sup.services.provide("facts", EventLogKey, log);
  h.sup.services.provide("facts", DeliveryLedgerKey, ledger);
  h.sup.services.provide("facts", WorkingContextKey, context);
  const heard = log.observe(
    {
      source: "voice.asr",
      silent: false,
      salience: "notable",
      attention_key: "voice:utterance:u1",
      revision: 1,
      summary: "Owen:米優",
      addressed_to_her: true,
      from: "Owen",
      context: VOICE,
    },
    { buckets: [{ op: "append-self", writer: "voice.asr", owner: "voice", untrusted: true }] },
  );
  const decided = log.append({ kind: "decision", source: "agent", cause: heard.id, body: {} });
  const line = ledger.open({
    attention_key: "voice:utterance:u1",
    revision: 1,
    channel: "voice",
    context: VOICE,
    said: "在喔",
    cause: decided.id,
  });
  const failed = ledger.open({
    attention_key: "topic:x",
    revision: 1,
    channel: "voice",
    context: VOICE,
    said: "被打斷",
  });
  ledger.ack(line);
  ledger.undelivered(failed, "interrupted");
  return { log, heard, decided, line };
}

const ids = (body: unknown) => (body as LogEvent[]).map((e) => e.id);

describe("fact routes", () => {
  it("are 503 while the module is stopped and need the token", async () => {
    const h = await harness();
    const missing = await h.get("/api/facts/events");
    expect(missing.status).toBe(503);
    expect((missing.body as { error: string }).error).toContain("facts module");
    expect((await raw(h.base, "GET", "/api/facts/events")).status).toBe(401);
    expect((await raw(h.base, "POST", "/api/facts/events", { token: TOKEN })).status).toBe(405);
  });

  it("leave the live bus stream where it is", async () => {
    const h = await harness();
    const stream = await fetch(`${h.base}/api/events`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
  });

  it("list and filter events", async () => {
    const h = await harness();
    const { heard, line } = await withFacts(h);
    expect(((await h.get("/api/facts/events")).body as LogEvent[]).length).toBe(6);
    expect(ids((await h.get("/api/facts/events?kind=observation")).body)).toEqual([heard.id]);
    const two = await h.get("/api/facts/events?kind=utterance,observation&order=asc&limit=2");
    expect(ids(two.body)).toEqual([heard.id, line]);
    const person = await h.get("/api/facts/events?person=Owen");
    expect(ids(person.body)).toEqual([heard.id]);
    const key = await h.get(
      "/api/facts/events?attention_key=voice%3Autterance%3Au1&kind=observation",
    );
    expect(ids(key.body)).toEqual([heard.id]);
    const here = await h.get(
      "/api/facts/events?context=discord%3Ag1%3Avoice%3Av1&kind=observation",
    );
    expect(ids(here.body)).toEqual([heard.id]);
    expect(((await h.get("/api/facts/events?source=nobody")).body as LogEvent[]).length).toBe(0);
  });

  it("lists one turn: what names it and what that caused", async () => {
    const h = await harness();
    const { log, decided } = await withFacts(h);
    const ledger = h.sup.services.require(DeliveryLedgerKey);
    const said = ledger.open({
      attention_key: "topic:t1",
      revision: 1,
      channel: "voice",
      context: VOICE,
      said: "好",
      turn: "t1",
      cause: decided.id,
    });
    ledger.ack(said);
    log.append({ kind: "decision", source: "agent", body: { turn: "t2" } });
    // The delivery ack names the line it acks, not the turn; it still belongs to the turn.
    const found = (await h.get("/api/facts/events?turn=t1&order=asc")).body as LogEvent[];
    expect(found.map((e) => e.kind)).toEqual(["utterance", "delivered"]);
    expect(found[0]?.id).toBe(said);
    const acks = await h.get("/api/facts/events?turn=t1&kind=delivered");
    expect((acks.body as LogEvent[]).map((e) => e.kind)).toEqual(["delivered"]);
    expect(((await h.get("/api/facts/events?turn=nope")).body as LogEvent[]).length).toBe(0);
  });

  it("refuse what does not parse", async () => {
    const h = await harness();
    await withFacts(h);
    expect((await h.get("/api/facts/events?kind=nonsense")).status).toBe(400);
    expect((await h.get("/api/facts/events?limit=x")).status).toBe(400);
    expect((await h.get("/api/facts/events?since=yesterday")).status).toBe(400);
    expect((await h.get("/api/facts/events?context=nope")).status).toBe(400);
  });

  it("fetch one event, its causes and its effects", async () => {
    const h = await harness();
    const { heard, decided, line } = await withFacts(h);
    expect(((await h.get(`/api/facts/events/${heard.id}`)).body as LogEvent).source).toBe(
      "voice.asr",
    );
    expect((await h.get("/api/facts/events/nope")).status).toBe(404);
    expect((await h.get("/api/facts/events/nope/chain")).status).toBe(404);

    const chain = (await h.get(`/api/facts/events/${line}/chain`)).body as {
      events: LogEvent[];
      complete: boolean;
    };
    expect(chain.complete).toBe(true);
    expect(chain.events.map((e) => e.id)).toEqual([heard.id, decided.id, line]);

    const effects = (await h.get(`/api/facts/events/${heard.id}/effects`)).body as LogEvent[];
    expect(effects.map((e) => e.kind)).toEqual(["decision", "utterance", "delivered"]);
  });

  it("show what she knows and what reached someone", async () => {
    const h = await harness();
    await withFacts(h);
    const buckets = (await h.get("/api/facts/context")).body as { writer: string }[];
    expect(buckets.map((b) => b.writer)).toEqual(["voice.asr"]);
    const elsewhere = await h.get("/api/facts/context?context=discord%3Ag1%3Ac1");
    expect(elsewhere.body).toEqual([]);
    const deliveries = (await h.get("/api/facts/deliveries")).body as { said: string }[];
    expect(deliveries.map((d) => d.said)).toEqual(["在喔"]);
    const retry = (await h.get("/api/facts/retryable")).body as { said: string; state: string }[];
    expect(retry).toMatchObject([{ said: "被打斷", state: "interrupted" }]);
  });
});
