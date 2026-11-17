// Chat lines on the event log (v5-data §2.7, §8 step 5): one event per line with its place,
// person and scope; one raw record per line; "do not remember this" and "forget me" as
// redaction; the old `message_log` rows as a view for the data export.

import type { EventEnvelope } from "@miyoria/contracts/events";
import {
  type ContextKey,
  type IncomingMessage,
  newId,
  toTimestamp,
  type VoiceUtterance,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_SQL, CHAT_TYPES_SQL, type Redaction, SqliteStore } from "../src/index.js";
import { openTestDb } from "../src/testing.js";

const P = "deepseek-chan";
const T0 = Date.UTC(2026, 10, 1, 12);
const GUILD: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
const DM: ContextKey = { platform: "discord", scope: null, channel: "d1", kind: "dm" };
const OWEN = { account: { platform: "discord", id: "100" }, display_name: "Owen", is_bot: false };
const AMY = { account: { platform: "discord", id: "200" }, display_name: "Amy", is_bot: false };
const HER = { account: { platform: "discord", id: "999" }, display_name: "Miyori", is_bot: false };

let now = T0;
const clock = { now: () => now };
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  now = T0;
});

async function open(): Promise<SqliteStore> {
  const store = await SqliteStore.open(":memory:", { clock });
  stores.push(store);
  return store;
}

function message(
  context: ContextKey,
  id: string,
  text: string,
  secs: number,
  author = OWEN,
): IncomingMessage {
  return {
    id: { context, id },
    author,
    text,
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(T0 + secs * 1000),
  };
}

function utterance(id: string, text: string, secs: number, speaker = OWEN): VoiceUtterance {
  return {
    id,
    context: VOICE,
    speaker,
    text,
    language: "zh",
    emotion: null,
    audio_events: [],
    started_at: toTimestamp(T0 + (secs - 1) * 1000),
    ended_at: toTimestamp(T0 + secs * 1000),
    asr_ms: 80,
  };
}

/** Her observation of a line, as the facts writer stores it (same key, her derived view). */
function observation(store: SqliteStore, key: string, context: ContextKey, author = OWEN) {
  return store.events.appendNow({
    draft: {
      id: newId(),
      at: toTimestamp(T0),
      type: "facts.observation.said",
      key,
      data: { observation: { attention_key: key, summary: "Owen:我養了一隻貓" } },
    },
    source: "platform.discord",
    context,
    author: { account: author.account, display_name: author.display_name },
  });
}

const row = (store: SqliteStore, id: string) => store.events.get(id)?.envelope;

