// The lorebook (World Info) and the style note of a turn (its Author's Note): what comes up and
// when, the kaomoji offered, and the shipped `profiles/deepseek-chan/lorebook.toml`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Lorebook, parseLorebook } from "@miyoria/profile";
import { describe, expect, it } from "vitest";
import {
  KAOMOJI_LINE,
  MAX_ENTRIES,
  pickKaomoji,
  STYLE_LINES,
  styleNote,
  triggeredEntries,
} from "../src/lorebook.js";

const SHIPPED = join(
  fileURLToPath(new URL("../../..", import.meta.url)),
  "profiles/deepseek-chan/lorebook.toml",
);
const shipped = parseLorebook(readFileSync(SHIPPED, "utf8"), SHIPPED);

const book: Lorebook = parseLorebook(`
[[kaomoji]]
group = "開心"
moods = ["happy", "joy"]
faces = ["(H1)", "(H2)", "(H3)", "(H4)", "(H5)"]

[[kaomoji]]
group = "難過"
moods = ["sad"]
faces = ["(S1)", "(S2)", "(S3)"]

[[kaomoji]]
group = "生氣"
moods = ["angry"]
faces = ["(A1)", "(A2)"]

[[entries]]
id = "rice"
keys = ["白飯", "FanFan"]
text = "白飯是最愛"
priority = 30

[[entries]]
id = "fat"
keys = ["胖"]
text = "流線型"
priority = 40

[[entries]]
id = "busy"
keys = ["當機"]
text = "伺服器繁忙"
priority = 20

[[entries]]
id = "owner"
keys = ["主人"]
text = "偏心主人"
priority = 10

[[entries]]
id = "sulk"
moods = ["sad"]
text = "難過時想討抱抱"

[[entries]]
id = "spoken"
keys = ["唱歌"]
text = "只在語音"
channel = "voice"
`);

const ids = (entries: readonly { id: string }[]) => entries.map((e) => e.id);
const none = new Set<string>();

describe("lorebook entries", () => {
  it("come up on a key in any case, or on her mood", () => {
    expect(ids(triggeredEntries(book, "今天吃白飯", none, false))).toEqual(["rice"]);
    expect(ids(triggeredEntries(book, "請你吃 fanfan", none, false))).toEqual(["rice"]);
    expect(ids(triggeredEntries(book, "早安", new Set(["sad"]), false))).toEqual(["sulk"]);
    expect(triggeredEntries(book, "早安", new Set(["happy"]), false)).toEqual([]);
    expect(triggeredEntries(null, "白飯", none, false)).toEqual([]);
  });

  it("at most three, the highest priority first", () => {
    const all = "主人說你胖,吃太多白飯,伺服器當機了";
    expect(ids(triggeredEntries(book, all, none, false))).toEqual(["fat", "rice", "busy"]);
    expect(MAX_ENTRIES).toBe(3);
    expect(ids(triggeredEntries(book, all, none, false, 1))).toEqual(["fat"]);
  });

  it("an entry of one channel stays out of the other", () => {
    expect(triggeredEntries(book, "來唱歌", none, false)).toEqual([]);
    expect(ids(triggeredEntries(book, "來唱歌", none, true))).toEqual(["spoken"]);
    expect(ids(triggeredEntries(book, "白飯", none, true))).toEqual(["rice"]);
  });
});

describe("kaomoji of a turn", () => {
  const happy = new Set(["happy"]);
  const group = (face: string) => face.slice(1, 2);

  it("four, mostly of her mood's group and one of another", () => {
    for (let seed = 0; seed < 50; seed++) {
      const picks = pickKaomoji(book, happy, [], seed);
      expect(picks).toHaveLength(4);
      expect(new Set(picks).size).toBe(4);
      expect(picks.filter((f) => group(f) === "H")).toHaveLength(3);
    }
  });

  it("the same turn picks the same ones; another turn may not", () => {
    expect(pickKaomoji(book, happy, [], 7)).toEqual(pickKaomoji(book, happy, [], 7));
    const seen = new Set(
      Array.from({ length: 20 }, (_, s) => pickKaomoji(book, happy, [], s).join()),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("never one she used in her last lines", () => {
    const recent = ["好耶 (H1)", "嗯", "(H2)(H3) 才不是", "(S1)"];
    for (let seed = 0; seed < 50; seed++) {
      const picks = pickKaomoji(book, happy, recent, seed);
      for (const used of ["(H1)", "(H2)", "(H3)", "(S1)"]) expect(picks).not.toContain(used);
      // What is left of her group comes first, the others fill up.
      expect(picks.slice(0, 2).sort()).toEqual(["(H4)", "(H5)"]);
      expect(picks).toHaveLength(4);
    }
  });

  it("with no group of her mood, any group; with no book, none", () => {
    const picks = pickKaomoji(book, new Set(["thinking"]), [], 3);
    expect(picks).toHaveLength(4);
    expect(pickKaomoji(null, happy, [], 3)).toEqual([]);
  });
});

describe("the style note", () => {
  const rice = triggeredEntries(book, "白飯", none, false);

  it("text: the lines, the kaomoji to pick from, the entries", () => {
    expect(styleNote(false, ["(H1)", "(S2)"], rice)).toBe(
      [...STYLE_LINES.text, `${KAOMOJI_LINE}(H1) (S2)`, "- 白飯是最愛"].join("\n"),
    );
  });

  it("voice: the entries, no kaomoji", () => {
    const note = styleNote(true, ["(H1)"], rice);
    expect(note).toBe([...STYLE_LINES.voice, "- 白飯是最愛"].join("\n"));
    expect(note).not.toContain("(H1)");
    expect(note).not.toContain(KAOMOJI_LINE);
  });
});

describe("the shipped lorebook", () => {
  it("has the six kaomoji groups, none with a backtick, and the memes", () => {
    expect(shipped.kaomoji.map((g) => g.group)).toEqual([
      "開心得意",
      "害羞被誇",
      "嘟嘴不服",
      "慌張出包",
      "難過委屈",
      "疑惑偷懶",
    ]);
    const faces = shipped.kaomoji.flatMap((g) => g.faces);
    expect(faces.length).toBeGreaterThan(80);
    expect(faces.filter((f) => f.includes("`"))).toEqual([]);
    expect(new Set(faces).size).toBe(faces.length);
    expect(shipped.entries.map((e) => e.id).sort()).toEqual(
      ["owner", "rice", "server_busy", "slacker", "streamlined"].sort(),
    );
    for (const e of shipped.entries) expect([...e.text].length).toBeLessThanOrEqual(80);
  });

  it("maps each of her nine emotion tags to a group", () => {
    const tags = ["neutral", "happy", "smug", "annoyed", "angry", "embarrassed", "sad"];
    for (const tag of [...tags, "surprised", "thinking"]) {
      expect(
        shipped.kaomoji.some((g) => g.moods.includes(tag)),
        tag,
      ).toBe(true);
    }
  });

  it("brings up its memes by their words", () => {
    const of = (text: string) => ids(triggeredEntries(shipped, text, none, false));
    expect(of("餵你一碗")).toEqual(["rice"]);
    expect(of("大肥魚")).toEqual(["streamlined"]);
    expect(of("又當機了")).toEqual(["server_busy"]);
    expect(of("又在摸魚")).toEqual(["slacker"]);
    expect(of("主人來了")).toEqual(["owner"]);
  });
});
