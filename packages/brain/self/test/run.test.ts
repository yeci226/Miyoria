import {
  BudgetExhaustedError,
  type ChatMessage,
  type ContentPart,
  contentText,
  type ImagePart,
} from "@miyoria/llm/llm";
import { FIND_TOOLS, type Tool, ToolRegistry } from "@miyoria/llm/tools";
import { toMessages } from "@miyoria/memory/transcript";
import { contextKeyString } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EXHAUSTED_LINE, FALLBACK_LINES } from "../../agent/src/index.js";
import { PROFILES, withLimits } from "../src/profiles.js";
import { serialiseMessages, serialiseTools } from "../src/prompt.js";
import {
  BLOCKED_LABEL,
  LIMIT_NOTES,
  longReceipt,
  NO_MORE_CALLS,
  REFUSALS,
  RULES,
  SAY_TOOL,
} from "../src/rules.js";
import { SAY, sayTool } from "../src/say.js";
import { SpendLedger } from "../src/spend.js";
import { ALLOW, type Guard, refuse } from "../src/types.js";
import {
  addressed,
  CTX,
  calls,
  done,
  fakeTool,
  MODEL,
  OTHER,
  OWEN,
  promptText,
  rig,
  SESSION,
  say,
  USAGE,
} from "./harness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("one run of the text profile", () => {
  it("says what she writes, line by line, with the prompt laid out for the cache", async () => {
    const r = await rig([say("<emo:happy>嗨 Owen\n今天怎麼樣?")]);
    r.line("Owen", "@她 在嗎");
    const result = await r.run();
    expect(result.outcome).toBe("said");
    expect(r.outlet.texts()).toEqual(["嗨 Owen", "今天怎麼樣?"]);
    expect(r.outlet.lines[0]).toMatchObject({
      place: CTX,
      emotion: "happy",
      focus: true,
      replyTo: { context: CTX, id: "m1" },
    });
    const request = r.model.requests[0];
    const roles = request?.messages.map((m) => m.role);
    // 1 | 3 | 4 | the transcript | 6 | 7
    expect(roles).toEqual(["system", "system", "user", "user", "user", "system"]);
    const [fixed, pinned, place, history, recalled, now] = request?.messages ?? [];
    expect(contentText(fixed?.content ?? "")).toContain("# 你是測試角色");
    expect(contentText(fixed?.content ?? "")).toContain(RULES);
    expect(contentText(pinned?.content ?? "")).toContain("主人規則");
    expect(contentText(place?.content ?? "")).toContain('<data source="people"');
    expect(contentText(history?.content ?? "")).toBe("Owen: @她 在嗎");
    expect(contentText(recalled?.content ?? "")).toContain("想起的事");
    expect(contentText(now?.content ?? "")).toMatch(/^<now>\n時間:.*\n<\/now>\n<turn>Owen 在叫你/);
    expect(request?.tools?.map((t) => t.name)).toEqual([FIND_TOOLS]);
    expect(request).toMatchObject({ reasoning_purpose: "chat_text", session: "s1" });
    expect(request?.reasoning).toBeUndefined();
    expect(r.model.purposes).toEqual(["chat"]);
    // Each line of hers is an entry with the id it went out under; they read as one message.
    const tail = r.transcript.tail(SESSION.id);
    expect(tail.entries.slice(-2).map((e) => [e.kind, e.content, e.turn, e.message_id])).toEqual([
      ["self", "嗨 Owen", "t1", "out-1"],
      ["self", "今天怎麼樣?", "t1", "out-2"],
    ]);
    expect(toMessages(tail).at(-1)).toMatchObject({
      role: "assistant",
      content: "嗨 Owen\n今天怎麼樣?",
    });
    expect(r.events.map((e) => e.type)).toEqual([
      "started",
      "speaking",
      "line",
      "line",
      "step",
      "finished",
    ]);
    expect(r.events.at(-1)).toMatchObject({
      type: "finished",
      outcome: "said",
      rounds: 1,
      lines: 2,
      limits: [],
      spend_basis: "usd",
    });
  });

  it("a prompt block that fails is left out; the run goes on", async () => {
    const r = await rig([say("嗨")], {
      prompt: {
        place: async () => {
          throw new Error("no people today");
        },
        pinned: async () => null,
      },
    });
    r.line("Owen", "@她 嗨");
    expect((await r.run()).outcome).toBe("said");
    expect(r.model.requests[0]?.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "user",
      "system",
    ]);
  });

  it("stays quiet when she writes <silence/>, and that is not a failure", async () => {
    const r = await rig([say("<silence/>")]);
    r.line("Owen", "@她 嗯");
    const result = await r.run();
    expect(result.outcome).toBe("silent");
    expect(r.outlet.lines).toEqual([]);
  });

  it("writing nothing on a glance is staying quiet", async () => {
    const r = await rig([say("")]);
    r.line("Owen", "今天好熱");
    const result = await r.run({ kind: "glance", lines: 1 });
    expect(result.outcome).toBe("silent");
    expect(r.outlet.lines).toEqual([]);
    expect(promptText(r.model.requests[0])).toContain("你看了一眼這裡最近的 1 則訊息");
  });

  it("someone waiting gets one fixed line when she writes nothing at all", async () => {
    const r = await rig([say("")]);
    r.line("Owen", "@她 在嗎");
    const result = await r.run();
    expect(result.outcome).toBe("failed");
    expect(r.outlet.texts()).toEqual([FALLBACK_LINES[0]]);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: "line", via: "fixed", text: FALLBACK_LINES[0] }),
    );
    expect(r.transcript.tail(SESSION.id).entries.at(-1)).toMatchObject({
      kind: "self",
      content: FALLBACK_LINES[0],
    });
  });

  it("a model failure: one fixed line only when someone waits", async () => {
    const waiting = await rig([new Error("provider down")]);
    waiting.line("Owen", "@她 在嗎");
    expect((await waiting.run()).outcome).toBe("failed");
    expect(waiting.outlet.texts()).toEqual([FALLBACK_LINES[0]]);

    const nobody = await rig([new Error("provider down")]);
    const result = await nobody.run({
      kind: "result",
      tool: "sing",
      job: "7",
      ok: true,
      text: "唱完了",
    });
    expect(result.outcome).toBe("failed");
    expect(nobody.outlet.lines).toEqual([]);

    const broke = await rig([new BudgetExhaustedError()]);
    broke.line("Owen", "@她 在嗎");
    await broke.run();
    expect(broke.outlet.texts()).toEqual([EXHAUSTED_LINE]);
  });

  it("a failure after she said something adds no fixed line", async () => {
    const r = await rig([calls([{ name: "lookup" }], "我查一下"), new Error("provider down")]);
    r.tools.register(fakeTool("lookup"));
    r.line("Owen", "@她 幫我查");
    const result = await r.run();
    expect(result.outcome).toBe("failed");
    expect(r.outlet.texts()).toEqual(["我查一下"]);
  });
});

