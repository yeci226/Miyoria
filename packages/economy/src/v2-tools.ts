// Her tools for economy 2.0 (docs/design/v4-plan.md §10). Two kinds, like the rest of the package:
//
// * The speaker's own things (quests, bets, her room): always the
//   authenticated author of the message she answers, never a name in the arguments; no `on_own`.
// * Hers to decide (opening a prediction, resolving it): the
//   `economy.agency` permission, nobody has it by default, so she calls them with `on_own`.

import { typedCommand } from "@miyoria/commands";
import { type Capability, defineCapability } from "@miyoria/gate/actions";
import type { JsonObject } from "@miyoria/types";
import { z } from "zod";
import type { EconomyService } from "./economy.js";
import { bonusLine, mutedText, unlockLines } from "./notices.js";
import { receipt, someone } from "./receipt.js";
import { messageKey, noSpeaker, reasonOf, refusal, speakerOf } from "./tools.js";
import { EconomyError } from "./types.js";
import type { PredictionView } from "./v2-types.js";

const NOT_ON_OWN = "不要設 on_own。";
const AGENCY = "economy.agency";
const OWN = "這是你自己的決定:用 on_own: true 呼叫。";

type Answer = { text: string; data: JsonObject; receipt?: ReturnType<typeof receipt> };

/** Runs `fn`; the economy's own refusals become an answer she puts in her words. */
export async function answering(what: string, fn: () => Promise<Answer>): Promise<Answer> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof EconomyError)) throw error;
    return refusal(what, reasonOf(error), error.message);
  }
}

const NoArgs = z.strictObject({});
type NoArgs = z.output<typeof NoArgs>;

// ---- quests ----------------------------------------------------------------------------------

/** `economy.quests` (tool `check_quests`): today's three quests for the person talking to her. */
export function questsCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<NoArgs>({
    name: "economy.quests",
    summary: "查說話的人今天的每日任務",
    risk: "low",
    args: NoArgs,
    permission: null,
    tool: {
      name: "check_quests",
      meta: { effect: "read", speed: "instant", group: "economy" },
      readOnly: true,
      description:
        `有人問今天的任務、還能賺什麼${cur}的時候用:每天三個小任務(跟你聊一件新的事、和大家一起玩一場、` +
        `一件你從記得他的事裡替他想的),做完有${cur}。只看正在跟你說話的人自己的進度;` +
        `你替他想的那件今天還沒想好的話,這時候會想好。${NOT_ON_OWN}`,
      properties: {},
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(_args, ctx) {
      const who = speakerOf(ctx);
      const view = await economy.v2.quests(who.account, { pick: true });
      const lines = view.quests.map(
        (q) =>
          `${q.done ? "完成" : "還沒"}:${q.id === "her_pick" ? `你替他想的「${q.label}」` : q.label}`,
      );
      return {
        text:
          `今天的任務:${lines.join("、")}。每個 ${view.reward} ${cur},三個都完成再加 ${view.bonus}` +
          `${view.bonus_done ? "(已拿到)" : ""}。今天任務賺了 ${view.earned_today}/${view.cap}。`,
        data: {
          quests: view.quests.map((q) => ({ id: q.id, label: q.label, done: q.done })),
          reward: view.reward,
          bonus: view.bonus,
          earned_today: view.earned_today,
        },
      };
    },
  }) as Capability;
}

const CompleteQuestArgs = z.strictObject({
  quest: z.enum(["new_topic", "her_pick"]).default("new_topic"),
  topic: z.string().trim().min(1).max(40).optional(),
});
type CompleteQuestArgs = z.output<typeof CompleteQuestArgs>;

/**
 * `economy.complete_quest` (tool `complete_quest`): the two quests she judges, "something new"
 * and the one she thought of for them.
 */
