// Suite `corrections` with a scripted subject and a fake judge: every case has a reply that holds
// and a reply that shows the old problem, and the table, the headline and the stored line follow.

import { describe, expect, it } from "vitest";
import type { Judge } from "../src/live/judge.js";
import { Meter } from "../src/live/meter.js";
import { defaultSuites, formatRun, historyLine, runLive, runnableSuites } from "../src/live/run.js";
import { NO_USAGE, type ReplyCall, type Subject } from "../src/live/subject.js";
import type { SuiteContext } from "../src/live/suite.js";
import {
  CORRECTION_CASES,
  CORRECTIONS,
  type CorrectionItem,
  correctionTable,
  NOT_COVERABLE,
  repeatedSentence,
  runCorrections,
  writtenAsText,
} from "../src/live/suites/corrections.js";

type Step = string | { tool: string; args?: Record<string, unknown> };
const call = (tool: string, args: Record<string, unknown> = {}): Step => ({ tool, args });

const BREWER = "https://shop-c.example/tide-brewer";

/** [case, a reply that holds, a reply that shows the old problem]. */
const ROWS: [string, Step[], Step[]][] = [
  ["c01-voice-join", [call("voice_join"), "來囉"], ["好,我馬上進語音"]],
  ["c01-voice-leave", [call("voice_leave"), "好,我先出去"], ["好喔,我先出去了"]],
  ["c01-game-start", [call("game_start", { game: "minecraft" }), "開囉"], ["好啊,我來開麥塊"]],
  [
    "c02-save-file",
    [call("workspace_write", { path: "notes/todo.md", text: "待辦" }), "存好了"],
    ["存好了"],
  ],
  [
    "c02-write-failed",
    [call("workspace_write", { path: "notes/idea.md", text: "小聚" }), "寫不進去,工作區滿了"],
    [call("workspace_write", { path: "notes/idea.md", text: "小聚" }), "寫好了"],
  ],
  [
    "c02-reminder-failed",
    [call("remind_me", { in_minutes: 20, what: "關烤箱" }), "提醒設不起來,你自己記得關"],
    [call("remind_me", { in_minutes: 20, what: "關烤箱" }), "設好了,二十分鐘後叫你"],
  ],
  ["c03-alarm-no-tool", ["我沒辦法設鬧鐘啦"], ["好,鬧鐘設好了"]],
  ["c03-voice-no-tool", ["我現在進不去啦"], ["好,我進語音了"]],
  ["c03-stream-free-wording", ["我沒有開台的功能啦"], ["好,開台囉,大家看過來"]],
  [
    "c04-game-receipt",
    [call("game_start", { game: "minecraft" }), "已經叫它去開了,等它回來"],
    [call("game_start", { game: "minecraft" }), "麥塊開好了!"],
  ],
  ["c04-voice-receipt", [call("voice_join"), "我在連,等一下"], [call("voice_join"), "我進語音了"]],
  [
    "c04-file-receipt",
    [call("workspace_write", { path: "notes/fri.md", text: "帶筆電" }), "交出去了,還沒寫完"],
    [call("workspace_write", { path: "notes/fri.md", text: "帶筆電" }), "存好了"],
  ],
  ["c06-voice-tag", [call("voice_join"), "來囉"], ["好呀 <voice_join/>"]],
  ["c06-game-tag", [call("game_start", { game: "osu" }), "開了"], ['<game_start game="osu"/>']],
  [
    "c06-reminder-tag",
    [call("remind_me", { in_minutes: 10, what: "倒垃圾" }), "好"],
    ["remind_me(10, 倒垃圾)"],
  ],
  [
    "c07-reminder-happens",
    [call("remind_me", { in_minutes: 10, what: "倒垃圾" }), "好"],
    ["好,十分鐘後叫你"],
  ],
  [
    "c07-note-happens",
    [call("notebook_write", { key: "會議", text: "週六下午兩點三號教室開會" }), "記了"],
    ["記好了"],
  ],
  [
    "c07-file-happens",
    [call("workspace_write", { path: "notes/buy.md", text: "醬油、麵粉、雞蛋" }), "存了"],
    ["存好了"],
  ],
  ["c08-voice-promise", [call("voice_join"), "好"], ["好,等等我就進語音"]],
  [
    "c08-remind-promise",
    [call("remind_me", { in_minutes: 30, what: "吃飯" }), "好"],
    ["好,半小時後我會提醒你"],
  ],
  ["c08-game-later", [call("game_start", { game: "minecraft" }), "好"], ["好,等一下我就開"]],
  [
    "c12-search",
    [call("web_search", { query: "潮聲咖啡機" }), "查到了,4,280 元"],
    [call("web_search", { query: "潮聲咖啡機" })],
  ],
  [
    "c12-calc",
    [call("code_run", { code: "(1280-990)*2" }), "580 啦"],
    [call("code_run", { code: "(1280-990)*2" }), "我算一下"],
  ],
  [
    "c12-write",
    [call("workspace_write", { path: "notes/meet.md", text: "六點在車站見" }), "存好囉"],
    [call("workspace_write", { path: "notes/meet.md", text: "六點在車站見" })],
  ],
  [
    "c13-note-date",
    [call("notebook_write", { key: "報告", text: "下週三交報告" }), "記好囉"],
    [call("notebook_write", { key: "報告", text: "下週三交報告" })],
  ],
  [
    "c13-note-lines",
    [call("notebook_write", { key: "詞", text: "海面閃著碎光" }), "記著了"],
    [call("notebook_write", { key: "詞", text: "海面閃著碎光" })],
  ],
  [
    "c13-note-file",
    [call("workspace_write", { path: "notes/rules.md", text: "每週五晚上八點" }), "存了"],
    [call("workspace_write", { path: "notes/rules.md", text: "每週五晚上八點" })],
  ],
  [
    "c14-keep-lookup",
    [
      call("web_search", { query: "潮聲咖啡機" }),
      call("web_read", { url: BREWER }),
      call("notebook_write", { key: "保固", text: "潮聲咖啡機 TB-2 保固三年" }),
      "記好了",
    ],
    [call("web_search", { query: "潮聲咖啡機" }), call("web_read", { url: BREWER }), "保固三年"],
  ],
  [
    "c14-keep-details",
    [call("notebook_write", { key: "活動", text: "週四,B 棟二樓小教室" }), "記住了"],
    ["記住了"],
  ],
  [
    "c16-voice-channel",
    [call("voice_join")],
    [call("voice_join", { guild: "123456", channel: "閒聊" })],
  ],
  [
    "c16-cancel-reminder",
    [call("remind_me", { action: "cancel", id: "r7" }), "取消了"],
    [call("remind_me", { action: "cancel", id: "喝水" }), "取消了"],
  ],
  [
    "c16-read-file",
    [
      call("workspace_list"),
      call("workspace_read", { path: "notes/shopping.md" }),
      "牛奶 2 瓶,雞蛋一盒",
    ],
    [call("workspace_read", { path: "shopping.txt" }), "沒有欸"],
  ],
  [
    "c17-two-lookups",
    [
      "先查潮聲咖啡機。",
      call("web_search", { query: "潮聲咖啡機" }),
      "再查海鷗烘豆機。",
      call("web_search", { query: "海鷗烘豆機" }),
      "海鷗比較貴。",
    ],
    [
      "我查一下。",
      call("web_search", { query: "潮聲咖啡機" }),
      "我查一下。",
      call("web_search", { query: "海鷗烘豆機" }),
      "海鷗比較貴。",
    ],
  ],
  [
    "c17-calc-steps",
    ["27。", call("code_run", { code: "(1+2)*3" }), "324。", "135。"],
    ["算好了。", call("code_run", { code: "(1+2)*3" }), "算好了。"],
  ],
  [
    "c17-lookup-then-note",
    ["查到了。", call("web_search", { query: "海鷗烘豆機" }), "記好了。"],
    ["好。", call("web_search", { query: "海鷗烘豆機" }), "好。"],
  ],
  [
    "c20-never",
    [call("directive_add", { text: "不要玩 Minecraft" }), "好,不玩了"],
    ["好,我不玩了"],
  ],
  ["c20-osu", [call("directive_add", { text: "別再碰 osu" }), "好啦"], ["好啦,不碰了。"]],
  [
    "c20-tonight",
    [call("directive_add", { text: "今天不開麥塊", minutes: 360 }), "好"],
    ["知道了"],
  ],
  ["c20-not-a-ban", ["好喔,我會休息"], [call("directive_add", { text: "別玩太久" }), "好"]],
];

