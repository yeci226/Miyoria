import type { ChatRequest, ChatResponse, Completer } from "@miyoria/llm/llm";
import { currentLlmTag, withLlmTag } from "@miyoria/llm/llm";
import { describe, expect, it } from "vitest";
import {
  checkReply,
  groupByScope,
  type LineInput,
  mergedEvidence,
  mergedSource,
  type NoteDocument,
  type NoteLine,
  type NoteScope,
  NotesError,
  type NotesStore,
  personSubject,
  placeSubject,
  SELF_SUBJECT,
  sameScope,
  TIDIED_REASON,
  TIDY_REASON,
  type TidyConfig,
  tidyMessage,
  tidyNotes,
  tidyPrompt,
} from "../src/index.js";
import { BEN, MINUTE, OWEN, rig, SESSION, SPACE, testClock } from "./helpers.js";

const OWEN_DOC = personSubject(OWEN);
const inSpace: NoteScope = { type: "space", space: SPACE };
const inDm: NoteScope = { type: "dm", person: OWEN };
const own: NoteScope = { type: "self" };
const write = { author: "segment" as const };

const CONFIG: Partial<TidyConfig> = { min_group_lines: 3, documents_per_night: 20 };

/** Adds lines one by one, a minute apart, so they read back in a known order. */
function addLines(
  notes: NotesStore,
  clock: ReturnType<typeof testClock>,
  subject: string,
  lines: Array<Partial<LineInput> & { text: string; scope: NoteScope }>,
): NoteLine[] {
  return lines.map((l, i) => {
    clock.tick(MINUTE);
    return notes.add(
      subject,
      {
        section: "近況",
        provenance: "told_by_subject",
        told_by: OWEN,
        evidence: [
          {
            quote: l.text,
            person_id: OWEN,
            session: SESSION,
            seq_from: i + 1,
            message_id: `m${i}`,
          },
        ],
        ...l,
      },
      write,
    );
  });
}

/** The lines shown in a tidy message: ref, section label, text. */
function shown(request: ChatRequest): Array<{ ref: string; section: string; text: string }> {
  const content = request.messages[1]?.content;
  const body = typeof content === "string" ? content : "";
  const out: Array<{ ref: string; section: string; text: string }> = [];
  let section = "";
  for (const row of body.split("\n")) {
    const head = row.match(/^【(.+)】$/);
    if (head) section = head[1] ?? "";
    const m = row.match(/^- (L\d+) (.*)\([^(]*\)$/);
    if (m) out.push({ ref: m[1] ?? "", section, text: m[2] ?? "" });
  }
  return out;
}

/** Keeps every line but merges the first two shown into one shorter line. */
function mergeFirstTwo(request: ChatRequest): string {
  const lines = shown(request);
  const [a, b, ...rest] = lines;
  if (a === undefined || b === undefined) return JSON.stringify({ lines: [] });
  return JSON.stringify({
    lines: [
      {
        section: a.section,
        text: `合併:${[...a.text].slice(0, 6).join("")}`,
        from: [a.ref, b.ref],
      },
      ...rest.map((r) => ({ section: r.section, text: r.text, from: [r.ref] })),
    ],
  });
}

/** Writes every line back as it was. */
function unchanged(request: ChatRequest): string {
  return JSON.stringify({
    lines: shown(request).map((r) => ({ section: r.section, text: r.text, from: [r.ref] })),
  });
}

/** A model that answers through `reply`, recording what it was asked. */
function model(
  reply: (request: ChatRequest, n: number) => string,
  options: { cost?: number | null; tokens?: number } = {},
) {
  const asked: ChatRequest[] = [];
  const router: Completer = {
    async complete(_purpose: string, request: ChatRequest): Promise<ChatResponse> {
      asked.push(request);
      const tokens = options.tokens ?? 140;
      // What the router does for a priced call: tell the tag what it cost once it ended.
      if (options.cost !== undefined && options.cost !== null) {
        currentLlmTag()?.onCall?.({
          id: `c${asked.length}`,
          cost_usd: options.cost,
          status: "done",
        });
      }
      return {
        text: reply(request, asked.length),
        reasoning: "",
        tool_calls: [],
        finish_reason: "stop",
        usage: { prompt_tokens: tokens - 40, completion_tokens: 40, cached_prompt_tokens: null },
      };
    },
  };
  return { router, asked };
}

/** Owen's document with six lines in the server, four in his DM and three of her own. */
function mixedDocument(notes: NotesStore, clock: ReturnType<typeof testClock>) {
  addLines(notes, clock, OWEN_DOC, [
    { text: "伺服器:Owen 在練鋼琴", scope: inSpace },
    { text: "伺服器:Owen 每天練鋼琴", scope: inSpace },
    { text: "伺服器:Owen 想學爵士鋼琴", scope: inSpace },
    { text: "伺服器:Owen 在準備期末考", scope: inSpace },
    { text: "伺服器:Owen 期末考在下週", scope: inSpace },
    { text: "伺服器:Owen 養了一隻貓", scope: inSpace },
  ]);
  addLines(notes, clock, OWEN_DOC, [
    { text: "私訊:Owen 最近睡不好", scope: inDm },
    { text: "私訊:Owen 最近常失眠", scope: inDm },
    { text: "私訊:Owen 在考慮換工作", scope: inDm },
    { text: "私訊:Owen 不想讓同事知道", scope: inDm },
  ]);
  addLines(notes, clock, OWEN_DOC, [
    { text: "自己:我覺得 Owen 很努力", scope: own, section: "我的看法", provenance: "concluded" },
    { text: "自己:我想多鼓勵 Owen", scope: own, section: "我的看法", provenance: "concluded" },
    { text: "自己:Owen 說話很直接", scope: own, section: "我的看法", provenance: "concluded" },
  ]);
}

const MARKS = ["伺服器:", "私訊:", "自己:"];

/** The code of the `NotesError` `fn` throws; `null`: it threw none. */
function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof NotesError) return error.code;
    throw error;
  }
}