describe("tools in the loop", () => {
  it("runs reads together and the rest in order, and every result goes back to her", async () => {
    const order: string[] = [];
    let flying = 0;
    let most = 0;
    const read = (name: string) =>
      fakeTool(name, `${name} 查到的`, {
        call: async () => {
          order.push(`${name}:start`);
          flying += 1;
          most = Math.max(most, flying);
          await sleep(20);
          flying -= 1;
          order.push(`${name}:end`);
          return `${name} 查到的`;
        },
      });
    const r = await rig([
      calls([{ name: "look_a" }, { name: "look_b" }, { name: "write_it" }, { name: "look_c" }]),
      say("都好了"),
    ]);
    r.tools.register(read("look_a"));
    r.tools.register(read("look_b"));
    r.tools.register(read("look_c"));
    r.tools.register(
      fakeTool("write_it", "寫好了", {
        effect: "act",
        call: () => {
          order.push("write_it");
          return "寫好了";
        },
      }),
    );
    r.line("Owen", "@她 查三個東西再寫下來");
    const result = await r.run();
    expect(result.outcome).toBe("said");
    expect(most).toBe(2);
    expect(order.indexOf("write_it")).toBeGreaterThan(order.indexOf("look_b:end"));
    expect(order.indexOf("look_c:start")).toBeGreaterThan(order.indexOf("write_it"));
    const second = r.model.requests[1]?.messages ?? [];
    const assistant = second.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls.map((c) => c.name)).toEqual([
      "look_a",
      "look_b",
      "write_it",
      "look_c",
    ]);
    expect(second.filter((m) => m.role === "tool").map((m) => contentText(m.content))).toEqual([
      "look_a 查到的",
      "look_b 查到的",
      "寫好了",
      "look_c 查到的",
    ]);
    expect(r.outlet.texts()).toEqual(["都好了"]);
    const kinds = r.transcript.tail(SESSION.id).entries.map((e) => e.kind);
    expect(kinds).toEqual([
      "other",
      "tool_calls",
      "tool_result",
      "tool_result",
      "tool_result",
      "tool_result",
      "self",
    ]);
    expect(result.calls.map((c) => [c.name, c.ok])).toEqual([
      ["look_a", true],
      ["look_b", true],
      ["write_it", true],
      ["look_c", true],
    ]);
  });

  it("a refused call comes back to her as its result, and the tool does not run", async () => {
    let ran = false;
    const guard: Guard = {
      checkCall: async ({ entry }) =>
        entry.name === "play_game" ? refuse("directive", REFUSALS.directive) : ALLOW,
      checkLine: async () => ALLOW,
    };
    const r = await rig([calls([{ name: "play_game" }]), say("主人說不行,那就不玩了")], { guard });
    r.tools.register(
      fakeTool("play_game", "開始了", {
        effect: "act",
        call: () => {
          ran = true;
          return "開始了";
        },
      }),
    );
    r.line("Owen", "@她 來玩 Minecraft");
    const result = await r.run();
    expect(ran).toBe(false);
    const tool = r.model.requests[1]?.messages.find((m) => m.role === "tool");
    expect(contentText(tool?.content ?? "")).toBe(REFUSALS.directive);
    expect(result.calls[0]).toMatchObject({ ok: false, code: "refused", text: REFUSALS.directive });
    expect(r.events).toContainEqual(
      expect.objectContaining({
        type: "refusal",
        what: "call",
        name: "play_game",
        code: "directive",
      }),
    );
    expect(r.outlet.texts()).toEqual(["主人說不行,那就不玩了"]);
  });

  it("an unknown or unoffered tool is refused with the way to find it; find_tools adds it at the end", async () => {
    const r = await rig([
      calls([{ name: "made_up" }, { name: "sing_song" }]),
      calls([{ name: FIND_TOOLS, args: { query: "唱歌" } }]),
      calls([{ name: "sing_song" }]),
      say("唱好了"),
    ]);
    r.tools.register(fakeTool("look", "看到了"));
    r.tools.register(
      fakeTool("sing_song", "唱了", {
        core: false,
        group: "sing",
        effect: "act",
        description: "唱一首歌。",
      }),
    );
    r.line("Owen", "@她 唱首歌");
    const result = await r.run();
    expect(result.calls.slice(0, 2).map((c) => c.text)).toEqual([
      REFUSALS.unknown("made_up"),
      REFUSALS.notOffered("sing_song"),
    ]);
    expect(REFUSALS.unknown("x")).toContain("find_tools");
    const lists = r.model.requests.map((q) => q.tools?.map((t) => t.name));
    expect(lists[0]).toEqual([FIND_TOOLS, "look"]);
    expect(lists[2]).toEqual([FIND_TOOLS, "look", "sing_song"]);
    expect(result.calls.at(-1)).toMatchObject({ name: "sing_song", ok: true, text: "唱了" });
    // Kept for the session, in the transcript's state.
    expect(r.transcript.state.get(SESSION.id)).toEqual({
      version: 1,
      value: { tools: ["sing_song"] },
    });
  });

  it("arguments that are not JSON are refused, not guessed", async () => {
    const r = await rig([calls([{ name: "look", args: "{oops" }]), say("嗯")]);
    r.tools.register(fakeTool("look"));
    r.line("Owen", "@她 看");
    const result = await r.run();
    expect(result.calls[0]?.text).toMatch(/^參數不是合法的 JSON/);
  });

  it("a long tool's receipt carries the job id its executor reported", async () => {
    const r = await rig([calls([{ name: "start_song" }]), say("開始唱了")]);
    r.tools.register(
      fakeTool("start_song", "開始了", {
        effect: "act",
        speed: "long",
        call: (_args, ctx) => {
          ctx.report?.({ task: 7 });
          return "開始了";
        },
      }),
    );
    r.line("Owen", "@她 唱歌");
    const result = await r.run();
    expect(result.calls[0]).toMatchObject({ job: "7", text: longReceipt("開始了", "7") });
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: "tool_call", name: "start_song", job: "7" }),
    );
  });

  it("a tool acts for whoever woke her", async () => {
    let asked: unknown = null;
    const r = await rig([calls([{ name: "look" }]), say("好")]);
    r.tools.register(
      fakeTool("look", "", {
        call: (_args, ctx) => {
          asked = { account: ctx.account, principal: ctx.principal.kind, priority: ctx.priority };
          return "ok";
        },
      }),
    );
    r.line("Owen", "@她 看");
    await r.run();
    expect(asked).toEqual({ account: OWEN.account, principal: "user", priority: "direct" });
  });

  it("sends her reasoning back with each of her steps", async () => {
    const r = await rig([calls([{ name: "look" }], "", "先查一下比較好"), say("查到了")]);
    r.tools.register(fakeTool("look"));
    r.line("Owen", "@她 查");
    await r.run();
    const assistant = r.model.requests[1]?.messages.find((m) => m.role === "assistant");
    expect(assistant?.reasoning).toBe("先查一下比較好");
    expect(
      r.transcript.tail(SESSION.id).entries.find((e) => e.kind === "tool_calls"),
    ).toMatchObject({ reasoning: "先查一下比較好" });
    // The next run reads it back from the transcript.
    r.line("Owen", "@她 再一次");
    await r.run();
    const later = r.model.requests[2]?.messages.find((m) => m.role === "assistant");
    expect(later?.reasoning).toBe("先查一下比較好");
  });

  it("a step that says lines and calls: each line with its id, then the calls and reasoning", async () => {
    const r = await rig([calls([{ name: "look" }], "我查一下\n等等", "要查"), say("好了")]);
    r.tools.register(fakeTool("look"));
    r.line("Owen", "@她 查");
    await r.run();
    const own = r.transcript
      .tail(SESSION.id)
      .entries.filter((e) => e.turn === "t1" && e.kind !== "tool_result");
    expect(own.map((e) => [e.kind, e.content, e.message_id, e.reasoning])).toEqual([
      ["self", "我查一下", "out-1", null],
      ["self", "等等", "out-2", null],
      ["tool_calls", "", null, "要查"],
      ["self", "好了", "out-3", null],
    ]);
    // The second step reads the first as her lines, then her calls with their results.
    const second = r.model.requests[1]?.messages.slice(-3);
    expect(second?.map((m) => [m.role, contentText(m.content), m.tool_calls.length])).toEqual([
      ["assistant", "我查一下\n等等", 0],
      ["assistant", "", 1],
      ["tool", "look 的結果", 0],
    ]);
  });
});

