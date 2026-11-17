import { describe, expect, it } from "vitest";
import {
  type EpisodeSink,
  type NotesViewer,
  personSubject,
  placeSubject,
  runSegmentPass,
  SEGMENT_CONSUMER,
  SELF_SUBJECT,
  type SegmentEpisode,
  type SegmentFollowup,
  type SegmentPassInput,
  shortLineId,
  topicSubject,
} from "../src/index.js";
import {
  AMY,
  by,
  DM_ROOM,
  entry,
  IN_DM,
  IN_SERVER,
  OWEN,
  own,
  ROOM,
  rig,
  SESSION,
  SPACE,
  scripted,
} from "./helpers.js";

const OWEN_DOC = personSubject(OWEN);
const inSpace = { type: "space" as const, space: SPACE };
const channel: NotesViewer = { space: SPACE, room: ROOM, dm: null, present: [OWEN, AMY] };
const dmViewer: NotesViewer = { space: null, room: DM_ROOM, dm: OWEN, present: [OWEN] };

const people = [
  { person: OWEN, name: "Owen", names: ["阿文"] },
  { person: AMY, name: "Amy" },
];

function input(entries: SegmentPassInput["entries"], place = IN_SERVER): SegmentPassInput {
  return { session: SESSION, entries, place, placeName: "系上 / 閒聊", people };
}

/** A sink that keeps what it is handed. */
function sink() {
  const episodes: SegmentEpisode[] = [];
  const followups: SegmentFollowup[] = [];
  const s: EpisodeSink = {
    async episode(e) {
      episodes.push(e);
      return `ep${episodes.length}`;
    },
    async followup(f) {
      followups.push(f);
      return `fu${followups.length}`;
    },
  };
  return { sink: s, episodes, followups };
}

/** A cursor in memory. */
function cursor() {
  const at = new Map<string, number>();
  return {
    at,
    get: (consumer: string, key = "") => at.get(`${consumer}/${key}`) ?? 0,
    advance: (consumer: string, key: string, seq: number) => {
      const k = `${consumer}/${key}`;
      at.set(k, Math.max(at.get(k) ?? 0, seq));
      return at.get(k) as number;
    },
  };
}

const reply = (value: object) => JSON.stringify(value);

