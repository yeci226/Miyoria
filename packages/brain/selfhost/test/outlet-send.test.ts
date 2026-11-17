// What is sent of a text line of hers: `@name` as the platform's mention, a long line in messages
// under `max_message_chars`. The transcript keeps what she wrote.

import {
  type AccountRef,
  type PlatformSink,
  PlatformSinks,
  PlatformSinksKey,
  type SocialSignals,
  SocialSignalsKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { splitLine } from "../src/split.js";
import { channel, mention, Rig, type RigOptions, says, stopRigs, until } from "./harness.js";

const C1 = channel("c1");

afterEach(async () => {
  await stopRigs();
});

function withMentions(): RigOptions["provide"] {
  return (sup) => {
    const sinks = new PlatformSinks();
    sinks.register({
      platform: "test",
      mention: (account: AccountRef) => `<@${account.id}>`,
    } as unknown as PlatformSink);
    sup.services.provide("app", PlatformSinksKey, sinks);
  };
}

describe("@name in a text line", () => {
  it("is sent as the platform's mention and kept as written in the transcript", async () => {
    const rig = await Rig.create({ provide: withMentions() });
    rig.model.push(says("@amy 好喔,也問一下 @nobody 和 `@amy`"));
    rig.say(mention(C1, "amy", "@她 在嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "her answer");
    expect(rig.sink.texts()[0]).toBe("<@amy> 好喔,也問一下 @nobody 和 `@amy`");
    const mine = rig.entries(C1).find((e) => e.kind === "self");
    expect(mine?.content).toContain("@amy 好喔");
    expect(mine?.content).not.toContain("<@amy>");
  });

  it("knows someone by what she calls them", async () => {
    const provide = withMentions();
    const rig = await Rig.create({
      provide: (sup, tools) => {
        provide?.(sup, tools);
        sup.services.provide("app", SocialSignalsKey, {
          attitude: (a: AccountRef) => (a.id === "amy" ? { call_name: "阿咪" } : null),
        } as unknown as SocialSignals);
      },
    });
    rig.model.push(says("@阿咪 好喔"));
    rig.say(mention(C1, "amy", "@她 在嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "her answer");
    expect(rig.sink.texts()[0]).toBe("<@amy> 好喔");
  });

  it("stays plain when mention_users is off", async () => {
    const rig = await Rig.create({ provide: withMentions(), config: { mention_users: false } });
    rig.model.push(says("@amy 好喔"));
    rig.say(mention(C1, "amy", "@她 在嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "her answer");
    expect(rig.sink.texts()).toEqual(["@amy 好喔"]);
  });
});

describe("a long line", () => {
  it("of 4500 characters goes out as messages under the limit, whole and in order", async () => {
    const rig = await Rig.create();
    const text = Array.from({ length: 700 }, (_, n) => `第${n}句話。`).join("");
    expect(text.length).toBeGreaterThan(4_500);
    rig.model.push(says(text));
    rig.say(mention(C1, "amy", "@她 說長一點"));
    await until(() => rig.sink.texts().join("").length >= text.length - 8, 8_000, "the parts");
    const sent = rig.sink.texts();
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.every((t) => t.length <= 1_900)).toBe(true);
    expect(sent.join("") === text).toBe(true);
    const mine = rig.entries(C1).filter((e) => e.kind === "self");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.content).toBe(text);
  });
});

describe("splitLine", () => {
  it("keeps a code block whole and a mention uncut", () => {
    const code = `\`\`\`ts\n${"const a = 1;\n".repeat(50)}\`\`\``;
    const text = `${"前面的話。".repeat(150)}\n\n${code}\n\n${"<@123456789012345678>".repeat(2)}${"字".repeat(100)}`;
    const parts = splitLine(text, 700);
    expect(parts.every((p) => p.length <= 700)).toBe(true);
    expect(parts.some((p) => p.includes(code))).toBe(true);
    expect(parts.join("")).toContain("<@123456789012345678>");
    for (const p of parts)
      expect((p.match(/<@/g) ?? []).length).toBe((p.match(/<@\d+>/g) ?? []).length);
  });

  it("cuts a code block longer than the limit by lines, each piece fenced", () => {
    const code = `\`\`\`\n${"line of code\n".repeat(100)}\`\`\``;
    const parts = splitLine(code, 300);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(300);
      expect(p.startsWith("```")).toBe(true);
      expect(p.endsWith("```")).toBe(true);
    }
  });

  it("returns a short text as it is", () => {
    expect(splitLine("嗨", 1_900)).toEqual(["嗨"]);
  });
});
