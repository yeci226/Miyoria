import { describe, expect, it } from "vitest";
import {
  NotesError,
  type NotesViewer,
  notesTables,
  personSubject,
  placeSubject,
  SELF_SEED,
  SELF_SUBJECT,
  shortLineId,
  topicSubject,
} from "../src/index.js";
import {
  AMY,
  BEN,
  DM_ROOM,
  MINUTE,
  OTHER_SPACE,
  OWEN,
  opened,
  ROOM,
  rig,
  SESSION,
  SPACE,
} from "./helpers.js";

const OWEN_DOC = personSubject(OWEN);
const segment = {
  author: "segment" as const,
  segment: { session: SESSION, seq_from: 1, seq_to: 9 },
};
const inSpace = { type: "space" as const, space: SPACE };
const inDm = { type: "dm" as const, person: OWEN };

/** A channel of the space with Owen and Amy. */
const channel: NotesViewer = { space: SPACE, room: ROOM, dm: null, present: [OWEN, AMY] };
/** Owen's DM. */
const dm: NotesViewer = { space: null, room: DM_ROOM, dm: OWEN, present: [OWEN] };
/** Another server, Owen there. */
const elsewhere: NotesViewer = { space: OTHER_SPACE, room: null, dm: null, present: [OWEN] };

describe("NotesStore", () => {
  it("adds lines with provenance, scope and evidence, and reads them back", async () => {
    const { notes } = await rig();
    const line = notes.add(
      OWEN_DOC,
      {
        section: "喜好",
        text: "Owen 喜歡吃拉麵",
        provenance: "told_by_subject",
        told_by: OWEN,
        scope: inSpace,
        evidence: [
          {
            quote: "我超愛吃拉麵",
            person_id: OWEN,
            session: SESSION,
            seq_from: 3,
            message_id: "m3",
          },
        ],
      },
      segment,
      "Owen",
    );
    expect(line).toMatchObject({
      section: "likes",
      text: "Owen 喜歡吃拉麵",
      provenance: "told_by_subject",
      told_by: OWEN,
      scope: inSpace,
      confidence: 0.9,
      author: "segment",
      segment: { session: SESSION, seq_from: 1, seq_to: 9 },
      outdated_at: null,
    });
    expect(line.evidence).toEqual([
      expect.objectContaining({ quote: "我超愛吃拉麵", seq_from: 3, seq_to: 3, message_id: "m3" }),
    ]);
    const doc = notes.document(OWEN_DOC);
    expect(doc).toMatchObject({ kind: "person", person_id: OWEN, title: "Owen", version: 1 });
    expect(notes.lines(OWEN_DOC, channel).map((l) => l.id)).toEqual([line.id]);
  });

  it("refuses an unknown section, an empty or too long line, and a scope without its id", async () => {
    const { notes } = await rig();
    const base = { text: "x", provenance: "observed" as const, scope: inSpace };
    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof NotesError ? error.code : String(error);
      }
      return "written";
    };
    expect(refused(() => notes.add(OWEN_DOC, { ...base, section: "星座" }, segment))).toBe(
      "bad_section",
    );
    expect(
      refused(() => notes.add(OWEN_DOC, { ...base, section: "基本", text: "  " }, segment)),
    ).toBe("empty");
    expect(
      refused(() =>
        notes.add(OWEN_DOC, { ...base, section: "基本", text: "長".repeat(201) }, segment),
      ),
    ).toBe("too_long");
    expect(
      refused(() =>
        notes.add(
          OWEN_DOC,
          { ...base, section: "基本", scope: { type: "space", space: "" } },
          segment,
        ),
      ),
    ).toBe("bad_scope");
    expect(refused(() => notes.add("person:", { ...base, section: "基本" }, segment))).toBe(
      "bad_subject",
    );
    // Nothing was left behind by the refusals.
    expect(notes.document(OWEN_DOC)).toBeNull();
  });

  it("replaces a line: the old one is outdated, points at the new one and stays in history", async () => {
    const { notes, clock } = await rig();
    const old = notes.add(
      OWEN_DOC,
      { section: "基本", text: "Owen 住在台北", provenance: "told_by_subject", scope: inSpace },
      segment,
    );
    clock.tick(MINUTE);
    const fresh = notes.replace(OWEN_DOC, shortLineId(old.id), { text: "Owen 住在高雄" }, segment);
    expect(fresh).toMatchObject({
      text: "Owen 住在高雄",
      section: "basics",
      provenance: "told_by_subject",
      scope: inSpace,
    });
    expect(notes.line(old.id)).toMatchObject({
      replaced_by: fresh.id,
      outdated_reason: "replaced",
    });
    expect(notes.lines(OWEN_DOC, channel).map((l) => l.text)).toEqual(["Owen 住在高雄"]);
    expect(notes.lines(OWEN_DOC, channel, { outdated: true }).map((l) => l.text)).toEqual([
      "Owen 住在高雄",
      "Owen 住在台北",
    ]);
    const history = notes.history(OWEN_DOC);
    expect(history.map((h) => [h.version, h.op, h.text])).toEqual([
      [1, "add", "Owen 住在台北"],
      [2, "outdate", "Owen 住在台北"],
      [2, "add", "Owen 住在高雄"],
    ]);
    expect(() => notes.outdate(OWEN_DOC, old.id, "again", segment)).toThrow(/outdated already/);
  });

  it("outdates a line with its reason, and refuses a line of another document", async () => {
    const { notes } = await rig();
    const line = notes.add(
      OWEN_DOC,
      { section: "喜好", text: "Owen 喜歡原神", provenance: "told_by_subject", scope: inSpace },
      segment,
    );
    notes.add(
      personSubject(AMY),
      { section: "喜好", text: "Amy 喜歡貓", provenance: "told_by_subject", scope: inSpace },
      segment,
    );
    expect(() => notes.outdate(personSubject(AMY), line.id, "x", segment)).toThrow(/has no line/);
    const out = notes.outdate(OWEN_DOC, line.id, "他退坑了", segment);
    expect(out).toMatchObject({ outdated_reason: "他退坑了" });
    expect(notes.lines(OWEN_DOC, "owner")).toEqual([]);
  });

  it("applies a change set all or nothing, or leniently with what was refused", async () => {
    const { notes } = await rig();
    const ops = [
      {
        op: "add" as const,
        section: "喜好",
        text: "Owen 喜歡拉麵",
        provenance: "observed" as const,
        scope: inSpace,
      },
      {
        op: "add" as const,
        section: "星座",
        text: "x",
        provenance: "observed" as const,
        scope: inSpace,
      },
    ];
    expect(() => notes.apply(OWEN_DOC, ops, segment)).toThrow(NotesError);
    expect(notes.document(OWEN_DOC)).toBeNull();
    const done = notes.apply(OWEN_DOC, ops, { ...segment, lenient: true });
    expect(done.applied.map((a) => a.index)).toEqual([0]);
    expect(done.refused).toEqual([expect.objectContaining({ index: 1, code: "bad_section" })]);
    expect(done.version).toBe(1);
  });

  it("keeps a document and a section within their limits", async () => {
    const { notes: small } = await rig(undefined, { linesPerDocument: 3, linesPerSection: 2 });
    const add = (section: string, text: string) =>
      small.add(OWEN_DOC, { section, text, provenance: "observed", scope: inSpace }, segment);
    add("喜好", "a");
    add("喜好", "b");
    expect(() => add("喜好", "c")).toThrow(/holds 2 lines/);
    add("基本", "d");
    expect(() => add("近況", "e")).toThrow(/holds 3 lines/);
  });

  it("reverts to an earlier version as a new one, and back again", async () => {
    const { notes, clock } = await rig();
    const a = notes.add(
      OWEN_DOC,
      { section: "基本", text: "Owen 住在台北", provenance: "told_by_subject", scope: inSpace },
      segment,
    );
    clock.tick(MINUTE);
    const b = notes.replace(OWEN_DOC, a.id, { text: "Owen 住在高雄" }, segment);
    clock.tick(MINUTE);
    const c = notes.add(
      OWEN_DOC,
      { section: "喜好", text: "Owen 喜歡拉麵", provenance: "told_by_subject", scope: inSpace },
      segment,
    );
    const back = notes.revert(OWEN_DOC, 1, { author: "panel" });
    expect(back.version).toBe(4);
    expect(back.restored).toEqual([a.id]);
    expect(back.outdated.sort()).toEqual([b.id, c.id].sort());
    expect(notes.lines(OWEN_DOC, "owner").map((l) => l.text)).toEqual(["Owen 住在台北"]);
    expect(notes.line(a.id)?.replaced_by).toBeNull();
    // The revert is itself a version: reverting to 3 brings the later lines back.
    const again = notes.revert(OWEN_DOC, 3, { author: "panel" });
    expect(again.version).toBe(5);
    expect(
      notes
        .lines(OWEN_DOC, "owner")
        .map((l) => l.text)
        .sort(),
    ).toEqual(["Owen 住在高雄", "Owen 喜歡拉麵"].sort());
    expect(notes.revert(OWEN_DOC, 5, { author: "panel" }).version).toBeNull();
    expect(() => notes.revert(OWEN_DOC, 9, { author: "panel" })).toThrow(/versions 0 to 5/);
  });

  it("renders a card within its budget, most relevant and newest first, outdated lines hidden", async () => {
    const { notes, clock } = await rig();
    const add = (section: string, text: string) => {
      clock.tick(MINUTE);
      return notes.add(
        OWEN_DOC,
        { section, text, provenance: "told_by_subject", scope: inSpace },
        segment,
      );
    };
    add("稱呼", "叫他阿文");
    const old = add("基本", "Owen 住在台北");
    add("喜好", "Owen 喜歡吃拉麵");
    add("喜好", "Owen 喜歡打 osu");
    add("近況", "Owen 在準備期末考");
    notes.outdate(OWEN_DOC, old.id, "搬家了", segment);
    const full = notes.card(OWEN_DOC, channel, { budget: 1000 });
    expect(full.split("\n")).toEqual([
      "稱呼:叫他阿文",
      "喜好:Owen 喜歡打 osu;Owen 喜歡吃拉麵",
      "近況:Owen 在準備期末考",
    ]);
    // A small budget keeps how to address him, then the newest.
    const small = notes.card(OWEN_DOC, channel, { budget: 30 });
    expect(small).toContain("叫他阿文");
    expect([...small].length).toBeLessThanOrEqual(30);
    expect(small).not.toContain("拉麵");
    // A query brings what it is about first.
    const asked = notes.card(OWEN_DOC, channel, { budget: 30, query: "拉麵好吃嗎" });
    expect(asked).toContain("拉麵");
    expect(notes.card(OWEN_DOC, channel, { budget: 0 })).toBe("");
    expect(notes.card(personSubject(BEN), channel)).toBe("");
  });

  it("never shows a DM line in a channel card, nor a server's line in another server", async () => {
    const { notes } = await rig();
    notes.add(
      OWEN_DOC,
      { section: "近況", text: "Owen 最近失戀了", provenance: "told_by_subject", scope: inDm },
      segment,
    );
    notes.add(
      OWEN_DOC,
      { section: "喜好", text: "Owen 喜歡拉麵", provenance: "told_by_subject", scope: inSpace },
      segment,
    );
    notes.add(
      OWEN_DOC,
      {
        section: "稱呼",
        text: "叫他阿文",
        provenance: "told_by_subject",
        scope: { type: "person", person: OWEN },
      },
      segment,
    );
    expect(notes.card(OWEN_DOC, channel)).not.toContain("失戀");
    expect(notes.card(OWEN_DOC, channel)).toContain("拉麵");
    expect(notes.card(OWEN_DOC, dm)).toContain("失戀");
    expect(notes.card(OWEN_DOC, dm)).not.toContain("拉麵");
    expect(notes.card(OWEN_DOC, elsewhere)).toBe("稱呼:叫他阿文");
    expect(notes.full(OWEN_DOC, channel)).not.toContain("失戀");
    expect(notes.full(OWEN_DOC, "owner")).toContain("失戀");
    // Search and listing see only what the reader may see.
    expect(notes.search("失戀", channel)).toEqual([]);
    expect(notes.search("失戀", dm).map((h) => h.document.subject)).toEqual([OWEN_DOC]);
    expect(notes.list(channel)).toEqual([expect.objectContaining({ lines: 2 })]);
  });

  it("renders the full document with line ids, provenance and the outdated lines on request", async () => {
    const { notes } = await rig();
    const a = notes.add(
      OWEN_DOC,
      { section: "基本", text: "Owen 住在台北", provenance: "told_by_subject", scope: inSpace },
      segment,
      "Owen",
    );
    notes.add(
      OWEN_DOC,
      { section: "我的看法", text: "Owen 很可靠", provenance: "concluded", scope: inSpace },
      segment,
    );
    notes.outdate(OWEN_DOC, a.id, "搬家了", segment);
    const text = notes.full(OWEN_DOC, channel, { outdated: true }) ?? "";
    expect(text).toContain("「Owen」(1 行");
    expect(text).toContain(`[${shortLineId(a.id)}] ~~Owen 住在台北~~(已過時:搬家了)`);
    expect(text).toContain("## 我的看法");
    expect(text).toContain("Owen 很可靠(我的推測");
    expect(notes.full(OWEN_DOC, channel)).not.toContain("台北");
  });

  it("lists and searches documents by title and lines", async () => {
    const { notes } = await rig();
    notes.add(
      topicSubject("Minecraft 建築"),
      { section: "重點", text: "城堡要用石磚", provenance: "observed", scope: inSpace },
      segment,
      "Minecraft 建築",
    );
    notes.add(
      placeSubject(SPACE),
      { section: "規矩", text: "不能貼色圖", provenance: "observed", scope: inSpace },
      segment,
      "系上",
    );
    expect(notes.search("石磚", channel).map((h) => h.document.title)).toEqual(["Minecraft 建築"]);
    expect(notes.search("minecraft", channel)[0]?.score).toBe(1);
    expect(notes.list(channel, { kind: "place" }).map((e) => e.document.title)).toEqual(["系上"]);
    expect(notes.list(elsewhere)).toEqual([]);
  });

  describe("her self document", () => {
    it("reads as the neutral seed before she wrote it", async () => {
      const { notes } = await rig();
      expect(notes.readSelf()).toBe(SELF_SEED.join("\n"));
      expect(SELF_SEED).toHaveLength(2);
      expect(notes.document(SELF_SUBJECT)).toBeNull();
    });

    it("is rewritten as one version, kept lines stay, and the panel can roll it back", async () => {
      const { notes, clock } = await rig();
      const first = notes.rewriteSelf("最近很喜歡跟大家打 osu\n想做的事:學會畫畫", [
        { quote: "今天玩得很開心", session: SESSION, seq_from: 4 },
      ]);
      expect(first.version).toBe(1);
      expect(notes.readSelf()).toBe("最近:最近很喜歡跟大家打 osu\n想做的事:學會畫畫");
      expect(notes.lines(SELF_SUBJECT, "owner")[0]?.evidence[0]?.quote).toBe("今天玩得很開心");
      clock.tick(MINUTE);
      const second = notes.rewriteSelf("最近很喜歡跟大家打 osu\n想做的事:存錢買新耳機");
      expect(second.version).toBe(2);
      expect(second.applied.map((a) => a.op)).toEqual(["outdate", "add"]);
      expect(notes.readSelf()).toContain("存錢買新耳機");
      notes.revert(SELF_SUBJECT, 1, { author: "panel" });
      expect(notes.readSelf()).toContain("學會畫畫");
      expect(notes.readSelf()).not.toContain("耳機");
      // Her self lines are her own: shown anywhere, in her prompt.
      expect(notes.card(SELF_SUBJECT, dm)).toContain("學會畫畫");
    });

    it("refuses an empty rewrite or one past its line limit, writing nothing", async () => {
      const { notes } = await rig();
      expect(() => notes.rewriteSelf("  \n ")).toThrow(/needs text/);
      expect(() =>
        notes.rewriteSelf(Array.from({ length: 13 }, (_, i) => `第 ${i} 件事`).join("\n")),
      ).toThrow(/at most 12 lines/);
      expect(notes.document(SELF_SUBJECT)).toBeNull();
    });

    it("stays within its budget", async () => {
      const { notes } = await rig();
      notes.rewriteSelf(
        Array.from({ length: 10 }, (_, i) => `這是第 ${i} 件很長很長很長的事情`).join("\n"),
      );
      expect([...notes.readSelf({ budget: 60 })].length).toBeLessThanOrEqual(60);
    });
  });

  describe("forgetting", () => {
    it("redacts by evidence: a line resting only on the message loses its text, one with more stays", async () => {
      const { notes } = await rig();
      const only = notes.add(
        OWEN_DOC,
        {
          section: "近況",
          text: "Owen 失戀了",
          provenance: "told_by_subject",
          scope: inSpace,
          evidence: [
            { quote: "我被甩了", person_id: OWEN, session: SESSION, seq_from: 5, message_id: "m5" },
          ],
        },
        segment,
      );
      const more = notes.add(
        OWEN_DOC,
        {
          section: "喜好",
          text: "Owen 喜歡拉麵",
          provenance: "told_by_subject",
          scope: inSpace,
          evidence: [
            { quote: "拉麵讚", person_id: OWEN, session: SESSION, seq_from: 5, message_id: "m5" },
            { quote: "又吃拉麵", person_id: OWEN, session: SESSION, seq_from: 7, message_id: "m7" },
          ],
        },
        segment,
      );
      expect(notes.redactEvidence({ message_id: "m5" })).toEqual({ evidence: 2, lines: 1 });
      const gone = notes.line(only.id);
      expect(gone).toMatchObject({ text: "", redacted: true, outdated_reason: "redacted" });
      expect(gone?.evidence[0]).toMatchObject({ quote: "", redacted: true });
      const kept = notes.line(more.id);
      expect(kept).toMatchObject({ text: "Owen 喜歡拉麵", outdated_at: null });
      expect(kept?.evidence.map((e) => e.quote)).toEqual(["", "又吃拉麵"]);
      expect(
        notes
          .history(OWEN_DOC)
          .filter((h) => h.op === "redact")
          .map((h) => h.line_id),
      ).toEqual([only.id]);
      // A transcript entry finds its quotes too; a source nothing quotes touches nothing.
      expect(notes.redactEvidence({ session: SESSION, seq: 7 })).toEqual({ evidence: 1, lines: 1 });
      expect(notes.redactEvidence({ message_id: "m99" })).toEqual({ evidence: 0, lines: 0 });
      expect(notes.redactEvidence({})).toEqual({ evidence: 0, lines: 0 });
      // A redacted line is never brought back by a revert.
      expect(notes.revert(OWEN_DOC, 2, { author: "panel" }).gone.sort()).toEqual(
        [only.id, more.id].sort(),
      );
    });

    it("forgets a person: their document, what they told and what is kept to them", async () => {
      const { store, notes } = await rig();
      notes.add(
        OWEN_DOC,
        { section: "喜好", text: "Owen 喜歡拉麵", provenance: "told_by_subject", scope: inSpace },
        segment,
      );
      const told = notes.add(
        personSubject(AMY),
        {
          section: "基本",
          text: "Amy 會彈吉他",
          provenance: "told_by_other",
          told_by: OWEN,
          scope: inSpace,
        },
        segment,
      );
      const quoted = notes.add(
        personSubject(AMY),
        {
          section: "喜好",
          text: "Amy 喜歡貓",
          provenance: "told_by_other",
          told_by: BEN,
          scope: inSpace,
          evidence: [{ quote: "Amy 超愛貓", person_id: OWEN, message_id: "m1" }],
        },
        segment,
      );
      const backed = notes.add(
        personSubject(AMY),
        {
          section: "近況",
          text: "Amy 在學日文",
          provenance: "observed",
          scope: inSpace,
          evidence: [
            { quote: "她在學日文", person_id: OWEN, message_id: "m2" },
            { quote: "我在學日文", person_id: AMY, message_id: "m3" },
          ],
        },
        segment,
      );
      notes.add(
        placeSubject(SPACE),
        { section: "近況", text: "大家在準備期末考", provenance: "observed", scope: inDm },
        segment,
      );
      const counts = notes.forgetPerson([OWEN]);
      expect(counts).toEqual({ documents: 1, lines: 3, evidence: 2, redacted: 1 });
      expect(notes.document(OWEN_DOC)).toBeNull();
      expect(notes.line(told.id)).toBeNull();
      expect(notes.line(quoted.id)).toMatchObject({ text: "", redacted: true });
      expect(notes.line(backed.id)?.evidence.map((e) => e.quote)).toEqual(["我在學日文"]);
      const left = store.db.get(
        `SELECT
           (SELECT count(*) FROM notes_documents WHERE person_id = $p) +
           (SELECT count(*) FROM notes_lines WHERE told_by = $p OR scope_id = $p) +
           (SELECT count(*) FROM notes_evidence WHERE person_id = $p) AS n`,
        { p: OWEN },
      );
      expect(Number(left?.n)).toBe(0);
    });

    it("merges two persons into one document, renumbering the absorbed history", async () => {
      const { notes } = await rig();
      notes.add(
        OWEN_DOC,
        { section: "喜好", text: "Owen 喜歡拉麵", provenance: "told_by_subject", scope: inSpace },
        segment,
      );
      const ben = personSubject(BEN);
      notes.add(
        ben,
        {
          section: "基本",
          text: "他住在高雄",
          provenance: "told_by_subject",
          told_by: BEN,
          scope: { type: "dm", person: BEN },
        },
        segment,
      );
      notes.add(
        ben,
        {
          section: "近況",
          text: "他在學日文",
          provenance: "told_by_subject",
          told_by: BEN,
          scope: { type: "dm", person: BEN },
        },
        segment,
      );
      expect(notes.mergePerson(OWEN, BEN)).toEqual({ documents: 1, lines: 6 });
      expect(notes.document(ben)).toBeNull();
      const doc = notes.document(OWEN_DOC);
      expect(doc?.version).toBe(3);
      const lines = notes.lines(OWEN_DOC, dm);
      expect(lines.map((l) => l.text).sort()).toEqual(["他住在高雄", "他在學日文"].sort());
      expect(lines.every((l) => l.told_by === OWEN)).toBe(true);
      expect(notes.history(OWEN_DOC).map((h) => h.version)).toEqual([1, 2, 3]);
    });

    it("moves the absorbed document whole when the kept person has none", async () => {
      const { notes } = await rig();
      notes.add(
        personSubject(BEN),
        { section: "基本", text: "他住在高雄", provenance: "observed", scope: inSpace },
        segment,
      );
      expect(notes.mergePerson(OWEN, BEN)).toEqual({ documents: 1, lines: 0 });
      expect(notes.document(OWEN_DOC)).toMatchObject({ person_id: OWEN });
    });
  });

  it("is a store plugin: opened by the store, its person hooks and data category", async () => {
    const { store, notes } = await opened();
    try {
      notes.add(
        OWEN_DOC,
        { section: "喜好", text: "Owen 喜歡拉麵", provenance: "told_by_subject", scope: inSpace },
        segment,
      );
      notes.add(
        personSubject(BEN),
        { section: "喜好", text: "他喜歡貓", provenance: "observed", scope: inSpace },
        segment,
      );
      expect(notesTables.mergePerson?.(notes, { keep: OWEN, absorb: BEN, source: "test" })).toEqual(
        { counts: { documents: 1, lines: 1 } },
      );
      expect(
        notesTables.forgetPerson?.(notes, {
          person: OWEN,
          ids: [OWEN],
          accounts: [],
          reason: "test",
          source: "memory",
        }),
      ).toEqual({ counts: { documents: 1, lines: 2, evidence: 0, redacted: 0 } });
      expect(notesTables.data?.[0]?.category).toBe("knowledge");
      expect(notes.counts()).toEqual({ documents: 0, lines: 0, in_use: 0 });
    } finally {
      await store.close();
    }
  });
});
