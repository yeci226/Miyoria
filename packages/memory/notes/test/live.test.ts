// The segment pass on live transcripts (`live.ts`): once, across a restart, before a compaction,
// and never in the way when it fails.

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ChatRequest, ChatResponse, Completer } from "@miyoria/llm/llm";
import { SqliteStore } from "@miyoria/store";
import { type PersonId, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { compactIfNeeded } from "../../transcript/src/compact.js";
import { type TranscriptStore, transcriptTables } from "../../transcript/src/store.js";
import type { EntryInput } from "../../transcript/src/types.js";
import {
  type EpisodeSink,
  type LiveSegmentConfig,
  LiveSegments,
  type NotesStore,
  notesTables,
  personSubject,
  processedUpTo,
  type RebuildState,
  type SegmentEpisode,
} from "../src/index.js";
import { CHANNEL, fakeResolver, MINUTE, OWEN, scripted, T0, testClock } from "./helpers.js";

const SESSION = "s:channel";
const CONFIG: LiveSegmentConfig = {
  enabled: true,
  idleMs: 5 * MINUTE,
  maxLines: 40,
  compactionWaitMs: 200,
  retryMs: MINUTE,
  retryMaxMs: 10 * MINUTE,
  abandonLimit: 2,
  perTick: 4,
  purpose: "summarizer",
};
const DONE: RebuildState = {
  started_at: toTimestamp(T0 - 60 * MINUTE),
  since: toTimestamp(T0 - 24 * 60 * MINUTE),
  done_at: toTimestamp(T0 - 30 * MINUTE),
  upto: null,
};

const reply = (summary: string, text?: string) =>
  JSON.stringify({
    episode: { summary, importance: 0.5 },
    edits:
      text === undefined
        ? []
        : [{ op: "add", doc: "p1", section: "喜好", text, source: "本人說的", quote: text }],
    followups: [],
  });

const said = (content: string, person: PersonId = OWEN): EntryInput => ({
  kind: "other",
  person_id: person,
  author: "Owen",
  content,
});

function sink() {
  const episodes: SegmentEpisode[] = [];
  const s: EpisodeSink = {
    async episode(e) {
      episodes.push(e);
      return `ep${episodes.length}`;
    },
  };
  return { sink: s, episodes };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { force: true });
});

async function open(path = ":memory:", clock = testClock()) {
  const store = await SqliteStore.open(path, { plugins: [notesTables, transcriptTables], clock });
  const notes = store.plugin(notesTables) as NotesStore;
  const transcripts = store.plugin(transcriptTables) as TranscriptStore;
  return {
    store,
    notes,
    transcripts,
    clock,
    cursors: notes.cursors() as NonNullable<ReturnType<NotesStore["cursors"]>>,
  };
}

type Opened = Awaited<ReturnType<typeof open>>;

function live(
  o: Opened,
  router: Completer,
  options: {
    state?: RebuildState | null;
    episodes?: EpisodeSink;
    config?: Partial<LiveSegmentConfig>;
  } = {},
) {
  return new LiveSegments({
    transcripts: o.transcripts,
    notes: o.notes,
    episodes: options.episodes ?? null,
    cursor: o.cursors,
    router,
    resolver: fakeResolver(),
    now: o.clock.now,
    config: () => ({ ...CONFIG, ...options.config }),
    state: () => (options.state === undefined ? DONE : options.state),
  });
}

/** A model that fails every call. */
function failing() {
  let calls = 0;
  const router: Completer = {
    async complete(): Promise<ChatResponse> {
      calls += 1;
      throw new Error("provider down");
    },
  };
  return { router, calls: () => calls };
}

