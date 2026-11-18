// What she hears of a card: one short line for a rare card, the pity, a wished part and a title,
// nothing for an ordinary card, and no number that is not public.

import { describe, expect, it } from "vitest";
import { cardNotes, type IssuedCard } from "../src/index.js";

const part = (id: string, rarity: "N" | "R" | "SR" | "SSR", name: string) => ({
  id,
  slot: id.slice(0, id.indexOf(".")) as "hand",
  rarity,
  series: null,
  name,
  blank: false,
});

function issued(over: Partial<IssuedCard["card"]> = {}, titles: IssuedCard["titles"] = []) {
  return {
    card: {
      serial: "MYR-0000-0000-0001",
      person: "p1",
      kind: "daily",
      rarity: "N",
      parts: [part("pose.front", "N", "正面")],
      expression: { id: "smile", name: "微笑" },
      foil: false,
      seed: 1,
      face: {
        name: "小明",
        avatar_url: null,
        call_name: null,
        line: null,
        stamp: null,
        fields: [],
        number: 3,
      },
      relationship: {
        tier: "朋友",
        tier_label: "朋友 I",
        closeness: "不錯",
        trust: "有點信任",
        familiarity: "見過幾次",
        public_feeling: null,
      },
      artifact_id: null,
      price: 30,
      pity_hit: false,
      wished: [],
      frame: null,
      created_at: "2026-11-17T02:00:00.000Z",
      issue_key: null,
      ...over,
    },
    pity: { since: 0, pity: 20, until: 20 },
    new_parts: [],
    titles,
    again: false,
  } as IssuedCard;
}

const names = new Map([["background.aurora", "極光"]]);

describe("what she hears of a card", () => {
  it("is nothing for an ordinary card", () => {
    expect(cardNotes(issued(), names)).toEqual([]);
  });

  it("is one line each for a rare card, the pity, a wish and a title", () => {
    const lines = cardNotes(
      issued(
        {
          rarity: "SSR",
          parts: [part("pose.front", "N", "正面"), part("background.aurora", "SSR", "極光")],
          pity_hit: true,
          wished: ["background.aurora"],
          face: { ...issued().card.face, call_name: "小明明" },
        },
        [
          {
            series: "sky",
            title: "摘星的人",
            card: "MYR-0000-0000-0001",
            public: false,
            earned_at: "2026-11-17T02:00:00.000Z",
          },
        ],
      ),
      names,
    );
    expect(lines).toEqual([
      "小明明 自己抽卡,抽到一張 SSR 的卡,上面有「極光」(是 小明明 的卡,不是你抽的)。",
      "小明明 好久沒抽到 SR 以上,小明明 這張是保底給的。",
      "小明明 抽到的卡上有 小明明 願望單上的「極光」。",
      "小明明 集滿了一個系列,拿到一個稱號。",
    ]);
    // Nothing private: not the price, the card's number, the pity count, the relationship or a
    // title they have not made public.
    expect(lines.join("")).not.toMatch(/30|第 3|20|朋友|摘星/);
  });

  it("names a title only when it is public", () => {
    const title = (series: string, name: string, shown: boolean) => ({
      series,
      title: name,
      card: "MYR-0000-0000-0001",
      public: shown,
      earned_at: "2026-11-17T02:00:00.000Z",
    });
    expect(
      cardNotes(
        issued({}, [title("sky", "摘星的人", false), title("night", "夜貓子", true)]),
        names,
      ),
    ).toEqual(["小明 集滿了一個系列,拿到一個稱號。", "小明 集滿了一個系列,拿到稱號「夜貓子」。"]);
  });

  it("says who picked up a card she dropped, and nothing for a keepsake", () => {
    const fireworks = {
      ...part("background.fireworks", "SR", "頻道裡的煙火"),
      slot: "background" as const,
    };
    const drop = issued({ kind: "drop", rarity: "SR", price: 0, parts: [fireworks] });
    expect(cardNotes(drop, names)).toEqual([
      "你丟在頻道裡的卡被 小明 撿走了,上面有「頻道裡的煙火」。",
    ]);
    expect(cardNotes(issued({ kind: "keepsake", rarity: "SSR", price: 0 }), names)).toEqual([]);
  });

  it("is the tier for a milestone card, and a wish on it was not drawn", () => {
    const lines = cardNotes(
      issued({
        kind: "milestone",
        issue_key: "milestone:45",
        rarity: "SSR",
        price: 0,
        parts: [part("background.aurora", "SSR", "極光")],
        wished: ["background.aurora"],
      }),
      names,
    );
    expect(lines).toEqual([
      "你和 小明 的關係到了「好朋友」,你給了他一張里程碑卡。",
      "小明 拿到的卡上有 小明 願望單上的「極光」。",
    ]);
  });
});