describe("limits", () => {
  const looping = (n = 6) => Array.from({ length: n }, () => calls([{ name: "look" }]));

  it("rounds: one last step without tools, told so; a call there is refused", async () => {
    const r = await rig(looping());
    r.tools.register(fakeTool("look"));
    r.line("Owen", "@她 一直查");
    const result = await r.run(addressed(), { profile: withLimits(PROFILES.text, { rounds: 2 }) });
    expect(r.model.requests).toHaveLength(3);
    const last = r.model.requests[2];
    expect(contentText(last?.messages.at(-1)?.content ?? "")).toBe(LIMIT_NOTES.rounds);
    // The tools stay in the request (the prefix cache); the call she made anyway did not run.
    expect(last?.tools?.map((t) => t.name)).toContain("look");
    expect(result.calls.map((c) => c.ok)).toEqual([true, true, false]);
    expect(result.calls[2]?.text).toBe(NO_MORE_CALLS);
    expect(result.limits).toEqual(["rounds"]);
    expect(r.events.filter((e) => e.type === "step").map((e) => e.final)).toEqual([
      false,
      false,
      true,
    ]);
    // Every call of the run is paired with its answer.
    const tail = r.transcript.tail(SESSION.id).entries;
    expect(tail.filter((e) => e.kind === "tool_result")).toHaveLength(3);
  });

  it("calls per round: the ones past the cap are refused", async () => {
    const r = await rig([calls([{ name: "look" }, { name: "look" }, { name: "look" }]), say("好")]);
    r.tools.register(fakeTool("look"));
    r.line("Owen", "@她 查");
    const result = await r.run(addressed(), {
      profile: withLimits(PROFILES.text, { callsPerRound: 2 }),
    });
    expect(result.calls.map((c) => c.ok)).toEqual([true, true, false]);
    expect(result.calls[2]?.text).toBe(REFUSALS.tooMany(2));
  });

  it("wall time", async () => {
    const r = await rig(looping());
    r.tools.register(
      fakeTool("look", "", {
        call: () => {
          r.clock.tick(70_000);
          return "ok";
        },
      }),
    );
    r.line("Owen", "@她 查");
    const result = await r.run();
    expect(result.limits).toEqual(["time"]);
    expect(r.model.requests).toHaveLength(3);
    expect(contentText(r.model.requests[2]?.messages.at(-1)?.content ?? "")).toBe(LIMIT_NOTES.time);
  });

  it("tokens of a run", async () => {
    const r = await rig(looping());
    r.tools.register(fakeTool("look"));
    r.line("Owen", "@她 查");
    const result = await r.run(addressed(), {
      profile: withLimits(PROFILES.text, { tokens: 2000 }),
    });
    // 1,100 a step: the second step reaches 2,200.
    expect(result.limits).toEqual(["tokens"]);
    expect(r.model.requests).toHaveLength(3);
    expect(result.usage).toMatchObject({ calls: 3, prompt_tokens: 3000, completion_tokens: 300 });
  });

  it("a tool that takes too long is answered as timed out", async () => {
    const r = await rig([calls([{ name: "slow" }]), say("算了")]);
    r.tools.register(fakeTool("slow", "", { call: () => sleep(200).then(() => "late") }));
    r.line("Owen", "@她 查");
    const result = await r.run(addressed(), { profile: withLimits(PROFILES.text, { toolMs: 10 }) });
    expect(result.calls[0]).toMatchObject({ ok: false, text: REFUSALS.timedOut });
  });

  it("spend per session per hour: over it, no model call at all", async () => {
    const spend = new SpendLedger();
    spend.add(SESSION.id, Date.UTC(2026, 10, 16, 3, 30), 1.5, USAGE);
    const r = await rig([say("嗨")], { runner: { compaction: null, spend } });
    r.line("Owen", "@她 在嗎");
    const result = await r.run();
    expect(result.outcome).toBe("over_budget");
    expect(r.model.requests).toEqual([]);
    expect(result.limits).toEqual(["spend"]);
  });

  it("spend reached within a run ends it like the other limits", async () => {
    const r = await rig(looping());
    r.tools.register(fakeTool("look"));
    r.model.prices_[MODEL] = {
      input_per_mtok: 600,
      cached_input_per_mtok: 600,
      output_per_mtok: 0,
    };
    r.line("Owen", "@她 查");
    const result = await r.run();
    // 1,000 prompt tokens at 600 USD a million: 0.6 a step.
    expect(result.limits).toEqual(["spend"]);
    expect(r.model.requests).toHaveLength(3);
    expect(result.cost_usd).toBeCloseTo(1.8);
  });

  it("a model without a price is held to the token cap", async () => {
    const r = await rig([say("嗨")]);
    delete r.model.prices_[MODEL];
    r.line("Owen", "@她 在嗎");
    await r.run();
    expect(r.events.at(-1)).toMatchObject({ type: "finished", spend_basis: "tokens", cost_usd: 0 });
    expect(r.runner.spend.hour(SESSION.id, r.clock.now())).toMatchObject({
      basis: "tokens",
      tokens: 1100,
    });
  });
});