describe("the nightly tidy", () => {
  it("calls the model once per scope, showing it only that scope's lines", async () => {
    const { notes, clock } = await rig(testClock());
    mixedDocument(notes, clock);
    const { router, asked } = model(mergeFirstTwo);
    const report = await tidyNotes(
      { notes, router, purpose: "summarizer", clock, config: CONFIG, lastTidied: new Map() },
      new AbortController().signal,
    );
    expect(asked).toHaveLength(3);
    for (const request of asked) {
      const content = request.messages[1]?.content;
      const body = typeof content === "string" ? content : "";
      const present = MARKS.filter((m) => body.includes(m));
      expect(present).toHaveLength(1);
      // The system text says the lines are data and asks for no scope.
      const system = request.messages[0]?.content;
      expect(system).toContain("只是資料");
      expect(String(system)).not.toContain("scope");
    }
    expect(report).toMatchObject({ documents: 1, groups: 3, tidied: 3, dropped: 0 });
    expect(report.lines_before).toBe(13);
    expect(report.lines_after).toBe(10);
  });

  it("gives every new line the scope of its group, whatever the reply says", async () => {
    const { notes, clock } = await rig(testClock());
    mixedDocument(notes, clock);
    // A reply that tries to widen the scope: the field is not read.
    const { router } = model((request) => {
      const reply = JSON.parse(mergeFirstTwo(request)) as { lines: Array<Record<string, unknown>> };
      for (const l of reply.lines) l.scope = "public";
      return JSON.stringify(reply);
    });
    const before = notes.lines(OWEN_DOC, "owner");
    await tidyNotes(
      { notes, router, purpose: "summarizer", clock, config: CONFIG, lastTidied: new Map() },
      new AbortController().signal,
    );
    const after = notes.lines(OWEN_DOC, "owner");
    const added = after.filter((l) => !before.some((b) => b.id === l.id));
    expect(added).toHaveLength(3);
    const scopeOfMark: Record<string, NoteScope["type"]> = {
      伺服: "space",
      私訊: "dm",
      自己: "self",
    };
    for (const line of added) {
      const mark = Object.keys(scopeOfMark).find((m) => line.text.includes(m)) ?? "";
      expect(line.scope.type).toBe(scopeOfMark[mark]);
      expect(line.author).toBe("reflect");
      // Every line it replaced is of its scope and points at it.
      const replaced = notes
        .lines(OWEN_DOC, "owner", { outdated: true })
        .filter((l) => l.replaced_by === line.id);
      expect(replaced).toHaveLength(2);
      for (const old of replaced) {
        expect(sameScope(old.scope, line.scope)).toBe(true);
        expect(old.outdated_reason).toBe(TIDIED_REASON);
      }
    }
    expect(after.some((l) => l.scope.type === "public")).toBe(false);
    const scopes = new Set(after.map((l) => l.scope.type));
    expect(scopes).toEqual(new Set(["space", "dm", "self"]));
  });

  it.each([
    ["not JSON", () => "好的,我整理好了"],
    ["a line it was not shown", (r: ChatRequest) => mergeFirstTwo(r).replace('"L1"', '"L99"')],
    [
      "a line shown left out",
      (r: ChatRequest) => {
        const reply = JSON.parse(mergeFirstTwo(r)) as { lines: unknown[] };
        return JSON.stringify({ lines: reply.lines.slice(0, -1) });
      },
    ],
    [
      "more lines than before",
      (r: ChatRequest) => {
        const lines = shown(r);
        return JSON.stringify({
          lines: [
            ...lines.map((l) => ({ section: l.section, text: "短", from: [l.ref] })),
            { section: lines[0]?.section, text: "多的", from: [] },
          ],
        });
      },
    ],
    [
      "longer than it was",
      (r: ChatRequest) =>
        JSON.stringify({
          lines: shown(r).map((l) => ({
            section: l.section,
            text: `${l.text},而且還多寫了很多很多很多很多字`,
            from: [l.ref],
          })),
        }),
    ],
    [
      "a section the lines are not in",
      (r: ChatRequest) => mergeFirstTwo(r).replace(/"section":"[^"]+"/, '"section":"梗"'),
    ],
    [
      "a line over the length limit",
      (r: ChatRequest) => {
        const lines = shown(r);
        return JSON.stringify({
          lines: [
            { section: lines[0]?.section, text: "長".repeat(201), from: lines.map((l) => l.ref) },
          ],
        });
      },
    ],
    ["no lines at all", () => JSON.stringify({ lines: [] })],
  ])("leaves the document as it was for a reply with %s", async (_name, reply) => {
    const { notes, clock } = await rig(testClock());
    mixedDocument(notes, clock);
    const version = notes.document(OWEN_DOC)?.version;
    const before = notes
      .lines(OWEN_DOC, "owner", { outdated: true })
      .map((l) => [l.id, l.outdated_at]);
    const { router, asked } = model(reply);
    const report = await tidyNotes(
      { notes, router, purpose: "summarizer", clock, config: CONFIG, lastTidied: new Map() },
      new AbortController().signal,
    );
    expect(asked).toHaveLength(3);
    expect(report.tidied).toBe(0);
    expect(report.dropped).toBe(3);
    expect(report.details.map((d) => d.outcome)).toEqual(["invalid", "invalid", "invalid"]);
    expect(notes.document(OWEN_DOC)?.version).toBe(version);
    expect(
      notes.lines(OWEN_DOC, "owner", { outdated: true }).map((l) => [l.id, l.outdated_at]),
    ).toEqual(before);
  });

  it("stops at its cap of tokens for a model with no price", async () => {
    const { notes, clock } = await rig(testClock());
    mixedDocument(notes, clock);
    const { router, asked } = model(mergeFirstTwo, { tokens: 140 });
    const report = await tidyNotes(
      {
        notes,
        router,
        purpose: "summarizer",
        clock,
        config: { ...CONFIG, budget_tokens: 200 },
        lastTidied: new Map(),
      },
      new AbortController().signal,
    );
    expect(asked).toHaveLength(2);
    expect(report.stopped).toBe("budget");
    expect(report.tidied).toBe(2);
    expect(report.unpriced_tokens).toBe(280);
  });

  it("stops at its cap in USD, and the caller's accounting still sees every call", async () => {
    const { notes, clock } = await rig(testClock());
    mixedDocument(notes, clock);
    const { router, asked } = model(mergeFirstTwo, { cost: 0.06 });
    const seen: Array<number | null> = [];
    const report = await withLlmTag({ onCall: (call) => seen.push(call.cost_usd) }, () =>
      tidyNotes(
        {
          notes,
          router,
          purpose: "summarizer",
          clock,
          config: { ...CONFIG, budget_usd: 0.1 },
          lastTidied: new Map(),
        },
        new AbortController().signal,
      ),
    );
    expect(asked).toHaveLength(2);
    expect(seen).toEqual([0.06, 0.06]);
    expect(report.stopped).toBe("budget");
    expect(report.cost_usd).toBeCloseTo(0.12);
    expect(report.unpriced_tokens).toBe(0);
  });

  it("stops when the caller's signal aborts (the nightly figure)", async () => {
    const { notes, clock } = await rig(testClock());
    mixedDocument(notes, clock);
    const controller = new AbortController();
    const { router, asked } = model((r, n) => {
      if (n === 1) controller.abort(new Error("budget"));
      return mergeFirstTwo(r);
    });
    const report = await tidyNotes(
      { notes, router, purpose: "summarizer", clock, config: CONFIG, lastTidied: new Map() },
      controller.signal,
    );
    expect(asked).toHaveLength(1);
    expect(report.stopped).toBe("aborted");
  });

  it("rotates: a document tidied and not changed since is not taken again", async () => {
    const { notes, clock } = await rig(testClock());
    const lines = (place: string) =>
      ["一", "二", "三", "四"].map((n) => ({
        text: `${place}的規矩${n}`,
        scope: inSpace,
        section: "規矩",
        told_by: null,
      }));
    addLines(notes, clock, placeSubject("a"), lines("甲"));
    addLines(notes, clock, placeSubject("b"), lines("乙"));
    const last = new Map<string, number>();
    const run = async () => {
      clock.tick(60 * MINUTE);
      const { router, asked } = model(unchanged);
      await tidyNotes(
        {
          notes,
          router,
          purpose: "summarizer",
          clock,
          config: { ...CONFIG, documents_per_night: 1 },
          lastTidied: last,
          tidied: (id, at) => last.set(id, at),
        },
        new AbortController().signal,
      );
      return asked.map((r) => shown(r)[0]?.text.slice(0, 1));
    };
    const first = await run();
    const second = await run();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second])).toEqual(new Set(["甲", "乙"]));
    // Both tidied, neither changed since: nothing to do.
    expect(await run()).toEqual([]);
    // One changes: it is taken again.
    addLines(notes, clock, placeSubject("a"), [
      { text: "甲的規矩五", scope: inSpace, section: "規矩", told_by: null },
    ]);
    expect(await run()).toEqual(["甲"]);
  });

  it("takes first the documents that need it most", async () => {
    const { notes, clock } = await rig(testClock());
    addLines(
      notes,
      clock,
      placeSubject("calm"),
      ["簡介一", "規矩二", "常客三", "梗四"].map((t) => ({
        text: `平靜:${t}`,
        scope: inSpace,
        told_by: null,
      })),
    );
    addLines(
      notes,
      clock,
      placeSubject("busy"),
      Array.from({ length: 10 }, (_, i) => ({
        text: `熱鬧:大家晚上會一起打遊戲${i % 2 === 0 ? "" : "喔"}`,
        scope: inSpace,
        told_by: null,
      })),
    );
    const { router, asked } = model(unchanged);
    await tidyNotes(
      {
        notes,
        router,
        purpose: "summarizer",
        clock,
        config: { ...CONFIG, documents_per_night: 1 },
        lastTidied: new Map(),
      },
      new AbortController().signal,
    );
    expect(asked).toHaveLength(1);
    expect(shown(asked[0] as ChatRequest)[0]?.text).toContain("熱鬧");
  });

  it("leaves a group below the minimum and her self document alone", async () => {
    const { notes, clock } = await rig(testClock());
    addLines(notes, clock, OWEN_DOC, [
      { text: "伺服器:一", scope: inSpace },
      { text: "伺服器:二", scope: inSpace },
      { text: "私訊:一", scope: inDm },
      { text: "私訊:二", scope: inDm },
      { text: "私訊:三", scope: inDm },
    ]);
    notes.rewriteSelf("最近:我在學新歌\n最近:我在學新的歌\n想法:我喜歡晚上\n想做的事:唱歌");
    const { router, asked } = model(unchanged);
    const report = await tidyNotes(
      { notes, router, purpose: "summarizer", clock, config: CONFIG, lastTidied: new Map() },
      new AbortController().signal,
    );
    expect(asked).toHaveLength(1);
    expect(shown(asked[0] as ChatRequest).map((l) => l.text.slice(0, 2))).toEqual([
      "私訊",
      "私訊",
      "私訊",
    ]);
    expect(report.documents).toBe(1);
    expect(notes.lines(SELF_SUBJECT, "owner")).toHaveLength(4);
  });

  it("keeps what it outdated in history, restorable by a revert", async () => {
    const { notes, clock } = await rig(testClock());
    mixedDocument(notes, clock);
    const before = notes
      .lines(OWEN_DOC, "owner")
      .map((l) => l.id)
      .sort();
    const version = notes.document(OWEN_DOC)?.version ?? 0;
    const { router } = model(mergeFirstTwo);
    await tidyNotes(
      { notes, router, purpose: "summarizer", clock, config: CONFIG, lastTidied: new Map() },
      new AbortController().signal,
    );
    const history = notes.history(OWEN_DOC).filter((h) => h.version > version);
    expect(history.length).toBeGreaterThan(0);
    expect(new Set(history.map((h) => h.author))).toEqual(new Set(["reflect"]));
    expect(history.filter((h) => h.op === "add").every((h) => h.reason === TIDY_REASON)).toBe(true);
    expect(history.filter((h) => h.op === "outdate").every((h) => h.reason === TIDIED_REASON)).toBe(
      true,
    );
    const outdated = notes
      .lines(OWEN_DOC, "owner", { outdated: true })
      .filter((l) => l.outdated_at !== null);
    expect(outdated).toHaveLength(6);
    notes.revert(OWEN_DOC, version, { author: "panel" });
    expect(
      notes
        .lines(OWEN_DOC, "owner")
        .map((l) => l.id)
        .sort(),
    ).toEqual(before);
  });

  it("merges to the most cautious source, keeps who told it, and carries the evidence over", async () => {
    const { notes, clock } = await rig(testClock());
    const [a, b, c] = addLines(notes, clock, OWEN_DOC, [
      { text: "Owen 會彈鋼琴", scope: inSpace, provenance: "told_by_subject", confidence: 0.9 },
      {
        text: "Owen 鋼琴應該彈很久了",
        scope: inSpace,
        provenance: "concluded",
        told_by: null,
        evidence: [],
      },
      { text: "Owen 喜歡蕭邦", scope: inSpace, provenance: "observed", told_by: null },
    ]);
    // Owen told one of them, the others rest on no one else: the merged line stays his.
    expect(mergedSource([a, b, c] as NoteLine[])).toEqual({
      provenance: "concluded",
      confidence: 0.4,
      told_by: OWEN,
    });
    const [group] = groupByScope(notes.lines(OWEN_DOC, "owner"));
    if (group === undefined) throw new Error("no group");
    const refs = group.lines.map((_, i) => `L${i + 1}`);
    const checked = checkReply(
      "person",
      group,
      { lines: [{ section: "近況", text: "Owen 彈鋼琴、喜歡蕭邦", from: refs }] },
      notes.limits,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const result = notes.merge(OWEN_DOC, checked.merges, {
      author: "reflect",
      reason: TIDY_REASON,
    });
    const added = result.applied.find((x) => x.op === "add");
    const line = added === undefined ? null : notes.line(added.line);
    expect(line).toMatchObject({ provenance: "concluded", told_by: OWEN, confidence: 0.4 });
    expect(line?.scope).toEqual(inSpace);
    expect(line?.evidence.map((e) => e.message_id).sort()).toEqual(["m0", "m2"]);
  });

  it("never merges what two different people told or said", async () => {
    const { notes, clock } = await rig(testClock());
    addLines(notes, clock, placeSubject("p1"), [
      // Two different tellers.
      { text: "Owen 說週五有聚會", scope: inSpace, provenance: "told_by_other", told_by: OWEN },
      {
        text: "Ben 說週五有聚會",
        scope: inSpace,
        provenance: "told_by_other",
        told_by: BEN,
        evidence: [{ quote: "週五聚會喔", person_id: BEN, session: SESSION, seq_from: 9 }],
      },
      // No teller, but backed by Ben's words, and one by Owen's.
      {
        text: "聚會在晚上",
        scope: inSpace,
        provenance: "observed",
        told_by: null,
        evidence: [{ quote: "晚上喔", person_id: BEN, session: SESSION, seq_from: 10 }],
      },
      { text: "聚會在晚上七點", scope: inSpace, provenance: "observed", told_by: null },
    ]);
    const [group] = groupByScope(notes.lines(placeSubject("p1"), "owner"));
    if (group === undefined) throw new Error("no group");
    // Newest first: L1 七點 (Owen's words), L2 晚上 (Ben's), L3 Ben told, L4 Owen told.
    const reply = (merged: string[]) => ({
      lines: [
        { section: "近況", text: "週五有聚會", from: merged },
        ...["L1", "L2", "L3", "L4"]
          .filter((r) => !merged.includes(r))
          .map((r) => ({
            section: "近況",
            text: group.lines[Number(r.slice(1)) - 1]?.text ?? "",
            from: [r],
          })),
      ],
    });
    expect(checkReply("place", group, reply(["L3", "L4"]), notes.limits)).toEqual({
      ok: false,
      why: "a line merges what different people told",
    });
    expect(checkReply("place", group, reply(["L1", "L2"]), notes.limits)).toEqual({
      ok: false,
      why: "a line merges what different people said",
    });
    // Ben told one, Ben's words back the other: one person, and the line stays his.
    const ok = checkReply("place", group, reply(["L2", "L3"]), notes.limits);
    expect(ok.ok).toBe(true);
    expect(ok.ok ? ok.merges[0]?.line.told_by : null).toBe(BEN);
    // The prompt tells the model who each line is from, by a letter, and not to merge them.
    const message = tidyMessage(notes.document(placeSubject("p1")) as NoteDocument, group);
    expect(message).toContain("L1 聚會在晚上七點(我看到的;來源 A)");
    expect(message).toContain("L2 聚會在晚上(我看到的;來源 B)");
    expect(message).not.toContain(OWEN);
    expect(tidyPrompt(200)).toContain("不同的人說的事不要合併成一條");
  });

  it("lets forgetting the person who told it remove a merged line", async () => {
    const { notes, clock } = await rig(testClock());
    const lines = addLines(notes, clock, placeSubject("p1"), [
      {
        text: "Ben 說這裡週五有聚會",
        scope: inSpace,
        provenance: "told_by_other",
        told_by: BEN,
        evidence: [{ quote: "週五聚會喔", person_id: BEN, session: SESSION, seq_from: 9 }],
      },
      {
        text: "這裡週五晚上有聚會",
        scope: inSpace,
        provenance: "observed",
        told_by: null,
        evidence: [],
      },
    ]);
    const result = notes.merge(
      placeSubject("p1"),
      [
        {
          from: lines.map((l) => l.id),
          line: {
            section: "近況",
            text: "週五晚上有聚會",
            ...mergedSource(lines),
            scope: inSpace,
            evidence: mergedEvidence(lines),
          },
        },
      ],
      { author: "reflect", reason: TIDY_REASON },
    );
    const added = result.applied.find((x) => x.op === "add")?.line ?? "";
    expect(notes.line(added)?.told_by).toBe(BEN);
    notes.forgetPerson([BEN]);
    expect(notes.line(added)).toBeNull();
    expect(notes.lines(placeSubject("p1"), "owner").map((l) => l.text)).toEqual([]);
    // What Ben did not tell is outdated, still there to restore.
    expect(notes.lines(placeSubject("p1"), "owner", { outdated: true }).map((l) => l.text)).toEqual(
      ["這裡週五晚上有聚會"],
    );
  });

  it("drops a source label the reply copied back, so a line kept word for word is unchanged", async () => {
    const { notes, clock } = await rig(testClock());
    addLines(notes, clock, OWEN_DOC, [
      { text: "Owen 喜歡貓", scope: inSpace },
      { text: "Owen 喜歡狗", scope: inSpace },
    ]);
    const [group] = groupByScope(notes.lines(OWEN_DOC, "owner"));
    if (group === undefined) throw new Error("no group");
    const checked = checkReply(
      "person",
      group,
      {
        lines: group.lines.map((l, i) => ({
          section: "近況",
          text: i === 0 ? `${l.text}(本人說的)` : `${l.text}（本人說的）`,
          from: [`L${i + 1}`],
        })),
      },
      notes.limits,
    );
    expect(checked).toEqual({ ok: true, merges: [], after: 2 });
  });

  it("refuses a merge whose evidence would not fit the store's cap", async () => {
    const { notes, clock } = await rig(testClock(), { evidencePerLine: 2 });
    addLines(notes, clock, OWEN_DOC, [
      { text: "一", scope: inSpace },
      { text: "二", scope: inSpace },
      { text: "三", scope: inSpace },
    ]);
    const [group] = groupByScope(notes.lines(OWEN_DOC, "owner"));
    if (group === undefined) throw new Error("no group");
    const checked = checkReply(
      "person",
      group,
      { lines: [{ section: "近況", text: "一二三", from: ["L1", "L2", "L3"] }] },
      notes.limits,
    );
    expect(checked.ok).toBe(false);
  });
});

