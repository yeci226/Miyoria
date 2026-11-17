// What the prompt says of the people here once the heart has rows for them (docs/design/
// v5-heart.md §2.5, §2.9): block 4's person tag with the tier, the level and the slow values as
// words; block 7's lines with the values that move by the day; `<style_note>`'s sentences from
// her feelings. No number but the level.

import type { HeartPeople, HeartView, PersonId } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  HEART_NOW_TITLE,
  heartNowBody,
  MOOD_STYLE,
  moodStyleLines,
  type PresentPerson,
  peopleBody,
} from "../src/index.js";

function view(person: PersonId, over: Partial<HeartView> = {}): HeartView {
  return {
    person,
    bond: 60,
    trust: 45,
    familiarity: 35,
    warmth: 0.5,
    respect: 0.2,
    ease: 0.45,
    grudge: 0,
    longing: 0,
    rapport: 0.2,
    stance: "嘴上嫌他,其實很照顧",
    impression: "很會煮飯的人",
    call_name: "阿明",
    tags: [],
    owner: false,
    blocked: false,
    last_seen: null,
    last_together: null,
    ...over,
  };
}

function heart(views: readonly HeartView[]): HeartPeople {
  const by = new Map(views.map((v) => [v.person, v]));
  const fake: Pick<HeartPeople, "view"> = { view: (p) => by.get(p) ?? null };
  return fake as HeartPeople;
}

const present = (handle: string, person: PersonId | null, speaker = false): PresentPerson => ({
  account: { platform: "test", id: handle },
  handle,
  person,
  speaker,
});

describe("block 4 from the heart", () => {
  it("is the tier, the level, the slow values in words and her words, no other number", () => {
    const body = peopleBody([present("ming", "p1", true), present("guest", null)], {
      heart: heart([view("p1")]),
    });
    expect(body.split("\n")).toEqual([
      expect.stringMatching(/^<scale>/),
      '<person name="ming" relation="好朋友" level="60/1000" trust="信任" familiar="熟" respect="欣賞" ease="自在" rapport="有點默契" call_as="阿明" impression="很會煮飯的人" stance="嘴上嫌他,其實很照顧"/>',
      '<person name="guest"/>',
    ]);
  });

  it("leaves a blocked person out, and says nothing of how warm she is now", () => {
    const body = peopleBody([present("bad", "p2"), present("ming", "p1")], {
      heart: heart([view("p2", { blocked: true }), view("p1", { warmth: 0.9, grudge: 0.8 })]),
    });
    expect(body).not.toContain("bad");
    expect(body).not.toMatch(/好感|心結|想念|warmth|grudge|longing/);
  });
});

describe("block 7 from the heart", () => {
  it("names how warm she is, a grudge and longing, with a sentence when they are high", () => {
    const body = heartNowBody(
      [
        { handle: "ming", person: "p1" },
        { handle: "kai", person: "p2" },
        { handle: "amy", person: "p3" },
        { handle: "nobody", person: null },
      ],
      heart([
        view("p1", { warmth: 0.5 }),
        view("p2", { warmth: -0.3, grudge: 0.45 }),
        view("p3", { warmth: 0.2, longing: 0.75 }),
      ]),
    );
    expect(body).toBe(
      [
        HEART_NOW_TITLE,
        "- ming:很有好感",
        "- kai:有點冷淡、有心結(你對他還有心結,還沒說開)",
        "- amy:有好感、很想念(你很想他)",
      ].join("\n"),
    );
  });

  it("is empty without the heart or anyone with a row", () => {
    expect(heartNowBody([{ handle: "ming", person: "p1" }], null)).toBe("");
    expect(heartNowBody([{ handle: "x", person: "p9" }], heart([]))).toBe("");
  });
});

describe("<style_note> from her feelings", () => {
  it("says longer or shorter, and in writing whether to react", () => {
    expect(moodStyleLines({ talkativeness: 0.4, valence: 0.5 }, false)).toEqual([
      MOOD_STYLE.longer,
      MOOD_STYLE.react,
    ]);
    expect(moodStyleLines({ talkativeness: -0.4, valence: -0.5 }, false)).toEqual([
      MOOD_STYLE.shorter,
      MOOD_STYLE.noReact,
    ]);
    expect(moodStyleLines({ talkativeness: -0.4, valence: 0.9 }, true)).toEqual([
      MOOD_STYLE.shorter,
    ]);
    expect(moodStyleLines({ talkativeness: 0, valence: 0 }, false)).toEqual([]);
    expect(moodStyleLines(null, false)).toEqual([]);
  });
});
