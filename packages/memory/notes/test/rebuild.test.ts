// `miyoria memory rebuild` underneath: the plan from the event log, its estimate, and a run with a
// scripted model on a real store (progress kept in `event_cursors`).

import type { ChatRequest, ChatResponse, Completer } from "@miyoria/llm/llm";
import { SqliteStore } from "@miyoria/store";
import { type ContextKey, type IncomingMessage, type PersonId, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { memoryTables } from "../../memory/src/tables.js";
import {
  applyRebuild,
  estimateRebuild,
  notesTables,
  planRebuild,
  REBUILD_CONSUMER,
  type RebuildPlan,
  rebuildEpisodeSink,
  rebuildState,
  switched,
  THINKING_REPLY_TOKENS,
} from "../src/index.js";
import { personSubject } from "../src/store.js";

const P = "p";
const T0 = Date.UTC(2026, 10, 1, 12);
const MIN = 60_000;
const GUILD: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const DM: ContextKey = { platform: "discord", scope: null, channel: "d1", kind: "dm" };
const OWEN = { account: { platform: "discord", id: "100" }, display_name: "Owen", is_bot: false };
const HER = { account: { platform: "discord", id: "999" }, display_name: "Miyori", is_bot: false };
const SINCE = toTimestamp(T0 - 24 * 60 * MIN);
/** One model call costs exactly 1 USD at this price. */
const PRICE = { input_per_mtok: 10_000, cached_input_per_mtok: null, output_per_mtok: 0 };

let clockNow = T0;
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  clockNow = T0;
});

async function open() {
  const store = await SqliteStore.open(":memory:", {
    plugins: [notesTables, memoryTables],
    clock: { now: () => clockNow },
  });
  stores.push(store);
  return store;
}

let nextId = 0;
function say(store: SqliteStore, context: ContextKey, minutes: number, text: string, self = false) {
  const message: IncomingMessage = {
    id: { context, id: `m${++nextId}` },
    author: self ? HER : OWEN,
    text,
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(T0 + minutes * MIN),
  };
  store.chat.message(message, { self, source: "platform.discord" });
}

/** Two sessions: the channel in two bursts, a DM in one. */
function seed(store: SqliteStore) {
  for (let i = 0; i < 4; i++) say(store, GUILD, i, `我喜歡拉麵 ${i}`);
  say(store, GUILD, 4, "那你要去試試", true);
  for (let i = 0; i < 3; i++) say(store, GUILD, 30 + i, `昨天又去吃了 ${i}`);
  for (let i = 0; i < 3; i++) say(store, DM, 60 + i, `私訊的拉麵話題 ${i}`);
}

/** A model that answers each call with an episode and one added line about the first speaker. */
function modelFor(plan: RebuildPlan, from = 0) {
  const asked: ChatRequest[] = [];
  let call = from;
  const router: Completer = {
    async complete(_purpose: string, request: ChatRequest): Promise<ChatResponse> {
      asked.push(request);
      const planned = plan.segments[call++];
      if (planned === undefined) throw new Error("the scripted model has no more replies");
      const first = planned.segment.entries.find((e) => e.kind === "other");
      if (first === undefined) throw new Error("no line to quote");
      const text = JSON.stringify({
        episode: {
          summary: `p1 說:${first.content}`,
          who: ["p1"],
          feeling: "開心",
          importance: 0.6,
        },
        edits: [
          {
            op: "add",
            doc: "p1",
            section: "喜好",
            text: `p1 說:${first.content}`,
            source: "本人說的",
            quote: first.content,
            seq: first.seq,
          },
        ],
        followups: [],
      });
      return {
        text,
        reasoning: "",
        tool_calls: [],
        finish_reason: "stop",
        usage: { prompt_tokens: 100, completion_tokens: 40, cached_prompt_tokens: null },
      };
    },
  };
  return { router, asked };
}

async function run(store: SqliteStore, plan: RebuildPlan, maxUsd: number, model = modelFor(plan)) {
  const notes = store.plugin(notesTables);
  const cursors = notes.cursors();
  if (cursors === null) throw new Error("no cursors");
  return applyRebuild(plan, {
    router: model.router,
    notes,
    episodes: rebuildEpisodeSink(store, P, notes.resolver(), plan),
    cursor: cursors,
    price: PRICE,
    maxUsd,
    marker: { settings: store.settings, profile: P },
    wallClock: () => Date.UTC(2026, 10, 16, 3),
  });
}

const records = (store: SqliteStore) =>
  store.plugin(memoryTables).list(P, {
    subject: null,
    scope: null,
    kind: null,
    before: null,
    include_superseded: true,
    limit: 100,
  });
