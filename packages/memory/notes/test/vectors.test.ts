// Embeddings of her documents' lines (`vectors.ts`, `rank.ts`), with an embedder that makes
// vectors from a small table of concepts: two texts that share a concept and no word are close.

import { describe, expect, it } from "vitest";
import type { Embedder } from "../../memory/src/embed.js";
import { NoEmbedder } from "../../memory/src/embed.js";
import {
  type LineInput,
  NotesIndex,
  NotesSearch,
  type NotesStore,
  type NotesViewer,
  personSubject,
  rebuildVectors,
  topicSubject,
  type VectorWait,
} from "../src/index.js";
import { DEFAULT_RANKING } from "../src/rank.js";
import { OWEN, ROOM, rig, SPACE } from "./helpers.js";

/** Words that stand for a concept; a text's vector counts them, plus a small constant. */
const CONCEPTS: readonly (readonly string[])[] = [
  ["貓", "喵"],
  ["拉麵", "吃"],
  ["唱歌", "音樂", "歌"],
  ["考試", "期末"],
];

function meaning(text: string): number[] {
  const v = CONCEPTS.map((words) => words.reduce((n, w) => n + text.split(w).length - 1, 0));
  return [...v, 0.1];
}

/** A deterministic embedder; `delayMs` makes every call that slow, `failAfter` fails later calls. */
class FakeEmbedder implements Embedder {
  readonly name = "fake";
  readonly embeddingModel: string;
  enabled = true;
  calls: string[][] = [];
  delayMs = 0;
  failAfter = Number.POSITIVE_INFINITY;

  constructor(model = "fake|concepts") {
    this.embeddingModel = model;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    if (this.calls.length > this.failAfter) throw new Error("the embedder is down");
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return texts.map(meaning);
  }
}

const WAIT: VectorWait = { text: 200, voice: 50 };
const channel: NotesViewer = { space: SPACE, room: ROOM, dm: null, present: [OWEN] };
const OWEN_DOC = personSubject(OWEN);
const tool = { author: "tool" as const };
const line = (text: string, section = "喜好"): LineInput => ({
  section,
  text,
  provenance: "told_by_subject",
  told_by: OWEN,
  scope: { type: "space", space: SPACE },
});

function searchOver(notes: NotesStore, embedder: Embedder | null) {
  const index = embedder === null ? null : new NotesIndex({ notes, embedder });
  const search = new NotesSearch({
    notes,
    index,
    ranking: () => DEFAULT_RANKING,
    wait: () => WAIT,
  });
  return { index, search };
}

const texts = (hits: readonly { line: { text: string } }[]) => hits.map((h) => h.line.text);