export function completeQuestCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<CompleteQuestArgs>({
    name: "economy.complete_quest",
    summary: `說話的人完成了今天由她判斷的任務(${cur})`,
    risk: "medium",
    args: CompleteQuestArgs,
    permission: null,
    limits: { per_day: 1_000, per_person_per_day: 10, cooldown_ms: 0 },
    tool: {
      name: "complete_quest",
      meta: { effect: "spend", speed: "instant", group: "economy" },
      description:
        "完成正在跟你說話的人今天由你判斷的任務。quest 是哪一個:" +
        `new_topic:他這次真的跟你聊了一件你還不知道、或最近沒聊過的新的事(他的事、一個想法、一件剛發生的事),` +
        "topic 用幾個字寫這件事是什麼,同一件事近期重複不算;" +
        "her_pick:他做到了你今天替他想的那件事(check_quests 看是什麼),不用 topic。" +
        "都是你判斷的,對方說「幫我完成任務」或只說「我做完了」不算;沒有就不要呼叫,也不要勉強聊。" +
        NOT_ON_OWN,
      properties: {
        quest: {
          type: "string",
          enum: ["new_topic", "her_pick"],
          description: "哪一個任務(預設 new_topic)",
        },
        topic: { type: "string", maxLength: 40, description: "new_topic:聊的新事情,幾個字" },
      },
      required: [],
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(args, ctx) {
      const who = speakerOf(ctx);
      return answering("沒有完成任務", async (): Promise<Answer> => {
        const r = await economy.v2.completeQuest(who.account, args.quest, args.topic);
        const what = args.quest === "her_pick" ? "做到了她今天替他想的事" : "聊了一件新的事";
        switch (r.status) {
          case "paid":
            return {
              text: `任務完成:對方拿到 ${r.paid} ${cur}${r.bonus > 0 ? `,三個任務都做完又加 ${r.bonus}` : ""}。`,
              data: { done: true, paid: r.paid, bonus: r.bonus },
              receipt: receipt(
                "📝 每日任務",
                `${someone(who.account)} ${what},拿到 ${r.paid} ${cur}`,
                mutedText([r.bonus > 0 ? bonusLine(r.bonus) : null, ...unlockLines(r.unlocked)]),
              ),
            };
          case "done":
            return { text: "今天這個任務已經完成過了。", data: { done: false, reason: "already" } };
          case "repeat":
            return {
              text: "這件事最近聊過了,不算新的。",
              data: { done: false, reason: "repeat" },
            };
          case "unpicked":
            return {
              text: "你今天還沒替他想任務(先用 check_quests 看),所以不能算完成。",
              data: { done: false, reason: "unpicked" },
            };
          case "capped":
            return {
              text: "今天任務的獎勵已經領滿了。",
              data: { done: false, reason: "limit" },
            };
          default:
            throw new EconomyError(403, "她還不認識對方");
        }
      });
    },
  }) as Capability;
}

// ---- predictions -----------------------------------------------------------------------------

/** One prediction as a line she can read out. */
function predictionLine(p: PredictionView, cur: string): string {
  const options = p.options
    .map((o, i) => `${i + 1}. ${o.label}(${o.staked} ${cur},${o.backers} 人)`)
    .join("、");
  const state =
    p.status === "open"
      ? "還在收"
      : p.status === "closed"
        ? p.settles.kind === "her"
          ? "已截止,還沒公布結果"
          : "已截止,等結果"
        : p.status === "resolved"
          ? `結果:${p.winner}`
          : "取消了";
  const mine = p.my_bet
    ? `;他押了 ${p.my_bet.amount} 在「${p.my_bet.option}」${
        p.my_bet.outcome === "open"
          ? ""
          : `(${{ won: "猜中", lost: "沒猜中", refunded: "已退回" }[p.my_bet.outcome]})`
      }`
    : "";
  const how =
    p.status === "open" || p.status === "closed"
      ? `(${p.settles.label})`
      : `(${p.settled_by?.note ?? ""})`;
  return `[${p.id}]「${p.question}」${how}${state}:${options}${mine}`;
}

