import { MemorySettingsStore } from "@miyoria/store";
import { newId, type Thought, type ThoughtDigest, toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { DIGEST_PREFIX, Journal, ruleDigest, THOUGHT_PREFIX } from "../src/index.js";

function thought(i: number): Thought {
  return {
    id: newId(),
    at: toTimestamp(Date.parse("2026-11-02T12:00:00Z") + i * 60_000),
    triggers: [],
    thought: `想法 ${i}`,
    changes: [],
    intents: [
      {
        id: `i${i}`,
        capability: "chat.start",
        args: {},
        why: "",
        opening: null,
        context: null,
        about: null,
        expires_at: toTimestamp(0),
        status: i % 2 === 0 ? "done" : "dropped",
        detail: null,
        turn: null,
        decisions: [],
        said: null,
      },
    ],
    tokens: null,
    error: null,
    ms: 0,
  };
}

describe("journal compaction", () => {
  it("keeps a bounded number of raw thoughts and condenses the rest into digests", async () => {
    const store = new MemorySettingsStore();
    const condensed: Thought[][] = [];
    const journal = new Journal(store, "p", 5, () => {}, {
      batch: 3,
      digestsKeep: 2,
      condense: async (thoughts): Promise<ThoughtDigest> => {
        condensed.push(thoughts);
        return {
          ...ruleDigest(thoughts),
          summary: `整理了 ${thoughts.length} 個`,
          by: "summarizer",
        };
      },
    });
    let maxRaw = 0;
    for (let i = 0; i < 30; i++) {
      await journal.add(thought(i));
      maxRaw = Math.max(maxRaw, journal.size);
    }
    await journal.settle();
    // Never more than keep + batch - 1 raw.
    expect(maxRaw).toBeLessThanOrEqual(5 + 3 - 1);
    expect(journal.size).toBeLessThanOrEqual(7);
    const raw = await store.list("p", THOUGHT_PREFIX);
    expect(raw.size).toBe(journal.size);
    expect(journal.recent(1)[0]?.thought).toBe("想法 29");
    // Every retired thought went into a digest, oldest first; only the newest digests stay.
    expect(condensed.flat().map((t) => t.thought)).toEqual(
      Array.from({ length: 30 - journal.size }, (_, i) => `想法 ${i}`),
    );
    const digests = journal.digests();
    expect(digests).toHaveLength(2);
    expect((await store.list("p", DIGEST_PREFIX)).size).toBe(2);
    expect(digests[0]?.summary).toMatch(/^整理了 3 個$/);
    expect(digests[0]?.intents).toMatchObject({});
  });

  it("falls back to a plain digest when condensing fails, and reloads both", async () => {
    const store = new MemorySettingsStore();
    const journal = new Journal(store, "p", 2, () => {}, {
      batch: 1,
      digestsKeep: 10,
      condense: async () => {
        throw new Error("no model");
      },
    });
    for (let i = 0; i < 4; i++) await journal.add(thought(i));
    await journal.settle();
    const [d] = journal.digests();
    expect(d?.by).toBe("rule");
    expect(d?.summary).toContain("想法 1");
    expect(Object.values(d?.intents ?? {}).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    const again = new Journal(store, "p", 2, () => {}, {
      batch: 1,
      digestsKeep: 10,
      condense: async (t) => ruleDigest(t),
    });
    await again.load();
    expect(again.size).toBe(2);
    expect(again.digests().length).toBe(journal.digests().length);
  });
});

describe("journal detail", () => {
  it("only the newest thoughts keep what they saw and the reasoning, also in the store", async () => {
    const store = new MemorySettingsStore();
    const journal = new Journal(store, "p", 10, () => {}, null, 2);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = { ...thought(i), reasoning: `推理 ${i}`, input: { world: `世界 ${i}` } as never };
      ids.push(t.id);
      await journal.add(t);
    }
    await journal.flush();
    const kept = journal.list(10).map((t) => [t.thought, t.reasoning ?? null]);
    expect(kept).toEqual([
      ["想法 3", "推理 3"],
      ["想法 2", "推理 2"],
      ["想法 1", null],
      ["想法 0", null],
    ]);
    const stored = await store.get("p", `${THOUGHT_PREFIX}${ids[0]}`);
    expect(stored).toMatchObject({ input: null, reasoning: null, thought: "想法 0" });
  });
});