describe("NotesStore.merge", () => {
  it("refuses to merge lines of another scope", async () => {
    const { notes, clock } = await rig(testClock());
    const [s, d] = addLines(notes, clock, OWEN_DOC, [
      { text: "伺服器的事", scope: inSpace },
      { text: "私訊的事", scope: inDm },
    ]);
    const version = notes.document(OWEN_DOC)?.version;
    const merge = () =>
      notes.merge(
        OWEN_DOC,
        [
          {
            from: [s?.id ?? "", d?.id ?? ""],
            line: { section: "近況", text: "合在一起", provenance: "observed", scope: inSpace },
          },
        ],
        { author: "reflect", reason: TIDY_REASON },
      );
    expect(codeOf(merge)).toBe("bad_scope");
    expect(notes.document(OWEN_DOC)?.version).toBe(version);
    expect(notes.lines(OWEN_DOC, "owner")).toHaveLength(2);
  });

  it("refuses to merge lines of different people, or to drop who told them", async () => {
    const { notes, clock } = await rig(testClock());
    const place = placeSubject("p1");
    const [owen, ben, nobody, bensWords] = addLines(notes, clock, place, [
      { text: "Owen 說的", scope: inSpace, provenance: "told_by_other", told_by: OWEN },
      {
        text: "Ben 說的",
        scope: inSpace,
        provenance: "told_by_other",
        told_by: BEN,
        evidence: [{ quote: "嗯", person_id: BEN, session: SESSION, seq_from: 3 }],
      },
      { text: "沒人說的", scope: inSpace, provenance: "observed", told_by: null, evidence: [] },
      {
        text: "Ben 的話撐著的",
        scope: inSpace,
        provenance: "observed",
        told_by: null,
        evidence: [{ quote: "對", person_id: BEN, session: SESSION, seq_from: 4 }],
      },
    ]);
    const meta = { author: "reflect" as const, reason: TIDY_REASON };
    const merge = (from: Array<NoteLine | undefined>, told_by: typeof OWEN | null) => () =>
      notes.merge(
        place,
        [
          {
            from: from.map((l) => l?.id ?? ""),
            line: { section: "近況", text: "合", provenance: "observed", told_by, scope: inSpace },
          },
        ],
        meta,
      );
    const version = notes.document(place)?.version;
    // Two tellers; a teller and another person's words.
    expect(codeOf(merge([owen, ben], null))).toBe("mixed_people");
    expect(codeOf(merge([owen, bensWords], OWEN))).toBe("mixed_people");
    // One teller and a line of no one's: only if the merged line keeps them.
    expect(codeOf(merge([owen, nobody], null))).toBe("mixed_people");
    // A line rewritten keeps who told it.
    expect(codeOf(merge([ben], null))).toBe("mixed_people");
    expect(notes.document(place)?.version).toBe(version);
    expect(notes.lines(place, "owner")).toHaveLength(4);
    expect(merge([owen, nobody], OWEN)().version).toBe((version ?? 0) + 1);
  });

  it("refuses a line that is no longer in use, and one named twice", async () => {
    const { notes, clock } = await rig(testClock());
    const [x, y] = addLines(notes, clock, OWEN_DOC, [
      { text: "一", scope: inSpace },
      { text: "二", scope: inSpace },
    ]);
    const line = {
      section: "近況",
      text: "一二",
      provenance: "observed" as const,
      told_by: OWEN,
      scope: inSpace,
    };
    const meta = { author: "reflect" as const, reason: TIDY_REASON };
    expect(
      codeOf(() => notes.merge(OWEN_DOC, [{ from: [x?.id ?? "", x?.id ?? ""], line }], meta)),
    ).toBe("duplicate");
    notes.outdate(OWEN_DOC, y?.id ?? "", "不對", write);
    expect(
      codeOf(() => notes.merge(OWEN_DOC, [{ from: [x?.id ?? "", y?.id ?? ""], line }], meta)),
    ).toBe("outdated");
    expect(notes.lines(OWEN_DOC, "owner").map((l) => l.id)).toEqual([x?.id]);
  });
});
