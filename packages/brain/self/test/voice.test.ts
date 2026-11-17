// What the runner does for the voice profile: requests that open like text's, sentences said as
// they are written and screened one by one, lines the outlet writes itself, and the silences where
// the old turn said a fixed wait line.

import { describe, expect, it } from "vitest";
import { PROFILES } from "../src/profiles.js";
import { serialiseMessages, serialiseTools } from "../src/prompt.js";
import { PROFILE_NOTES } from "../src/rules.js";
import { asideLine, StepText } from "../src/screens.js";
import type { Delivery, OutgoingLine } from "../src/types.js";
import { addressed, calls, fakeTool, rig, say } from "./harness.js";

describe("a voice request", () => {
  it("opens like a text one: the same block 1 and tools; the voice note comes last", async () => {
    const r = await rig([say("好。"), say("好。")]);
    r.tools.register(fakeTool("web_search"));
    r.tools.register(fakeTool("react", "ok", { effect: "say" }));
    r.line("Owen", "@她 在嗎");
    await r.run(addressed(), { profile: PROFILES.text });
    await r.run(addressed(), { profile: PROFILES.voice });
    const [text, voice] = r.model.requests;
    expect(serialiseMessages(voice?.messages.slice(0, 1) ?? [])).toEqual(
      serialiseMessages(text?.messages.slice(0, 1) ?? []),
    );
    expect(serialiseTools(voice?.tools ?? [])).toEqual(serialiseTools(text?.tools ?? []));
    const last = String(voice?.messages.at(-1)?.content ?? "");
    expect(last).toContain(PROFILE_NOTES.voice ?? "-");
    expect(String(text?.messages[0]?.content ?? "")).not.toContain("## 語音");
  });
});

describe("spoken text", () => {
  const all = (unit: "line" | "sentence", parts: readonly string[]) => {
    const s = new StepText(unit);
    const out = parts.flatMap((p) => s.push(p));
    return { lines: [...out, ...s.finish()], screen: s };
  };

  it("is cut into sentences as it streams, each with the emotion it was written under", () => {
    const { lines } = all("sentence", [
      "<emo:happy>考完啦?",
      "辛苦了",
      "。<emo:sad>可是",
      "我好累",
    ]);
    expect(lines).toEqual([
      { text: "考完啦?", emotion: "happy" },
      { text: "辛苦了。", emotion: "happy" },
      { text: "可是我好累", emotion: "sad" },
    ]);
  });

  it("leaves out a sentence that is reasoning or a note to herself, and says the rest (#10)", () => {
    const { lines, screen } = all("sentence", [
      "好啊。回覆要簡短。",
      "Owen在問我歌名,直接告訴他就好。",
      "是那首海的歌!",
    ]);
    expect(lines.map((l) => l.text)).toEqual(["好啊。", "是那首海的歌!"]);
    expect(screen.leakDropped).toBe(1);
    expect(screen.selfTalkCut).toBe(1);
  });

  it("keeps a link and a code block apart, never in a sentence", () => {
    const { lines } = all("sentence", ["給你看 https://example.com/a?b=1 ", "很好笑吧。"]);
    expect(lines.map((l) => l.text)).toEqual(["給你看", "https://example.com/a?b=1", "很好笑吧。"]);
    expect(asideLine("https://example.com/a?b=1")).toBe(true);
    expect(asideLine("```x```")).toBe(true);
    expect(asideLine("很好笑吧。")).toBe(false);
  });

  it("a voice run says each sentence before the next is written", async () => {
    const r = await rig([say("嗨。今天好嗎?")]);
    r.line("Owen", "@她 嗨");
    await r.run(addressed(), { profile: PROFILES.voice });
    expect(r.outlet.texts()).toEqual(["嗨。", "今天好嗎?"]);
  });
});

/** An outlet that keeps the lines for itself, as the voice outlet does until they play. */
function later(r: Awaited<ReturnType<typeof rig>>): void {
  r.outlet.deliver = async (line: OutgoingLine): Promise<Delivery> => {
    r.outlet.lines.push(line);
    return { status: "delivered", message_id: null, later: true };
  };
}

describe("lines the outlet writes itself", () => {
  it("are not written by the runner, but the run's next step reads them", async () => {
    const r = await rig([calls([{ name: "web_search" }], "我查一下。"), say("找到了。")]);
    r.tools.register(fakeTool("web_search"));
    later(r);
    r.line("Owen", "@她 幫我查");
    const result = await r.run(addressed(), { profile: PROFILES.voice });
    expect(result.lines).toEqual(["我查一下。", "找到了。"]);
    const kinds = r.transcript.tail("s1").entries.map((e) => [e.kind, e.content]);
    expect(kinds).toEqual([
      ["other", "@她 幫我查"],
      ["tool_calls", ""],
      ["tool_result", "web_search 的結果"],
    ]);
    const second = r.model.requests[1]?.messages ?? [];
    expect(second.some((m) => m.role === "assistant" && m.content === "我查一下。")).toBe(true);
  });
});

describe("the silence while tools run", () => {
  const slow = (r: Awaited<ReturnType<typeof rig>>) =>
    fakeTool("web_search", "結果", {
      call: () => {
        r.clock.tick(1_500);
        return "結果";
      },
    });

  it("is counted when nothing of hers went out before a slow round", async () => {
    const r = await rig([calls([{ name: "web_search" }]), say("找到了。")]);
    r.tools.register(slow(r));
    r.line("Owen", "@她 查");
    await r.run(addressed(), { profile: PROFILES.voice });
    expect(r.events.at(-1)).toMatchObject({ type: "finished", silent_waits: 1 });
  });

  it("is not when she said something first, and text runs do not count it", async () => {
    const r = await rig([calls([{ name: "web_search" }], "等我查。"), say("找到了。")]);
    r.tools.register(slow(r));
    r.line("Owen", "@她 查");
    await r.run(addressed(), { profile: PROFILES.voice });
    expect(r.events.at(-1)).toMatchObject({ type: "finished", silent_waits: 0 });
    await r.run(addressed(), { profile: PROFILES.text });
    expect(r.events.at(-1)).not.toHaveProperty("silent_waits");
  });
});