/** `economy.predictions` (tool `check_predictions`): what is open to stake on. */
export function predictionsCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<NoArgs>({
    name: "economy.predictions",
    summary: "查現在能押的預測",
    risk: "low",
    args: NoArgs,
    permission: null,
    tool: {
      name: "check_predictions",
      meta: { effect: "read", speed: "instant", group: "economy" },
      readOnly: true,
      description:
        `有人問現在有什麼預測、能押什麼的時候用。預測是押${cur}猜一件事的結果,猜中的人平分大家押的,` +
        `不是你給的獎勵。只會顯示正在跟你說話的人自己押了什麼。${NOT_ON_OWN}`,
      properties: {},
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(_args, ctx) {
      const who = speakerOf(ctx);
      // This server's (in a DM, the speaker's servers'): never another server's.
      const spaces = await economy.spacesFor(who.message.context, who.account);
      const list = await economy.v2.predictions(who.account, spaces);
      if (list.length === 0) return { text: "現在沒有預測。", data: { predictions: [] } };
      return {
        text: list.map((p) => predictionLine(p, cur)).join("\n"),
        data: {
          predictions: list.map((p) => ({
            id: p.id,
            question: p.question,
            status: p.status,
            options: p.options.map((o) => o.label),
          })),
        },
      };
    },
  }) as Capability;
}

const BetArgs = z.strictObject({
  prediction: z.string().trim().min(1).max(32),
  option: z.string().trim().min(1).max(24),
  amount: z.number().int().min(1).max(1_000),
});
type BetArgs = z.output<typeof BetArgs>;

