// `[modules.agent.corrections]` reaches the runner: a note to herself (#19) is left out of a reply
// by default and goes out once its switch is off.

import { afterEach, describe, expect, it } from "vitest";
import { dm, line, Rig, says, stopRigs, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const DM = dm("dm-owen");
const NOTE = "Owen 要我幫他查天氣，查完回他就好";

describe("the output check switches of the config", () => {
  it("leave a note to herself out of her reply by default", async () => {
    const rig = await Rig.create();
    rig.model.push(says(`${NOTE}\n好，我查一下`));
    rig.say(line(DM, "owen", "在嗎"));
    await until(() => rig.sink.texts().length >= 1, 3_000, "the reply");
    expect(rig.sink.texts().join("")).toContain("我查一下");
    expect(rig.sink.texts().join("")).not.toContain(NOTE);
  });

  it("send it when `self_talk` is off", async () => {
    const rig = await Rig.create({ config: { corrections: { self_talk: false } } });
    rig.model.push(says(`${NOTE}\n好，我查一下`));
    rig.say(line(DM, "owen", "在嗎"));
    await until(() => rig.sink.texts().join("").includes("我查一下"), 3_000, "the reply");
    expect(rig.sink.texts().join("")).toContain(NOTE);
  });
});
