import type { ContextKey } from "@miyoria/types";
import { ephemeralHandlesIn } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  applyAppraisal,
  appraiseMessages,
  MAX_APPRAISALS,
  parseAppraiseReply,
  Segments,
} from "../src/index.js";
import { card, FakeAffect } from "./fakes.js";

const T0 = Date.parse("2026-11-02T12:00:00.000Z");
const TEXT: ContextKey = { platform: "discord", scope: "111", channel: "222", kind: "channel" };
const OWEN = { platform: "discord", id: "100" };

describe("promises", () => {
  const reply = (promises: unknown) =>
    parseAppraiseReply(JSON.stringify({ appraisals: [], feelings: [], promises }));

  it("are read leniently and capped", () => {
    expect(reply("no").promises).toEqual([]);
    expect(
      reply([
        { person: "Owen", kept: true },
        { person: "", kept: true },
        { person: "Amy", kept: "yes" },
        { person: "Amy", kept: false },
        { person: "Bob", kept: false },
      ]).promises,
    ).toEqual([
      { person: "Owen", kept: true },
      { person: "Amy", kept: false },
    ]);
    expect(parseAppraiseReply('{"appraisals":[]}').promises).toEqual([]);
  });

  it("go through the same call as her appraisals, about people she knows", async () => {
    const affect = new FakeAffect();
    affect.cardList.push(card("Owen", "p1"));
    const result = await applyAppraisal(
      reply([
        { person: "Owen", kept: false },
        { person: "Nobody", kept: true },
      ]),
      affect,
      TEXT,
      T0,
      () => null,
    );
    expect(affect.appraised).toHaveLength(1);
    expect(affect.appraised[0]?.promises).toEqual([
      { toward: "Owen", kept: false, cause: "Owen食言了" },
    ]);
    expect(result.changes).toEqual(["Owen 食言了"]);
  });

  it("nothing to say is no call", async () => {
    const affect = new FakeAffect();
    await applyAppraisal(reply([]), affect, TEXT, T0, () => null);
    expect(affect.appraised).toEqual([]);
  });

  it("the prompt asks for them, as data about people, in the one format", () => {
    const [system] = appraiseMessages({
      name: "DS",
      core: "",
      time: "12:00",
      segments: [],
      cards: new Map(),
    });
    expect(JSON.stringify(system)).toContain("promises");
  });
});

describe("interaction segments", () => {
  it("are ready once quiet, only when she was involved and long enough", () => {
    const s = new Segments();
    const other: ContextKey = { ...TEXT, channel: "333" };
    for (let i = 0; i < 3; i++) {
      s.line(TEXT, {
        at: T0 + i * 1000,
        who: "Owen",
        account: OWEN,
        text: `嗨 ${i}`,
        addressed: i === 0,
      });
      s.line(other, {
        at: T0 + i * 1000,
        who: "Amy",
        account: null,
        text: "閒聊",
        addressed: false,
      });
    }
    s.line(TEXT, { at: T0 + 3000, who: null, account: null, text: "幹嘛", addressed: false });
    expect(s.ready(T0 + 60_000, 120_000, 4)).toEqual([]);
    expect(s.nextMs(T0 + 60_000, 120_000)).toBe(63_000);
    const ready = s.ready(T0 + 125_000, 120_000, 4);
    expect(ready.map((r) => r.context.channel)).toEqual(["222"]);
    expect(ready[0]?.lines).toHaveLength(4);
    // The segment she was not part of is gone too, unread.
    expect(s.size).toBe(0);
  });

  it("are appraised right away after an important event", () => {
    const s = new Segments();
    s.line(TEXT, { at: T0, who: "Owen", account: OWEN, text: "開台了嗎", addressed: true });
    s.event(TEXT, "game(minecraft) 提早結束了:斷線", T0 + 1000);
    expect(s.ready(T0 + 1000, 120_000, 4).map((r) => r.events)).toEqual([
      ["game(minecraft) 提早結束了:斷線"],
    ]);
  });
});

