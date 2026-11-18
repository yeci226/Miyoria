// The typing notice of a text run: Discord has no "stop typing", so it goes out only once she is
// going to speak (her first visible text streams), is refreshed while the run goes on, and is
// never sent for a run that ends in a reaction or in silence.

import { defineTool } from "@miyoria/llm/tools";
import { sleep } from "@miyoria/runtime/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { calls, channel, mention, Rig, says, stopRigs, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");

const tool = (name: string, ms: number) =>
  defineTool({
    name,
    description: "測試用。",
    parameters: z.object({}),
    effect: "read",
    speed: "instant",
    risk: "low",
    group: "test",
    core: true,
    next: true,
    readOnly: true,
    call: async () => {
      await sleep(ms);
      return "好了";
    },
  });

/** The kinds of the actions so far, in order: "typing" or "send". */
function kinds(rig: Rig): string[] {
  return rig.sink.actions.flatMap((a) => {
    const t = a.payload.type;
    return t === "typing" ? ["typing"] : t === "send_message" ? ["send"] : [];
  });
}

describe("the typing notice", () => {
  // Discord has no "stop typing": a notice lingers about ten seconds. She shows that she is
  // answering from the start (the wait before her first word is the long part), and the notices
  // stop as early as it is known that nothing will be said.
  it("stops being refreshed once she only reacts", async () => {
    const rig = await Rig.create({
      config: { typing_refresh_ms: 1000 },
      provide: (_sup, tools) => tools.register(tool("react", 2_300)),
    });
    rig.model.push(calls("react", {}), says("<silence/>"));
    rig.say(mention(C1, "amy", "@她 看這個"));
    await until(() => rig.model.requests.length === 2, 6_000, "the run");
    await sleep(150);
    // One at the start; none during the 2.3 s the reaction took, none after.
    expect(kinds(rig)).toEqual(["typing"]);
  });

  it("starts again when she speaks after reacting", async () => {
    const rig = await Rig.create({
      config: { typing_refresh_ms: 1000 },
      provide: (_sup, tools) => tools.register(tool("react", 50)),
    });
    rig.model.push(calls("react", {}), says("好啦"));
    rig.say(mention(C1, "amy", "@她 看這個"));
    await until(() => rig.sink.texts().length === 1, 6_000, "the reply");
    const seen = kinds(rig);
    expect(seen.filter((k) => k === "typing").length).toBeGreaterThanOrEqual(2);
    expect(seen.lastIndexOf("typing")).toBeLessThan(seen.lastIndexOf("send"));
  });

  it("is sent once for a silent run and not again", async () => {
    const rig = await Rig.create({ config: { typing_refresh_ms: 1000 } });
    rig.model.push(says("<silence/>"));
    rig.say(mention(C1, "amy", "@她 嗯"));
    await until(() => rig.model.requests.length === 1, 3_000, "the run");
    await sleep(1_300);
    expect(kinds(rig)).toEqual(["typing"]);
  });

  it("is sent once for a run that only feels and not again", async () => {
    const rig = await Rig.create({ config: { typing_refresh_ms: 1000 } });
    rig.model.push(says("<feel>\n我: 難過 弱\n</feel>"));
    rig.say(mention(C1, "amy", "@她 嗯"));
    await until(() => rig.model.requests.length === 1, 3_000, "the run");
    await sleep(1_300);
    expect(kinds(rig)).toEqual(["typing"]);
  });

  it("comes before the first message of a run that speaks", async () => {
    const rig = await Rig.create({ config: { typing_refresh_ms: 1000 } });
    rig.model.push(says("早安"));
    rig.say(mention(C1, "amy", "@她 早安"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the reply");
    expect(kinds(rig)[0]).toBe("typing");
    expect(kinds(rig)).toContain("send");
  });

  it("is refreshed while a long run goes on", async () => {
    const rig = await Rig.create({
      config: { typing_refresh_ms: 1000 },
      provide: (_sup, tools) => tools.register(tool("slow", 2_300)),
    });
    rig.model.push(
      [{ type: "text_delta", text: "我查一下" }, ...calls("slow", {})],
      says("查好了"),
    );
    rig.say(mention(C1, "amy", "@她 幫我查"));
    await until(() => rig.sink.texts().length === 2, 6_000, "both lines");
    const typing = kinds(rig).filter((k) => k === "typing").length;
    expect(typing).toBeGreaterThanOrEqual(3);
    // Nothing more once the run ended.
    const after = rig.sink.actions.length;
    await sleep(1_200);
    expect(rig.sink.actions.length).toBe(after);
  });
});
