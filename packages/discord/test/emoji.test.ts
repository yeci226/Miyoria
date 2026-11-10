import type { PromptRequest } from "@miyoria/types";
import { describe, expect, test } from "vitest";
import {
  type EmojiLimits,
  EmojiTable,
  EmojiUsage,
  emojiContributor,
  emojiLines,
  reactionEmoji,
  renderEmoji,
  type ServerEmoji,
  serverEmoji,
} from "../src/emoji.js";
import { cleanLine, type DescriptionStore, EmojiDescriber } from "../src/emoji-describe.js";
import { DiscordSink, type RestLike, type RestRequest } from "../src/sink.js";

const rice: ServerEmoji = { id: "111", name: "fanfan", animated: false, available: true };
const dance: ServerEmoji = { id: "222", name: "dance", animated: true, available: true };
const gone: ServerEmoji = { id: "333", name: "gone", animated: false, available: false };

const limits: EmojiLimits = { per_message: 1, window_messages: 3, max_in_window: 1 };

function table(): EmojiTable {
  const t = new EmojiTable();
  t.setGuild("1", [rice, dance, gone]);
  return t;
}

const lookup = (name: string) => table().get("1", name);

describe("server emoji table", () => {
  test("maps_discord_emoji_and_skips_unusable_ones", () => {
    expect(serverEmoji({ id: "9", name: "x", animated: null, available: undefined })).toEqual({
      id: "9",
      name: "x",
      animated: false,
      available: true,
    });
    expect(serverEmoji({ id: null, name: "x" })).toBeNull();
    const t = table();
    expect(t.list("1").map((e) => e.name)).toEqual(["dance", "fanfan"]);
    expect(t.get("1", "gone")).toBeUndefined();
    expect(t.get("1", "FanFan")?.id).toBe("111");
    expect(t.list(null)).toEqual([]);
  });

  test("tells_listeners_about_changes", () => {
    const t = new EmojiTable();
    const seen: string[] = [];
    const off = t.onChange((g) => seen.push(g));
    t.upsert("1", rice);
    t.remove("1", "111");
    t.remove("1", "111");
    off();
    t.upsert("1", rice);
    expect(seen).toEqual(["1", "1"]);
  });
});

describe("renderEmoji", () => {
  test("turns_known_names_into_markup_and_leaves_others", () => {
    const out = renderEmoji("好餓 :fanfan: :nothing:", lookup, [], limits);
    expect(out).toEqual({ text: "好餓 <:fanfan:111> :nothing:", used: ["fanfan"] });
    expect(renderEmoji("轉圈 :dance:", lookup, [], limits).text).toBe("轉圈 <a:dance:222>");
  });

  test("leaves_existing_markup_and_times_alone", () => {
    const text = "已經有 <:fanfan:111> 了,現在 12:30:45";
    expect(renderEmoji(text, lookup, [], limits)).toEqual({ text, used: [] });
  });

  test("one_per_message", () => {
    const out = renderEmoji("嗨 :fanfan: 再來 :dance: !", lookup, [], limits);
    expect(out.text).toBe("嗨 <:fanfan:111> 再來!");
    expect(out.used).toEqual(["fanfan"]);
  });

  test("not_twice_in_the_window_and_never_the_same_twice_in_a_row", () => {
    // One of her last two messages already had one.
    expect(renderEmoji("又 :dance:", lookup, [[], ["fanfan"]], limits).text).toBe("又");
    // Out of the window, but the last one she used was the same.
    expect(renderEmoji("又 :fanfan:", lookup, [["fanfan"], [], []], limits).text).toBe("又");
    expect(renderEmoji("換 :dance:", lookup, [["fanfan"], [], []], limits).text).toBe(
      "換 <a:dance:222>",
    );
  });

  test("a_message_of_only_emoji_keeps_one", () => {
    expect(renderEmoji(":fanfan:", lookup, [[], ["dance"]], limits).text).toBe("<:fanfan:111>");
  });
});

describe("reactions", () => {
  test("server_emoji_names_become_name_and_id", () => {
    expect(reactionEmoji(":fanfan:", lookup)).toBe("fanfan:111");
    expect(reactionEmoji("fanfan", lookup)).toBe("fanfan:111");
    expect(reactionEmoji("👍", lookup)).toBe("👍");
    expect(reactionEmoji("unknown", lookup)).toBe("unknown");
  });
});

