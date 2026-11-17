import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_TOOL_META,
  defineTool,
  FIND_TOOLS,
  LoadedTools,
  searchTerms,
  searchTools,
  TOOL_EFFECTS,
  TOOL_RISKS,
  TOOL_SPEEDS,
  type Tool,
  type ToolContext,
  type ToolListing,
  type ToolMeta,
  ToolRegistry,
  toolParameters,
  toolSession,
} from "../src/index.js";

const CONTEXT = { platform: "cli", scope: null, channel: "c", kind: "dm" } as const;

function ctx(signal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    turn: "01JC0000000000000000000000",
    context: CONTEXT,
    account: { platform: "cli", id: "u" },
    principal: {
      kind: "user",
      requester: { platform: "cli", id: "u" },
      context: null,
      override: false,
      actor: null,
    },
    message: { context: CONTEXT, id: "m" },
    priority: "direct",
    signal,
  };
}

const SESSION = toolSession(CONTEXT);

function plain(name: string, description: string, meta: Partial<ToolMeta> = {}): Tool {
  return defineTool({
    name,
    description,
    parameters: z.object({}),
    effect: "act",
    speed: "instant",
    risk: "low",
    group: "other",
    ...meta,
    call: async () => name,
  });
}

describe("the registry", () => {
  it("holds every tool once, with what it does", () => {
    const reg = new ToolRegistry();
    reg.register(plain("give_coins", "送魚幣給一個人。", { effect: "spend", group: "economy" }));
    reg.register(plain("recall", "搜尋回憶。", { effect: "read", group: "memory", core: true }));
    expect(reg.entries().map((e) => e.name)).toEqual([FIND_TOOLS, "give_coins", "recall"]);
    expect(reg.entry("give_coins")).toMatchObject({
      name: "give_coins",
      description: "送魚幣給一個人。",
      effect: "spend",
      speed: "instant",
      risk: "low",
      group: "economy",
      core: false,
      next: false,
      declared: true,
    });

    // A second registration under the same name replaces the first.
    reg.register(plain("give_coins", "新的說明。", { effect: "spend", group: "economy" }));
    expect(reg.entries().filter((e) => e.name === "give_coins")).toHaveLength(1);
    expect(reg.entry("give_coins")?.description).toBe("新的說明。");

    for (const entry of reg.entries()) {
      expect(TOOL_EFFECTS, entry.name).toContain(entry.effect);
      expect(TOOL_SPEEDS, entry.name).toContain(entry.speed);
      expect(TOOL_RISKS, entry.name).toContain(entry.risk);
      expect(entry.group, entry.name).not.toBe("");
    }
  });

  it("takes a tool that says nothing about itself for an outside one of medium risk", () => {
    const reg = new ToolRegistry();
    reg.register({
      spec: { name: "ext_tool", description: "x", parameters: { type: "object" } },
      call: async () => "",
    });
    expect(reg.entry("ext_tool")).toMatchObject({ ...DEFAULT_TOOL_META, declared: false });
    expect(reg.entry("ext_tool")).toMatchObject({ effect: "external", risk: "medium" });
    expect(reg.entry("ext_tool")?.schema).toBeNull();
  });

  it("keeps a tool for the new runner away from the current turn", () => {
    const reg = new ToolRegistry();
    expect(reg.isEmpty).toBe(true);
    expect(reg.names()).toEqual([]);
    expect(reg.specs()).toEqual([]);
    expect(reg.get(FIND_TOOLS)).toBeUndefined();
    expect(reg.entry(FIND_TOOLS)).toMatchObject({ core: true, next: true, effect: "read" });

    reg.register(plain("later", "之後才有。", { next: true }));
    reg.register(plain("now", "現在就有。"));
    expect(reg.names()).toEqual(["now"]);
    expect(reg.get("later")).toBeUndefined();
    expect(reg.entries().map((e) => e.name)).toEqual([FIND_TOOLS, "later", "now"]);
    // Replaced by one the current turn may see.
    reg.register(plain("later", "現在也有。"));
    expect(reg.names()).toEqual(["later", "now"]);
  });

  it("writes the JSON Schema of zod arguments the way the hand-written ones are", () => {
    const schema = z.object({
      query: z.string().describe("要找什麼"),
      limit: z.int().min(1).max(20).optional(),
      from: z.int().min(0).describe("從哪裡開始").optional(),
      count: z.int().optional(),
      mode: z.enum(["append", "replace"]).describe("預設 append").optional(),
      tags: z.array(z.string()).describe("標籤").optional(),
      weight: z.number().min(0).max(1).describe("0~1").optional(),
      here: z.boolean().optional(),
    });
    expect(JSON.stringify(toolParameters(schema))).toBe(
      JSON.stringify({
        type: "object",
        properties: {
          query: { type: "string", description: "要找什麼" },
          limit: { type: "integer", minimum: 1, maximum: 20 },
          from: { type: "integer", minimum: 0, description: "從哪裡開始" },
          count: { type: "integer" },
          mode: { type: "string", enum: ["append", "replace"], description: "預設 append" },
          tags: { type: "array", items: { type: "string" }, description: "標籤" },
          weight: { type: "number", minimum: 0, maximum: 1, description: "0~1" },
          here: { type: "boolean" },
        },
        required: ["query"],
      }),
    );
    expect(JSON.stringify(toolParameters(z.object({ a: z.string().optional() })))).toBe(
      '{"type":"object","properties":{"a":{"type":"string"}}}',
    );

    const tool = defineTool({
      name: "lookup",
      description: "查。",
      parameters: schema,
      effect: "read",
      speed: "instant",
      risk: "low",
      group: "web",
      readOnly: true,
      call: async () => "",
    });
    expect(tool.spec.parameters).toEqual(toolParameters(schema));
    expect(tool.parameters).toBe(schema);
    expect(tool.readOnly).toBe(true);
    expect(tool.meta).toEqual({ effect: "read", speed: "instant", risk: "low", group: "web" });
  });

  it("gives a call's outcome as a value", async () => {
    const reg = new ToolRegistry();
    reg.register(plain("fine", "好。"));
    reg.register({
      ...plain("breaks", "壞。"),
      call: async () => {
        throw new Error("no such page");
      },
    });
    reg.register({
      ...plain("refuses", "擋。"),
      result: async () => ({ ok: false, code: "denied", stage: "rate", text: "not allowed: slow" }),
    });
    expect(await reg.run("fine", ctx(), {})).toEqual({ ok: true, text: "fine" });
    expect(await reg.run("breaks", ctx(), {})).toEqual({
      ok: false,
      code: "failed",
      stage: null,
      text: "no such page",
    });
    expect(await reg.run("refuses", ctx(), {})).toMatchObject({ code: "denied", stage: "rate" });
    expect(await reg.run("nothing", ctx(), {})).toMatchObject({ ok: false, code: "unknown_tool" });

    const cancelled = new AbortController();
    cancelled.abort(new Error("turn cancelled"));
    await expect(reg.run("breaks", ctx(cancelled.signal), {})).rejects.toThrow("no such page");
  });
});

