import { describe, expect, it } from "vitest";
import { linkMentions, type MentionTarget } from "../src/mentions.js";

const OWEN: MentionTarget = { name: "Owen Liu", markup: "<@1>" };
const AMY: MentionTarget = { name: "amy", markup: "<@2>" };

describe("linkMentions", () => {
  it("matches the full name without regard to case", () => {
    expect(linkMentions("@owen liu 在嗎", [OWEN, AMY])).toBe("<@1> 在嗎");
    expect(linkMentions("@AMY 來", [OWEN, AMY])).toBe("<@2> 來");
  });

  it("takes the first word of a name when one person has it", () => {
    expect(linkMentions("@owen 你看", [OWEN, AMY])).toBe("<@1> 你看");
    expect(linkMentions("@Owen,你看", [OWEN, AMY])).toBe("<@1>,你看");
  });

  it("mentions nobody by a first word two people share", () => {
    const other: MentionTarget = { name: "Owen Chen", markup: "<@3>" };
    expect(linkMentions("@owen 你看", [OWEN, other])).toBe("@owen 你看");
    expect(linkMentions("@owen chen 你看", [OWEN, other])).toBe("<@3> 你看");
  });

  it("prefers a person named exactly that over another's first word", () => {
    const short: MentionTarget = { name: "owen", markup: "<@4>" };
    expect(linkMentions("@owen 你看", [OWEN, short])).toBe("<@4> 你看");
  });

  it("matches an alias: the name as the prompt shows it, a handle", () => {
    const colon: MentionTarget = { name: "小明:D", markup: "<@5>", aliases: ["小明∶D", "ming"] };
    expect(linkMentions("@小明∶D 好", [colon])).toBe("<@5> 好");
    expect(linkMentions("@ming 好", [colon])).toBe("<@5> 好");
  });

  it("leaves longer words, unknown names and code alone", () => {
    expect(linkMentions("@owenx 和 @nobody 和 `@amy`", [OWEN, AMY])).toBe(
      "@owenx 和 @nobody 和 `@amy`",
    );
    expect(linkMentions("寄到 a@amy.tw", [AMY])).toBe("寄到 a@amy.tw");
    expect(linkMentions("問一下@amy", [AMY])).toBe("問一下<@2>");
  });

  it("does not take a one-letter first word for the person", () => {
    expect(linkMentions("@a 好", [{ name: "A Lin", markup: "<@6>" }])).toBe("@a 好");
  });
});
