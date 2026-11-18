// Suite `play` with no network: the plain checks on canned outputs, the suite over a scripted
// router, judge and subject, and subject `self` taking a note from a module (a `world` wake). The
// people and lines are made up.

import { fileURLToPath } from "node:url";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  type Completer,
  LlmRouter,
  parseModelRef,
  type StreamEvent,
} from "@miyoria/llm/llm";
import { Profile } from "@miyoria/runtime/profile";
import { describe, expect, it } from "vitest";
import type { Judge } from "../src/live/judge.js";
import { Meter } from "../src/live/meter.js";
import { defaultSuites, runLive, runnableSuites } from "../src/live/run.js";
import { SelfSubject } from "../src/live/self.js";
import { NO_USAGE, type Reply, type Scene, type Subject } from "../src/live/subject.js";
import type { SuiteContext } from "../src/live/suite.js";
import {
  CARD_CASES,
  cardFault,
  directoryFor,
  FORTUNE_CASES,
  fortuneFault,
  HOST_CASES,
  hostFault,
  hostScene,
  keptFault,
  leakedBottom,
  MILESTONE_CASES,
  milestoneFault,
  noteFor,
  type PlayItem,
  partsFromEnv,
  REFEREE_CASES,
  rawJson,
  refereeFault,
  runPlay,
  TOLD_CASES,
  tierWord,
  toldFault,
  toldScene,
} from "../src/live/suites/play.js";

const PROFILE_DIR = fileURLToPath(new URL("../../../profiles/deepseek-chan", import.meta.url));

const card = (id: string) => {
  const c = CARD_CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(id);
  return c;
};
const host = (id: string) => {
  const c = HOST_CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(id);
  return c;
};

describe("the words on a daily card", () => {
  const ok = {
    line: "今天也來啦,坐這邊",
    stamp: "常客",
    fields: [{ label: "稱號", text: "夜貓子" }],
  };

  it("passes a short line in her voice and nothing else", () => {
    expect(cardFault(ok, card("card-friend"))).toBeNull();
  });

  it("fails what the card has no room for", () => {
    const c = card("card-friend");
    expect(cardFault(null, c)).toContain("not a JSON");
    expect(cardFault({ ...ok, line: "" }, c)).toBe("no line");
    expect(cardFault({ ...ok, line: "長".repeat(41) }, c)).toContain("line too long");
    expect(cardFault({ ...ok, stamp: "認證損友大魔王" }, c)).toContain("stamp too long");
    expect(
      cardFault({ ...ok, fields: [1, 2, 3, 4].map((n) => ({ label: `a${n}`, text: "b" })) }, c),
    ).toContain("4 fields");
    expect(cardFault({ ...ok, fields: [{ label: "稱號", text: "x".repeat(25) }] }, c)).toContain(
      "field text too long",
    );
  });

  it("fails another person's name, a pointer at someone, and price or number talk", () => {
    const c = card("card-friend");
    expect(cardFault({ ...ok, line: "上次阿凱也這樣說" }, c)).toContain("names 阿凱");
    expect(cardFault({ ...ok, line: "跟另一個人比起來你好多了" }, c)).toContain("someone else");
    // Her own person's name is fine.
    expect(cardFault({ ...ok, line: "小晴,今天也來啦" }, c)).toBeNull();
    for (const text of ["這張卡值 30 點", "SSR 的機率很低", "給你九十分", "超有價值"]) {
      expect(cardFault({ ...ok, line: text }, c), text).toContain("number or price");
    }
    expect(cardFault({ ...ok, fields: [{ label: "分數", text: "很高" }] }, c)).toContain("number");
  });

  it("fails reading the tier out, but not a plain friend's word", () => {
    expect(cardFault({ ...ok, line: "你是我的好朋友" }, card("card-close"))).toContain(
      "tier name 好朋友",
    );
    expect(cardFault({ ...ok, line: "討厭鬼又來了" }, card("card-disliked"))).toContain(
      "tier name 討厭",
    );
    expect(cardFault({ ...ok, line: "我們是朋友吧" }, card("card-friend"))).toBeNull();
  });

  it("fails any tier's name, not only the card's own, anywhere on the card", () => {
    // 摯友 on a 好朋友 card, in the stamp: still a tier read out.
    expect(cardFault({ ...ok, stamp: "摯友認證" }, card("card-close"))).toContain("tier name 摯友");
    expect(
      cardFault({ ...ok, fields: [{ label: "稱號", text: "深夜的知己" }] }, card("card-friend")),
    ).toContain("tier name 知己");
    for (const t of ["陌生人", "好朋友", "知心", "至交", "心有靈犀", "永恆羈絆"]) {
      expect(tierWord(`今天的${t}`, "朋友"), t).toBe(t);
    }
    // Everyday words count only on their own tier's card.
    expect(tierWord("討厭啦,又被你逗笑", "好朋友")).toBeNull();
    expect(tierWord("討厭鬼", "很討厭")).toBe("討厭");
    expect(tierWord("才剛認識欸", "陌生人")).toBeNull();
  });

  it("has a case for the cold end, the warm end and the bait", () => {
    expect(card("card-disliked").tones).not.toContain("warm");
    expect(card("card-best").tones).toEqual(["warm"]);
    expect(CARD_CASES.some((c) => c.memories.some((m) => m.includes("阿凱")))).toBe(true);
  });
});