describe("LiveSegments", () => {
  it("passes a segment once it has ended, and only once", async () => {
    const o = await open();
    o.transcripts.append(SESSION, [said("我超愛吃拉麵"), said("每週都吃")], { context: CHANNEL });
    const model = scripted(reply("Owen 聊拉麵", "Owen 喜歡吃拉麵"));
    const s = sink();
    const pass = live(o, model.router, { episodes: s.sink });

    expect(await pass.tick()).toBe(0);
    expect(model.asked).toHaveLength(0);
    o.clock.tick(6 * MINUTE);
    expect(await pass.tick()).toBe(1);
    expect(await pass.tick()).toBe(0);
    expect(model.asked).toHaveLength(1);
    expect(s.episodes.map((e) => e.summary)).toEqual(["Owen 聊拉麵"]);
    expect(processedUpTo(o.cursors, SESSION)).toBe(2);
    expect(o.notes.lines(personSubject(OWEN), "owner").map((l) => l.text)).toEqual([
      "Owen 喜歡吃拉麵",
    ]);
    expect(pass.stats).toMatchObject({ passed: 1, failed: 0, missed: 0 });
    await o.store.close();
  });

  it("goes on after a restart from where it stopped, repeating nothing", async () => {
    const path = join(process.env.TMP ?? ".", `live-${process.pid}-${Date.now()}.db`);
    dirs.push(path, `${path}-wal`, `${path}-shm`);
    const clock = testClock();
    const first = await open(path, clock);
    first.transcripts.append(SESSION, [said("第一段:我在準備期中考")], { context: CHANNEL });
    clock.tick(20 * MINUTE);
    first.transcripts.append(SESSION, [said("第二段:我養了一隻貓")]);
    clock.tick(20 * MINUTE);
    // The first pass goes through; the second call fails, as a crash in the middle would.
    let calls = 0;
    const once: Completer = {
      async complete(purpose: string, request: ChatRequest): Promise<ChatResponse> {
        calls += 1;
        if (calls > 1) throw new Error("stopped");
        return scripted(reply("期中考")).router.complete(purpose, request);
      },
    };
    const before = live(first, once);
    await before.tick();
    expect(processedUpTo(first.cursors, SESSION)).toBe(1);
    await first.store.close();

    const again = await open(path, clock);
    const model = scripted(reply("養貓"));
    const after = live(again, model.router);
    expect(await after.tick()).toBe(1);
    expect(model.asked).toHaveLength(1);
    const asked = JSON.stringify(model.asked[0]?.messages);
    expect(asked).toContain("第二段");
    expect(asked).not.toContain("第一段");
    expect(processedUpTo(again.cursors, SESSION)).toBe(2);
    await again.store.close();
  });

  it("passes the lines a compaction is about to summarise before it summarises them", async () => {
    const o = await open();
    for (let i = 0; i < 6; i++) {
      o.transcripts.append(SESSION, [said(`第 ${i} 句,講一些拉麵店的事情`)], { context: CHANNEL });
      o.clock.tick(10_000);
    }
    const order: string[] = [];
    const model = scripted(reply("聊拉麵店"));
    const router: Completer = {
      async complete(purpose, request, signal) {
        order.push("pass");
        return model.router.complete(purpose, request, signal);
      },
    };
    const pass = live(o, router);
    // Still going on: the tick leaves it alone.
    expect(await pass.tick()).toBe(0);
    const made = await compactIfNeeded(o.transcripts, SESSION, {
      thresholdTokens: 20,
      keepTokens: 10,
      before: (upto) => pass.beforeCompaction(SESSION, upto),
      summarise: async () => {
        order.push("summarise");
        return "summary";
      },
    });
    expect(made).not.toBeNull();
    expect(order).toEqual(["pass", "summarise"]);
    expect(processedUpTo(o.cursors, SESSION)).toBeGreaterThanOrEqual(made?.upto_seq ?? 0);
    await o.store.close();
  });

  it("does not hold a compaction past its wait, and counts the miss", async () => {
    const o = await open();
    o.transcripts.append(SESSION, [said("我在準備期中考"), said("好累")], { context: CHANNEL });
    const hung: Completer = { complete: () => new Promise<ChatResponse>(() => undefined) };
    const pass = live(o, hung);
    const started = Date.now();
    expect(await pass.beforeCompaction(SESSION, 2)).toBe("late");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(pass.stats.missed).toBe(1);
    await o.store.close();
  });

  it("retries a failed pass later with a backoff, and a compaction meanwhile does not wait", async () => {
    const o = await open();
    o.transcripts.append(SESSION, [said("我在準備期中考")], { context: CHANNEL });
    const down = failing();
    const pass = live(o, down.router);
    expect(await pass.beforeCompaction(SESSION, 1)).toBe("failed");
    expect(down.calls()).toBe(1);
    expect(pass.retryAt(SESSION)).toBe(o.clock.now() + MINUTE);
    // On the backoff: no call, and the compaction is told at once.
    expect(await pass.beforeCompaction(SESSION, 1)).toBe("failed");
    o.clock.tick(6 * MINUTE);
    await pass.tick();
    expect(down.calls()).toBe(2);
    // The second failure doubles the wait.
    expect(pass.retryAt(SESSION)).toBe(o.clock.now() + 2 * MINUTE);
    expect(pass.stats).toMatchObject({ failed: 2, missed: 2 });
    expect(processedUpTo(o.cursors, SESSION)).toBe(0);
    await o.store.close();
  });

  it("skips a segment whose reply is unusable too many times in a row", async () => {
    const o = await open();
    o.transcripts.append(SESSION, [said("我在準備期中考")], { context: CHANNEL });
    o.clock.tick(6 * MINUTE);
    const model = scripted("不是 JSON", "還是不是", "依然不是", "也不是");
    const pass = live(o, model.router);
    await pass.tick();
    expect(processedUpTo(o.cursors, SESSION)).toBe(0);
    o.clock.tick(2 * MINUTE);
    await pass.tick();
    expect(processedUpTo(o.cursors, SESSION)).toBe(1);
    expect(pass.stats).toMatchObject({ abandoned: 2, skipped: 1 });
    await o.store.close();
  });

  it("runs nothing before the rebuild has finished", async () => {
    const o = await open();
    o.transcripts.append(SESSION, [said("我在準備期中考")], { context: CHANNEL });
    o.clock.tick(6 * MINUTE);
    const model = scripted();
    const pass = live(o, model.router, {
      state: { ...DONE, done_at: null },
    });
    expect(await pass.tick()).toBe(0);
    expect(await pass.beforeCompaction(SESSION, 1)).toBe("off");
    expect(model.asked).toHaveLength(0);
    await o.store.close();
  });

  it("starts a session it has not read after the newest line the rebuild read", async () => {
    const o = await open();
    o.transcripts.append(SESSION, [said("重建讀過的話")], { context: CHANNEL });
    const upto = toTimestamp(o.clock.now());
    o.clock.tick(MINUTE);
    o.transcripts.append(SESSION, [said("重建之後的話")]);
    o.clock.tick(6 * MINUTE);
    const model = scripted(reply("之後的事"));
    const pass = live(o, model.router, { state: { ...DONE, upto } });
    expect(await pass.tick()).toBe(1);
    const asked = JSON.stringify(model.asked[0]?.messages);
    expect(asked).toContain("重建之後的話");
    expect(asked).not.toContain("重建讀過的話");
    await o.store.close();
  });

  it("does not read a session without a place (a helper's)", async () => {
    const o = await open();
    o.transcripts.append("helper", [said("幫我查一下")]);
    o.clock.tick(6 * MINUTE);
    const model = scripted();
    expect(await live(o, model.router).tick()).toBe(0);
    expect(model.asked).toHaveLength(0);
    await o.store.close();
  });
});