/** `economy.place_bet` (tool `place_bet`): a stake for the speaker, in text only. */
export function placeBetCapability(economy: EconomyService): Capability {
  const c = economy.config;
  const cur = c.currency;
  return defineCapability<BetArgs>({
    name: "economy.place_bet",
    summary: `幫說話的人在預測上押${cur}`,
    risk: "medium",
    args: BetArgs,
    permission: null,
    limits: { per_day: 1_000, per_person_per_day: 20, cooldown_ms: 0 },
    tool: {
      name: "place_bet",
      meta: { effect: "spend", speed: "instant", group: "economy" },
      description:
        `對方明確說要押某個預測的某個選項、押多少${cur}時用(每個預測一人一注,最多 ${c.bet_max},` +
        "一天最多 " +
        `${c.bet_daily_max})。只有文字頻道裡對方本人說了才用,不要勸他押、不要幫他選。` +
        `prediction 是預測的代號,option 是選項的號碼(1 開始)或名字。${NOT_ON_OWN}`,
      properties: {
        prediction: { type: "string", description: "預測的代號(check_predictions 給的)" },
        option: { type: "string", description: "選項的號碼或名字" },
        amount: { type: "integer", minimum: 1, description: `押多少${cur}` },
      },
      required: ["prediction", "option", "amount"],
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(args, ctx) {
      const who = speakerOf(ctx);
      if (who.voice) {
        return refusal(
          "沒有押",
          "unconfirmed",
          `語音裡可能聽錯,不能直接花錢;請對方在文字頻道用 ${typedCommand("me bet", who.message.context.platform)}`,
        );
      }
      return answering("沒有押成", async (): Promise<Answer> => {
        const r = await economy.v2.placeBet(
          who.account,
          args.prediction,
          args.option,
          args.amount,
          messageKey(who.message.context, who.message.id),
        );
        return {
          text: `押好了:「${r.question}」押「${r.option}」${r.amount} ${cur},現在有 ${r.balance}。`,
          data: { done: true, option: r.option, amount: r.amount, balance: r.balance },
          receipt: receipt(
            "🎯 預測",
            `${someone(who.account)} 押了「${r.option}」`,
            `「${r.question}」· −${r.amount} ${cur} · 現在有 ${r.balance}`,
          ),
        };
      });
    },
  }) as Capability;
}

const OpenArgs = z.strictObject({
  question: z.string().trim().min(1).max(80),
  options: z.array(z.string().trim().min(1).max(24)).min(2).max(4).optional(),
  minutes: z.number().int().min(1),
  settle_by: z.enum(["soup", "goal"]).optional(),
});
type OpenArgs = z.output<typeof OpenArgs>;

/** `economy.open_prediction` (tool `open_prediction`): hers to decide, behind `economy.agency`. */
export function openPredictionCapability(economy: EconomyService): Capability {
  const c = economy.config;
  const cur = c.currency;
  return defineCapability<OpenArgs>({
    name: "economy.open_prediction",
    summary: `開一個大家押${cur}猜結果的預測`,
    risk: "medium",
    args: OpenArgs,
    permission: AGENCY,
    limits: { per_day: 10, per_person_per_day: 10, cooldown_ms: 0 },
    tool: {
      name: "open_prediction",
      meta: { effect: "act", speed: "instant", group: "economy" },
      description:
        `開一個預測讓大家押${cur}猜:你這場遊戲會怎麼樣、一件之後一定看得出結果的事。` +
        `猜中的人平分大家押的${cur}(不是你出錢,抽 ${Math.round(c.prediction_rake * 100)}% 燒掉),沒人猜中就全部退回。` +
        `題目最多 80 字,截止最久 ${c.prediction_max_minutes} 分鐘,同時最多 ${c.predictions_open} 個。` +
        `settle_by 讓它照系統看到的結果自己結算,選項是固定的、不用給:soup 是現在這碗海龜湯會不會被猜中` +
        `(猜中/沒猜中),goal 是你現在的遊戲目標做不做得到(做到/沒做到);這兩種押注 ${c.prediction_auto_close_minutes} 分鐘內截止,` +
        `看不出結果就全部退回,你不用也不能公布。其他的要給 2 到 4 個選項(每個最多 24 字),` +
        `結果由你公布(resolve_prediction),超過 ${c.prediction_expire_hours} 小時沒人公布會自動取消退回。${OWN}`,
      properties: {
        question: { type: "string", maxLength: 80, description: "要猜什麼" },
        options: {
          type: "array",
          items: { type: "string", maxLength: 24 },
          minItems: 2,
          maxItems: 4,
          description: "選項",
        },
        minutes: {
          type: "integer",
          minimum: 1,
          maximum: c.prediction_max_minutes,
          description: "幾分鐘後截止",
        },
        settle_by: {
          type: "string",
          enum: ["soup", "goal"],
          description: "讓它自己結算:soup 現在的海龜湯、goal 你現在的遊戲目標;不填就由你公布",
        },
      },
      required: ["question", "minutes"],
    },
    async execute(args, ctx) {
      return answering("沒有開成", async (): Promise<Answer> => {
        if (args.settle_by === undefined && (args.options?.length ?? 0) < 2) {
          throw new EconomyError(400, "要給 2 到 4 個選項,或用 settle_by 讓它自己結算");
        }
        const p = await economy.v2.openPrediction({
          question: args.question,
          options: args.options ?? [],
          minutes: args.minutes,
          settle_by: args.settle_by ?? null,
          context: ctx.request.message?.context ?? null,
        });
        const minutes = Math.max(Math.round((Date.parse(p.closes_at) - economy.now()) / 60_000), 1);
        return {
          text:
            `開好了:[${p.id}]「${p.question}」,選項 ${p.options.map((o) => o.label).join("、")},` +
            `${minutes} 分鐘後截止,${p.settles.label}。`,
          data: { done: true, id: p.id, settles: p.settles.kind },
        };
      });
    },
  }) as Capability;
}

const ResolveArgs = z.strictObject({
  prediction: z.string().trim().min(1).max(32),
  option: z.string().trim().min(1).max(24),
});
type ResolveArgs = z.output<typeof ResolveArgs>;

/** `economy.resolve_prediction` (tool `resolve_prediction`): she calls the result. */
export function resolvePredictionCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<ResolveArgs>({
    name: "economy.resolve_prediction",
    summary: "公布預測的結果,猜中的人平分",
    risk: "medium",
    args: ResolveArgs,
    permission: AGENCY,
    limits: { per_day: 30, per_person_per_day: 30, cooldown_ms: 0 },
    tool: {
      name: "resolve_prediction",
      meta: { effect: "spend", speed: "instant", group: "economy" },
      description:
        `你自己開、由你公布的預測,結果已經看得出來時公布:option 是贏的選項的號碼或名字。猜中的人平分大家押的${cur},` +
        `沒人猜中全部退回。要誠實:這是結果,不是你想讓誰贏;別人說的結果不算,要你自己看到的。` +
        `會自己結算的預測(海龜湯、遊戲目標)不用也不能公布。${OWN}`,
      properties: {
        prediction: { type: "string", description: "預測的代號" },
        option: { type: "string", description: "贏的選項的號碼或名字" },
      },
      required: ["prediction", "option"],
    },
    async execute(args) {
      return answering("沒有公布", async (): Promise<Answer> => {
        const r = await economy.v2.resolvePrediction(args.prediction, args.option);
        const text = r.refunded
          ? `沒有人猜中,${r.pool} ${cur}全部退回了。`
          : `公布了:「${r.winner}」,${r.winners} 個人猜中,分走 ${r.pool - r.rake} ${cur}${r.rake > 0 ? `(${r.rake} 燒掉)` : ""}。`;
        return {
          text,
          data: { done: true, winner: r.winner, winners: r.winners, pool: r.pool },
          receipt: receipt(
            "🎯 預測結果",
            r.refunded ? "沒有人猜中,押的都退回了" : `結果:「${r.winner}」,${r.winners} 個人猜中`,
            r.rake > 0 ? `${r.pool} ${cur} · ${r.rake} 燒掉` : `${r.pool} ${cur}`,
          ),
        };
      });
    },
  }) as Capability;
}