describe("the kept screens", () => {
  it("#9: a response that turns out to be reasoning goes nowhere, the held line with it", async () => {
    const r = await rig([say("嗯好\n回覆要短一點。\n可以說:「好啊」")]);
    r.line("Owen", "@她 好不好");
    const result = await r.run();
    // Nothing of hers went out; someone waits, so the fixed line does.
    expect(r.outlet.texts()).toEqual([FALLBACK_LINES[0]]);
    expect(result.outcome).toBe("failed");
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: "screened", kind: "leak_dropped" }),
    );
  });

  it("#19: a note to herself is cut, the rest of the reply goes", async () => {
    const r = await rig([say("Owen在問我上面訊息寫什麼,直接念給他聽就好。\n上面寫明天停課啦")]);
    r.line("Owen", "@她 上面寫什麼");
    await r.run();
    expect(r.outlet.texts()).toEqual(["上面寫明天停課啦"]);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: "screened", kind: "self_talk_cut", count: 1 }),
    );
  });

  it("#11 and #18: a thinking block, tags and a tool written as text are not shown", async () => {
    const r = await rig([
      say("<emo:thinking>他在問天氣,我要回短一點</emo:thinking><p>今天會下雨</p><sing_start>"),
    ]);
    r.line("Owen", "@她 天氣");
    await r.run();
    expect(r.outlet.texts()).toEqual(["今天會下雨"]);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: "screened", kind: "tag_stripped", count: 1 }),
    );
  });

  it("a line the guard refuses is a note she reads in one more step", async () => {
    const guard: Guard = {
      checkCall: async () => ALLOW,
      checkLine: async (_place, line) =>
        line.includes("秘密") ? refuse("moderation", "內容沒有通過輸出審查") : ALLOW,
    };
    const r = await rig([say("好\n告訴你一個秘密"), say("<silence/>")], { guard });
    r.line("Owen", "@她 說嘛");
    const result = await r.run();
    expect(r.outlet.texts()).toEqual(["好"]);
    expect(r.model.requests).toHaveLength(2);
    const note = promptText(r.model.requests[1]);
    expect(note).toContain(`<data source="${BLOCKED_LABEL}">`);
    expect(note).toContain("有 1 行沒有送出去:內容沒有通過輸出審查");
    expect(result.outcome).toBe("said");
    expect(r.transcript.tail(SESSION.id).entries.at(-1)).toMatchObject({ kind: "note" });
  });

  it("a refused line with a fixed one to say instead has that one said, and she is told", async () => {
    const guard: Guard = {
      checkCall: async () => ALLOW,
      checkLine: async (_place, line) =>
        line.includes("按鈕") ? refuse("game_secret", "說出了湯底的字", "很接近了!") : ALLOW,
    };
    const r = await rig([say("很接近了喔\n想想電梯按鈕\n再想想按鈕"), say("<silence/>")], {
      guard,
    });
    r.line("Owen", "@她 是不是身體的關係?");
    await r.run();
    // Each refused line has the fixed one said in its place (the game decides how often it gives
    // one); what she wrote is never sent, and the transcript has what was said.
    expect(r.outlet.texts()).toEqual(["很接近了喔", "很接近了!", "很接近了!"]);
    expect(promptText(r.model.requests[1])).toContain("有 2 行沒有送出去:說出了湯底的字");
    const said = r.transcript
      .tail(SESSION.id)
      .entries.map((e) => e.content)
      .join("\n");
    expect(said).not.toContain("按鈕");
  });
});