const CATALOG: ToolListing[] = [
  ["give_coins", "送魚幣給一個人,當作你自己的獎勵。每人每天最多 30。", "economy", "spend"],
  ["check_coins", "有人問他有多少魚幣的時候用這個,不要自己猜餘額。", "economy", "read"],
  ["place_bet", "對方明確說要押某個預測時用,押多少魚幣。", "economy", "spend"],
  ["sing_start", "唱一首已經準備好的歌(在你所在的語音頻道)。", "sing", "act"],
  ["sing_request", "準備一首歌給你唱,有人點歌的時候用。", "sing", "act"],
  ["party_start", "在語音頻道開一場派對遊戲,你當主持人。", "party", "act"],
  ["game_start", "開始玩遊戲(例如 Minecraft)。", "game", "act"],
  ["stream_start", "開直播 / 開台:在語音頻道 Go Live。", "stream", "act"],
  ["recall", "在你的長期記憶裡搜尋回憶。", "memory", "read"],
].map(([name, description, group, effect]) => ({
  name: name as string,
  description: description as string,
  group: group as string,
  effect: effect as ToolListing["effect"],
  risk: "medium",
  core: name === "recall",
}));

const names = (query: string, group: string | null = null, limit?: number) =>
  searchTools(CATALOG, query, group, limit).map((t) => t.name);

describe("searching tools", () => {
  it("splits a query into words, and Chinese into the run, its pairs and its characters", () => {
    const terms = (query: string) => searchTerms(query).map((t) => `${t.text}:${t.weight}`);
    expect(terms("give_coins web-read")).toEqual(["give_coins:2", "web-read:2"]);
    expect(terms("Give  coins!")).toEqual(["give:2", "coins:2"]);
    expect(terms("魚幣")).toEqual(["魚幣:2", "魚+幣:1"]);
    expect(terms("派對遊戲")).toEqual(["派對遊戲:2", "派對:1", "對遊:1", "遊戲:1"]);
    expect(terms("歌 sing")).toEqual(["歌:2", "sing:2"]);
    expect(terms(" ,。 ")).toEqual([]);
  });

  it("ranks a name above a group above a description, ties by name", () => {
    expect(names("coins")).toEqual(["check_coins", "give_coins"]);
    expect(names("give_coins")).toEqual(["give_coins"]);
    expect(names("give coins")).toEqual(["give_coins", "check_coins"]);
    expect(names("魚幣")).toEqual(["check_coins", "give_coins", "place_bet"]);
    expect(names("sing")).toEqual(["sing_request", "sing_start"]);
    expect(names("economy")).toEqual(["check_coins", "give_coins", "place_bet"]);
    expect(names("派對遊戲")[0]).toBe("party_start");
    // 「遊戲」 is in the party tool's description too, but far behind the game group.
    expect(names("想玩遊戲")).toEqual(["game_start"]);
    expect(names("遊戲")).toEqual(["game_start"]);
    expect(names("直播")).toEqual(["stream_start"]);
    // No description here has 「唱歌」 as one word: the group's words and the two characters do.
    expect(names("唱歌")).toEqual(["sing_request", "sing_start"]);
    // One character of a word is not a match.
    expect(names("歌手")).toEqual([]);
    expect(names("START game")[0]).toBe("game_start");
  });

  it("never returns an always-on tool, stays in the group and within the limit", () => {
    expect(names("回憶")).toEqual([]);
    expect(names("recall")).toEqual([]);
    expect(names("start", "sing")).toEqual(["sing_start"]);
    expect(names("", "Economy")).toEqual(["check_coins", "give_coins", "place_bet"]);
    expect(names("")).toEqual([]);
    expect(names("魚幣", null, 2)).toEqual(["check_coins", "give_coins"]);
    expect(names("沒有這種東西xyz")).toEqual([]);
  });

  it("shows a match by name, first sentence, effect and risk", () => {
    expect(searchTools(CATALOG, "give")).toEqual([
      {
        name: "give_coins",
        description: "送魚幣給一個人,當作你自己的獎勵。",
        effect: "spend",
        risk: "medium",
        group: "economy",
      },
    ]);
  });
});

