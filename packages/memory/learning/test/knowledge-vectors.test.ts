// The knowledge section of a prompt over her notes with embeddings on (`notes/src/vectors.ts`): a
// topic close in meaning to the line comes in without its name being said, and a query vector
// that is late leaves the section as it is by words, within the wait.

import { MockProvider } from "@miyoria/llm/llm";
import type { Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import { afterEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../memory/src/embed.js";
import { DEFAULT_RANKING } from "../../notes/src/rank.js";
import { notesTables } from "../../notes/src/store.js";
import { NotesIndex, NotesSearch, NotesSearchKey } from "../../notes/src/vectors.js";
import { request, rig, stopRigs, TEXT, VOICE } from "./helpers.js";

/** Vectors from two concepts: noodles and cats. */
class Concepts implements Embedder {
  readonly name = "concepts";
  readonly enabled = true;
  readonly embeddingModel = "concepts|1";
  delayMs = 0;

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return texts.map((t) => [
      ["麵", "拉麵"].filter((w) => t.includes(w)).length,
      ["貓"].filter((w) => t.includes(w)).length,
      0.1,
    ]);
  }
}

const stores: SqliteStore[] = [];
afterEach(async () => {
  await stopRigs();
  for (const s of stores.splice(0)) await s.close();
});

async function setUp(withSearch: boolean) {
  const store = await SqliteStore.open(":memory:", { plugins: [notesTables] });
  stores.push(store);
  const notes = store.plugin(notesTables);
  const embedder = new Concepts();
  const index = new NotesIndex({ notes, embedder });
  const add = (subject: string, text: string) =>
    notes.add(
      subject,
      { section: "重點", text, provenance: "observed", scope: { type: "public" } },
      { author: "tool" },
      subject.slice("topic:".length),
    );
  add("topic:車站前的店", "那家拉麵湯頭很濃");
  add("topic:咖啡廳", "二樓有很多貓");
  await index.idle();
  const search = new NotesSearch({
    notes,
    index,
    ranking: () => DEFAULT_RANKING,
    wait: () => ({ text: 200, voice: 50 }),
  });
  const r = await rig({
    provider: new MockProvider("p"),
    modules: ["knowledge"],
    extra: async (sup: Supervisor) => {
      sup.services.provide("app", StoreKey, store);
      if (withSearch) sup.services.provide("app", NotesSearchKey, search);
    },
  });
  return { r, embedder };
}

const asking = (context: typeof TEXT, query: string) => ({ ...request(context), query });

describe("the knowledge section with embeddings on", () => {
  it("brings in a topic close in meaning to the line", async () => {
    const { r } = await setUp(true);
    const body = (await r.contribute("knowledge", asking(TEXT, "肚子好餓想吃麵"))) ?? "";
    expect(body).toContain("那家拉麵湯頭很濃");
    expect(body).not.toContain("二樓有很多貓");
  });

  it("without the search, by words as before", async () => {
    const { r } = await setUp(false);
    const body = (await r.contribute("knowledge", asking(TEXT, "肚子好餓想吃麵"))) ?? "";
    expect(body).not.toContain("那家拉麵湯頭很濃");
  });

  it("a voice turn does not wait for a late vector", async () => {
    const { r, embedder } = await setUp(true);
    embedder.delayMs = 1_000;
    const started = Date.now();
    const body = (await r.contribute("knowledge", asking(VOICE, "肚子好餓想吃麵"))) ?? "";
    expect(Date.now() - started).toBeLessThan(400);
    expect(body).not.toContain("那家拉麵湯頭很濃");
  });
});