const episodes = async (store: SqliteStore) =>
  (await records(store)).filter((r) => r.kind === "episode");

describe("planning a rebuild", () => {
  it("groups the chat lines into sessions and segments and estimates the cost", async () => {
    const store = await open();
    seed(store);
    const cursors = store.plugin(notesTables).cursors();
    if (cursors === null) throw new Error("no cursors");
    const plan = await planRebuild(store.events, cursors, { since: SINCE });
    expect(plan.sessions).toHaveLength(2);
    expect(plan.lines).toBe(11);
    expect(plan.segments).toHaveLength(3);
    expect(plan.segments.map((s) => s.lines)).toEqual([5, 3, 3]);

    const unknown = estimateRebuild(plan, null);
    expect(unknown).toMatchObject({ segments: 3, lines: 11, usd: null });
    expect(unknown.prompt_tokens).toBeGreaterThan(0);
    expect(unknown.completion_tokens).toBeGreaterThan(0);
    const priced = estimateRebuild(plan, PRICE);
    expect(priced.usd).toBeGreaterThan(0);
    // A model that thinks first is billed for the thinking too: about ten times the output.
    const thinking = estimateRebuild(plan, PRICE, "medium");
    expect(thinking.prompt_tokens).toBe(priced.prompt_tokens);
    expect(thinking.completion_tokens).toBe(3 * THINKING_REPLY_TOKENS);
    expect(thinking.completion_tokens).toBeGreaterThan(5 * priced.completion_tokens);
    const output = { ...PRICE, output_per_mtok: 10_000 };
    expect(estimateRebuild(plan, output, "medium").usd).toBeGreaterThan(
      estimateRebuild(plan, output).usd ?? Number.POSITIVE_INFINITY,
    );
    expect(estimateRebuild(plan, PRICE, "off")).toEqual(priced);

    const later = await planRebuild(store.events, cursors, { since: toTimestamp(T0 + 45 * MIN) });
    expect(later.segments).toHaveLength(1);
    expect(later.lines).toBe(3);
  });

  it("changes nothing", async () => {
    const store = await open();
    seed(store);
    const notes = store.plugin(notesTables);
    const cursors = notes.cursors();
    if (cursors === null) throw new Error("no cursors");
    await planRebuild(store.events, cursors, { since: SINCE });
    expect(notes.list("owner")).toEqual([]);
    expect(await episodes(store)).toEqual([]);
    expect(cursors.get(REBUILD_CONSUMER, "discord:g1:c1")).toBe(0);
  });
});