describe("prompt block", () => {
  const meanings = {
    owner: (name: string) => (name === "fanfan" ? "一碗白飯,討飯用" : undefined),
    described: (id: string) => (id === "222" ? "小人轉圈圈" : undefined),
  };

  test("lists_meanings_first", () => {
    const t = new EmojiTable();
    const plain: ServerEmoji = { id: "444", name: "aaa", animated: false, available: true };
    t.setGuild("1", [plain, rice, dance]);
    expect(emojiLines(t.list("1"), meanings, 10)).toEqual([
      ":dance: — 小人轉圈圈",
      ":fanfan: — 一碗白飯,討飯用",
      ":aaa:",
    ]);
    expect(emojiLines(t.list("1"), meanings, 1)).toHaveLength(1);
  });

  test("only_for_text_turns_in_a_guild", async () => {
    const contributor = emojiContributor(table(), meanings, {
      max_listed: 40,
      enabled: () => true,
    });
    const request = (scope: string | null, voice: boolean) =>
      ({
        context: { platform: "discord", scope, channel: "200", kind: "channel" },
        voice,
      }) as unknown as PromptRequest;
    const [section] = await contributor.contribute(request("1", false));
    expect(section?.title).toBe("伺服器表情");
    expect(section?.body).toContain(":fanfan: — 一碗白飯,討飯用");
    expect(await contributor.contribute(request("1", true))).toEqual([]);
    expect(await contributor.contribute(request(null, false))).toEqual([]);
  });
});

describe("EmojiDescriber", () => {
  const png = () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });

  test("describes_new_emoji_once_and_keeps_the_line", async () => {
    const saved = new Map<string, string>();
    const store: DescriptionStore = {
      load: async () => new Map([["222", "小人轉圈圈"]]),
      save: async (id, line) => {
        saved.set(id, line);
      },
    };
    const asked: string[] = [];
    const describer = new EmojiDescriber(
      store,
      async (url, name) => {
        asked.push(name);
        expect(url.startsWith("data:image/png;base64,")).toBe(true);
        return "「一碗白飯」\n多餘的";
      },
      async () => png(),
    );
    const signal = new AbortController().signal;
    await describer.describeMissing([rice, dance], () => false, signal);
    await describer.describeMissing([rice, dance], () => false, signal);
    expect(asked).toEqual(["fanfan"]);
    expect(describer.get("111")).toBe("一碗白飯");
    expect(describer.get("222")).toBe("小人轉圈圈");
    expect(saved.get("111")).toBe("一碗白飯");
  });

  test("skips_the_owners_and_works_without_a_model", async () => {
    const asked: string[] = [];
    const describer = new EmojiDescriber(
      null,
      async (_url, name) => {
        asked.push(name);
        return "x";
      },
      async () => png(),
    );
    await describer.describeMissing([rice], () => true, new AbortController().signal);
    expect(asked).toEqual([]);
    const none = new EmojiDescriber(null, null);
    await none.describeMissing([rice], () => false, new AbortController().signal);
    expect(none.get("111")).toBeUndefined();
  });

  test("clean_line", () => {
    expect(cleanLine('  "一碗白飯,討飯用"  ')).toBe("一碗白飯,討飯用");
    expect([...cleanLine("長".repeat(60))]).toHaveLength(40);
  });
});

class FakeRest implements RestLike {
  bodies: unknown[] = [];
  routes: string[] = [];

  async post(route: `/${string}`, options?: RestRequest): Promise<unknown> {
    this.routes.push(route);
    this.bodies.push(options?.body);
    return { id: String(this.bodies.length) };
  }

  async put(route: `/${string}`): Promise<unknown> {
    this.routes.push(route);
    return undefined;
  }
}

describe("DiscordSink with server emoji", () => {
  const channel = { platform: "discord", scope: "1", channel: "200", kind: "channel" } as const;

  test("sends_markup_within_the_limits_and_reacts_by_name", async () => {
    const rest = new FakeRest();
    const sink = new DiscordSink(rest, () => undefined, {
      table: table(),
      usage: new EmojiUsage(),
      enabled: () => true,
      limits: () => limits,
    });
    await sink.send(channel, { text: "餓了 :fanfan:", reply_to: null });
    await sink.send(channel, { text: "還是餓 :dance:", reply_to: null });
    const contents = rest.bodies.map((b) => (b as { content: string }).content);
    expect(contents).toEqual(["餓了 <:fanfan:111>", "還是餓"]);
    await sink.react({ context: channel, id: "5" }, ":fanfan:");
    expect(rest.routes.at(-1)).toBe(
      `/channels/200/messages/5/reactions/${encodeURIComponent("fanfan:111")}/@me`,
    );
  });

  test("dms_and_a_switched_off_table_send_text_as_written", async () => {
    const rest = new FakeRest();
    let on = false;
    const sink = new DiscordSink(rest, () => undefined, {
      table: table(),
      usage: new EmojiUsage(),
      enabled: () => on,
      limits: () => limits,
    });
    await sink.send(channel, { text: ":fanfan:", reply_to: null });
    on = true;
    const dm = { platform: "discord", scope: null, channel: "300", kind: "dm" } as const;
    await sink.send(dm, { text: ":fanfan:", reply_to: null });
    expect(rest.bodies.map((b) => (b as { content: string }).content)).toEqual([
      ":fanfan:",
      ":fanfan:",
    ]);
  });
});
