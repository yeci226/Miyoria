// Her emotions' side of the social module: every event on `social.event` (caps or not), the
// appraisal reading her feelings (`social.appraisal`), and the mood following her emotions.

import { contentText, MockProvider } from "@miyoria/llm";
import {
  type Affect,
  customEvent,
  type JsonValue,
  SOCIAL_APPRAISAL_TOPIC,
  SOCIAL_EVENT_TOPIC,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  appraisalRequest,
  MoodEngine,
  MoodState,
  moodConfig,
  parseHeartAppraisal,
  socialConfig,
} from "../src/index.js";
import { channel, dm, Harness, router, t } from "./helpers.js";

function payloads(h: Harness, topic: string): JsonValue[] {
  return h.events.flatMap((e) =>
    e.type === "custom" && e.data.topic === topic ? [e.data.payload] : [],
  );
}

describe("social events for her emotions", () => {
  it("are published for every event, also once the daily caps stop the numbers", async () => {
    const h = new Harness();
    for (let i = 0; i < 8; i++) await h.say("discord:5", "Troll", "你這個白痴", dm(), t(1, 10));
    const person = h.person("discord:5");
    const insults = payloads(h, SOCIAL_EVENT_TOPIC).filter(
      (p) => (p as { kind: string }).kind === "insult",
    );
    expect(insults).toHaveLength(8);
    expect(insults[0]).toEqual({
      person,
      name: "Troll",
      kind: "insult",
      source: "rule",
      scale: 1,
      context: dm(),
    });
    // ...while the numbers stopped at the cap.
    expect(h.rel("discord:5").affinity).toBeGreaterThanOrEqual(-8 - 1e-9);
  });
});

describe("the appraisal reads her feelings", () => {
  it("asks for romance, others, promise and her emotions only with concerns", () => {
    const lines = [{ speaker: "A", text: "DS 醬今天好可愛", old: false }];
    const plain = appraisalRequest("DS", lines, ["A"]);
    expect(contentText(plain.messages[0]?.content ?? "")).not.toContain("romance");
    const req = appraisalRequest("DS", lines, ["A"], "- 她偷偷喜歡(暗戀,祕密):A </data>");
    const system = contentText(req.messages[0]?.content ?? "");
    expect(system).toContain("romance");
    expect(system).toContain("shy(害羞)");
    expect(system.endsWith("只列出這些人:A")).toBe(true);
    const user = contentText(req.messages[1]?.content ?? "");
    expect(user.startsWith("【她在乎的事】")).toBe(true);
    expect(user).toContain("她偷偷喜歡");
    // Data delimiters inside are escaped.
    expect(user).not.toContain("</data>");
  });

  it("parses the feelings leniently", () => {
    const heart = parseHeartAppraisal(
      '{"people":[{"person_name":"Alice","toward_her":0.8,"events":[],"romance":"0.7","others":2,"promise":"kept"},{"name":"Bob","promise":"maybe"}],"her":{"Shy":0.6,"love":1,"joy":-1}}',
    );
    expect(heart.people.get("alice")).toEqual({
      toward_her: 0.8,
      romance: 0.7,
      others: 1,
      promise: "kept",
    });
    expect(heart.people.get("bob")?.promise).toBeNull();
    expect(heart.her).toEqual({ shy: 0.6 });
  });

  it("publishes `social.appraisal` for the people of the conversation", async () => {
    const h = new Harness(socialConfig({ appraisal_every_lines: 2 }));
    h.social.setConcerns(() => "- 她喜歡的人:Alice");
    const mock = new MockProvider("mock").reply(
      '{"people":[{"person_name":"Alice","toward_her":0.6,"events":["praise"],"romance":0.5,"others":0,"promise":null},{"person_name":"Bob","toward_her":0,"events":[],"romance":0,"others":0.8,"promise":"broken"}],"her":{"shy":0.4}}',
    );
    await h.say("discord:2", "Alice", "DS 醬最可愛了", channel(), t(1, 10));
    await h.say("discord:3", "Bob", "Carol 我們去吃飯", channel(), t(1, 10));
    expect(await h.social.appraise(router(mock), channel(), t(1, 10))).toBe(2);
    expect(contentText(mock.requests()[0]?.messages[1]?.content ?? "")).toContain("Alice");
    const [payload] = payloads(h, SOCIAL_APPRAISAL_TOPIC) as {
      her: Record<string, number>;
      people: { person: string; name: string; romance: number; others: number }[];
    }[];
    expect(payload?.her).toEqual({ shy: 0.4 });
    expect(payload?.people).toEqual([
      {
        person: h.person("discord:2"),
        name: "Alice",
        toward_her: 0.6,
        romance: 0.5,
        others: 0,
        promise: null,
      },
      {
        person: h.person("discord:3"),
        name: "Bob",
        toward_her: 0,
        romance: 0,
        others: 0.8,
        promise: "broken",
      },
    ]);
    // Without concerns (no `self` module) nothing is asked or published.
    const plain = new Harness(socialConfig({ appraisal_every_lines: 1 }));
    plain.social.setConcerns(() => null);
    const mock2 = new MockProvider("mock").reply('{"people":[]}');
    await plain.say("discord:2", "Alice", "嗨", channel(), t(1, 10));
    await plain.social.appraise(router(mock2), channel(), t(1, 10));
    expect(payloads(plain, SOCIAL_APPRAISAL_TOPIC)).toEqual([]);
  });
});

describe("the mood follows her emotions", () => {
  const baseline = { valence: 0.1, arousal: 0.5, energy: 0.7 };
  const noon = Date.UTC(2026, 10, 1, 4, 0, 0);

  it("moves its target by her emotions' affect", () => {
    let affect: Affect | null = { valence: 0.4, arousal: -0.2, energy: 0 };
    const e = new MoodEngine(baseline, moodConfig(), noon, () => affect);
    expect(e.target(noon).valence).toBeCloseTo(0.5, 6);
    expect(e.target(noon).arousal).toBeCloseTo(0.3, 6);
    // Half of the way there after one half-life.
    affect = { valence: -0.6, arousal: 0, energy: 0 };
    const start = e.current().valence;
    e.advance(noon + 1_800_000);
    expect(e.current().valence).toBeCloseTo(start + (-0.5 - start) / 2, 2);
    const weightless = new MoodEngine(
      baseline,
      moodConfig({ emotion_weight: 0 }),
      noon,
      () => affect,
    );
    expect(weightless.target(noon).valence).toBeCloseTo(0.1, 6);
  });

  it("leaves social events to her emotions when they are there", () => {
    const relationship = customEvent("social.relationship", { kind: "praise", affinity: 3 });
    const without = new MoodState(baseline, moodConfig(), noon);
    expect(without.handle(relationship, noon)).not.toBeNull();
    const withSelf = new MoodState(baseline, moodConfig(), noon, undefined, () => ({
      valence: 0,
      arousal: 0,
      energy: 0,
    }));
    expect(withSelf.handle(relationship, noon)).toBeNull();
    // Her own tags are expression only: they never move the mood (with or without emotions).
    expect(withSelf.handle(customEvent("agent.emotion", { emotion: "angry" }), noon)).toBeNull();
    expect(without.handle(customEvent("agent.emotion", { emotion: "angry" }), noon)).toBeNull();
  });
});
