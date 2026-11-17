import { fileURLToPath } from "node:url";
import type { Embedder } from "@miyoria/memory/memory";
import { describe, expect, it } from "vitest";
import {
  formatRecallReport,
  formatSweep,
  loadRecallSet,
  memorySuite,
  type QueryResult,
  type RecallResult,
  RecallSetError,
  RecallSetSchema,
  type Returned,
  runRecall,
  scoreRecall,
  sweepRecall,
  visibleAt,
} from "../src/recall/index.js";

const EXAMPLE = fileURLToPath(new URL("../sets/recall.example.json", import.meta.url));

const lobby = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const dm = { platform: "discord", scope: null, channel: "dm1", kind: "dm" };
const alice = { platform: "discord", id: "1" };
const guild = { type: "guild", platform: "discord", guild: "g1" };

function memory(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: "fact",
    content: `content of ${id}`,
    scope: guild,
    at: "2026-10-01T00:00:00Z",
    ...fields,
  };
}

function query(
  id: string,
  relevant: string[],
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    text: "a line",
    place: { context: lobby },
    at: "2026-11-01T00:00:00Z",
    relevant,
    ...fields,
  };
}

const ranked = (...ids: string[]): Returned[] => ids.map((id, i) => ({ id, score: 1 - i * 0.1 }));

describe("recall set schema", () => {
  it("accepts a minimal set and fills the defaults", () => {
    const set = RecallSetSchema.parse({
      memories: [memory("m1")],
      queries: [query("q1", ["m1"]), query("q2", [])],
    });
    expect(set.memories[0]).toMatchObject({
      subjects: [],
      importance: 0.5,
      confidence: 0.8,
      superseded_by: null,
    });
    expect(set.queries[0]).toMatchObject({ context: [], people: [] });
    expect(set.queries[0]?.place.accounts).toEqual([]);
  });

  it("accepts every scope shape", () => {
    const scopes = [
      { type: "global" },
      guild,
      { type: "channel", context: lobby },
      { type: "dm", account: alice },
      { type: "person", person: "p_a" },
    ];
    const set = RecallSetSchema.parse({
      memories: scopes.map((scope, i) => memory(`m${i}`, { scope })),
      queries: [query("q1", [])],
    });
    expect(set.memories.map((m) => m.scope.type)).toEqual([
      "global",
      "guild",
      "channel",
      "dm",
      "person",
    ]);
  });

  const bad: [string, unknown][] = [
    ["no memories", { memories: [], queries: [query("q1", [])] }],
    [
      "an unknown kind",
      { memories: [memory("m1", { kind: "rumour" })], queries: [query("q1", [])] },
    ],
    [
      "an unknown scope",
      { memories: [memory("m1", { scope: { type: "server" } })], queries: [query("q1", [])] },
    ],
    [
      "a guild scope without its guild",
      {
        memories: [memory("m1", { scope: { type: "guild", platform: "discord" } })],
        queries: [query("q1", [])],
      },
    ],
    [
      "a time that does not parse",
      { memories: [memory("m1", { at: "yesterday" })], queries: [query("q1", [])] },
    ],
    [
      "importance out of range",
      { memories: [memory("m1", { importance: 2 })], queries: [query("q1", [])] },
    ],
    [
      "a duplicate memory id",
      { memories: [memory("m1"), memory("m1")], queries: [query("q1", [])] },
    ],
    [
      "a duplicate query id",
      { memories: [memory("m1")], queries: [query("q1", []), query("q1", [])] },
    ],
    ["an unknown relevant id", { memories: [memory("m1")], queries: [query("q1", ["m9"])] }],
    [
      "an unknown superseding memory",
      { memories: [memory("m1", { superseded_by: "m9" })], queries: [query("q1", [])] },
    ],
    [
      "five context lines",
      {
        memories: [memory("m1")],
        queries: [query("q1", [], { context: ["1", "2", "3", "4", "5"] })],
      },
    ],
    [
      "a query before the newest memory",
      { memories: [memory("m1")], queries: [query("q1", [], { at: "2026-09-01T00:00:00Z" })] },
    ],
    [
      "talking with someone absent",
      { memories: [memory("m1")], queries: [query("q1", [], { talking_with: ["p_a"] })] },
    ],
    [
      "a query without a place",
      { memories: [memory("m1")], queries: [{ ...query("q1", []), place: undefined }] },
    ],
    ["an unknown field", { memories: [memory("m1", { text: "x" })], queries: [query("q1", [])] }],
  ];
  it.each(bad)("rejects %s", (_name, set) => {
    expect(RecallSetSchema.safeParse(set).success).toBe(false);
  });

  it("loads the example set", () => {
    const set = loadRecallSet(EXAMPLE);
    expect(set.memories.length).toBeGreaterThanOrEqual(30);
    expect(set.queries.length).toBeGreaterThanOrEqual(15);
    expect(set.queries.filter((q) => q.relevant.length === 0).length).toBeGreaterThanOrEqual(2);
  });

  it("names the file it cannot read", () => {
    expect(() => loadRecallSet(`${EXAMPLE}.missing`)).toThrow(RecallSetError);
  });
});