describe("find_tools", () => {
  function registry(): ToolRegistry {
    const reg = new ToolRegistry();
    for (const t of CATALOG) {
      reg.register(
        plain(t.name, t.description, { group: t.group, effect: t.effect, core: t.core }),
      );
    }
    return reg;
  }

  it("loads what it finds at the end of the session's list", async () => {
    const reg = registry();
    const first = await reg.run(FIND_TOOLS, ctx(), { query: "唱歌" });
    expect(first).toMatchObject({ ok: true });
    expect(first.text).toContain(
      "- sing_request(act,風險 low):準備一首歌給你唱,有人點歌的時候用。",
    );
    expect(reg.loaded.loaded(SESSION)).toEqual(["sing_request", "sing_start"]);

    await reg.run(FIND_TOOLS, ctx(), { query: "魚幣" });
    await reg.run(FIND_TOOLS, ctx(), { query: "sing_start sing_request" });
    expect(reg.loaded.loaded(SESSION)).toEqual([
      "sing_request",
      "sing_start",
      "check_coins",
      "give_coins",
      "place_bet",
    ]);
    expect(reg.loaded.loaded("another")).toEqual([]);

    // The always-on tools by name, then the loaded ones in the order they came.
    expect(reg.offered(SESSION).map((e) => e.name)).toEqual([
      FIND_TOOLS,
      "recall",
      "sing_request",
      "sing_start",
      "check_coins",
      "give_coins",
      "place_bet",
    ]);
    // A loaded tool that went away keeps its place for when it is back.
    reg.unregister("sing_start");
    expect(reg.offered(SESSION).map((e) => e.name)).not.toContain("sing_start");
    expect(reg.loaded.loaded(SESSION)[1]).toBe("sing_start");
  });

  it("names the groups when nothing matches, and loads nothing", async () => {
    const reg = registry();
    const none = await reg.run(FIND_TOOLS, ctx(), { query: "qwerty" });
    expect(none.text).toBe("沒有找到符合的工具。可以找的類別:economy、game、party、sing、stream");
    expect((await reg.run(FIND_TOOLS, ctx(), {})).text).toContain("query");
    expect(reg.loaded.loaded(SESSION)).toEqual([]);
  });
});

describe("the loaded tools of a session", () => {
  it("only grows at the end and keeps each name once", () => {
    const loaded = new LoadedTools();
    expect(loaded.loaded("s")).toEqual([]);
    expect(loaded.load("s", ["b", "a"])).toEqual(["b", "a"]);
    expect(loaded.load("s", ["a", "c", "c", "b"])).toEqual(["c"]);
    expect(loaded.load("s", [])).toEqual([]);
    expect(loaded.loaded("s")).toEqual(["b", "a", "c"]);
    loaded.load("t", ["z"]);
    expect(loaded.loaded("s")).toEqual(["b", "a", "c"]);
    loaded.end("t");
    expect(loaded.loaded("t")).toEqual([]);
  });

  it("comes back from its JSON in the same order", () => {
    const loaded = new LoadedTools();
    loaded.load("discord:1:2", ["sing_start", "give_coins"]);
    loaded.load("cli:dm:c", ["recall"]);
    loaded.load("discord:1:2", ["check_coins"]);
    const json = JSON.stringify(loaded);
    expect(json).toBe(
      '{"discord:1:2":["sing_start","give_coins","check_coins"],"cli:dm:c":["recall"]}',
    );
    const back = LoadedTools.parse(JSON.parse(json));
    expect(back.loaded("discord:1:2")).toEqual(["sing_start", "give_coins", "check_coins"]);
    expect(back.toJSON()).toEqual(loaded.toJSON());
    back.load("discord:1:2", ["give_coins", "party_start"]);
    expect(back.loaded("discord:1:2").at(-1)).toBe("party_start");
    expect(() => LoadedTools.parse({ s: "sing_start" })).toThrow();
  });
});