describe("running a rebuild", () => {
  it("writes the lines and the episodes, and a second run has nothing left", async () => {
    const store = await open();
    seed(store);
    const notes = store.plugin(notesTables);
    const cursors = notes.cursors();
    if (cursors === null) throw new Error("no cursors");
    const plan = await planRebuild(store.events, cursors, { since: SINCE });
    const report = await run(store, plan, 100);
    expect(report).toMatchObject({
      status: "done",
      segments: 3,
      total: 3,
      written: 3,
      episodes: 3,
    });
    expect(report.usage).toEqual({ calls: 3, prompt_tokens: 300, completion_tokens: 120 });
    expect(report.usd).toBeCloseTo(3);

    const owen = store.persons.personOf(OWEN.account)?.id as PersonId;
    expect(
      notes
        .lines(personSubject(owen), "owner")
        .map((l) => l.text)
        .sort(),
    ).toEqual(
      ["Owen 說:我喜歡拉麵 0", "Owen 說:昨天又去吃了 0", "Owen 說:私訊的拉麵話題 0"].sort(),
    );
    expect(await episodes(store)).toHaveLength(3);

    const again = await planRebuild(store.events, cursors, { since: SINCE });
    expect(again.segments).toHaveLength(0);
  });

  it("stops at the budget and goes on from there in the next run", async () => {
    const store = await open();
    seed(store);
    const notes = store.plugin(notesTables);
    const cursors = notes.cursors();
    if (cursors === null) throw new Error("no cursors");
    const plan = await planRebuild(store.events, cursors, { since: SINCE });
    const first = await run(store, plan, 1.5);
    expect(first).toMatchObject({ status: "budget", segments: 2, total: 3 });
    expect(first.usd).toBeCloseTo(2);
    expect(await episodes(store)).toHaveLength(2);

    // The next run plans only what is left and needs one call.
    const rest = await planRebuild(store.events, cursors, { since: SINCE });
    expect(rest.segments).toHaveLength(1);
    const second = await run(store, rest, 100, modelFor(plan, 2));
    expect(second).toMatchObject({ status: "done", segments: 1, episodes: 1 });
    expect(await episodes(store)).toHaveLength(3);
  });

  it("records its start, and its end only once a run has handled the whole plan", async () => {
    const store = await open();
    seed(store);
    const notes = store.plugin(notesTables);
    const cursors = notes.cursors();
    if (cursors === null) throw new Error("no cursors");
    expect(await rebuildState(store.settings, P)).toBeNull();
    const plan = await planRebuild(store.events, cursors, { since: SINCE });
    expect(plan.upto).not.toBeNull();
    await run(store, plan, 1.5);
    const started = await rebuildState(store.settings, P);
    expect(started).toMatchObject({ since: SINCE, done_at: null, upto: null });
    expect(switched(started)).toBe(false);

    const rest = await planRebuild(store.events, cursors, { since: SINCE });
    await run(store, rest, 100, modelFor(plan, 2));
    const done = await rebuildState(store.settings, P);
    expect(switched(done)).toBe(true);
    expect(done?.started_at).toBe(started?.started_at);
    expect(done?.upto).toBe(plan.upto);
  });

  it("goes on after a model error from the segment it stopped at", async () => {
    const store = await open();
    seed(store);
    const notes = store.plugin(notesTables);
    const cursors = notes.cursors();
    if (cursors === null) throw new Error("no cursors");
    const plan = await planRebuild(store.events, cursors, { since: SINCE });
    const broken = modelFor(plan);
    let calls = 0;
    const flaky: Completer = {
      complete: (purpose, request, signal) => {
        if (++calls === 2) throw new Error("provider down");
        return broken.router.complete(purpose, request, signal);
      },
    };
    const first = await run(store, plan, 100, { router: flaky, asked: [] });
    expect(first.status).toBe("error");
    expect(first.error).toContain("provider down");
    expect(first.segments).toBe(1);
    const rest = await planRebuild(store.events, cursors, { since: SINCE });
    expect(rest.segments).toHaveLength(2);
    const second = await run(store, rest, 100, modelFor(rest));
    expect(second).toMatchObject({ status: "done", segments: 2 });
  });

  it("closes in the order of history a follow-up a later segment answered", async () => {
    const store = await open();
    seed(store);
    const notes = store.plugin(notesTables);
    const cursors = notes.cursors();
    if (cursors === null) throw new Error("no cursors");
    const plan = await planRebuild(store.events, cursors, { since: SINCE });
    const replies = [
      { followups: [{ who: "p1", about: "問 Owen 有沒有去吃那家拉麵", due_in_hours: 48 }] },
      { close: [{ id: "f1", reason: "他說昨天又去吃了" }] },
      {},
    ];
    const asked: ChatRequest[] = [];
    const router: Completer = {
      async complete(_purpose: string, request: ChatRequest): Promise<ChatResponse> {
        asked.push(request);
        return {
          text: JSON.stringify(replies.shift() ?? {}),
          reasoning: "",
          tool_calls: [],
          finish_reason: "stop",
          usage: { prompt_tokens: 100, completion_tokens: 40, cached_prompt_tokens: null },
        };
      },
    };
    const report = await run(store, plan, 100, { router, asked });
    expect(report.status).toBe("done");
    expect(String(asked[1]?.messages[1]?.content)).toContain("f1 追問:問 Owen 有沒有去吃那家拉麵");
    const followups = (await records(store)).filter((r) => r.kind === "followup");
    expect(followups).toEqual([
      expect.objectContaining({
        content: "問 Owen 有沒有去吃那家拉麵",
        done: true,
        created_at: toTimestamp(T0 + 4 * MIN),
        updated_at: toTimestamp(T0 + 32 * MIN),
      }),
    ]);
  });

  it("never deletes or supersedes what was there", async () => {
    const store = await open();
    seed(store);
    const notes = store.plugin(notesTables);
    const owen = store.persons.personOf(OWEN.account)?.id as PersonId;
    notes.apply(
      personSubject(owen),
      [
        {
          op: "add",
          section: "likes",
          text: "本來就有的一行",
          provenance: "told_by_subject",
          scope: { type: "public" },
        },
      ],
      { author: "tool" },
    );
    const cursors = notes.cursors();
    if (cursors === null) throw new Error("no cursors");
    const plan = await planRebuild(store.events, cursors, { since: SINCE });
    await run(store, plan, 100);
    const lines = notes.lines(personSubject(owen), "owner");
    expect(lines.map((l) => l.text)).toContain("本來就有的一行");
    expect(lines).toHaveLength(4);
    expect(notes.lines(personSubject(owen), "owner", { outdated: true })).toHaveLength(4);
    expect((await records(store)).filter((r) => r.superseded_by !== null)).toEqual([]);
  });
});