describe("chat lines", () => {
  it("are one event each, with place, person, account, scope and tier", async () => {
    const store = await open();
    const text = store.chat.message(message(GUILD, "m1", "嗨", 1), {
      self: false,
      source: "platform.discord",
    });
    const hers = store.chat.message(message(GUILD, "m2", "你好", 2, HER), {
      self: true,
      turn: "t1",
      source: "platform.discord",
    });
    const dm = store.chat.message(message(DM, "m3", "私訊", 3), {
      self: false,
      source: "platform.discord",
    });
    const heard = store.chat.utterance(utterance("u1", "聽得到嗎", 4), { source: "voice" });
    const said = store.chat.playback(
      { context: VOICE, turn: "t2", state: "started", text: "聽得到", speaker: HER },
      { at: toTimestamp(T0 + 5000), source: "voice" },
    );
    const owen = store.persons.personOf(OWEN.account);
    const owenAccount = store.persons.account(OWEN.account);
    expect(owen).not.toBeNull();
    const guild = { session: "discord:g1:c1", scope: "room", tier: "long" };
    expect(text).toMatchObject({
      type: "platform.message.created",
      ...guild,
      person_id: owen?.id,
      account_id: owenAccount?.id,
      key: "msg:discord:m1",
      at: toTimestamp(T0 + 1000),
    });
    expect(text?.space_id).not.toBeNull();
    expect(text?.room_id).not.toBeNull();
    // Hers: no person (she is not one of the people she meets), marked in the payload.
    expect(hers).toMatchObject({ ...guild, person_id: null, account_id: null, turn: "t1" });
    expect(hers?.data).toMatchObject({ text: "你好", self: true });
    expect(dm).toMatchObject({
      session: `discord:dm:${owen?.id}`,
      scope: "dm",
      space_id: null,
      person_id: owen?.id,
    });
    expect(heard).toMatchObject({
      type: "voice.utterance",
      session: "discord:g1:voice:v1",
      scope: "room",
      tier: "long",
      person_id: owen?.id,
      key: "voice:utterance:u1",
    });
    expect(said).toMatchObject({
      type: "voice.playback",
      session: "discord:g1:voice:v1",
      scope: "room",
      person_id: null,
      turn: "t2",
    });
    // Stored as returned.
    for (const e of [text, hers, dm, heard, said]) {
      expect(row(store, e?.id ?? "")).toEqual(e);
    }
  });

  it("are stored once: the same message or utterance again is left out", async () => {
    const store = await open();
    const m = message(GUILD, "m1", "嗨", 1);
    expect(store.chat.message(m, { self: false, source: "bot" })).not.toBeNull();
    // The other connection delivers it too, or a replay does.
    expect(store.chat.message(m, { self: false, source: "self" })).toBeNull();
    expect(store.chat.utterance(utterance("u1", "嗨", 2), { source: "voice" })).not.toBeNull();
    expect(store.chat.utterance(utterance("u1", "嗨", 2), { source: "voice" })).toBeNull();
    // Her observation of the line is another type under the same key: hers, not a second record.
    observation(store, "msg:discord:m1", GUILD);
    const lines = store.events.query({ key: "msg:discord:m1" });
    expect(lines.map((e) => e.envelope.type).sort()).toEqual([
      "facts.observation.said",
      "platform.message.created",
    ]);
    expect(await store.messages.recent(P, GUILD, 10)).toHaveLength(1);
  });

  it("read back through MessageLog as the platform delivered them", async () => {
    const store = await open();
    const m: IncomingMessage = {
      ...message(GUILD, "m1", " 看這個 ", 1),
      stickers: [{ id: "s1", name: "貓貓" }],
    };
    store.chat.message(m, { self: false, turn: "t0", source: "bot" });
    store.chat.utterance(utterance("u1", "聽得到嗎", 2), { source: "voice" });
    store.chat.playback(
      { context: VOICE, turn: "t1", state: "started", text: "聽得到", speaker: HER },
      { at: toTimestamp(T0 + 3000), source: "voice" },
    );
    const [line] = await store.messages.recent(P, GUILD, 10);
    expect(line).toMatchObject({
      profile: P,
      context: GUILD,
      author: OWEN.account,
      author_name: "Owen",
      text: "看這個 [貼圖: 貓貓]",
      is_self: false,
      turn: "t0",
    });
    expect(await store.messages.recent(P, VOICE, 10)).toMatchObject([
      { author: OWEN.account, author_name: "Owen", text: "聽得到嗎", is_self: false },
      { author: HER.account, author_name: "Miyori", text: "聽得到", is_self: true, turn: "t1" },
    ]);
  });

  it("of a DM are not read in a guild room, nor its lines in the DM", async () => {
    const store = await open();
    store.chat.message(message(GUILD, "m1", "大家好", 1), { self: false, source: "bot" });
    store.chat.message(message(DM, "m2", "只跟你說", 2), { self: false, source: "bot" });
    const guild = await store.messages.recent(P, GUILD, 10);
    expect(guild.map((e) => e.text)).toEqual(["大家好"]);
    expect((await store.messages.recent(P, DM, 10)).map((e) => e.text)).toEqual(["只跟你說"]);
    const roomRead = store.events.query({ context: GUILD });
    expect(roomRead.map((e) => e.envelope.scope)).toEqual(["room"]);
    expect(JSON.stringify(roomRead)).not.toContain("只跟你說");
  });

  it("are read over the partial indexes of core migration 3", () => {
    const t = openTestDb({ identity: true });
    try {
      // The queries name the indexes' condition word for word, or SQLite would not use them.
      expect(CHAT_SQL.split(CHAT_TYPES_SQL).length - 1).toBe(3);
      const plan = (sql: string) =>
        t.db
          .all(`EXPLAIN QUERY PLAN ${sql}`, {})
          .map((r) => String(r.detail))
          .join(" | ");
      expect(
        plan(
          `SELECT id FROM events WHERE session = 's' AND ${CHAT_TYPES_SQL} AND redacted_at IS NULL ` +
            "ORDER BY at DESC, seq DESC LIMIT 50",
        ),
      ).toMatch(/USING INDEX events_chat_session_idx/);
      expect(
        plan(
          `SELECT at FROM events WHERE account_id IN ('a', 'b') AND ${CHAT_TYPES_SQL} ` +
            "AND at >= 0 ORDER BY at DESC, seq DESC LIMIT 50",
        ),
      ).toMatch(/USING INDEX events_chat_account_idx/);
    } finally {
      t.close();
    }
  });
});