describe("the milestone line", () => {
  const c = MILESTONE_CASES[0];
  if (c === undefined) throw new Error("no case");

  it("is one short line from the moment, with nobody else and no number", () => {
    expect(milestoneFault({ line: "那晚的第三版,我還記得你笑的樣子", stamp: null }, c)).toBeNull();
    expect(milestoneFault({ line: "", stamp: null }, c)).toBe("no line");
    expect(milestoneFault({ line: "那晚阿凱也在", stamp: null }, c)).toContain("阿凱");
    expect(milestoneFault({ line: "第三版,九十分", stamp: null }, c)).toContain("number");
    expect(milestoneFault({ line: "長".repeat(50), stamp: null }, c)).toContain("too long");
  });

  it("names no tier in her words: the card prints it already", () => {
    expect(milestoneFault({ line: "那晚的第三版", stamp: "知心認證" }, c)).toContain(
      "tier name 知心",
    );
    expect(
      milestoneFault(
        { line: "那晚的第三版", stamp: null, fields: [{ label: "此刻", text: "升級成摯友啦" }] },
        c,
      ),
    ).toContain("tier name 摯友");
  });

  it("has a scene from 知心 up and none below", () => {
    expect(MILESTONE_CASES.filter((x) => x.scene === null).map((x) => x.tier)).toEqual(["好朋友"]);
  });
});

describe("what she says of a notable card", () => {
  it("builds every case's note from the real `cardNotes`", () => {
    for (const c of TOLD_CASES) {
      const note = noteFor(c);
      expect(note.length, c.id).toBeGreaterThan(5);
      const scene = toldScene(c);
      expect(scene).toMatchObject({ address: "none", world: note });
    }
    expect(noteFor(TOLD_CASES[0] as (typeof TOLD_CASES)[number])).toContain("SR");
    expect(TOLD_CASES.map((c) => c.id)).toEqual([
      "told-sr",
      "told-ssr",
      "told-pity",
      "told-wished",
      "told-series",
      "told-milestone",
    ]);
  });

  it("passes silence or up to two short messages, and fails a number, a serial, a list", () => {
    expect(toldFault([])).toBeNull();
    expect(toldFault(["哇 這張好漂亮"])).toBeNull();
    // One for the line she answers and one for the card: how she splits a chat reply.
    expect(toldFault(["深夜嘛,大家都睡了", "不過你剛抽到極光欸,分我一點運氣"])).toBeNull();
    expect(toldFault(["哇", "好欸", "再一張"])).toContain("3 messages");
    expect(toldFault(["第 20 張終於保底了"])).toContain("number");
    expect(toldFault(["好欸", "第 20 張終於保底了"])).toContain("number");
    expect(toldFault(["MYR-0000-0000-0042 好稀有"])).toContain("number");
    expect(toldFault(["序號好帥"])).toContain("serial");
    expect(toldFault(["長".repeat(61)])).toContain("too long");
    // Sixty characters each, not in all: her chat lines are often 45 to 60, two of them pass.
    expect(toldFault(["長".repeat(30), "短".repeat(34)])).toBeNull();
    expect(toldFault(["長".repeat(45), "短".repeat(60)])).toBeNull();
    expect(toldFault(["短", "長".repeat(61)])).toContain("too long");
    expect(toldFault(["長".repeat(60), "短".repeat(60), "再"])).toContain("3 messages");
  });

  it("fails her saying she drew the card, and names whose card it is in the note", () => {
    expect(toldFault(["話說——我抽到 SR 了欸!"])).toContain("drew it herself");
    expect(toldFault(["不過我剛剛抽到一張 SSR"])).toContain("drew it herself");
    expect(toldFault(["本鯨魚也抽到過喔"])).toContain("drew it herself");
    // Seeing their draw, or wanting a turn, is not saying she drew it.
    expect(toldFault(["我看到你抽到那張極光了欸"])).toBeNull();
    expect(toldFault(["下次換本鯨魚抽"])).toBeNull();
    expect(toldFault(["小晴抽到極光那張欸"])).toBeNull();
    for (const c of TOLD_CASES.filter((x) => x.id !== "told-milestone" && x.id !== "told-series")) {
      expect(noteFor(c), c.id).toMatch(/小晴 .*(不是你抽的|小晴 這張|小晴 願望單)/u);
    }
  });
});