describe("a cancelled run", () => {
  it("keeps every call paired with an answer", async () => {
    const controller = new AbortController();
    const r = await rig([calls([{ name: "look" }, { name: "hang" }, { name: "after" }]), say("x")]);
    r.tools.register(fakeTool("look", "看到了"));
    r.tools.register(
      fakeTool("hang", "", {
        effect: "act",
        call: (_args, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
            setTimeout(() => controller.abort(), 0);
          }),
      }),
    );
    r.tools.register(fakeTool("after", "", { effect: "act" }));
    r.line("Owen", "@她 查");
    const result = await r.run(addressed(), { signal: controller.signal });
    expect(result.outcome).toBe("cancelled");
    expect(r.model.requests).toHaveLength(1);
    // `tail` leaves out a call without its result: all three are there, each answered.
    const entries = r.transcript.tail(SESSION.id).entries;
    expect(entries.find((e) => e.kind === "tool_calls")?.tool_calls).toHaveLength(3);
    expect(entries.filter((e) => e.kind === "tool_result").map((e) => e.content)).toEqual([
      "看到了",
      REFUSALS.cancelled,
      REFUSALS.cancelled,
    ]);
    expect(r.outlet.lines).toEqual([]);
  });

  it("mid-stream: what reached people stays hers, no fixed line", async () => {
    const controller = new AbortController();
    const r = await rig([say("第一句\n第二句\n第三句")]);
    r.model.onEvent = (ev) => {
      if (ev.type === "text_delta" && ev.text.includes("三")) controller.abort();
    };
    r.line("Owen", "@她 說");
    const result = await r.run(addressed(), { signal: controller.signal });
    expect(result.outcome).toBe("cancelled");
    expect(r.outlet.texts()).toEqual(["第一句", "第二句"]);
    expect(
      r.transcript
        .tail(SESSION.id)
        .entries.slice(-2)
        .map((e) => [e.kind, e.content]),
    ).toEqual([
      ["self", "第一句"],
      ["self", "第二句"],
    ]);
  });
});

