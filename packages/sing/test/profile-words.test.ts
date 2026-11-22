// The set list's prompt names the profile's coins (docs/design/v5-profiles.md); with none, the line
// is today's, byte for byte.

import { describe, expect, it } from "vitest";
import { SingPrompt } from "../src/prompt.js";
import type { SongEntry } from "../src/setlist.js";
import type { Singer } from "../src/singer.js";

const playing = { no: 1, query: "夜に駆ける", requester_name: "Amy" } as unknown as SongEntry;
const singer = {
  list: { playing: () => playing, ready: () => [], preparing: () => [], open: () => [] },
  starting: () => false,
  offlineSongs: () => null,
  voiceContext: () => ({ platform: "discord", scope: "g1", channel: "v", kind: "voice" }),
} as unknown as Singer;

const body = async (prompt: SingPrompt) => (await prompt.contribute())[0]?.body ?? "";

describe("the set list's words", () => {
  it("are today's with no profile", async () => {
    expect(await body(new SingPrompt(singer))).toContain(
      "唱歌時有人再點歌也能用 sing_request 準備,新歌會排在這首後面;只有連結也可以,不需要歌名。文字頻道照常回,收食物、查魚幣、簽到這些工具照常用,不用等唱完。",
    );
  });

  it("name another profile's coins", async () => {
    const text = await body(new SingPrompt(singer, () => "貝殼"));
    expect(text).toContain("收食物、查貝殼、簽到這些工具照常用");
    expect(text).not.toContain("魚幣");
  });
});