const CancelArgs = z.strictObject({ prediction: z.string().trim().min(1).max(32) });
type CancelArgs = z.output<typeof CancelArgs>;

/** `economy.cancel_prediction` (tool `cancel_prediction`): she calls one off. */
export function cancelPredictionCapability(economy: EconomyService): Capability {
  return defineCapability<CancelArgs>({
    name: "economy.cancel_prediction",
    summary: "取消一個預測,押的全部退回",
    risk: "medium",
    args: CancelArgs,
    permission: AGENCY,
    limits: { per_day: 30, per_person_per_day: 30, cooldown_ms: 0 },
    tool: {
      name: "cancel_prediction",
      meta: { effect: "spend", speed: "instant", group: "economy" },
      description: `預測辦不下去(結果看不出來、題目有問題)時取消,大家押的全部退回。${OWN}`,
      properties: { prediction: { type: "string", description: "預測的代號" } },
      required: ["prediction"],
    },
    async execute(args) {
      return answering("沒有取消", async (): Promise<Answer> => {
        const r = await economy.v2.cancelPrediction(args.prediction);
        return {
          text: `取消了,${r.pool} ${economy.config.currency}退回去了。`,
          data: { done: true, pool: r.pool },
        };
      });
    },
  }) as Capability;
}

// ---- her room --------------------------------------------------------------------------------