describe("recall metrics", () => {
  const set = RecallSetSchema.parse({
    memories: ["a", "b", "c", "d", "e", "f"].map((id) => memory(id)),
    queries: [
      query("q1", ["a", "b"]),
      query("q2", ["c"]),
      query("q3", ["d"]),
      query("q4", []),
      query("q5", []),
    ],
  });

  it("matches a hand-computed case", () => {
    const metrics = scoreRecall(
      set,
      new Map([
        // a first, b fourth: 1/2 at 1 and 3, 2/2 at 5; reciprocal rank 1.
        ["q1", ranked("a", "e", "f", "b")],
        // c second: 0 at 1, 1 from 3 on; reciprocal rank 1/2.
        ["q2", ranked("e", "c")],
        // d never: 0 everywhere. q3 is left out of the map: it got nothing.
        // q4 expects nothing and got nothing; q5 expects nothing and got two.
        ["q4", []],
        ["q5", ranked("e", "f")],
      ]),
    );
    expect(metrics.queries).toBe(5);
    expect(metrics.with_relevant).toBe(3);
    expect(metrics.nothing).toBe(2);
    expect(metrics.recall_at?.["1"]).toBeCloseTo((0.5 + 0 + 0) / 3);
    expect(metrics.recall_at?.["3"]).toBeCloseTo((0.5 + 1 + 0) / 3);
    expect(metrics.recall_at?.["5"]).toBeCloseTo((1 + 1 + 0) / 3);
    expect(metrics.recall_at?.["8"]).toBeCloseTo((1 + 1 + 0) / 3);
    expect(metrics.mrr).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(metrics.nothing_returned_rate).toBe(0.5);
    expect(metrics.nothing_mean_returned).toBe(1);
    expect(metrics.leaks).toBe(0);
    const q1 = metrics.per_query[0] as QueryResult;
    expect(q1.recall_at).toEqual({ "1": 0.5, "3": 0.5, "5": 1, "8": 1 });
    expect(q1.reciprocal_rank).toBe(1);
    expect(metrics.per_query[3]).toMatchObject({ recall_at: null, reciprocal_rank: null });
  });

  it("takes other k values and has no averages without queries of a kind", () => {
    const only = RecallSetSchema.parse({ memories: [memory("a")], queries: [query("q1", [])] });
    const metrics = scoreRecall(only, new Map(), [2]);
    expect(metrics.ks).toEqual([2]);
    expect(metrics.recall_at).toBeNull();
    expect(metrics.mrr).toBeNull();
    expect(metrics.nothing_returned_rate).toBe(1);
  });

  it("keeps ids and scores only", () => {
    const metrics = scoreRecall(set, new Map([["q1", ranked("a")]]));
    expect(JSON.stringify(metrics)).not.toContain("content of");
  });
});

