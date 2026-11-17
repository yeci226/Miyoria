// What is still open after a conversation: follow-ups shown to the segment pass, closed when the
// segment answered them, changed when their matter moved, and never written twice; her promises
// recorded in a book, closed when she did them. A real memory engine on a real store, a scripted
// model.

import { type MemoryRecord, SqliteStore } from "@miyoria/store";
import {
  type Commitment,
  type CommitmentDraft,
  type ContextKey,
  type PromiseBook,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { memoryConfig } from "../../memory/src/config.js";
import { MemoryEngine, memoryFilter } from "../../memory/src/engine.js";
import { memoryTables } from "../../memory/src/tables.js";
import {
  commitmentLedger,
  memoryEpisodeSink,
  notesTables,
  runSegmentPass,
  type SegmentPassDeps,
  type SegmentPassInput,
} from "../src/index.js";
import {
  by,
  CHANNEL,
  fakeResolver,
  IN_SERVER,
  OWEN,
  own,
  SESSION,
  scripted,
  T0,
} from "./helpers.js";

const P = "p";
const HOUR = 3_600_000;
const people = [{ person: OWEN, name: "Owen" }];
const reply = (value: object) => JSON.stringify(value);

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function setup() {
  let now = T0;
  const clock = { now: () => now };
  const store = await SqliteStore.open(":memory:", { plugins: [notesTables, memoryTables], clock });
  stores.push(store);
  const records = store.plugin(memoryTables);
  const engine = new MemoryEngine(P, memoryConfig(), records, { clock });
  const sink = memoryEpisodeSink(engine, { resolver: fakeResolver(), contextOf: () => CHANNEL });
  const notes = store.plugin(notesTables);
  const followups = async (): Promise<MemoryRecord[]> =>
    records.list(P, memoryFilter(100, { kind: "followup" }));
  const pass = (
    input: Omit<SegmentPassInput, "session" | "place" | "people">,
    deps: Pick<SegmentPassDeps, "router"> & Partial<SegmentPassDeps>,
  ) =>
    runSegmentPass(
      { session: SESSION, place: IN_SERVER, people, ...input },
      { notes, episodes: sink, now: clock.now, ...deps },
    );
  return {
    engine,
    followups,
    pass,
    at: (ms: number) => {
      now = ms;
    },
  };
}

/** An entry said at `ms`. */
const at = (e: ReturnType<typeof by>, ms: number) => ({ ...e, at: toTimestamp(ms) });

describe("follow-ups the segment pass sees", () => {
  it("closes a follow-up the segment answered, which then does not wake her", async () => {
    const r = await setup();
    const first = scripted(
      reply({
        episode: null,
        followups: [{ who: "p1", about: "問 Owen 微積分考得怎樣", due_in_hours: 24 }],
      }),
    );
    await r.pass({ entries: [by(1, OWEN, "Owen", "明天要考微積分,好緊張")] }, first);
    const [asked] = await r.followups();
    expect(asked).toMatchObject({ content: "問 Owen 微積分考得怎樣", done: false });

    r.at(T0 + 20 * HOUR);
    const second = scripted(
      reply({
        episode: null,
        close: [{ id: "f1", reason: "Owen 說考完了" }],
        followups: [{ who: "p1", about: "問 Owen 微積分的考試結果", due_in_hours: 24 }],
      }),
    );
    const result = await r.pass(
      { entries: [at(by(2, OWEN, "Owen", "微積分考完了,應該有過"), T0 + 20 * HOUR)] },
      second,
    );
    const message = String(second.asked[0]?.messages[1]?.content ?? "");
    expect(message).toContain("還沒了結的事");
    expect(message).toContain("f1 追問:問 Owen 微積分考得怎樣(關於 Owen)");
    expect(result.closed).toEqual([
      expect.objectContaining({
        kind: "followup",
        id: asked?.id,
        reason: "Owen 說考完了",
        count: 1,
      }),
    ]);
    // Answered just now: the same matter in other words is not asked again.
    expect(result.followups).toEqual([expect.objectContaining({ same: asked?.id, stored: null })]);
    expect(await r.followups()).toEqual([expect.objectContaining({ id: asked?.id, done: true })]);
    expect(await r.engine.due(P, toTimestamp(T0 + 25 * HOUR))).toEqual([]);
  });

  it("does not write the same matter twice, shown or not", async () => {
    const r = await setup();
    const ask = (about: string) =>
      scripted(reply({ episode: null, followups: [{ who: "p1", about, due_in_hours: 24 }] }));
    await r.pass(
      { entries: [by(1, OWEN, "Owen", "我下週要去面試實習")] },
      ask("問 Owen 實習面試順不順利"),
    );
    r.at(T0 + HOUR);
    const shown = await r.pass(
      { entries: [at(by(2, OWEN, "Owen", "面試是週三"), T0 + HOUR)] },
      ask("追問 Owen 實習面試的結果"),
    );
    expect(shown.followups[0]?.same).not.toBeNull();
    // Not shown to the model (nothing open is shown), the engine still holds it.
    r.at(T0 + 2 * HOUR);
    const hidden = await r.pass(
      { entries: [at(by(3, OWEN, "Owen", "有點緊張"), T0 + 2 * HOUR)] },
      { ...ask("問 Owen 實習面試後來怎樣"), caps: { open: 0 } },
    );
    expect(hidden.followups).toEqual([expect.objectContaining({ same: null, stored: null })]);
    expect(await r.followups()).toHaveLength(1);
    expect(await r.engine.due(P, toTimestamp(T0 + 25 * HOUR))).toHaveLength(1);
  });

  it("moves a follow-up whose matter moved instead of writing another", async () => {
    const r = await setup();
    await r.pass(
      { entries: [by(1, OWEN, "Owen", "明天要考微積分")] },
      scripted(
        reply({ followups: [{ who: "p1", about: "問 Owen 微積分考得怎樣", due_in_hours: 24 }] }),
      ),
    );
    r.at(T0 + HOUR);
    const result = await r.pass(
      { entries: [at(by(2, OWEN, "Owen", "考試延到下週了"), T0 + HOUR)] },
      scripted(
        reply({
          update: [{ id: "f1", about: "問 Owen 下週的微積分考得怎樣", due_in_hours: 168 }],
        }),
      ),
    );
    const [moved] = await r.followups();
    expect(result.updated).toEqual([moved?.id]);
    expect(moved).toMatchObject({
      content: "問 Owen 下週的微積分考得怎樣",
      due: toTimestamp(T0 + HOUR + 168 * HOUR),
      done: false,
    });
    expect(await r.engine.due(P, toTimestamp(T0 + 25 * HOUR))).toEqual([]);
  });

  it("closes in order when history is replayed", async () => {
    const r = await setup();
    // Asked at T0, answered at T0 + 3 h; a replay of the second segment does not see a follow-up
    // written after its own time.
    await r.pass(
      { entries: [by(1, OWEN, "Owen", "我在等研究所放榜")] },
      scripted(
        reply({ followups: [{ who: "p1", about: "問 Owen 研究所放榜了沒", due_in_hours: 48 }] }),
      ),
    );
    r.at(T0 - HOUR);
    const before = scripted(reply({ close: [{ id: "f1", reason: "x" }] }));
    const early = await r.pass({ entries: [at(by(0, OWEN, "Owen", "早安"), T0 - HOUR)] }, before);
    expect(early.closed).toEqual([]);
    expect(String(before.asked[0]?.messages[1]?.content)).not.toContain("f1 追問");
    r.at(T0 + 3 * HOUR);
    const later = await r.pass(
      { entries: [at(by(2, OWEN, "Owen", "放榜了,我上了!"), T0 + 3 * HOUR)] },
      scripted(reply({ close: ["f1"] })),
    );
    expect(later.closed).toHaveLength(1);
    expect((await r.followups())[0]?.done).toBe(true);
  });
});

/** A commitment book in memory, as the agent's keeps them (open, kept). */
function book(now: () => number) {
  const all: Commitment[] = [];
  const b: PromiseBook = {
    open: (context?: ContextKey) =>
      all.filter(
        (c) =>
          c.status === "open" && (context === undefined || c.context.channel === context.channel),
      ),
    add(draft: CommitmentDraft, context: ContextKey) {
      const c: Commitment = {
        id: `c-${all.length + 1}`,
        what: draft.what,
        capability: draft.capability,
        due: toTimestamp(now() + (draft.due_secs ?? 120) * 1000),
        status: "open",
        context,
        turn: null,
        made_at: toTimestamp(now()),
        reminded: false,
      };
      all.push(c);
      return c;
    },
    said(c: Commitment) {
      const found = all.find((x) => x.id === c.id);
      if (found) found.status = "kept";
    },
  };
  return { b, all };
}

describe("her promises", () => {
  it("records a promise from when she made it, keeps it once she did it, and never twice", async () => {
    const r = await setup();
    let now = T0 + 10 * 60_000;
    const { b, all } = book(() => now);
    const promises = commitmentLedger(() => b, { now: () => now });
    const made = await r.pass(
      {
        entries: [by(1, OWEN, "Owen", "那家店幾點開啊"), own(2, "我等等幫你查!")],
        context: CHANNEL,
      },
      {
        ...scripted(
          reply({
            promises: [{ to: "p1", what: "幫 Owen 查那家店幾點開", due_in_hours: 0.5, seq: 2 }],
          }),
        ),
        promises,
      },
    );
    expect(made.promises).toEqual([
      expect.objectContaining({ what: "幫 Owen 查那家店幾點開", to: OWEN, stored: "c-1" }),
    ]);
    // Due half an hour after the line she said it in (T0 + 2 min), not after the pass.
    expect(all[0]?.due).toBe(toTimestamp(T0 + 2 * 60_000 + 30 * 60_000) as Timestamp);

    const again = await r.pass(
      { entries: [own(3, "我等一下就去查那家店幾點開")], context: CHANNEL },
      {
        ...scripted(reply({ promises: [{ to: "p1", what: "查那家店幾點開" }] })),
        promises,
      },
    );
    expect(again.promises).toEqual([expect.objectContaining({ same: "c-1", stored: null })]);
    expect(all).toHaveLength(1);

    now = T0 + 20 * 60_000;
    const kept = scripted(reply({ close: [{ id: "c1", reason: "查到了" }] }));
    const done = await r.pass(
      {
        entries: [own(4, "查到了,那家店早上十一點開"), by(5, OWEN, "Owen", "謝啦")],
        context: CHANNEL,
      },
      { ...kept, promises },
    );
    expect(String(kept.asked[0]?.messages[1]?.content)).toContain(
      "c1 我答應過:幫 Owen 查那家店幾點開",
    );
    expect(done.closed).toEqual([
      expect.objectContaining({ kind: "promise", id: "c-1", count: 1 }),
    ]);
    expect(b.open()).toEqual([]);
  });

  it("records nothing without a place's context or a book", async () => {
    const r = await setup();
    const result = await r.pass(
      { entries: [own(1, "明天提醒你交報告")] },
      {
        ...scripted(
          reply({ promises: [{ to: null, what: "明天提醒大家交報告", due_in_hours: 24 }] }),
        ),
        promises: commitmentLedger(() => null, { now: () => T0 }),
      },
    );
    expect(result.promises).toEqual([expect.objectContaining({ stored: null })]);
  });
});
