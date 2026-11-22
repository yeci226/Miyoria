// Reaction-only answers: the matcher, the budget, and a thank-you on the host that gets an emoji
// with no model call while its turn is booked like any other. The chance is passed in.

import { sleep } from "@miyoria/runtime/kernel";
import { type Envelope, Events, PartyStatusKey, type TurnOutcomeRecord } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  COURTESY_EMOJI,
  COURTESY_LABEL,
  CourtesyBudget,
  courtesyEmoji,
  courtesyKind,
} from "../src/courtesy.js";
import { channel, dm, line, mention, Rig, says, stopRigs, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const NAMES = ["米優", "Miyo"];

describe("courtesyKind", () => {
  it.each([
    ["謝謝", "thanks"],
    ["謝謝!", "thanks"],
    ["謝啦~~", "thanks"],
    ["好喔 謝謝你", "thanks"],
    ["超感謝 🙏", "thanks"],
    ["感恩感恩", "thanks"],
    ["3Q", "thanks"],
    ["米優謝謝", "thanks"],
    ["@米優 謝謝", "thanks"],
    ["Thanks!", "thanks"],
    ["thank you so much miyo", "thanks"],
    ["thx :fanfan:", "thanks"],
    ["ty <:heart:123456>", "thanks"],
    ["ありがとう!", "thanks"],
    ["ありがとうございます", "thanks"],
    ["掰掰", "bye"],
    ["拜拜~", "bye"],
    ["我先下了 掰", "bye"],
    ["明天見!", "bye"],
    ["bye bye", "bye"],
    ["see ya", "bye"],
    ["またね", "bye"],
    ["謝謝 掰掰", "bye"],
    ["晚安", "night"],
    ["米優晚安安", "night"],
    ["謝謝 晚安", "night"],
    ["good night!", "night"],
    ["おやすみなさい", "night"],
  ])("%s is %s", (text, kind) => {
    expect(courtesyKind(text, NAMES)).toBe(kind);
  });

  it.each([
    // A request with a thank-you inside it.
    "謝謝你幫我查天氣",
    "謝謝,那明天會下雨嗎",
    "thanks, can you also check the queue",
    "thanks for the help with my code",
    "ありがとう、明日も手伝ってくれる?",
    // Questions.
    "謝謝?",
    "掰掰嗎",
    "晚安了嗎",
    "你呢 晚安",
    // Not a thank-you or goodbye to her alone.
    "不用謝",
    "謝謝大家",
    "大家晚安",
    "他說謝謝",
    "@小明 謝謝",
    "沒事了謝謝",
    "好",
    "哈哈",
    "",
    "   ",
    "🙏",
    "8",
    "goodbye world",
    "byebyebye then let us play",
    `謝謝${"啦".repeat(80)}`,
  ])("%j is no match", (text) => {
    expect(courtesyKind(text, NAMES)).toBeNull();
  });

  it("drops an @name only when the platform says she is the only one mentioned", () => {
    expect(courtesyKind("@MiyoBot 謝謝", NAMES)).toBeNull();
    expect(courtesyKind("@MiyoBot 謝謝", NAMES, true)).toBe("thanks");
    expect(courtesyKind("@Bot 謝謝", NAMES, true)).toBe("thanks");
    // Glued to the words, an unknown display name takes them with it: no match, she is woken.
    expect(courtesyKind("@Bot謝謝", NAMES, true)).toBeNull();
    expect(courtesyKind("@米優謝謝", NAMES, true)).toBe("thanks");
  });

  it("picks the emoji by the random value", () => {
    expect(courtesyEmoji("thanks", () => 0)).toBe(COURTESY_EMOJI.thanks[0]);
    expect(courtesyEmoji("night", () => 0.9999)).toBe(COURTESY_EMOJI.night.at(-1));
    expect(courtesyEmoji("bye", () => 1)).toBe(COURTESY_EMOJI.bye.at(-1));
  });
});

describe("CourtesyBudget", () => {
  it("counts per place over a rolling hour", () => {
    const budget = new CourtesyBudget();
    budget.take("a", 0);
    budget.take("a", 1_000);
    budget.take("b", 1_000);
    expect(budget.used("a", 2_000)).toBe(2);
    expect(budget.used("a", 3_600_500)).toBe(1);
    expect(budget.used("a", 3_601_000)).toBe(0);
    expect(budget.used("b", 2_000)).toBe(1);
  });
});

const C1 = channel("c1");

/** A rig whose chance always says yes (`random` 0), with `rhythm` merged in. */
function rig(rhythm: Record<string, number | boolean> = {}, random = () => 0) {
  return Rig.create({ config: { rhythm }, host: { random } });
}

function reactions(r: Rig): string[] {
  return r.sink.actions.flatMap((a) => (a.payload.type === "react" ? [a.payload.emoji] : []));
}

function ofTurn(r: Rig, turn: string): string[] {
  return r
    .drain()
    .filter((e: Envelope) => (e.data as { turn?: string } | null)?.turn === turn)
    .map((e) => e.type);
}

describe("a reaction-only answer on the host", () => {
  it("reacts, calls no model, and books the turn like a silent run", async () => {
    const r = await rig();
    const msg = mention(C1, "amy", "@她 謝謝!");
    r.say(msg);
    await until(() => reactions(r).length === 1, 3_000, "the reaction");
    await sleep(120);
    expect(r.model.requests).toHaveLength(0);
    expect(reactions(r)).toEqual([COURTESY_EMOJI.thanks[0]]);
    const react = r.sink.actions.find((a) => a.payload.type === "react");
    expect(react?.payload).toMatchObject({ type: "react", message: msg.id });
    expect(react?.priority).toBe("direct");
    const outcomes = r.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0] as TurnOutcomeRecord;
    expect(outcome).toMatchObject({
      reason: "addressed",
      outcome: { type: "silence" },
      focus: [msg.id],
      restarts: 0,
    });
    expect(react?.turn).toBe(outcome.turn);
    // Started, decided, the tool, completed, the outcome: one turn, in that order.
    const types = ofTurn(r, outcome.turn);
    expect(types).toEqual([
      Events.AgentTurnStarted.type,
      Events.AgentDecision.type,
      Events.AgentTool.type,
      Events.AgentTurnCompleted.type,
      Events.AgentTurnOutcome.type,
    ]);
    const decision = r.of<{ turn: string; respond: boolean; reasons: string[] }>(
      Events.AgentDecision.type,
    )[0];
    expect(decision?.respond).toBe(true);
    expect(decision?.reasons).toContain("courtesy: thanks");
    const completed = r.of<{ turn: string; text: string }>(Events.AgentTurnCompleted.type)[0];
    expect(completed).toMatchObject({ turn: outcome.turn, text: "" });
    // The transcript has the line, then a note of what she did, under the turn.
    const entries = r.entries(C1);
    const at = entries.findIndex((e) => e.message_id === msg.id.id);
    expect(entries[at + 1]).toMatchObject({
      kind: "note",
      label: COURTESY_LABEL,
      turn: outcome.turn,
      about_seq: entries[at]?.seq,
    });
    expect(entries[at + 1]?.content).toContain(COURTESY_EMOJI.thanks[0]);
    expect(entries.some((e) => e.kind === "self")).toBe(false);
  });

  it("the next run sees the line and the note, and answers what comes after", async () => {
    const r = await rig();
    r.say(mention(C1, "amy", "@她 掰掰"));
    await until(() => reactions(r).length === 1, 3_000, "the reaction");
    r.model.push(says("在喔"));
    r.say(mention(C1, "amy", "@她 等等我還有一個問題"));
    await until(() => r.sink.texts().length === 1, 3_000, "the answer");
    expect(r.model.requests).toHaveLength(1);
    expect(JSON.stringify(r.model.requests[0]?.messages)).toContain(COURTESY_LABEL);
  });

  it("wakes her as before when the chance says no, or when it is switched off", async () => {
    const no = await rig({}, () => 0.99);
    no.model.push(says("不客氣"));
    no.say(mention(C1, "amy", "@她 謝謝"));
    await until(() => no.sink.texts().length === 1, 3_000, "the answer");
    expect(reactions(no)).toEqual([]);

    const off = await rig({ courtesy_react: false });
    off.model.push(says("不客氣"));
    off.say(mention(C1, "amy", "@她 謝謝"));
    await until(() => off.sink.texts().length === 1, 3_000, "the answer");
    expect(reactions(off)).toEqual([]);
  });

  it.each([
    ["a request with thanks in it", mention(C1, "amy", "@她 謝謝你幫我查天氣")],
    ["a question", mention(C1, "amy", "@她 謝謝?")],
    [
      "an attachment",
      {
        ...mention(C1, "amy", "@她 謝謝"),
        attachments: [{ url: "https://x/a.png", filename: "a.png", content_type: "image/png" }],
      },
    ],
    [
      "someone else mentioned",
      {
        ...mention(C1, "amy", "@她 @bob 謝謝"),
        mentions_others: [
          { account: { platform: "test", id: "bob" }, display_name: "bob", is_bot: false },
        ],
      },
    ],
    ["a line that does not call her", line(C1, "amy", "謝謝")],
  ])("never for %s", async (_what, msg) => {
    const r = await rig();
    r.model.push(says("嗯"));
    r.say(msg as ReturnType<typeof mention>);
    await sleep(250);
    expect(reactions(r)).toEqual([]);
    expect(r.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type).some(isCourtesy(r))).toBe(false);
  });

  it("not while a party game runs there", async () => {
    const r = await Rig.create({
      config: { rhythm: {} },
      host: { random: () => 0 },
      provide: (sup) =>
        sup.services.provide("app", PartyStatusKey, {
          running: () => ({ game: "soup", title: "海龜湯" }),
        }),
    });
    r.model.push(says("嗯"));
    r.say(mention(C1, "amy", "@她 謝謝"));
    await until(() => r.model.requests.length === 1, 3_000, "the run");
    expect(reactions(r)).toEqual([]);
  });

  it("not when her last line asked them something", async () => {
    const r = await rig();
    r.model.push(says("你要我幫你記下來嗎?"));
    r.say(mention(C1, "amy", "@她 明天要交報告"));
    await until(() => r.sink.texts().length === 1, 3_000, "her question");
    await sleep(80);
    r.model.push(says("好,記下了"));
    r.say(mention(C1, "amy", "@她 謝謝"));
    await until(() => r.sink.texts().length === 2, 3_000, "the answer");
    expect(reactions(r)).toEqual([]);
  });

  it("keeps to the budget per place, then wakes her", async () => {
    const r = await rig({ courtesy_per_hour: 1, reaction_gap_ms: 0 });
    r.say(mention(C1, "amy", "@她 謝謝"));
    await until(() => reactions(r).length === 1, 3_000, "the reaction");
    r.model.push(says("不客氣啦"));
    r.say(mention(C1, "bob", "@她 謝謝"));
    await until(() => r.sink.texts().length === 1, 3_000, "the answer");
    expect(reactions(r)).toHaveLength(1);
    // Another place has its own budget, and a DM is a place too.
    r.say(line(dm("d1"), "amy", "晚安"));
    await until(() => reactions(r).length === 2, 3_000, "the DM reaction");
    expect(reactions(r)[1]).toBe(COURTESY_EMOJI.night[0]);
  });
});

/** The outcome is a reaction-only turn's (its decision says so). */
function isCourtesy(r: Rig) {
  const turns = new Set(
    r
      .of<{ turn: string; reasons: string[] }>(Events.AgentDecision.type)
      .filter((d) => d.reasons.includes("reaction only"))
      .map((d) => d.turn),
  );
  return (o: TurnOutcomeRecord) => turns.has(o.turn);
}