describe("scope leaks", () => {
  const place = { context: lobby, accounts: [alice] } as never;
  const dmPlace = { context: dm, accounts: [alice] } as never;

  it("decides visibility from the scope and the place", () => {
    expect(visibleAt({ type: "global" }, place, [])).toBe(true);
    expect(visibleAt({ type: "guild", platform: "discord", guild: "g1" }, place, [])).toBe(true);
    expect(visibleAt({ type: "guild", platform: "discord", guild: "g2" }, place, [])).toBe(false);
    expect(visibleAt({ type: "guild", platform: "discord", guild: "g1" }, dmPlace, [])).toBe(false);
    expect(visibleAt({ type: "channel", context: lobby as never }, place, [])).toBe(true);
    expect(
      visibleAt({ type: "channel", context: { ...lobby, channel: "c2" } as never }, place, []),
    ).toBe(false);
    // A DM memory: never in a channel, even with its account there; only in that account's DM.
    expect(visibleAt({ type: "dm", account: alice }, place, [])).toBe(false);
    expect(visibleAt({ type: "dm", account: alice }, dmPlace, [])).toBe(true);
    expect(visibleAt({ type: "dm", account: { platform: "discord", id: "2" } }, dmPlace, [])).toBe(
      false,
    );
    expect(visibleAt({ type: "person", person: "p_a" }, place, ["p_a"])).toBe(true);
    expect(visibleAt({ type: "person", person: "p_a" }, place, ["p_b"])).toBe(false);
  });

  it("counts what a leaking retrieval returns", () => {
    const set = RecallSetSchema.parse({
      memories: [
        memory("here"),
        memory("other_guild", { scope: { type: "guild", platform: "discord", guild: "g2" } }),
        memory("private", { scope: { type: "dm", account: alice } }),
        memory("someone", { scope: { type: "person", person: "p_a" } }),
        memory("old", { superseded_by: "here" }),
      ],
      queries: [
        query("in_channel", ["here"], { place: { context: lobby, accounts: [alice] } }),
        query("in_dm", ["private"], { place: { context: dm, accounts: [alice] }, people: ["p_a"] }),
      ],
    });
    // A retrieval with no scope filter at all: every memory, for every query.
    const everything = ranked("here", "other_guild", "private", "someone", "old", "not_in_set");
    const metrics = scoreRecall(
      set,
      new Map([
        ["in_channel", everything],
        ["in_dm", everything],
      ]),
    );
    expect(metrics.per_query[0]?.leaks).toEqual([
      "other_guild",
      "private",
      "someone",
      "old",
      "not_in_set",
    ]);
    // In the DM the guild memories are the leaks; the DM and the person memory are visible.
    expect(metrics.per_query[1]?.leaks).toEqual(["here", "other_guild", "old", "not_in_set"]);
    expect(metrics.leaks).toBe(9);

    const clean = scoreRecall(set, new Map([["in_channel", ranked("here")]]));
    expect(clean.leaks).toBe(0);
  });
});

/**
 * A deterministic embedder: signed hashes of character bigrams, plus one strong dimension per
 * group of words that mean the same thing, so a paraphrase lands next to its memory and texts
 * that share nothing stay far apart.
 */
class ConceptEmbedder implements Embedder {
  readonly name = "concepts";
  readonly enabled = true;
  readonly embeddingModel = "concepts|v1";
  calls = 0;
  static readonly GROUPS: readonly (readonly string[])[] = [
    ["芫荽", "香菜"],
    ["caffeine", "咖啡"],
    ["科系", "主修"],
    ["稱呼", "叫做"],
  ];
  static readonly HASHED = 64;

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((text) => ConceptEmbedder.vector(text));
  }

  static vector(text: string): number[] {
    const hashed = new Array<number>(ConceptEmbedder.HASHED).fill(0);
    const chars = [...text.toLowerCase()];
    for (let i = 0; i + 1 < chars.length; i++) {
      let h = 2166136261;
      for (const c of `${chars[i]}${chars[i + 1]}`) {
        h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 16777619) >>> 0;
      }
      const slot = h % ConceptEmbedder.HASHED;
      hashed[slot] = (hashed[slot] ?? 0) + ((h >>> 8) % 2 === 0 ? 1 : -1);
    }
    const norm = Math.sqrt(hashed.reduce((n, x) => n + x * x, 0)) || 1;
    const concepts = ConceptEmbedder.GROUPS.map((words) =>
      words.some((w) => text.toLowerCase().includes(w)) ? 3 : 0,
    );
    return [...hashed.map((x) => x / norm), ...concepts];
  }
}