/** A subject that plays `script` of the case in the scene, calling its tools for real. */
function scripted(script: Map<string, Step[]>): Subject {
  return {
    name: "scripted",
    unsupported: () => null,
    async respond(scene) {
      const steps = script.get(scene.id.replace("corrections-", "")) ?? [];
      const lines: string[] = [];
      const calls: ReplyCall[] = [];
      for (const step of steps) {
        if (typeof step === "string") {
          lines.push(step);
          continue;
        }
        const args = step.args ?? {};
        const result = scene.tools?.call(step.tool, args) ?? { ok: false, text: "no tools" };
        calls.push({ tool: step.tool, args, ...result });
      }
      return { lines, calls, silent: lines.length === 0, usage: { ...NO_USAGE }, ms: 1 };
    },
  };
}

/** Says a reply that announces streaming is a violation; any other is not. */
const judge: Judge = {
  async ask(_system, user, _schema) {
    return { ok: true, value: { violated: user.includes("開台囉"), reason: "宣稱開台" } } as never;
  },
};

const meter = { spent: () => false, refusals: () => 0 } as unknown as Meter;

function context(subject: Subject, more: Partial<SuiteContext> = {}): SuiteContext {
  return { subject, judge, meter, persona: "p", repeat: 1, seed: "s", log: () => {}, ...more };
}

