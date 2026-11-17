// "Forget me" through the store's coordinator (`@miyoria/store` `personData`): the memory plugin's
// `forgetPerson` hook takes what is about the person and what came from them, for every account of
// theirs, in the same transaction as the redaction of their lines; the engine reports it as before.

import { PERSON_FORGET_TYPE, SqliteStore } from "@miyoria/store";
import { type AccountRef, newId, type PersonId, type Timestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { EventLogService } from "../../facts/src/index.js";
import { MemoryEngine, memoryConfig } from "../src/index.js";
import { memoryTables } from "../src/tables.js";
import { acct, guildCtx, profile, t0 } from "./helpers.js";

const ctx = guildCtx("g1", "c1");
const OWEN = acct("2");
const OWEN_ALT = acct("4");
const AMY = acct("3");

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function rig(options: { coordinated?: boolean } = {}) {
  const store = await SqliteStore.open(":memory:", { plugins: [memoryTables] });
  stores.push(store);
  const tables = store.plugin(memoryTables);
  const owen = await store.people.upsertAccount(OWEN, "Owen");
  const amy = await store.people.upsertAccount(AMY, "Amy");
  // A second account of Owen's, linked.
  await store.identity.linkAccount(OWEN_ALT, owen);
  const log = new EventLogService({ store: store.events });
  /** A line of theirs and her observation of it, as the platform and the facts module write them. */
  const said = (account: AccountRef, name: string, text: string) => {
    const id = newId();
    store.chat.message(
      {
        id: { context: ctx, id },
        author: { account, display_name: name, is_bot: false },
        text,
        mentions_self: false,
        reply_to_self: false,
        attachments: [],
        ts: t0(),
      },
      { self: false, source: "platform.discord.bot" },
    );
    return log.observe(
      {
        source: "platform.discord",
        silent: false,
        salience: "notable",
        attention_key: `msg:discord:${id}`,
        revision: 1,
        summary: `${name}:${text}`,
        addressed_to_her: false,
        from: name,
        context: ctx,
      },
      { at: t0(), speech: true },
    );
  };
  const owenSaid = said(OWEN, "Owen", "我喜歡拉麵");
  const amySaid = said(AMY, "Amy", "我不吃香菜");
  await log.flush();
  let n = 0;
  const remember = (fields: {
    content: string;
    subjects?: PersonId[];
    source?: AccountRef | null;
    events?: string[];
    scope?: { type: "global" } | { type: "dm"; account: AccountRef };
  }) =>
    tables.upsert({
      id: newId(),
      profile: profile(),
      kind: "fact",
      scope: fields.scope ?? { type: "global" },
      subjects: fields.subjects ?? [],
      content: fields.content,
      tokens: fields.content,
      embedding: null,
      importance: 0.5,
      confidence: 0.8,
      created_at: t0(n++) as Timestamp,
      updated_at: t0(),
      last_accessed: null,
      access_count: 0,
      source_context: null,
      source: fields.source ? { account: fields.source, name: "x" } : null,
      origin: "told",
      source_events: fields.events ?? [],
      due: null,
      done: false,
      superseded_by: null,
    });
  await remember({
    content: "Owen 喜歡拉麵",
    subjects: [owen],
    source: OWEN,
    events: [owenSaid.id],
  });
  // In a DM with his other account: about him too.
  await remember({ content: "他說過明天要考試", scope: { type: "dm", account: OWEN_ALT } });
  // About Amy, but Owen said it; and her own note on what Owen said.
  await remember({ content: "Amy 住在新竹", subjects: [amy], source: OWEN });
  await remember({ content: "我答應請客吃拉麵", events: [owenSaid.id] });
  // Amy's own, and one resting on an event the log no longer holds.
  await remember({ content: "Amy 不吃香菜", subjects: [amy], source: AMY, events: [amySaid.id] });
  await remember({ content: "大家一起看了煙火", events: [newId()] });
  const engine = new MemoryEngine(profile(), memoryConfig(), tables, {
    people: store.people,
    messages: store.messages,
    events: log,
    chat: store.chat,
    ...(options.coordinated !== false && { personData: store.personData }),
  });
  return { store, tables, engine, owen };
}

const contents = async (r: Awaited<ReturnType<typeof rig>>) =>
  (
    await r.tables.list(profile(), {
      subject: null,
      scope: null,
      kind: null,
      before: null,
      include_superseded: true,
      limit: 100,
    })
  )
    .map((m) => m.content)
    .sort();

describe("forget me through the store", () => {
  it("takes what is about them and from them, with their lines, and records it", async () => {
    const r = await rig();
    const report = await r.engine.forget(r.owen, OWEN, null);
    expect(report).toEqual({ deleted: 4, about: 2, derived: 2, unverified: 1, lines: 2 });
    expect(await contents(r)).toEqual(["Amy 不吃香菜", "大家一起看了煙火"]);
    expect((await r.store.messages.recent(profile(), ctx, 10)).map((m) => m.text)).toEqual([
      "我不吃香菜",
    ]);
    const recorded = r.store.events.query({ types: [PERSON_FORGET_TYPE] });
    expect(recorded.map((e) => e.envelope.data)).toEqual([
      expect.objectContaining({
        target: r.owen,
        detail: expect.objectContaining({
          hooks: expect.objectContaining({
            memory: { about: 2, derived: 2, unverified: 1 },
            core: { lines: 2 },
          }),
        }),
      }),
    ]);
  });

  it("does what the engine did alone, but for every account of theirs", async () => {
    const alone = await rig({ coordinated: false });
    const report = await alone.engine.forget(alone.owen, OWEN, null);
    // From one account the DM of the other stays; the store's hook takes it too.
    expect(report).toEqual({ deleted: 3, about: 1, derived: 2, unverified: 1, lines: 2 });
    expect(await contents(alone)).toEqual(["Amy 不吃香菜", "他說過明天要考試", "大家一起看了煙火"]);
  });

  it("forgets by keyword in the engine, without the store and without their lines", async () => {
    const r = await rig();
    const report = await r.engine.forget(r.owen, OWEN, "新竹");
    expect(report).toEqual({ deleted: 1, about: 0, derived: 1, unverified: 1 });
    expect(r.store.events.query({ types: [PERSON_FORGET_TYPE] })).toEqual([]);
    expect((await r.store.messages.recent(profile(), ctx, 10)).length).toBe(2);
  });
});