describe("the prompt across runs", () => {
  it("the next run's request starts with this one's up to the end of its transcript", async () => {
    const r = await rig([
      calls([{ name: FIND_TOOLS, args: { query: "唱歌" } }]),
      say("有喔"),
      say("好啊"),
    ]);
    r.tools.register(fakeTool("look"));
    r.tools.register(fakeTool("sing_song", "唱了", { core: false, group: "sing", effect: "act" }));
    r.line("Owen", "@她 你會唱歌嗎");
    await r.run();
    r.line("Owen", "@她 那唱一首");
    await r.run();
    const first = r.model.requests[0];
    const next = r.model.requests[2];
    // The first request: blocks 1, 3, 4, the transcript, then 6 and 7 of that run.
    const prefix = serialiseMessages(first?.messages.slice(0, -2) ?? []);
    expect(serialiseMessages(next?.messages ?? []).slice(0, prefix.length)).toEqual(prefix);
    // The tool list only grew at its end.
    const before = serialiseTools(first?.tools ?? []);
    const after = serialiseTools(next?.tools ?? []);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(next?.tools?.map((t) => t.name)).toEqual([FIND_TOOLS, "look", "sing_song"]);
    // Blocks 6 and 7 of the first run are not in the second.
    expect(promptText(next)).not.toContain("第 t1 回合想起的事");
  });

  it("after a restart the session's loaded tools come back at the end of the list", async () => {
    const r = await rig([calls([{ name: FIND_TOOLS, args: { query: "唱歌" } }]), say("嗯")]);
    const sing = fakeTool("sing_song", "唱了", { core: false, group: "sing", effect: "act" });
    r.tools.register(sing);
    r.line("Owen", "@她 唱歌");
    await r.run();
    const fresh = new ToolRegistry();
    fresh.register(sing);
    const again = await rig([say("嗯")], { store: r.store, tools: fresh });
    await again.run();
    expect(again.model.requests[0]?.tools?.map((t) => t.name)).toEqual([FIND_TOOLS, "sing_song"]);
    expect(fresh.loaded.loaded(contextKeyString(CTX))).toEqual(["sing_song"]);
  });

  it("compacts the transcript after a run once it is over the threshold", async () => {
    const r = await rig([say("好")], {
      runner: { compaction: { thresholdTokens: 60, keepTokens: 10 } },
    });
    for (let i = 0; i < 12; i++) r.line("Owen", `第 ${i} 句,隨便聊聊今天發生的事情`);
    const result = await r.run();
    expect(result.compacted).toBe(true);
    expect(r.model.summarised).toHaveLength(1);
    expect(r.model.summarised[0]?.reasoning_purpose).toBe("summarizer");
    expect(promptText(r.model.summarised[0])).toContain("Owen: 第 0 句");
    expect(r.transcript.tail(SESSION.id).summary?.summary).toBe("之前聊了很多。");
    expect(r.events.at(-1)).toMatchObject({ type: "finished", compacted: true });
  });

  it("lets her memory read the lines up to the cut before they are summarised", async () => {
    const order: string[] = [];
    const r = await rig([say("好")], {
      runner: { compaction: { thresholdTokens: 60, keepTokens: 10 } },
      beforeCompaction: async (session, upto) => {
        order.push(`memory ${session} ${upto}`);
        expect(r.model.summarised).toHaveLength(0);
      },
    });
    for (let i = 0; i < 12; i++) r.line("Owen", `第 ${i} 句,隨便聊聊今天發生的事情`);
    expect((await r.run()).compacted).toBe(true);
    const upto = r.transcript.tail(SESSION.id).summary?.upto_seq;
    expect(order).toEqual([`memory ${SESSION.id} ${upto}`]);
    expect(r.model.summarised).toHaveLength(1);
  });

  it("compacts all the same when her memory's read fails", async () => {
    const r = await rig([say("好")], {
      runner: { compaction: { thresholdTokens: 60, keepTokens: 10 } },
      beforeCompaction: async () => {
        throw new Error("memory down");
      },
    });
    for (let i = 0; i < 12; i++) r.line("Owen", `第 ${i} 句,隨便聊聊今天發生的事情`);
    expect((await r.run()).compacted).toBe(true);
  });

  it("does not compact below the threshold", async () => {
    const r = await rig([say("好")], {
      runner: { compaction: { thresholdTokens: 100_000, keepTokens: 10 } },
    });
    r.line("Owen", "@她 嗨");
    expect((await r.run()).compacted).toBe(false);
    expect(r.model.summarised).toEqual([]);
  });
});