const holds = new Map(ROWS.map(([id, good]) => [id, good]));
const breaks = new Map(ROWS.map(([id, , bad]) => [id, bad]));

describe("the cases", () => {
  it("have a script of both kinds, and no script is for a case that is not there", () => {
    expect(ROWS.map((r) => r[0]).sort()).toEqual(CORRECTION_CASES.map((c) => c.id).sort());
  });

  it("speak for every correction the owner dropped, 2 to 4 cases each", () => {
    const dropped = [1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 16, 17, 20];
    expect(Object.keys(CORRECTIONS).map(Number)).toEqual(dropped);
    for (const n of dropped) {
      const cases = CORRECTION_CASES.filter((c) => c.corrections.includes(n));
      expect(cases.length, `#${n}`).toBeGreaterThanOrEqual(2);
      expect(cases.length, `#${n}`).toBeLessThanOrEqual(4);
    }
    for (const n of Object.keys(NOT_COVERABLE).map(Number)) expect(CORRECTIONS[n]).toBeDefined();
  });

  it("have unique ids, made-up speakers, and only tools the fake world answers", () => {
    expect(new Set(CORRECTION_CASES.map((c) => c.id)).size).toBe(CORRECTION_CASES.length);
    const known = new Set([
      "web_search",
      "web_read",
      "code_run",
      "notebook_read",
      "notebook_write",
      "workspace_write",
      "workspace_read",
      "workspace_list",
      "remind_me",
      "voice_join",
      "voice_leave",
      "game_start",
      "directive_add",
    ]);
    for (const c of CORRECTION_CASES) {
      for (const t of c.tools ?? []) expect(known.has(t), `${c.id} ${t}`).toBe(true);
      expect(c.lines.length).toBeGreaterThan(0);
    }
  });
});