const EXACT = [
  "q_exact_dog",
  "q_exact_song",
  "q_exact_rust",
  "q_exact_minecraft",
  "q_person_peanut_present",
  "q_dm_quit_in_dm",
  "q_guild_maimai",
  "q_channel_rule",
];
const PARAPHRASES = ["q_para_cilantro", "q_para_caffeine", "q_para_major", "q_para_nickname"];

function byId(result: RecallResult, id: string): QueryResult {
  const found = result.per_query.find((q) => q.id === id);
  if (!found) throw new Error(`no query ${id}`);
  return found;
}

const found = (q: QueryResult): boolean =>
  q.relevant.every((id) => q.returned.some((r) => r.id === id));

describe("recall harness on the example set", () => {
  const set = loadRecallSet(EXAMPLE);

  it("runs without an embedder: exact words hit, nothing leaks", async () => {
    const result = await runRecall(set);
    expect(result.embedder).toBeNull();
    expect(result.memories).toBe(set.memories.length);
    expect(result.per_query.map((q) => q.id)).toEqual(set.queries.map((q) => q.id));
    expect(result.leaks).toBe(0);
    for (const id of EXACT) expect(found(byId(result, id)), id).toBe(true);
    // A superseded record never comes back, and chatter with nobody around recalls nothing.
    for (const q of result.per_query) {
      expect(q.returned.map((r) => r.id)).not.toContain("m_yuki_home_old");
      expect(q.returned.length).toBeLessThanOrEqual(result.limit);
      const scores = q.returned.map((r) => r.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    }
    expect(byId(result, "q_nothing_chatter").returned).toEqual([]);
    expect(byId(result, "q_dm_quit_in_channel").returned.map((r) => r.id)).not.toContain(
      "m_amei_quit_dm",
    );
    expect(result.recall_at?.["8"]).toBeGreaterThan(0.5);
    expect(result.mrr).toBeGreaterThan(0);
    // Ids and numbers only.
    expect(JSON.stringify(result)).not.toMatch(/[一-鿿]/);
  });

  it("gives the same result when run again", async () => {
    const a = await runRecall(set);
    const b = await runRecall(set);
    expect(b.per_query).toEqual(a.per_query);
  });

  it("uses the vectors of an embedder: paraphrases are found, nothing leaks", async () => {
    const embedder = new ConceptEmbedder();
    const result = await runRecall(set, { embedder });
    expect(result.embedder).toBe("concepts|v1");
    expect(result.embedding_failures).toBe(0);
    expect(result.leaks).toBe(0);
    for (const id of [...EXACT, ...PARAPHRASES]) expect(found(byId(result, id)), id).toBe(true);
    const plain = await runRecall(set);
    expect(result.recall_at?.["8"]).toBeGreaterThanOrEqual(plain.recall_at?.["8"] ?? 1);
  });

  it("applies config overrides", async () => {
    const strict = await runRecall(set, { config: { min_score: 5 } });
    expect(strict.config.min_score).toBe(5);
    expect(strict.per_query.every((q) => q.returned.length === 0)).toBe(true);
    expect(strict.recall_at?.["8"]).toBe(0);
    expect(strict.nothing_returned_rate).toBe(1);

    const one = await runRecall(set, { ks: [1], config: { recall_limit: 1 } });
    expect(one.limit).toBe(1);
    expect(Object.keys(one.recall_at ?? {})).toEqual(["1"]);
    expect(one.per_query.every((q) => q.returned.length <= 1)).toBe(true);
  });

  it("sweeps configs and embeds the set once", async () => {
    const embedder = new ConceptEmbedder();
    const rows = await sweepRecall(
      set,
      [
        { name: "default", config: {} },
        { name: "min_vector 0.99", config: { min_vector: 0.99 } },
        { name: "min_score 5", config: { min_score: 5 } },
      ],
      { embedder },
    );
    expect(rows.map((r) => r.name)).toEqual(["default", "min_vector 0.99", "min_score 5"]);
    expect(rows[2]?.recall_at?.["8"]).toBe(0);
    expect(rows[0]?.recall_at?.["8"]).toBeGreaterThan(rows[1]?.recall_at?.["8"] ?? 1);
    expect(rows.every((r) => r.leaks === 0)).toBe(true);
    const single = new ConceptEmbedder();
    await runRecall(set, { embedder: single });
    expect(embedder.calls).toBe(single.calls);
    expect(formatSweep(rows).split("\n")).toHaveLength(4);
  });

  it("prints a report without any memory content", async () => {
    const text = formatRecallReport(await runRecall(set));
    expect(text).toContain("recall@5");
    expect(text).toContain("scope leaks: 0");
    expect(text).toContain("q_exact_dog");
    expect(text).not.toMatch(/[一-鿿]/);
  });

  it("is callable as the suite `memory`", async () => {
    const { headline, detail } = await memorySuite({ setPath: EXAMPLE });
    expect(Object.keys(headline).sort()).toEqual([
      "leaks",
      "mrr",
      "nothing_mean_returned",
      "nothing_returned_rate",
      "recall@5",
    ]);
    expect(headline.leaks).toBe(0);
    expect((detail as RecallResult).per_query).toHaveLength(set.queries.length);
  });
});

describe("recall harness on her notes", () => {
  const set = loadRecallSet(EXAMPLE);

  it("asks the notes by words, and nothing leaks", async () => {
    const result = await runRecall(set, { target: "notes" });
    expect(result.target).toBe("notes");
    expect(result.embedder).toBeNull();
    expect(result.per_query.map((q) => q.id)).toEqual(set.queries.map((q) => q.id));
    expect(result.leaks).toBe(0);
    for (const q of result.per_query) {
      expect(q.returned.map((r) => r.id)).not.toContain("m_yuki_home_old");
      const scores = q.returned.map((r) => r.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    }
    expect(byId(result, "q_dm_quit_in_channel").returned.map((r) => r.id)).not.toContain(
      "m_amei_quit_dm",
    );
    expect(formatRecallReport(result)).toContain("target notes");
    expect(JSON.stringify(result)).not.toMatch(/[一-鿿]/);
  });

  it("with an embedder finds paraphrases by meaning, and nothing leaks", async () => {
    const embedder = new ConceptEmbedder();
    const result = await runRecall(set, { target: "notes", embedder });
    const plain = await runRecall(set, { target: "notes" });
    expect(result.embedder).toBe("concepts|v1");
    expect(result.embedding_failures).toBe(0);
    expect(result.leaks).toBe(0);
    for (const id of PARAPHRASES) {
      expect(found(byId(plain, id)), id).toBe(false);
      expect(found(byId(result, id)), id).toBe(true);
    }
    expect(result.recall_at?.["5"]).toBeGreaterThan(plain.recall_at?.["5"] ?? 1);
  });

  it("is the suite `memory` with the target notes", async () => {
    const { headline, detail } = await memorySuite({
      setPath: EXAMPLE,
      embedder: new ConceptEmbedder(),
      target: "notes",
    });
    expect(headline.leaks).toBe(0);
    expect(headline["recall@5"]).toBeGreaterThan(0);
    expect((detail as RecallResult).target).toBe("notes");
    // How many lines the "nothing to recall" questions get, from `recall` and in the prompt.
    expect(headline.nothing_mean_returned).toBeGreaterThanOrEqual(0);
    expect(headline.block_nothing_mean_returned).toBeLessThanOrEqual(
      headline.nothing_mean_returned ?? 0,
    );
    expect(headline["block_recall@5"]).toBeLessThanOrEqual(headline["recall@5"] ?? 0);
  });

  it("cuts by the precision rules: the floor, and the block's separation check", async () => {
    const open = await runRecall(set, {
      target: "notes",
      config: { notes_recall: { min_score: 0, min_gap: 0 } },
    });
    const floor = await runRecall(set, {
      target: "notes",
      config: { notes_recall: { min_score: 2 } },
    });
    expect(floor.per_query.every((q) => q.returned.length === 0)).toBe(true);
    expect(open.block?.nothing_mean_returned).toBe(open.nothing_mean_returned);
    const strict = await runRecall(set, {
      target: "notes",
      config: { notes_recall: { min_score: 0, min_gap: 5 } },
    });
    expect(strict.block?.nothing_mean_returned).toBe(0);
    expect(strict.block?.recall_at?.["5"]).toBe(0);
    expect(strict.recall_at).toEqual(open.recall_at);
    expect(formatRecallReport(strict)).toContain("prompt block:");
  });
});