describe("do not remember this", () => {
  it("redacts the line and her observations of it, keeping the envelopes", async () => {
    const store = await open();
    const told: Redaction[] = [];
    store.events.onRedacted((r) => told.push(r));
    const line = store.chat.message(message(GUILD, "m1", "我養了一隻貓", 1), {
      self: false,
      source: "bot",
    }) as EventEnvelope;
    const other = store.chat.message(message(GUILD, "m2", "我喜歡拉麵", 2), {
      self: false,
      source: "bot",
    }) as EventEnvelope;
    const seen = observation(store, "msg:discord:m1", GUILD);
    now = T0 + 60_000;
    const ids = store.chat.redactMessage(
      { context: GUILD, id: "m1" },
      "do not remember",
      "recorder",
    );
    expect(ids.sort()).toEqual([line.id, seen.id].sort());
    expect(told).toEqual([{ ids: [line.id, seen.id], keys: ["msg:discord:m1"] }]);
    for (const id of ids) {
      const e = row(store, id);
      expect(e?.data).toEqual({ redacted: true });
      expect(e?.redacted_at).toBe(toTimestamp(now));
    }
    // The envelope stays: type, place, person, key.
    expect(row(store, line.id)).toMatchObject({
      type: line.type,
      session: line.session,
      person_id: line.person_id,
      key: line.key,
    });
    const records = store.events.query({ types: ["privacy.redacted"] });
    expect(records.map((r) => r.envelope.data)).toEqual(
      expect.arrayContaining([
        { target: line.id, reason: "do not remember" },
        { target: seen.id, reason: "do not remember" },
      ]),
    );
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.envelope)).toMatchObject([
      { scope: "owner", tier: "keep" },
      { scope: "owner", tier: "keep" },
    ]);
    expect(JSON.stringify(records)).not.toContain("貓");
    // Gone from the log she reads, still counted.
    expect((await store.messages.recent(P, GUILD, 10)).map((e) => e.id)).toEqual([other.id]);
    expect(await store.messages.authoredSince(P, [OWEN.account], toTimestamp(T0), 10)).toEqual([
      { ts: toTimestamp(T0 + 1000), kind: "channel" },
      { ts: toTimestamp(T0 + 2000), kind: "channel" },
    ]);
    expect(store.chat.redacted([line.id, other.id, seen.id])).toEqual(new Set([line.id, seen.id]));
    expect(store.chat.eventsOf("msg:discord:m1").sort()).toEqual([line.id, seen.id].sort());
    // Asked again: nothing more to do.
    expect(store.chat.redactMessage({ context: GUILD, id: "m1" }, "again", "recorder")).toEqual([]);
  });

  it("reaches a line of that message stored after it (a writer's buffer)", async () => {
    const store = await open();
    store.chat.redactMessage({ context: GUILD, id: "m9" }, "do not remember", "recorder");
    const late = observation(store, "msg:discord:m9", GUILD);
    expect(late.data).toEqual({ redacted: true });
    expect(row(store, late.id)?.redacted_at).not.toBeNull();
    expect(JSON.stringify(store.events.query({ key: "msg:discord:m9" }))).not.toContain("貓");
    expect(store.events.query({ types: ["privacy.redacted"] })).toHaveLength(1);
  });
});