describe("say", () => {
  const places = new Map([
    ["閒聊", OTHER],
    ["這裡", CTX],
  ]);

  async function withSay(script: Parameters<typeof rig>[0], guard?: Guard) {
    const r = await rig(script, guard ? { guard } : {});
    r.tools.register(
      sayTool({ resolve: (name) => places.get(name) ?? null, sayIn: r.runner.sayIn }),
    );
    return r;
  }

  it("speaks in another place through the same line check and outlet", async () => {
    const r = await withSay([
      calls([{ name: SAY, args: { place: "閒聊", text: "<emo:happy>大家晚安" } }]),
      say(""),
    ]);
    r.line("Owen", "@她 去閒聊說晚安");
    const result = await r.run();
    expect(r.outlet.lines).toEqual([
      expect.objectContaining({ place: OTHER, text: "大家晚安", emotion: "happy", focus: false }),
    ]);
    expect(result.calls[0]).toMatchObject({ ok: true, text: SAY_TOOL.sent("閒聊") });
    // She spoke: an empty last step owes nobody a fixed line.
    expect(result.outcome).toBe("said");
    expect(r.events).toContainEqual(expect.objectContaining({ type: "line", via: "say" }));
  });

  it("a refused line is the tool's answer", async () => {
    const guard: Guard = {
      checkCall: async () => ALLOW,
      checkLine: async (place) =>
        place.channel === "c2" ? refuse("floor", "你在那裡講太多了") : ALLOW,
    };
    const r = await withSay(
      [calls([{ name: SAY, args: { place: "閒聊", text: "嗨" } }]), say("那邊不能講")],
      guard,
    );
    r.line("Owen", "@她 去閒聊說嗨");
    const result = await r.run();
    expect(result.calls[0]).toMatchObject({
      ok: false,
      text: SAY_TOOL.blocked("你在那裡講太多了"),
    });
    expect(r.outlet.texts()).toEqual(["那邊不能講"]);
  });

  it("here is where she just writes; a profile that does not speak cannot say", async () => {
    const r = await withSay([
      calls([{ name: SAY, args: { place: "這裡", text: "嗨" } }]),
      say("嗨"),
    ]);
    r.line("Owen", "@她 說嗨");
    const result = await r.run();
    expect(result.calls[0]?.text).toBe(SAY_TOOL.here);

    const quiet = await withSay([
      calls([{ name: SAY, args: { place: "閒聊", text: "嗨" } }]),
      say("做完了"),
    ]);
    const done_ = await quiet.run({ kind: "self", note: null }, { profile: PROFILES.subagent });
    expect(quiet.model.requests[0]?.tools?.map((t) => t.name)).not.toContain(SAY);
    expect(done_.calls[0]?.text).toBe(REFUSALS.noSay);
    expect(quiet.outlet.lines).toEqual([]);
    expect(done_).toMatchObject({ outcome: "said", text: "做完了" });
  });
});

