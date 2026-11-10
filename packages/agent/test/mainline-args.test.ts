import type { ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { groundArgs, slimTool } from "../src/mainline/output.js";

const here: ContextKey = { platform: "discord", scope: "g1", channel: "text1", kind: "channel" };

describe("tool arguments on the main line", () => {
  it("keeps the hint that an id can be left out", () => {
    const spec = slimTool({
      name: "stream_start",
      description: "開台。",
      parameters: {
        type: "object",
        properties: {
          guild: { type: "string", description: "伺服器 id(省略 = 這個伺服器)" },
          scene: { type: "string", description: "場景,預設聊天" },
        },
      },
    });
    const properties = (spec.parameters as { properties: Record<string, { description: string }> })
      .properties;
    expect(properties.guild?.description).toContain("省略");
    expect(properties.scene?.description).toBe("場景");
  });

  it("drops a guild that is not this server", () => {
    expect(groundArgs("stream_start", { guild: "text1" }, here)).toEqual({});
    expect(groundArgs("stream_start", { guild: "g1" }, here)).toEqual({ guild: "g1" });
  });

  it("does not take the text channel for a voice channel", () => {
    expect(groundArgs("voice_join", { channel: "text1" }, here)).toEqual({});
    expect(groundArgs("voice_join", { channel: "v1" }, here)).toEqual({ channel: "v1" });
  });

  it("leaves the ids of a proposal alone where no server is known", () => {
    const core: ContextKey = {
      platform: "core",
      scope: null,
      channel: "mainline",
      kind: "channel",
    };
    expect(groundArgs("voice_join", { guild: "g1", channel: "v1" }, core)).toEqual({
      guild: "g1",
      channel: "v1",
    });
  });
});