describe("notes by meaning", () => {
  it("finds a line that shares no word with the query", async () => {
    const { notes, store } = await rig();
    try {
      const { index, search } = searchOver(notes, new FakeEmbedder());
      notes.add(OWEN_DOC, line("Owen 養了一隻貓"), tool);
      notes.add(OWEN_DOC, line("Owen 喜歡吃拉麵"), tool);
      await index?.idle();
      expect(index?.counts()).toEqual({ lines: 2, vectors: 2, waiting: 0 });

      // Words alone find nothing.
      expect(notes.searchLines("喵喵叫的寵物", channel)).toEqual([]);
      expect(notes.search("喵喵叫的寵物", channel)).toEqual([]);

      expect(texts(await search.lines("喵喵叫的寵物", channel))).toEqual(["Owen 養了一隻貓"]);
      const docs = await search.documents("喵喵叫的寵物", channel);
      expect(docs.map((d) => d.document.subject)).toEqual([OWEN_DOC]);
      expect(docs[0]?.matches.map((l) => l.text)).toEqual(["Owen 養了一隻貓"]);

      // A card puts the line close in meaning first.
      const vector = await search.vector("喵喵叫的寵物");
      expect(vector).not.toBeNull();
      const card = notes.card(OWEN_DOC, channel, {
        query: "喵喵叫的寵物",
        ...search.cardOptions(vector),
      });
      expect(card).toBe("喜好:Owen 養了一隻貓;Owen 喜歡吃拉麵");
      // Without the vector the newest comes first, as before.
      expect(notes.card(OWEN_DOC, channel, { query: "喵喵叫的寵物" })).toBe(
        "喜好:Owen 喜歡吃拉麵;Owen 養了一隻貓",
      );
      // A line kept to another place is not found there.
      const elsewhere: NotesViewer = { space: "other", room: null, dm: null, present: [] };
      expect(await search.lines("喵喵叫的寵物", elsewhere)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("follows a line that is rewritten, outdated or redacted", async () => {
    const { notes, store } = await rig();
    try {
      const embedder = new FakeEmbedder();
      const { index, search } = searchOver(notes, embedder);
      const cat = notes.add(OWEN_DOC, line("Owen 養了一隻貓"), tool);
      await index?.idle();
      expect(texts(await search.lines("喵喵叫的寵物", channel))).toEqual(["Owen 養了一隻貓"]);

      // Rewritten: the old line loses its vector, the new one gets one.
      const sings = notes.replace(OWEN_DOC, cat.id, { text: "Owen 每天都在唱歌" }, tool);
      await index?.idle();
      expect(index?.counts()).toEqual({ lines: 1, vectors: 1, waiting: 0 });
      expect(await search.lines("喵喵叫的寵物", channel)).toEqual([]);
      expect(texts(await search.lines("聽音樂", channel))).toEqual(["Owen 每天都在唱歌"]);

      // Outdated: gone from vectors and from search.
      notes.outdate(OWEN_DOC, sings.id, "not true", tool);
      expect(index?.counts()).toEqual({ lines: 0, vectors: 0, waiting: 0 });
      expect(await search.lines("聽音樂", channel)).toEqual([]);

      // Redacted: the same.
      const exam = notes.add(
        OWEN_DOC,
        { ...line("Owen 下週期末考"), evidence: [{ quote: "下週期末考", message_id: "m9" }] },
        tool,
      );
      await index?.idle();
      expect(texts(await search.lines("要考試了", channel))).toEqual(["Owen 下週期末考"]);
      notes.redactEvidence({ message_id: "m9" });
      expect(notes.line(exam.id)?.redacted).toBe(true);
      expect(index?.counts()).toEqual({ lines: 0, vectors: 0, waiting: 0 });
      expect(await search.lines("要考試了", channel)).toEqual([]);
      const rows = store.db.all("SELECT line_id FROM notes_vectors");
      expect(rows).toEqual([]);

      // A revert brings a line back into use: it is embedded again.
      notes.revert(OWEN_DOC, 1, tool);
      await index?.idle();
      expect(texts(await search.lines("喵喵叫的寵物", channel))).toEqual(["Owen 養了一隻貓"]);

      // Forgetting the person takes the vectors with the lines.
      notes.forgetPerson([OWEN]);
      expect(store.db.all("SELECT line_id FROM notes_vectors")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("without an embedder, searches by words exactly as the store does", async () => {
    const { notes, store } = await rig();
    try {
      for (const embedder of [null, new NoEmbedder()]) {
        const { index, search } = searchOver(notes, embedder);
        notes.add(OWEN_DOC, line("Owen 養了一隻貓"), tool);
        notes.add(topicSubject("拉麵店"), { ...line("車站前那家拉麵店很好吃", "重點") }, tool);
        await index?.idle();
        expect(store.db.all("SELECT line_id FROM notes_vectors")).toEqual([]);
        expect(await search.vector("拉麵")).toBeNull();
        for (const query of ["喵喵叫的寵物", "拉麵", "Owen 的貓"]) {
          expect(await search.documents(query, channel)).toEqual(notes.search(query, channel));
          expect(await search.documents(query, channel, { kind: "topic", limit: 3 })).toEqual(
            notes.search(query, channel, { kind: "topic", limit: 3 }),
          );
          expect(notes.card(OWEN_DOC, channel, { query, ...search.cardOptions(null) })).toBe(
            notes.card(OWEN_DOC, channel, { query }),
          );
        }
        index?.close();
      }
    } finally {
      store.close();
    }
  });

  it("fills missing vectors in the background, and goes on after a restart", async () => {
    const { notes, store } = await rig();
    try {
      // Written while embeddings were off.
      for (let i = 0; i < 5; i++) notes.add(OWEN_DOC, line(`Owen 的貓第 ${i} 隻`), tool);
      const first = new FakeEmbedder();
      const before = new NotesIndex({ notes, embedder: first, batch: 2 });
      expect(before.counts()).toEqual({ lines: 5, vectors: 0, waiting: 5 });
      expect(await before.backfill(2)).toBe(2);
      expect(before.counts().waiting).toBe(3);
      before.close();

      // A new process: the embedder fails on its second call; the first batch is kept.
      const flaky = new FakeEmbedder();
      flaky.failAfter = 1;
      const middle = new NotesIndex({ notes, embedder: flaky, batch: 2 });
      expect(await middle.backfill(10)).toBe(2);
      expect(middle.counts().waiting).toBe(1);
      middle.close();

      // Another model's vectors count as missing.
      const other = new NotesIndex({ notes, embedder: new FakeEmbedder("fake|other"), batch: 2 });
      expect(other.counts()).toEqual({ lines: 5, vectors: 0, waiting: 5 });
      other.close();

      const after = new NotesIndex({ notes, embedder: new FakeEmbedder(), batch: 2 });
      const report = await rebuildVectors(after);
      expect(report).toEqual({ done: 1, waiting: 0, status: "done" });
      expect(after.counts()).toEqual({ lines: 5, vectors: 5, waiting: 0 });
      // Nothing left: nothing is embedded again.
      expect(await after.backfill(10)).toBe(0);
      after.close();
    } finally {
      store.close();
    }
  });

  it("goes on with words when the query's vector is late, and keeps it for next time", async () => {
    const { notes, store } = await rig();
    try {
      const embedder = new FakeEmbedder();
      const { index, search } = searchOver(notes, embedder);
      notes.add(OWEN_DOC, line("Owen 養了一隻貓"), tool);
      notes.add(OWEN_DOC, line("Owen 的寵物叫小花"), tool);
      await index?.idle();

      embedder.delayMs = 1_000;
      const started = Date.now();
      const hits = await search.lines("喵喵叫的寵物", channel, { voice: true });
      const took = Date.now() - started;
      // The voice wait (50 ms) and the search, nowhere near the embedder's second.
      expect(took).toBeLessThan(400);
      // Words alone: the line sharing 寵物.
      expect(texts(hits)).toEqual(["Owen 的寵物叫小花"]);

      // Text waits 200 ms: still late, still words.
      expect(texts(await search.lines("喵喵叫的寵物", channel))).toEqual(["Owen 的寵物叫小花"]);

      // Once the vector has come, the same query reads meaning at once.
      await new Promise((r) => setTimeout(r, 1_100));
      embedder.delayMs = 0;
      const again = Date.now();
      const later = await search.lines("喵喵叫的寵物", channel, { voice: true });
      expect(Date.now() - again).toBeLessThan(100);
      expect(texts(later)).toContain("Owen 養了一隻貓");

      // An aborted turn does not wait at all.
      embedder.delayMs = 1_000;
      const abort = new AbortController();
      abort.abort();
      expect(await search.vector("別的問題", { signal: abort.signal })).toBeNull();
    } finally {
      store.close();
    }
  });

  it("does not hold up a write, and an embedder that is down leaves lines for the backfill", async () => {
    const { notes, store } = await rig();
    try {
      const embedder = new FakeEmbedder();
      embedder.failAfter = 0;
      const index = new NotesIndex({ notes, embedder });
      notes.add(OWEN_DOC, line("Owen 養了一隻貓"), tool);
      // The write returned before anything was embedded.
      expect(embedder.calls).toEqual([]);
      await index.idle();
      expect(embedder.calls).toHaveLength(1);
      expect(index.counts()).toEqual({ lines: 1, vectors: 0, waiting: 1 });
      embedder.failAfter = Number.POSITIVE_INFINITY;
      expect(await index.backfill(10)).toBe(1);
      expect(index.counts().waiting).toBe(0);
      index.close();
    } finally {
      store.close();
    }
  });
});