describe("the stream", () => {
  it("a call that arrives with no id gets one, and a step without usage still counts", async () => {
    const r = await rig([
      [
        { type: "tool_call_delta", index: 0, id: null, name: "look", arguments: "{}" },
        done(null, "tool_calls"),
      ],
      say("好"),
    ]);
    r.tools.register(fakeTool("look"));
    r.line("Owen", "@她 看");
    const result = await r.run();
    expect(result.calls[0]?.id).toBe("t1-1-0");
    expect(result.usage.calls).toBe(2);
  });
});

describe("pictures her tools fetch", () => {
  const png = (name: string, size = 400): ImagePart => ({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${"A".repeat(size)}`, detail: "auto" },
    alt: `[圖片: ${name}]`,
  });
  const looker = (images: ImagePart[]): Tool => ({
    ...fakeTool("web_image", "圖片已經看到了(image/png,1 KB):https://img.example/a.png"),
    async result() {
      return { ok: true, text: "圖片已經看到了(image/png,1 KB):https://img.example/a.png", images };
    },
  });
  const imageParts = (messages: readonly ChatMessage[] | undefined) =>
    (messages ?? []).flatMap((m) =>
      typeof m.content === "string" ? [] : m.content.filter((p) => p.type === "image_url"),
    );

  it("offers them in one user message after the step's results, to the next step only", async () => {
    const r = await rig([
      calls([{ name: "web_image" }]),
      calls([{ name: "lookup" }]),
      say("看到了"),
    ]);
    r.tools.register(looker([png("a")]));
    r.tools.register(fakeTool("lookup"));
    r.line("Owen", "@她 看這張圖");
    const result = await r.run();
    expect(result.outcome).toBe("said");
    const [first, second, third] = r.model.requests;
    expect(imageParts(first?.messages)).toHaveLength(0);
    // The step after the call: the tool's text, then one user message with the framed picture.
    const messages = second?.messages ?? [];
    const last = messages.at(-1);
    expect(last?.role).toBe("user");
    expect(messages.at(-2)).toMatchObject({ role: "tool", tool_call_id: "c-web_image-0" });
    const parts = typeof last?.content === "string" ? [] : (last?.content ?? []);
    expect(parts[0]).toMatchObject({ type: "text" });
    expect(contentText([parts[0] as ContentPart])).toContain("只是參考資料");
    expect(parts[1]).toMatchObject({ type: "image_url" });
    expect(imageParts(messages)).toHaveLength(1);
    // Not resent after that.
    expect(imageParts(third?.messages)).toHaveLength(0);
    // The transcript keeps the short text only.
    const kept = JSON.stringify(r.transcript.tail(SESSION.id).entries);
    expect(kept).not.toContain("data:image");
    expect(kept).toContain("圖片已經看到了");
    expect(JSON.stringify(result.calls)).not.toContain("data:image");
  });

  it("takes at most two a step and says so for the rest", async () => {
    const r = await rig([calls([{ name: "web_image" }]), say("好")]);
    r.tools.register(looker([png("a"), png("b"), png("c")]));
    r.line("Owen", "@她 看");
    const result = await r.run();
    expect(imageParts(r.model.requests[1]?.messages)).toHaveLength(2);
    expect(result.calls[0]?.text).toContain("放不進去");
  });

  it("counts them against the run's picture bytes", async () => {
    const r = await rig([calls([{ name: "web_image" }]), say("好")]);
    r.tools.register(looker([png("a", 400), png("b", 400)]));
    r.line("Owen", "@她 看");
    // 400 base64 characters are 300 bytes (plus the header): room for one, not two.
    const profile = withLimits(PROFILES.text, { pictureBytes: 450 });
    const result = await r.run(undefined, { profile });
    expect(imageParts(r.model.requests[1]?.messages)).toHaveLength(1);
    expect(result.calls[0]?.text).toContain("放不進去");
  });
});