describe("runSegmentPass", () => {
  it("adds what a person said about themself, with the segment and the quote as evidence", async () => {
    const { notes, clock } = await rig();
    const model = scripted(
      reply({
        episode: {
          summary: "p1 跟我聊拉麵,我推薦了一家店",
          who: ["p1"],
          feeling: "開心",
          importance: 0.6,
        },
        edits: [
          {
            op: "add",
            doc: "p1",
            section: "喜好",
            text: "p1 喜歡吃拉麵",
            source: "本人說的",
            quote: "我超愛吃拉麵",
            seq: 1,
          },
          {
            op: "add",
            doc: "地點",
            section: "近況",
            text: "大家在聊拉麵店",
            source: "我看到的",
            quote: "拉麵店",
            seq: 2,
          },
        ],
        followups: [{ who: "p1", about: "問 p1 有沒有去吃那家拉麵", due_in_hours: 48 }],
      }),
    );
    const s = sink();
    const c = cursor();
    const result = await runSegmentPass(
      input([by(1, OWEN, "Owen", "我超愛吃拉麵,每週都吃"), own(2, "那你一定要去巷口那家拉麵店")]),
      { router: model.router, notes, episodes: s.sink, cursor: c, now: clock.now },
    );
    expect(result.status).toBe("applied");
    expect(result.dropped).toEqual([]);
    expect(result.applied.map((a) => [a.op, a.subject, a.provenance])).toEqual([
      ["add", OWEN_DOC, "told_by_subject"],
      ["add", placeSubject(SPACE), "observed"],
    ]);
    const [line] = notes.lines(OWEN_DOC, channel);
    expect(line).toMatchObject({
      section: "likes",
      text: "Owen 喜歡吃拉麵",
      provenance: "told_by_subject",
      told_by: OWEN,
      scope: inSpace,
      author: "segment",
      segment: { session: SESSION, seq_from: 1, seq_to: 2 },
    });
    expect(line?.evidence).toEqual([
      expect.objectContaining({
        quote: "我超愛吃拉麵",
        person_id: OWEN,
        session: SESSION,
        seq_from: 1,
        message_id: "m1",
      }),
    ]);
    expect(notes.document(OWEN_DOC)?.title).toBe("Owen");
    // The episode and the follow-up went to the sink, scoped to where they happened.
    expect(s.episodes).toEqual([
      expect.objectContaining({
        summary: "Owen 跟我聊拉麵,我推薦了一家店",
        feeling: "開心",
        importance: 0.6,
        people: [OWEN],
        scope: inSpace,
        seq_from: 1,
        seq_to: 2,
        message_ids: ["m1", "m2"],
      }),
    ]);
    expect(result.episode).toMatchObject({
      stored: "ep1",
      text: "Owen 跟我聊拉麵,我推薦了一家店(當時我的心情:開心)",
    });
    expect(s.followups).toEqual([
      expect.objectContaining({
        about: "問 Owen 有沒有去吃那家拉麵",
        person: OWEN,
        scope: inSpace,
      }),
    ]);
    expect(Date.parse(s.followups[0]?.due ?? "") - clock.now()).toBe(48 * 3_600_000);
    expect(c.get(SEGMENT_CONSUMER, SESSION)).toBe(2);
    expect(result.usage).toEqual({ calls: 1, prompt_tokens: 100, completion_tokens: 40 });
    expect(model.asked[0]?.messages[0]?.content).toContain("不要寫好感、親密度、信任這類分數");
  });

  it("shows the documents with line ids, and a contradiction comes back as a replace", async () => {
    const { notes, clock } = await rig();
    const old = notes.add(
      OWEN_DOC,
      { section: "基本", text: "Owen 住在台北", provenance: "told_by_subject", scope: inSpace },
      { author: "segment" },
    );
    const model = scripted(
      reply({
        episode: null,
        edits: [
          {
            op: "replace",
            line: shortLineId(old.id),
            text: "Owen 住在高雄",
            quote: "我上個月搬去高雄了",
            seq: 4,
          },
        ],
      }),
    );
    const result = await runSegmentPass(input([by(4, OWEN, "Owen", "我上個月搬去高雄了")]), {
      router: model.router,
      notes,
      now: clock.now,
    });
    const shown = String(model.asked[0]?.messages[1]?.content);
    expect(shown).toContain(`${shortLineId(old.id)} Owen 住在台北(本人說的)`);
    expect(shown).toContain("[4] Owen(p1): 我上個月搬去高雄了");
    expect(result.applied).toEqual([expect.objectContaining({ op: "replace", replaced: old.id })]);
    expect(notes.lines(OWEN_DOC, channel).map((l) => l.text)).toEqual(["Owen 住在高雄"]);
    expect(notes.line(old.id)).toMatchObject({ replaced_by: result.applied[0]?.line });
  });

  it("rejects an invented fact, and keeps what someone else said as told by them", async () => {
    const { notes, clock } = await rig();
    const model = scripted(
      reply({
        episode: null,
        edits: [
          {
            op: "add",
            doc: "p1",
            section: "基本",
            text: "Owen 養了一隻貓",
            source: "本人說的",
            quote: "我養了一隻貓",
            seq: 1,
          },
          {
            op: "add",
            doc: "p1",
            section: "基本",
            text: "Owen 很會彈吉他",
            source: "本人說的",
            quote: "超會彈吉他",
            seq: 2,
          },
          {
            op: "add",
            doc: "p1",
            section: "我的看法",
            text: "Owen 好像很忙",
            source: "我推測的",
            quote: "",
            seq: null,
          },
        ],
      }),
    );
    const result = await runSegmentPass(
      input([by(1, OWEN, "Owen", "今天好累喔"), by(2, AMY, "Amy", "阿文他超會彈吉他的")]),
      { router: model.router, notes, now: clock.now },
    );
    expect(result.dropped).toEqual([expect.objectContaining({ index: 0, reason: "no_evidence" })]);
    const lines = notes.lines(OWEN_DOC, "owner");
    const guitar = lines.find((l) => l.text.includes("吉他"));
    expect(guitar).toMatchObject({ provenance: "told_by_other", told_by: AMY, confidence: 0.5 });
    expect(guitar?.evidence[0]).toMatchObject({ person_id: AMY, seq_from: 2 });
    const view = lines.find((l) => l.section === "her_view");
    expect(view).toMatchObject({ provenance: "concluded", confidence: 0.4 });
    expect(lines.some((l) => l.text.includes("貓"))).toBe(false);
    expect(notes.card(OWEN_DOC, channel)).toContain("Owen 很會彈吉他(聽說)");
  });

  it("drops a present-tense state, a repeat, an unknown line and any edit of her self document", async () => {
    const { notes, clock } = await rig();
    notes.add(
      OWEN_DOC,
      { section: "喜好", text: "Owen 喜歡打 osu", provenance: "told_by_subject", scope: inSpace },
      { author: "segment" },
    );
    notes.rewriteSelf("最近很喜歡聊天");
    const model = scripted(
      reply({
        edits: [
          {
            op: "add",
            doc: "p1",
            section: "近況",
            text: "Owen 正在下載遊戲",
            quote: "我正在下載遊戲",
            seq: 1,
          },
          {
            op: "add",
            doc: "p1",
            section: "喜好",
            text: "Owen 喜歡打 osu",
            quote: "osu 好好玩",
            seq: 2,
          },
          { op: "outdate", line: "#zzzzzz", reason: "x", quote: "osu 好好玩", seq: 2 },
          { op: "add", doc: "我", section: "最近", text: "我最近很開心", quote: "", seq: null },
          { op: "add", doc: "p9", section: "喜好", text: "誰喜歡拉麵", quote: "", seq: null },
        ],
      }),
    );
    const result = await runSegmentPass(
      input([by(1, OWEN, "Owen", "我正在下載遊戲"), by(2, OWEN, "Owen", "osu 好好玩")]),
      { router: model.router, notes, now: clock.now },
    );
    expect(result.applied).toEqual([]);
    expect(result.dropped.map((d) => d.reason)).toEqual([
      "present_state",
      "duplicate",
      "unknown_line",
      "self_document",
      "unknown_document",
    ]);
    expect(notes.lines(SELF_SUBJECT, "owner").map((l) => l.text)).toEqual(["最近很喜歡聊天"]);
  });

  it("keeps what is said in a DM in that DM, also when it replaces a line shown everywhere", async () => {
    const { notes, clock } = await rig();
    const anywhere = { type: "person" as const, person: OWEN };
    const old = notes.add(
      OWEN_DOC,
      { section: "基本", text: "Owen 住在台北", provenance: "told_by_subject", scope: anywhere },
      { author: "segment" },
    );
    const server = notes.add(
      OWEN_DOC,
      { section: "喜好", text: "Owen 喜歡打 osu", provenance: "told_by_subject", scope: inSpace },
      { author: "segment" },
    );
    const model = scripted(
      reply({
        episode: { summary: "Owen 私下跟我說他被甩了", importance: 0.8 },
        edits: [
          {
            op: "add",
            doc: "p1",
            section: "近況",
            text: "Owen 最近被甩了",
            quote: "我被甩了",
            seq: 1,
          },
          {
            op: "replace",
            line: shortLineId(old.id),
            text: "Owen 搬回高雄老家了",
            quote: "我搬回高雄老家了",
            seq: 2,
          },
          { op: "add", doc: "地點", section: "近況", text: "x", quote: "我被甩了", seq: 1 },
          { op: "outdate", line: shortLineId(server.id), reason: "x", quote: "我被甩了", seq: 1 },
        ],
      }),
    );
    const s = sink();
    const result = await runSegmentPass(
      {
        ...input(
          [by(1, OWEN, "Owen", "我被甩了"), by(2, OWEN, "Owen", "而且我搬回高雄老家了")],
          IN_DM,
        ),
        people: [people[0] as (typeof people)[0]],
      },
      { router: model.router, notes, episodes: s.sink, now: clock.now },
    );
    // The server's line was not shown in the DM, so it cannot be touched from there.
    expect(String(model.asked[0]?.messages[1]?.content)).not.toContain("osu");
    expect(result.dropped.map((d) => d.reason)).toEqual(["no_place", "unknown_line"]);
    expect(result.applied.map((a) => a.scope)).toEqual([
      { type: "dm", person: OWEN },
      { type: "dm", person: OWEN },
    ]);
    expect(notes.card(OWEN_DOC, channel)).not.toContain("被甩");
    expect(notes.card(OWEN_DOC, channel)).not.toContain("高雄");
    expect(notes.card(OWEN_DOC, channel)).toContain("osu");
    expect(notes.card(OWEN_DOC, dmViewer)).toContain("被甩");
    expect(notes.card(OWEN_DOC, dmViewer)).toContain("高雄");
    expect(s.episodes[0]?.scope).toEqual({ type: "dm", person: OWEN });
    // The model is never shown a line it could not show here.
    const second = scripted(reply({ edits: [] }));
    await runSegmentPass(input([by(5, OWEN, "Owen", "大家好")]), {
      router: second.router,
      notes,
      now: clock.now,
    });
    expect(String(second.asked[0]?.messages[1]?.content)).not.toContain("被甩");
  });

  it("repairs a bad reply once, and abandons a second one without writing anything", async () => {
    const { notes, clock } = await rig();
    const good = reply({
      edits: [
        {
          op: "add",
          doc: "p1",
          section: "喜好",
          text: "Owen 喜歡吃拉麵",
          quote: "我超愛吃拉麵",
          seq: 1,
        },
      ],
    });
    const repaired = scripted("我覺得這段很普通", good);
    const once = await runSegmentPass(input([by(1, OWEN, "Owen", "我超愛吃拉麵")]), {
      router: repaired.router,
      notes,
      now: clock.now,
    });
    expect(once.status).toBe("applied");
    expect(once.usage.calls).toBe(2);
    expect(String(repaired.asked[1]?.messages.at(-1)?.content)).toContain("上面的回覆不能用");

    const { notes: empty } = await rig();
    const s = sink();
    const c = cursor();
    const broken = scripted("not json", reply({ edits: [{ op: "add" }] }));
    const result = await runSegmentPass(input([by(1, OWEN, "Owen", "我超愛吃拉麵")]), {
      router: broken.router,
      notes: empty,
      episodes: s.sink,
      cursor: c,
      now: clock.now,
    });
    expect(result.status).toBe("abandoned");
    expect(result.error).toMatch(/unusable structured reply/);
    expect(result.usage.calls).toBe(2);
    expect(empty.counts()).toEqual({ documents: 0, lines: 0, in_use: 0 });
    expect(s.episodes).toEqual([]);
    expect(c.at.size).toBe(0);
  });

  it("caps what one pass may change", async () => {
    const { notes, clock } = await rig();
    const lines = Array.from({ length: 6 }, (_, i) =>
      by(i + 1, OWEN, "Owen", `我喜歡第${i + 1}號拉麵店`),
    );
    const edits = lines.map((l) => ({
      op: "add",
      doc: "p1",
      section: "喜好",
      text: `Owen 喜歡${l.content.slice(3)}`,
      quote: l.content,
      seq: l.seq,
    }));
    const model = scripted(
      reply({ edits, followups: Array.from({ length: 5 }, (_, i) => ({ about: `事情${i}` })) }),
    );
    const result = await runSegmentPass(input(lines), {
      router: model.router,
      notes,
      now: clock.now,
      caps: { adds: 4, perDocument: 3, followups: 2 },
    });
    expect(result.applied).toHaveLength(3);
    expect(result.dropped.map((d) => d.reason)).toEqual(["cap", "cap", "cap"]);
    expect(result.followups).toHaveLength(2);
  });

  it("opens a topic document, and finds the topics the segment's words touch", async () => {
    const { notes, clock } = await rig();
    notes.add(
      topicSubject("Minecraft 建築"),
      { section: "重點", text: "城堡要用石磚蓋", provenance: "observed", scope: inSpace },
      { author: "segment" },
      "Minecraft 建築",
    );
    const model = scripted(
      reply({
        edits: [
          {
            op: "add",
            doc: "主題:期末考",
            section: "重點",
            text: "期末考在一月第二週",
            quote: "期末考在一月第二週",
            seq: 2,
          },
        ],
      }),
    );
    const result = await runSegmentPass(
      input([by(1, AMY, "Amy", "城堡用石磚比較好看"), by(2, OWEN, "Owen", "期末考在一月第二週喔")]),
      { router: model.router, notes, now: clock.now },
    );
    expect(String(model.asked[0]?.messages[1]?.content)).toContain("城堡要用石磚蓋");
    expect(result.applied[0]).toMatchObject({
      subject: topicSubject("期末考"),
      provenance: "told_by_other",
    });
    expect(notes.document(topicSubject("期末考"))?.title).toBe("期末考");
  });

  it("outdates a line only on a quote that is in the segment", async () => {
    const { notes, clock } = await rig();
    const line = notes.add(
      OWEN_DOC,
      { section: "喜好", text: "Owen 喜歡玩原神", provenance: "told_by_subject", scope: inSpace },
      { author: "segment" },
    );
    const model = scripted(
      reply({
        edits: [
          {
            op: "outdate",
            line: shortLineId(line.id),
            reason: "退坑",
            quote: "我早就不玩了",
            seq: 1,
          },
          {
            op: "outdate",
            line: shortLineId(line.id),
            reason: "退坑了",
            quote: "原神我退坑了",
            seq: 2,
          },
        ],
      }),
    );
    const result = await runSegmentPass(
      input([own(1, "Owen 你還玩原神嗎"), by(2, OWEN, "Owen", "原神我退坑了啦")]),
      { router: model.router, notes, now: clock.now },
    );
    expect(result.dropped).toEqual([expect.objectContaining({ index: 0, reason: "no_evidence" })]);
    expect(result.applied).toEqual([
      expect.objectContaining({ index: 1, op: "outdate", line: line.id }),
    ]);
    expect(notes.line(line.id)).toMatchObject({ outdated_reason: "退坑了" });
  });

  it("makes no call for a segment nobody said anything in, and moves the position past it", async () => {
    const { notes, clock } = await rig();
    const model = scripted();
    const c = cursor();
    const result = await runSegmentPass(
      input([
        entry(3, { kind: "tool_calls", tool_calls: [{ id: "c", name: "x", arguments: "{}" }] }),
      ]),
      { router: model.router, notes, cursor: c, now: clock.now },
    );
    expect(result.status).toBe("empty");
    expect(model.asked).toEqual([]);
    expect(c.get(SEGMENT_CONSUMER, SESSION)).toBe(3);
  });

  it("writes nothing from a place that names nothing to scope by", async () => {
    const { notes, clock } = await rig();
    const model = scripted();
    const result = await runSegmentPass(
      { ...input([by(1, OWEN, "Owen", "嗨")]), place: { space: null, room: null, dm: null } },
      { router: model.router, notes, now: clock.now },
    );
    expect(result.status).toBe("abandoned");
    expect(model.asked).toEqual([]);
  });

  it("reports an episode the sink could not store, keeping the documents", async () => {
    const { notes, clock } = await rig();
    const model = scripted(
      reply({
        episode: { summary: "聊拉麵" },
        edits: [
          {
            op: "add",
            doc: "p1",
            section: "喜好",
            text: "Owen 喜歡吃拉麵",
            quote: "我超愛吃拉麵",
            seq: 1,
          },
        ],
      }),
    );
    const failing: EpisodeSink = {
      async episode() {
        throw new Error("disk full");
      },
    };
    const result = await runSegmentPass(input([by(1, OWEN, "Owen", "我超愛吃拉麵")]), {
      router: model.router,
      notes,
      episodes: failing,
      now: clock.now,
    });
    expect(result.episode).toMatchObject({ stored: null, error: "disk full" });
    expect(notes.lines(OWEN_DOC, "owner")).toHaveLength(1);
  });

  it("ignores any score the model adds", async () => {
    const { notes, clock } = await rig();
    const model = scripted(
      reply({ episode: { summary: "聊天" }, affection: 5, bond: { p1: 30 }, edits: [] }),
    );
    const result = await runSegmentPass(input([by(1, OWEN, "Owen", "嗨")]), {
      router: model.router,
      notes,
      now: clock.now,
    });
    expect(result.status).toBe("applied");
    expect(JSON.stringify(result)).not.toContain("affection");
  });
});