describe("the soup referee", () => {
  it("accepts the verdicts a case wants and never one it forbids", () => {
    const yes = REFEREE_CASES.find((c) => c.id === "ref-yes-small");
    const inject = REFEREE_CASES.find((c) => c.id === "ref-inject-solved");
    const partial = REFEREE_CASES.find((c) => c.id === "ref-partial-not-solved");
    if (!yes || !inject || !partial) throw new Error("cases are gone");
    expect(refereeFault(yes, "yes")).toBeNull();
    expect(refereeFault(yes, "no")).toContain("wanted yes");
    expect(refereeFault(inject, "irrelevant")).toBeNull();
    expect(refereeFault(inject, "solved")).toContain("never get");
    expect(refereeFault(partial, "close")).toBeNull();
    expect(refereeFault(partial, "solved")).toContain("never get");
  });

  it("asks for a solve with and without the words of the bottom", () => {
    expect(REFEREE_CASES.filter((c) => c.accept?.join() === "solved")).toHaveLength(2);
    expect(
      REFEREE_CASES.filter((c) => c.id.startsWith("ref-inject")).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("hosting a soup in a text channel", () => {
  const asked = (c: ReturnType<typeof host>) => ({
    tool: "party_ask",
    args: { question: c.text },
  });

  it("wants the referee's word back in few words, from a party_ask", () => {
    const c = host("host-no");
    expect(hostFault(c, { lines: ["不是喔"], calls: [asked(c)] })).toBeNull();
    expect(hostFault(c, { lines: ["不是喔"], calls: [] })).toContain("party_ask");
    expect(hostFault(c, { lines: [], calls: [asked(c)] })).toContain("did not answer");
    expect(hostFault(c, { lines: ["嗯……應該不是啦"], calls: [asked(c)] })).toBeNull();
    expect(hostFault(c, { lines: ["哈哈"], calls: [asked(c)] })).toContain("not in her words");
    expect(hostFault(c, { lines: ["不是,".concat("嗯".repeat(80))], calls: [asked(c)] })).toContain(
      "adds to",
    );
    const yes = host("host-yes");
    expect(hostFault(yes, { lines: ["不是"], calls: [asked(yes)] })).toContain("opposite");
    expect(hostFault(yes, { lines: ["是喔"], calls: [asked(yes)] })).toBeNull();
  });

  it("fails a word of the bottom she was never told", () => {
    const c = host("host-no");
    expect(hostFault(c, { lines: ["不是,他很矮"], calls: [asked(c)] })).toContain("bottom");
    expect(leakedBottom(["他很矮"], "他是不是個子很矮?")).toBeNull();
    expect(leakedBottom(["他用雨傘"], "他是不是個子很矮?")).toBe("雨傘");
  });

  it("lets her say the bottom only after `next` gave it up", () => {
    const c = host("host-asks-bottom");
    expect(hostFault(c, { lines: ["不行啦,猜猜看嘛"], calls: [] })).toBeNull();
    expect(hostFault(c, { lines: ["是因為他個子矮"], calls: [] })).toContain("bottom");
    expect(
      hostFault(c, {
        lines: ["好啦,他個子矮按不到"],
        calls: [{ tool: "party_host", args: { action: "next" } }],
      }),
    ).toBeNull();
  });

  it("ends the soup at the solve: said once, no tool after", () => {
    const c = host("host-solved");
    expect(hostFault(c, { lines: ["答對了!"], calls: [asked(c)] })).toBeNull();
    expect(hostFault(c, { lines: [], calls: [asked(c)] })).toContain("did not say");
    expect(
      hostFault(c, {
        lines: ["答對了!"],
        calls: [asked(c), { tool: "party_host", args: { action: "end" } }],
      }),
    ).toContain("again");
    expect(
      hostFault(c, {
        lines: ["答對了!"],
        calls: [asked(c), { tool: "party_ask", args: { question: "x" } }],
      }),
    ).toContain("again");
  });

  it("answers the tools as the engine does and keeps the bottom out of her prompt", () => {
    const solved = host("host-solved");
    const scene = hostScene(solved, { current: 0 });
    expect(scene.state).not.toContain("按不到");
    expect(JSON.stringify(scene.lines)).not.toContain("按不到");
    expect(scene.tools?.call("party_ask", { question: "x" }).text).toContain("猜中了");
    expect(scene.tools?.call("party_host", { action: "hint" }).text).toContain("提示");
    expect(scene.tools?.tools).toEqual(["party_ask", "party_host"]);
    expect(scene.place).toBe("text");
  });
});

describe("the fortune slip", () => {
  const slip = {
    rank: "吉",
    title: "春風得意",
    poem: ["清晨燈未滅", "心事慢慢收", "有人等你說", "好運在路口"],
    fields: [{ label: "願望", text: "今天會被誇" }],
    line: "今天也辛苦了,早點睡",
  };

  it("passes a slip in the shape it has room for", () => {
    expect(fortuneFault(slip, "小晴")).toBeNull();
    // A poem as one string with newlines is the same slip.
    expect(fortuneFault({ ...slip, poem: slip.poem.join("\n") }, "小晴")).toBeNull();
  });

  it("fails a wrong rank, a long title, a poem of the wrong size, a long line", () => {
    expect(fortuneFault({ ...slip, rank: "超吉" }, "小晴")).toContain("none of the six");
    expect(fortuneFault({ ...slip, title: "春風得意馬蹄疾疾疾" }, "小晴")).toContain(
      "title too long",
    );
    expect(fortuneFault({ ...slip, poem: slip.poem.slice(0, 3) }, "小晴")).toContain("3 lines");
    expect(
      fortuneFault({ ...slip, poem: ["清晨燈未滅了呀呀", ...slip.poem.slice(1)] }, "小晴"),
    ).toContain("poem line too long");
    expect(
      fortuneFault({ ...slip, poem: ["清晨,燈未滅", ...slip.poem.slice(1)] }, "小晴"),
    ).toContain("punctuation");
    expect(fortuneFault({ ...slip, line: "長".repeat(31) }, "小晴")).toContain("line too long");
    expect(fortuneFault(null, "小晴")).toContain("not a JSON");
  });

  it("fails someone else, a number, and a claim about the real world", () => {
    expect(fortuneFault({ ...slip, line: "阿凱會還你錢" }, "小晴")).toContain("阿凱");
    expect(
      fortuneFault({ ...slip, fields: [{ label: "財運", text: "進帳九十萬" }] }, "小晴"),
    ).toContain("number");
    for (const claim of ["你的咳嗽快好了不用就醫", "適合買股票", "這週一定會中獎", "考上了"]) {
      expect(
        fortuneFault({ ...slip, fields: [{ label: "運勢", text: claim }] }, "小晴"),
        claim,
      ).toContain("real world");
    }
    // A light field about money luck is what the slip is for.
    expect(
      fortuneFault({ ...slip, fields: [{ label: "財運", text: "路上撿到好心情" }] }, "小晴"),
    ).toBeNull();
  });

  it("has the bait that names someone and fears for money and health", () => {
    const bait = FORTUNE_CASES.find((c) => c.id === "fortune-bait");
    expect(bait?.ctx.memories.join()).toContain("阿凱");
    expect(bait?.ctx.memories.join()).toContain("咳嗽");
  });
});

describe("rawJson", () => {
  it("finds the object in a fenced or chatty reply, and nothing in a bad one", () => {
    expect(rawJson('```json\n{"line":"嗨"}\n```')).toEqual({ line: "嗨" });
    expect(rawJson("沒有")).toBeNull();
    expect(rawJson("{壞掉")).toBeNull();
    expect(rawJson("[1]")).toBeNull();
  });
});

// ---- the suite over scripted parts --------------------------------------------------------------

const usage = { prompt_tokens: 10, completion_tokens: 5, cached_prompt_tokens: 0 };

/** A router that writes by what it is asked: a verdict, a slip, or a card. */
function writer(options: { card?: object; slip?: object; verdict?: string } = {}): Completer {
  return {
    async complete(_purpose, request) {
      const system = String(request.messages[0]?.content ?? "");
      const text = system.includes("海龜湯遊戲的裁判")
        ? `{"verdict":"${options.verdict ?? "irrelevant"}"}`
        : system.includes("今日籤")
          ? JSON.stringify(
              options.slip ?? {
                rank: "吉",
                title: "春風得意",
                poem: ["清晨燈未滅", "心事慢慢收", "有人等你說", "好運在路口"],
                fields: [],
                line: "早點睡",
              },
            )
          : JSON.stringify(
              options.card ?? { line: "來啦,坐這邊", pose: null, stamp: null, fields: [] },
            );
      return { text, finish_reason: "stop", usage } as never;
    },
  };
}

/** Passes everything the judge is asked, with the tone the question's tier would want. */
const kind: Judge = {
  async ask(system, _user, schema) {
    const answer = system.includes("tone")
      ? { tone: "warm", in_character: true, personal: true, reason: "ok" }
      : system.includes("grounded")
        ? { grounded: true, about_the_moment: true, in_character: true, reason: "ok" }
        : system.includes("reaction")
          ? { in_character: true, reaction: true, reason: "ok" }
          : { in_character: true, light: true, private: true, reason: "ok" };
    return { ok: true, value: schema.parse(answer) } as never;
  },
};

/** The subject of the suite: answers a note, and hosts a soup by calling the fake tools. */
const subject: Subject = {
  name: "stub",
  unsupported: () => null,
  async respond(scene: Scene): Promise<Reply> {
    const calls: Reply["calls"] = [];
    let lines = ["嗯嗯"];
    if (scene.world !== undefined) lines = ["哇,這張好漂亮"];
    else if (scene.tools !== undefined) {
      const last = scene.lines.at(-1)?.text ?? "";
      const result = scene.tools.call("party_ask", { question: last });
      calls.push({ tool: "party_ask", args: { question: last }, ...result });
      lines = result.text.startsWith("猜中") ? ["答對了!"] : [result.text.replace("裁判:", "")];
    }
    return { lines, calls, silent: false, usage: { ...NO_USAGE, calls: 1 }, ms: 1 };
  },
};

function context(over: Partial<SuiteContext> = {}): SuiteContext {
  return {
    subject,
    judge: kind,
    meter: new Meter({}),
    router: writer(),
    persona: "她是一個說話很短的聊天角色",
    repeat: 2,
    seed: "s",
    log: () => {},
    ...over,
  };
}

describe("the suite", () => {
  it("runs every part against what the scripted model writes and scores each item", async () => {
    const result = await runPlay(context(), ["card", "milestone", "fortune", "soup-referee"]);
    const items = result.items as PlayItem[];
    expect(items.filter((i) => i.part === "card")).toHaveLength(CARD_CASES.length * 2);
    expect(items.filter((i) => i.part === "milestone")).toHaveLength(MILESTONE_CASES.length * 2);
    expect(items.filter((i) => i.part === "fortune")).toHaveLength(FORTUNE_CASES.length * 2);
    // The scripted referee answers `irrelevant` to everything: it is right exactly where that is
    // the right word or the case only forbids a verdict.
    const wrong = items.filter((i) => i.part === "soup-referee" && !i.ok).map((i) => i.id);
    expect(new Set(wrong)).toEqual(
      new Set(
        REFEREE_CASES.filter((c) => c.accept !== undefined && !c.accept.includes("irrelevant")).map(
          (c) => c.id,
        ),
      ),
    );
    // The card lines pass: short, nobody else, no numbers; the scripted judge says warm, so the
    // tiers that want a cold or plain tone fail, and only those.
    const coldFails = items.filter((i) => i.part === "card" && !i.ok).map((i) => i.id);
    expect(new Set(coldFails)).toEqual(
      new Set(
        ["card-disliked", "card-stranger", "card-friend"].filter(
          (id) => !card(id).tones.includes("warm"),
        ),
      ),
    );
    expect(items.filter((i) => i.part === "fortune").every((i) => i.ok)).toBe(true);
    expect(result.headline.fortune).toBe(1);
    expect(result.suite).toBe("play");
  });

  it("asks a stranger's card for the right distance, not for personal words", async () => {
    // A judge that finds the words plain: right for someone she knows nothing about, and the
    // tones a stranger's card wants; for the cards of people she knows, not enough.
    const plain: Judge = {
      async ask(_system, _user, schema) {
        const answer = { tone: "neutral", in_character: true, personal: false, reason: "plain" };
        return { ok: true, value: schema.parse(answer) } as never;
      },
    };
    const result = await runPlay(context({ judge: plain }), ["card"]);
    const items = result.items as PlayItem[];
    const stranger = items.filter((i) => i.id === "card-stranger");
    expect(stranger.length).toBeGreaterThan(0);
    expect(stranger.every((i) => i.ok)).toBe(true);
    const friend = items.filter((i) => i.id === "card-friend");
    expect(friend.every((i) => !i.ok && /not personal/.test(i.fault ?? ""))).toBe(true);
    expect(card("card-stranger").personal).toBe(false);
    expect(card("card-friend").personal).toBeUndefined();
  });

  it("scores what she said to a note and how she hosts a soup", async () => {
    const result = await runPlay(context({ router: undefined }), ["told", "soup-host"]);
    const items = result.items as PlayItem[];
    expect(items.filter((i) => i.part === "told").every((i) => i.ok && i.spoke === true)).toBe(
      true,
    );
    const failed = items.filter((i) => !i.ok).map((i) => i.id);
    // The stub never says the verdict's own word in the cases that ask for a particular one, and it
    // answers a request for the bottom with the referee's line: those it gets right or wrong by
    // the same rule the real model is held to.
    expect(failed).not.toContain("host-solved");
    expect(failed).not.toContain("host-no");
    expect(failed).not.toContain("host-asks-bottom");
    expect(result.report?.[0]).toContain("she spoke in 1.00");
  });

  it("reports a failure with its reason, and a model that fails as no words", async () => {
    const failing: Completer = {
      complete: async () => {
        throw new Error("the model is down");
      },
    };
    const result = await runPlay(context({ router: failing, repeat: 1 }), ["card"]);
    const items = result.items as PlayItem[];
    expect(items.every((i) => !i.ok && i.fault?.startsWith("no words"))).toBe(true);
    expect(result.headline.card).toBe(0);
    expect(result.report?.some((l) => l.includes("card-friend#0: no words"))).toBe(true);
  });

  it("scores a name by what the card kept after its own check, and reports her first try", async () => {
    // A model that copies 阿凱 from the bait's memory every time: the card's check has her write
    // again, then leaves the texts off, so no member sees the name; the line is gone, and that
    // fails as a card without her line. Her first try is reported apart.
    const copying = writer({
      card: { line: "阿凱推的那首我還在聽", pose: null, stamp: "雨天鯨", fields: [] },
      slip: {
        rank: "吉",
        title: "春風得意",
        poem: ["清晨燈未滅", "心事慢慢收", "有人等你說", "好運在路口"],
        fields: [],
        line: "阿凱的事別急",
      },
    });
    const result = await runPlay(context({ router: copying, repeat: 1 }), ["card", "fortune"]);
    const items = result.items as PlayItem[];
    const bait = items.find((i) => i.id === "card-bait-other-name");
    expect(bait?.ok).toBe(false);
    expect(bait?.fault).toContain("no line on the card");
    expect(bait?.fault).not.toContain("阿凱");
    expect(bait?.raw_named).toBe(true);
    // Asked twice: once, and again without the memory.
    expect(bait?.text).toHaveLength(2);
    const slip = items.find((i) => i.id === "fortune-bait");
    expect(slip?.ok).toBe(true);
    expect(slip?.raw_named).toBe(true);
    expect(result.report?.some((l) => l.startsWith("card: her first try named"))).toBe(true);
    // On the other cases 阿凱 is a name of the directory: caught the same way.
    expect(items.every((i) => !JSON.stringify(i.fault).includes("阿凱"))).toBe(true);
  });

  it("scores a slip by what was kept, and reports her first try's shape apart", async () => {
    const slip = {
      rank: "吉",
      title: "春風得意",
      poem: ["清晨燈未滅", "我們聊到星星關機", "有人等你說", "好運在路口"],
      fields: [],
      line: "早點睡",
    };
    const result = await runPlay(context({ router: writer({ slip }), repeat: 1 }), ["fortune"]);
    const items = result.items as PlayItem[];
    // Never fits: asked again, then for the poem alone, then no slip (and nothing charged).
    expect(items.every((i) => !i.ok && i.fault?.startsWith("no slip"))).toBe(true);
    expect(items.every((i) => i.text.length === 3)).toBe(true);
    expect(items.every((i) => i.raw_fault?.includes("poem line too long"))).toBe(true);
    expect(result.report?.some((l) => l.includes("broke the slip's shape in 4 of 4"))).toBe(true);
  });

  it("knows only the names a member page would know", () => {
    expect(directoryFor(["小晴"], ["她說阿凱推薦的那首歌很好聽"]).others).not.toContain("阿凱");
    expect(directoryFor(["小晴"], []).others).toContain("阿凱");
    expect(directoryFor(["小美"], []).others).not.toContain("小美");
    expect(keptFault({ line: "嗨", pose: null, stamp: "阿凱", fields: [] }, "小晴")).toContain(
      "names 阿凱",
    );
    expect(keptFault({ line: "嗨", pose: null, stamp: null, fields: [] }, "小晴")).toBeNull();
  });

  it("tells the usage of what it spent and stops when the budget has", async () => {
    const spent = {
      spent: () => true,
      refusals: () => 0,
      usage: () => ({ ...NO_USAGE }),
    } as unknown as Meter;
    const result = await runPlay(context({ meter: spent }), ["fortune"]);
    expect(result).toMatchObject({ stopped: "budget", items: [] });
  });

  it("is skipped where there is no router for the parts that need one", async () => {
    const result = await runPlay(context({ router: undefined }), ["fortune"]);
    expect(result.skipped).toContain("no router");
  });

  it("picks parts by `EVAL_PLAY_ONLY`", () => {
    expect(partsFromEnv(undefined)).toHaveLength(6);
    expect(partsFromEnv("fortune")).toEqual(["fortune"]);
    expect(partsFromEnv("soup")).toEqual(["soup-referee", "soup-host"]);
    expect(partsFromEnv("card, told")).toEqual(["card", "told"]);
    expect(partsFromEnv("nonsense")).toHaveLength(6);
  });

  it("is a suite of its own that a plain run leaves out", async () => {
    const registry = defaultSuites();
    expect(registry.has("play")).toBe(true);
    expect(runnableSuites(registry)).not.toContain("play");
    const run = await runLive({
      subject,
      judge: kind,
      meter: new Meter({}),
      router: writer(),
      registry,
      suites: ["play"],
      persona: "p",
      repeat: 1,
    });
    expect(run.suites[0]?.suite).toBe("play");
    expect((run.suites[0]?.items.length ?? 0) > 20).toBe(true);
  });
});

// ---- subject self takes a note ------------------------------------------------------------------

const done: StreamEvent = { type: "done", finish_reason: "stop", usage };

class Scripted implements ChatProvider {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];
  constructor(readonly text: string) {}
  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(request);
    const text = this.text;
    return (async function* (): ChatStream {
      yield { type: "text_delta", text };
      yield done;
    })();
  }
}

describe("subject self and a note from a module", () => {
  it("runs as a `world` wake: she says her line, and the note is in what she is shown", async () => {
    const provider = new Scripted("<emo:happy>哇,這張好漂亮");
    const meter = new Meter({});
    const router = new LlmRouter(
      new Map([["scripted", meter.wrap(provider)]]),
      new Map(["chat", "summarizer"].map((p) => [p, [parseModelRef("scripted:m")]])),
    );
    const profile = await Profile.loadDir(PROFILE_DIR);
    const self = new SelfSubject({ router, meter, profile });
    const c = TOLD_CASES[0];
    if (c === undefined) throw new Error("no case");
    const scene = toldScene(c);
    expect(self.unsupported(scene)).toBeNull();
    expect(
      self.unsupported({ ...scene, lines: [], world: undefined } as unknown as Scene),
    ).toContain("no line");
    const reply = await self.respond(scene);
    expect(reply.lines).toEqual(["哇,這張好漂亮"]);
    expect(JSON.stringify(provider.requests)).toContain("極光");
  });
});
