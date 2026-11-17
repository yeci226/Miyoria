// The ack rules of §8: only a real delivery counts, everything else stays retryable, and the whole
// ledger comes back from the log.

import { SqliteStore } from "@miyoria/store";
import {
  type ContextKey,
  type JsonValue,
  type NewLine,
  type Observation,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliveryLedgerView } from "../src/delivery.js";
import { EventLogService } from "../src/log.js";

const T0 = Date.UTC(2026, 10, 7, 12);
const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "v", kind: "voice" };
const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const KEY = "game:craft:stone_pickaxe";

let now = T0;
const clock = { now: () => now };

async function ledgerOn(log: EventLogService) {
  const ledger = new DeliveryLedgerView(log, { clock, answerWindowMs: 60_000 });
  await log.project(ledger);
  return ledger;
}

const line = (over: Partial<NewLine> = {}): NewLine => ({
  attention_key: KEY,
  revision: 1,
  channel: "voice",
  context: VOICE,
  said: "石鎬做好了",
  audience: ["Owen"],
  turn: "t1",
  ...over,
});

function speech(log: EventLogService, from: string, context: ContextKey): void {
  const observation: Observation = {
    source: "voice.asr",
    silent: true,
    salience: "ambient",
    attention_key: `voice:utterance:${from}`,
    revision: 1,
    summary: "",
    addressed_to_her: false,
    from,
    context,
  };
  log.observe(observation, { speech: true });
}

let log: EventLogService;
let ledger: DeliveryLedgerView;

beforeEach(async () => {
  now = T0;
  log = new EventLogService({ profile: "p", store: null, clock });
  ledger = await ledgerOn(log);
});

describe("ack", () => {
  it("nothing is said until it is acked", () => {
    const id = ledger.open(line());
    expect(ledger.line(id)?.state).toBe("pending");
    expect(ledger.delivered(KEY, 1)).toBeNull();
    expect(ledger.recent()).toEqual([]);
    expect(ledger.retryable()).toEqual([]);
  });

  it("an ack makes it said, under its key", () => {
    const id = ledger.open(line());
    now += 5000;
    const delivery = ledger.ack(id);
    expect(delivery).toMatchObject({
      attention_key: KEY,
      revision: 1,
      channel: "voice",
      context: VOICE,
      said: "石鎬做好了",
      delivered_at: toTimestamp(T0 + 5000),
      audience: ["Owen"],
      answered_by: [],
      line: id,
    });
    expect(ledger.line(id)).toMatchObject({
      state: "delivered",
      settled_at: toTimestamp(T0 + 5000),
    });
    expect(ledger.delivered(KEY, 1)).toEqual(delivery);
    expect(ledger.delivered(KEY)).toEqual(delivery);
  });

  it("is idempotent", () => {
    const id = ledger.open(line());
    const first = ledger.ack(id);
    expect(ledger.ack(id)).toEqual(first);
    expect(ledger.recent()).toHaveLength(1);
    expect(log.recent().filter((e) => e.kind === "delivered")).toHaveLength(1);
  });

  it("logs the delivery as caused by the line, and the line by its decision", async () => {
    const decision = log.append({ kind: "decision", source: "agent", body: {} });
    const id = ledger.open(line({ cause: decision.id }));
    ledger.ack(id);
    const delivered = log.recent().find((e) => e.kind === "delivered");
    const chain = await log.chain(delivered?.id ?? "");
    expect(chain.complete).toBe(true);
    expect(chain.events.map((e) => e.kind)).toEqual(["decision", "utterance", "delivered"]);
  });

  it("does not ack what it does not know", () => {
    expect(ledger.ack("nope")).toBeNull();
    expect(log.recent()).toEqual([]);
  });
});

describe("lines that did not arrive", () => {
  for (const state of ["interrupted", "failed", "cancelled"] as const) {
    it(`${state} is not said and stays retryable`, () => {
      const id = ledger.open(line());
      ledger.undelivered(id, state, "why");
      expect(ledger.delivered(KEY, 1)).toBeNull();
      expect(ledger.line(id)).toMatchObject({ state, reason: "why" });
      expect(ledger.retryable().map((l) => l.line)).toEqual([id]);
      expect(ledger.mayClaim({ attention_key: KEY, revision: 1, salience: "notable" })).toBe(true);
    });
  }

  it("a final line cannot be acked afterwards", () => {
    const id = ledger.open(line());
    ledger.undelivered(id, "interrupted");
    expect(ledger.ack(id)).toBeNull();
    expect(ledger.delivered(KEY)).toBeNull();
  });

  it("a delivered line cannot fail afterwards", () => {
    const id = ledger.open(line());
    ledger.ack(id);
    ledger.undelivered(id, "failed");
    expect(ledger.line(id)?.state).toBe("delivered");
    expect(log.recent().filter((e) => e.kind === "result")).toEqual([]);
  });

  it("a retry that arrives ends it: not retryable, and said", () => {
    const first = ledger.open(line());
    ledger.undelivered(first, "interrupted");
    const second = ledger.open(line({ said: "我的石鎬好了" }));
    ledger.ack(second);
    expect(ledger.retryable()).toEqual([]);
    expect(ledger.delivered(KEY, 1)?.said).toBe("我的石鎬好了");
  });

  it("two failed attempts of one thing are one retry", () => {
    ledger.undelivered(ledger.open(line()), "failed");
    const second = ledger.open(line());
    ledger.undelivered(second, "cancelled");
    expect(ledger.retryable().map((l) => l.line)).toEqual([second]);
  });

  it("filters retries by place", () => {
    ledger.undelivered(ledger.open(line()), "failed");
    expect(ledger.retryable({ context: TEXT })).toEqual([]);
    expect(ledger.retryable({ context: VOICE })).toHaveLength(1);
  });

  it("a line without an answer ends as failed once it is too old", () => {
    const id = ledger.open(line());
    now += 1000;
    expect(ledger.expire(5000, "no ack")).toBe(0);
    now += 5000;
    expect(ledger.expire(5000, "no ack")).toBe(1);
    expect(ledger.line(id)).toMatchObject({ state: "failed", reason: "no ack" });
    expect(ledger.retryable()).toHaveLength(1);
  });
});