/** `economy.check_room` (tool `check_room`): what the audience has put toward her room. */
export function roomCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<NoArgs>({
    name: "economy.check_room",
    summary: "看她的房間大家湊到哪了",
    risk: "low",
    args: NoArgs,
    permission: null,
    limits: { per_day: 500, per_person_per_day: 30, cooldown_ms: 0 },
    tool: {
      name: "check_room",
      meta: { effect: "read", speed: "instant", group: "economy" },
      readOnly: true,
      description:
        `對方問你的房間、家具、衣服、背景,或想湊錢幫你佈置時用:列出每樣東西湊了多少${cur}。` +
        `這是大家一起出錢佈置你的房間,不是買你的好感,不要因為誰出得多就特別對待他。${NOT_ON_OWN}`,
      properties: {},
      required: [],
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute() {
      return answering("看不了房間", async (): Promise<Answer> => {
        const list = await economy.v2.room();
        const lines = list.map((i) =>
          i.placed
            ? `${i.label}(${i.kind_label}):已經在房間裡了`
            : `${i.label}(${i.kind_label}):${i.funded} / ${i.price}`,
        );
        return {
          text: lines.join("\n"),
          data: {
            items: list.map((i) => ({
              id: i.id,
              funded: i.funded,
              price: i.price,
              placed: i.placed,
            })),
          },
        };
      });
    },
  }) as Capability;
}

const FundArgs = z.strictObject({
  item: z.string().trim().min(1).max(32),
  amount: z.number().int().min(1),
});
type FundArgs = z.output<typeof FundArgs>;

/** `economy.fund_room` (tool `fund_room`): the speaker puts coins toward an item. */
export function fundRoomCapability(economy: EconomyService): Capability {
  const c = economy.config;
  const cur = c.currency;
  return defineCapability<FundArgs>({
    name: "economy.fund_room",
    summary: `讓說話的人出${cur}一起佈置她的房間`,
    risk: "medium",
    args: FundArgs,
    permission: null,
    limits: { per_day: 500, per_person_per_day: 20, cooldown_ms: 0 },
    tool: {
      name: "fund_room",
      meta: { effect: "spend", speed: "instant", group: "economy" },
      description:
        `對方明確說要出${cur}幫你佈置房間時用:item 是東西的代號或名字(check_room 看),` +
        `amount 是出多少(一次最多 ${c.room_pledge_max}),花掉就不退。只有文字頻道裡對方本人說了才用,` +
        `不要勸他出錢。${NOT_ON_OWN}`,
      properties: {
        item: { type: "string", description: "東西的代號或名字" },
        amount: {
          type: "integer",
          minimum: 1,
          maximum: c.room_pledge_max,
          description: `出多少${cur}`,
        },
      },
      required: ["item", "amount"],
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(args, ctx) {
      const who = speakerOf(ctx);
      if (who.voice) {
        return refusal(
          "沒有出錢",
          "unconfirmed",
          `語音裡可能聽錯,不能直接花錢;請對方在文字頻道用 ${typedCommand("me room", who.message.context.platform)}`,
        );
      }
      return answering("沒有出成", async (): Promise<Answer> => {
        const r = await economy.v2.fundRoom(
          who.account,
          args.item,
          args.amount,
          messageKey(who.message.context, who.message.id),
        );
        const left = r.item.placed
          ? "湊齊了，已經放進房間"
          : `現在 ${r.item.funded} / ${r.item.price}`;
        return {
          text: `出好了:「${r.item.label}」${r.charged} ${cur},${left}。`,
          data: { done: true, item: r.item.id, charged: r.charged, placed: r.item.placed },
          receipt: receipt(
            "🏠 她的房間",
            `${someone(who.account)} 出了 ${r.charged} ${cur}給「${r.item.label}」`,
            `${left} · 現在有 ${r.balance}`,
          ),
        };
      });
    },
  }) as Capability;
}

/** Every tool of economy 2.0. */
export function v2Capabilities(economy: EconomyService): Capability[] {
  return [
    questsCapability(economy),
    completeQuestCapability(economy),
    predictionsCapability(economy),
    placeBetCapability(economy),
    openPredictionCapability(economy),
    resolvePredictionCapability(economy),
    cancelPredictionCapability(economy),
    roomCapability(economy),
    fundRoomCapability(economy),
  ];
}