describe("forget me", () => {
  it("redacts every line of the person in one go, and theirs only", async () => {
    const store = await open();
    const told: Redaction[] = [];
    store.events.onRedacted((r) => told.push(r));
    const a = store.chat.message(message(GUILD, "m1", "我住台北", 1), {
      self: false,
      source: "bot",
    });
    const b = store.chat.message(message(DM, "m2", "我的生日是三月", 2), {
      self: false,
      source: "bot",
    });
    const c = store.chat.utterance(utterance("u1", "我養貓", 3), { source: "voice" });
    const seen = observation(store, "msg:discord:m1", GUILD);
    const amy = store.chat.message(message(GUILD, "m3", "我是 Amy", 4, AMY), {
      self: false,
      source: "bot",
    });
    const hers = store.chat.message(message(GUILD, "m4", "好喔", 5, HER), {
      self: true,
      source: "bot",
    });
    const owen = store.persons.personOf(OWEN.account)?.id ?? "";
    expect(store.chat.forgetPerson(owen, "forget me", "memory")).toBe(4);
    const gone = [a, b, c, seen].map((e) => e?.id ?? "");
    expect(told).toEqual([{ ids: gone, keys: [] }]);
    for (const id of gone) expect(row(store, id)?.data).toEqual({ redacted: true });
    for (const e of [amy, hers]) expect(row(store, e?.id ?? "")?.redacted_at).toBeNull();
    expect((await store.messages.recent(P, GUILD, 10)).map((e) => e.text)).toEqual([
      "我是 Amy",
      "好喔",
    ]);
    expect(await store.messages.recent(P, DM, 10)).toEqual([]);
    // The envelopes stay for counts.
    expect(await store.messages.authoredSince(P, [OWEN.account], toTimestamp(T0), 10)).toEqual([
      { ts: toTimestamp(T0 + 1000), kind: "channel" },
      { ts: toTimestamp(T0 + 2000), kind: "dm" },
      { ts: toTimestamp(T0 + 3000), kind: "voice" },
    ]);
    expect(store.chat.forgetPerson(owen, "again", "memory")).toBe(0);
  });

  it("needs a key or a person: nothing redacts the whole log", async () => {
    const store = await open();
    expect(() => store.events.redactWhere({}, "all", "x")).toThrow(/key or a person/);
  });
});

describe("the conversation log as data", () => {
  it("exports the old message_log columns, and wipes and purges the lines", async () => {
    const store = await open();
    store.chat.message(message(GUILD, "m1", "嗨", 1), { self: false, source: "bot" });
    store.chat.message(message(GUILD, "m2", "安安", 2, HER), { self: true, source: "bot" });
    observation(store, "msg:discord:m1", GUILD);
    const inventory = await store.profileData.inventory(P);
    const parts = inventory.categories.flatMap((c) => c.parts);
    expect(parts.find((p) => p.id === "message_log")?.count).toBe(2);
    // Her observations are the event log's, not the conversation log's.
    expect(parts.find((p) => p.id === "events")?.count).toBe(1);
    const backup = await store.profileData.export(P, ["messages"]);
    expect(backup.parts.message_log).toMatchObject([
      {
        type: "platform.message.created",
        platform: "discord",
        scope: "g1",
        channel: "c1",
        kind: "channel",
        author_platform: "discord",
        author_id: "100",
        author_name: "Owen",
        text: "嗨",
        is_self: false,
        ts: toTimestamp(T0 + 1000),
        session: "discord:g1:c1",
      },
      { author_id: "999", text: "安安", is_self: true },
    ]);
    expect(await store.profileData.wipe(P, ["messages"])).toMatchObject({
      message_log: 2,
      events: 1,
    });
    expect(await store.messages.recent(P, GUILD, 10)).toEqual([]);
    store.chat.message(message(GUILD, "m5", "又來了", 5), { self: false, source: "bot" });
    expect(await store.messages.purge(P)).toBe(1);
    expect(await store.messages.recent(P, GUILD, 10)).toEqual([]);
  });
});