describe("what may claim the floor", () => {
  const claim = (revision: number, salience: Observation["salience"] = "notable") =>
    ledger.mayClaim({ attention_key: KEY, revision, salience });

  it("ambient never does", () => {
    expect(claim(1, "ambient")).toBe(false);
  });

  it("the same revision does not once it was delivered, a new one does", () => {
    expect(claim(1)).toBe(true);
    ledger.ack(ledger.open(line()));
    expect(claim(1)).toBe(false);
    expect(claim(1, "urgent")).toBe(false);
    expect(claim(2)).toBe(true);
    ledger.ack(ledger.open(line({ revision: 2 })));
    expect(claim(1)).toBe(false);
    expect(claim(2)).toBe(false);
    expect(claim(3)).toBe(true);
  });
});

describe("what was said lately", () => {
  it("lists deliveries newest first, by place", () => {
    ledger.ack(ledger.open(line({ said: "一" })));
    ledger.ack(ledger.open(line({ said: "二", channel: "text", context: TEXT })));
    expect(ledger.recent().map((d) => d.said)).toEqual(["二", "一"]);
    expect(ledger.recent({ limit: 1 }).map((d) => d.said)).toEqual(["二"]);
    expect(ledger.recent({ context: VOICE }).map((d) => d.said)).toEqual(["一"]);
  });

  it("finds a rewording of something recent", () => {
    ledger.ack(ledger.open(line({ said: "我的石鎬終於做好了耶" })));
    expect(ledger.saidLately("石鎬終於做好了")).not.toBeNull();
    expect(ledger.saidLately("今天天氣真不錯呢")).toBeNull();
    expect(ledger.saidLately("石鎬終於做好了", { context: TEXT })).toBeNull();
    now += 40 * 60_000;
    expect(ledger.saidLately("石鎬終於做好了")).toBeNull();
  });
});

describe("who answered", () => {
  it("counts people speaking in that place inside the window", () => {
    ledger.ack(ledger.open(line()));
    now += 10_000;
    speech(log, "Amy", VOICE);
    speech(log, "Amy", VOICE);
    speech(log, "Bob", TEXT);
    expect(ledger.delivered(KEY)?.answered_by).toEqual(["Amy"]);
    now += 120_000;
    speech(log, "Cid", VOICE);
    expect(ledger.delivered(KEY)?.answered_by).toEqual(["Amy"]);
  });

  it("does not count what was said before the line", () => {
    speech(log, "Amy", VOICE);
    ledger.ack(ledger.open(line()));
    expect(ledger.delivered(KEY)?.answered_by).toEqual([]);
  });

  it("does not count an observation that is not speech", () => {
    ledger.ack(ledger.open(line()));
    log.observe(
      {
        source: "voice.presence",
        silent: true,
        salience: "ambient",
        attention_key: "x",
        revision: 1,
        summary: "",
        addressed_to_her: false,
        from: "Amy",
        context: VOICE,
      },
      { speech: false },
    );
    expect(ledger.delivered(KEY)?.answered_by).toEqual([]);
  });
});

describe("after a restart", () => {
  const stores: SqliteStore[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.close();
  });

  it("comes back from the log", async () => {
    const store = await SqliteStore.open(":memory:");
    stores.push(store);
    const options = { profile: "p", store: store.events, clock };
    const first = new EventLogService(options);
    const before = await ledgerOn(first);
    before.ack(before.open(line()));
    before.undelivered(before.open(line({ attention_key: "game:night_started" })), "interrupted");
    const lost = before.open(line({ attention_key: "game:advancement:x" }));
    now += 1000;
    speech(first, "Amy", VOICE);
    await first.flush();

    const second = new EventLogService(options);
    const after = new DeliveryLedgerView(second, { clock, answerWindowMs: 60_000 });
    await second.project(after, { since: toTimestamp(T0 - 1000) });
    expect(after.delivered(KEY, 1)?.answered_by).toEqual(["Amy"]);
    expect(after.mayClaim({ attention_key: KEY, revision: 1, salience: "notable" })).toBe(false);
    expect(after.retryable().map((l) => l.attention_key)).toEqual(["game:night_started"]);
    // The line in flight has nobody left to answer for it: what the module does on start.
    expect(after.line(lost)?.state).toBe("pending");
    after.expire(0, "the core restarted");
    expect(after.line(lost)).toMatchObject({ state: "failed", reason: "the core restarted" });
    expect(after.retryable()).toHaveLength(2);
  });

  it("ignores a broken line in the log", () => {
    const body: JsonValue = { delivery: "failed", line: "nope" };
    expect(() =>
      ledger.apply({
        id: "x",
        at: toTimestamp(T0),
        kind: "result",
        source: "s",
        cause: null,
        context: null,
        person: null,
        body,
      }),
    ).not.toThrow();
  });
});
