import { REQUEST_RULE } from "@miyoria/actions";
import type { ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { groundArgs, slimTool, upToSentence } from "../src/mainline/output.js";

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
    // v4 §4.2: an argument is described whole again (V3 kept its first clause, 「場景」).
    expect(properties.scene?.description).toBe("場景,預設聊天");
  });

  it("offers a tool's whole description, each part within its limit, the request rule once", () => {
    const spec = slimTool(
      {
        name: "web_read",
        description: `讀一個網頁。回傳正文,太長的會分段。用在查到連結以後。${REQUEST_RULE}`,
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "網址。一定要是 http 或 https。不要編造。" },
            why: { type: "string", description: "為什麼" },
          },
        },
      },
      { description: 20, argument: 12 },
    );
    expect(spec.description).toBe("讀一個網頁。回傳正文,太長的會分段。");
    const properties = (spec.parameters as { properties: Record<string, { description: string }> })
      .properties;
    expect(properties.url?.description).toBe("網址。");
    expect(properties.why).toBeUndefined();
    const whole = slimTool({
      name: "x",
      description: `一。二。三。${REQUEST_RULE}`,
      parameters: { type: "object" },
    });
    expect(whole.description).toBe("一。二。三。");
    expect(upToSentence("沒有句號的一長串字", 5)).toBe("沒有句號…");
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