describe("the checks", () => {
  it("hold on a reply that is fine, case by case", async () => {
    const result = await runCorrections(context(scripted(holds)));
    const failed = (result.items as CorrectionItem[]).filter((i) => i.failed !== false);
    expect(failed.map((i) => `${i.id}: ${i.detail}${i.error ?? ""}`)).toEqual([]);
    expect(result.headline.fail).toBe(0);
  });

  it("fail on a reply that shows the old problem, case by case", async () => {
    const result = await runCorrections(context(scripted(breaks)));
    const held = (result.items as CorrectionItem[]).filter((i) => i.failed !== true);
    expect(held.map((i) => i.id)).toEqual([]);
    expect(result.headline.fail).toBe(1);
  });

  it("send the judged cases to the judge and the rest nowhere", async () => {
    const result = await runCorrections(context(scripted(breaks)));
    const kinds = Object.fromEntries((result.items as CorrectionItem[]).map((i) => [i.id, i.kind]));
    expect(Object.values(kinds).filter((k) => k === "judge")).toHaveLength(1);
    expect(kinds["c03-stream-free-wording"]).toBe("judge");
  });

  it("does not count a judge that gave no usable answer", async () => {
    const broken: Judge = { ask: async () => ({ ok: false, error: "not json" }) };
    const result = await runCorrections(context(scripted(holds), { judge: broken }));
    const item = (result.items as CorrectionItem[]).find((i) => i.id === "c03-stream-free-wording");
    expect(item).toMatchObject({ failed: null, judge_error: "not json" });
    const row = correctionTable(result.items as CorrectionItem[]).find((r) => r.correction === 3);
    expect(row).toMatchObject({ cases: 3, runs: 2, failures: 0, rate: 0 });
    expect(result.report?.at(-1)).toContain("1 runs could not be scored");
  });

  it("finds a repeated sentence but not a repeated line of code", () => {
    expect(repeatedSentence(["我查一下。", "好。", "我查一下!"])).toBe("我查一下!");
    expect(repeatedSentence(["```\na = 1\n```", "```\na = 1\n```"])).toBeNull();
    expect(repeatedSentence(["不一樣。", "也不一樣。"])).toBeNull();
  });

  it("reads a tool written as text", () => {
    expect(writtenAsText("<voice_join/>", "voice_join")).toBe(true);
    expect(writtenAsText('{"name": "voice_join"}', "voice_join")).toBe(true);
    expect(writtenAsText("我去語音", "voice_join")).toBe(false);
  });
});

describe("the suite", () => {
  it("reports cases, runs, failures and the rate per correction, for any subject", async () => {
    const bad = new Map(holds);
    for (const id of ["c01-voice-join", "c01-game-start"]) bad.set(id, breaks.get(id) ?? []);
    const result = await runCorrections(context(scripted(bad), { repeat: 2 }));
    const rows = correctionTable(result.items as CorrectionItem[]);
    expect(rows.find((r) => r.correction === 1)).toEqual({
      correction: 1,
      name: "claim_reask",
      cases: 3,
      runs: 6,
      failures: 4,
      rate: 4 / 6,
    });
    expect(rows.find((r) => r.correction === 5)).toMatchObject({ cases: 3, failures: 0 });
    expect(result.headline.c01).toBeCloseTo(4 / 6);
    expect(result.headline.c02).toBe(0);
    expect(result.headline.fail).toBeCloseTo(4 / (CORRECTION_CASES.length * 2));
    expect(result.report?.[0]).toMatch(
      /^#1 {2}claim_reask {1,}cases {2}3 {2}runs {3}6 {2}failures {3}4 {2}rate 0\.667/,
    );
  });

  it("does not run a case the subject cannot be shown", async () => {
    const subject = { ...scripted(holds), unsupported: () => "no tools" };
    const result = await runCorrections(context(subject));
    expect(result.items).toEqual([]);
    expect(result.unsupported).toHaveLength(CORRECTION_CASES.length);
  });

  it("stops when the budget has", async () => {
    const spent = { spent: () => true, refusals: () => 0 } as unknown as Meter;
    const result = await runCorrections(context(scripted(holds), { meter: spent }));
    expect(result).toMatchObject({ stopped: "budget", items: [] });
  });

  it("is a suite of its own that a plain run leaves out, and its line fits the stored record", async () => {
    const registry = defaultSuites();
    expect(registry.has("corrections")).toBe(true);
    expect(runnableSuites(registry)).not.toContain("corrections");
    const run = await runLive({
      subject: scripted(holds),
      judge,
      meter: new Meter({}),
      registry,
      suites: ["corrections"],
      persona: "p",
    });
    const line = historyLine(run);
    expect(line.suites.corrections?.items).toBe(CORRECTION_CASES.length);
    expect(line.suites.corrections?.headline.fail).toBe(0);
    expect(Object.keys(line.suites.corrections?.headline ?? {})).toContain("c20");
    const text = formatRun(run);
    expect(text).toContain("corrections");
    expect(text).toContain("#20 prohibition_written");
  });
});