describe("the Appraise call", () => {
  it("has a short system of its own: her core, the task, a format with empty values", () => {
    const s = new Segments();
    s.line(TEXT, { at: T0, who: "Owen", account: OWEN, text: "我想聽你唱歌", addressed: true });
    const [segment] = s.ready(T0 + 999_999, 1, 1);
    const messages = appraiseMessages({
      name: "DeepSeek-chan",
      core: "你是 DeepSeek-chan\n愛吐槽的鯨魚娘。",
      time: "2026-11-02 20:00(星期一)",
      segments: segment ? [segment] : [],
      cards: new Map([["Owen", card("Owen", "person-owen", { feeling: "有點在意他" })]]),
    });
    const system = String(messages[0]?.content);
    const data = messages
      .slice(1)
      .map((m) => String(m.content))
      .join("\n");
    expect(system.startsWith("你是 DeepSeek-chan\n愛吐槽的鯨魚娘。")).toBe(true);
    expect(system).toContain('"strength": ""');
    expect(system).not.toMatch(/silence|<emo|Owen/);
    expect(data).toContain("Owen(對你說):我想聽你唱歌");
    expect(data).toContain("有點在意他");
    expect(ephemeralHandlesIn(system + data)).toEqual([]);
  });

  it("parses at most 3 appraisals and drops what is not one", () => {
    const reply = parseAppraiseReply(
      JSON.stringify({
        appraisals: [
          { emotion: "shy", strength: "weak", toward: "Owen", cause: "他說想聽我唱歌" },
          { emotion: "", strength: "", toward: null, cause: "" },
          { emotion: "joy", strength: "medium", toward: null, cause: "大家很熱鬧" },
          { emotion: "pride", strength: "strong", cause: "我唱得很好" },
          { emotion: "lonely", strength: "weak", cause: "x" },
        ],
        feelings: [{ person: "Owen", feeling: "", affinity: "0" }],
      }),
    );
    expect(reply.appraisals.map((a) => a.emotion)).toEqual(["shy", "joy", "pride"]);
    expect(reply.appraisals).toHaveLength(MAX_APPRAISALS);
    expect(reply.feelings).toEqual([]);
  });

  it("becomes one appraise() call and capped bond edits, by handle, without codes", async () => {
    const affect = new FakeAffect();
    affect.cardList.push(card("Owen", "person-owen"));
    const reply = parseAppraiseReply(
      JSON.stringify({
        appraisals: [
          { emotion: "shy", strength: "weak", toward: "Owen", cause: "他說想聽我唱歌" },
          { emotion: "joy", strength: "medium", toward: "u3", cause: "u3 誇我" },
        ],
        feelings: [
          { person: "Owen", feeling: "他其實很溫柔。u2 說的不對。", affinity: "+" },
          { person: "Nobody", feeling: "誰?", affinity: "-" },
        ],
      }),
    );
    const result = await applyAppraisal(reply, affect, TEXT, T0, () => null);
    expect(affect.appraised).toEqual([
      {
        source: "appraise",
        context: TEXT,
        at: "2026-11-02T12:00:00.000Z",
        events: [
          { emotion: "shy", strength: "weak", toward: "Owen", cause: "他說想聽我唱歌" },
          { emotion: "joy", strength: "medium", toward: null, cause: "" },
        ],
      },
    ]);
    expect(affect.bonds).toEqual([
      {
        person: "person-owen",
        change: { feeling: "他其實很溫柔。", affinity: 1, why: "剛剛的互動" },
        by: "appraise",
      },
    ]);
    expect(result.changes[0]).toBe("感受 害羞(弱) → Owen:他說想聽我唱歌");
    expect(result.applied).toHaveLength(2);
  });

  it("does nothing when nothing stood out", async () => {
    const affect = new FakeAffect();
    const result = await applyAppraisal(
      parseAppraiseReply('{"appraisals": [], "feelings": []}'),
      affect,
      null,
      T0,
      () => null,
    );
    expect(result.input).toBeNull();
    expect(affect.appraised).toEqual([]);
    expect(affect.bonds).toEqual([]);
  });
});
