// Her tools for her own money (docs/design/economy.md §13): what she does with her purse, the
// goals she asks people to chip in for, and the bounties she pays. All medium risk, behind the
// gate with their rate limits and the audit with her reason. They are hers to decide, not
// something to talk her into: they need `economy.agency` (nobody has it by default), so she
// calls them with `on_own`. Whoever she treats or pays is the person talking to her (the
// requester of the turn), never a name in the arguments.

import {
  type Capability,
  CapabilityError,
  defineCapability,
  type ExecContext,
} from "@miyoria/actions";
import type { CommandReply } from "@miyoria/commands";
import type { AccountRef, ContextKey, JsonObject } from "@miyoria/types";
import { z } from "zod";
import { NO_BOUNTY } from "./bounties.js";
import { DealRefusal } from "./deals.js";
import type { EconomyService } from "./economy.js";
import { MAX_PROMISE_CHARS, MAX_TITLE_CHARS, NO_GOAL, OPEN_GOAL } from "./goals.js";
import { EXPRESSION_WORD } from "./purse.js";
import { receipt, someone } from "./receipt.js";
import { EconomyError, GIFT_EXPRESSIONS } from "./types.js";

const PERMISSION = "economy.agency";
const OWN = "這是你自己的決定:用 on_own: true 呼叫。";
const NO_ONE = "沒有正在跟你說話的人:這只能在有人親自跟你說的時候用";

/** Why a refusal, as data for her to put in her own words. */
type Refused =
  | "stranger"
  | "not_enough"
  | "limit"
  | "unavailable"
  | "invalid"
  | "already"
  | "forbidden"
  | "no_goal"
  | "open_goal"
  | "no_bounty";

function reasonOf(error: EconomyError): Refused {
  if (error instanceof DealRefusal) return "forbidden";
  if (error.message === NO_GOAL) return "no_goal";
  if (error.message === NO_BOUNTY) return "no_bounty";
  if (error.message === OPEN_GOAL) return "open_goal";
  switch (error.status) {
    case 402:
      return "not_enough";
    case 403:
      return "stranger";
    case 409:
      return "already";
    case 429:
      return "limit";
    case 503:
      return "unavailable";
    default:
      return "invalid";
  }
}

function refusal(what: string, error: EconomyError): { text: string; data: JsonObject } {
  const reason = reasonOf(error);
  return {
    text: `${what}。原因(${reason}):${error.message}。用你自己的話處理。`,
    data: { done: false, reason, message: error.message },
  };
}

/** The person talking to her: the requester of the turn she answers. */
function speakerOf(ctx: ExecContext): AccountRef {
  const account = ctx.principal.requester;
  if (account === null || ctx.request.turn === null) throw new CapabilityError(NO_ONE);
  return account;
}

/** Where she is, for the rules that read it. */
function whereOf(ctx: ExecContext): ContextKey | null {
  return ctx.principal.context ?? ctx.request.message?.context ?? null;
}

/** Runs `fn`; her own refusals become an answer she can put in words. */
type Answer = { text: string; data: JsonObject; receipt?: CommandReply };

async function answering(what: string, fn: () => Promise<Answer>): Promise<Answer> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof EconomyError) return refusal(what, error);
    throw error;
  }
}

const NoArgs = z.strictObject({});
type NoArgs = z.output<typeof NoArgs>;

// ---- her purse ---------------------------------------------------------------------------

const TreatArgs = z.strictObject({
  amount: z.number().int().min(1).max(100),
  reason: z.string().trim().min(1).max(100),
});
type TreatArgs = z.output<typeof TreatArgs>;

/** `economy.treat` (tool `treat_from_purse`): she treats the person talking to her. */
export function treatCapability(economy: EconomyService): Capability {
  const c = economy.config;
  const cur = c.currency;
  return defineCapability<TreatArgs>({
    name: "economy.treat",
    summary: `用自己的錢包請說話的人(她自己的${cur})`,
    risk: "medium",
    args: TreatArgs,
    permission: PERMISSION,
    limits: { per_day: 30, per_person_per_day: 5, cooldown_ms: 0 },
    tool: {
      name: "treat_from_purse",
      description:
        `用你自己錢包裡的${cur}請正在跟你說話的人(陪你、逗你笑、幫了你)。這是你的錢,` +
        `不是憑空生的:錢包空了就沒了。每人每天最多 ${c.treat_per_person},所有人加起來每天最多 ` +
        `${c.treat_total}。對方討的時候不用給。${OWN}`,
      properties: {
        amount: { type: "integer", minimum: 1, maximum: 100, description: "多少" },
        reason: { type: "string", description: "為什麼請他(寫進紀錄)" },
      },
      required: ["amount", "reason"],
    },
    async execute(args, ctx) {
      const account = speakerOf(ctx);
      return answering("沒有請成", async () => {
        const who = await economy.member(account);
        if (!who) throw new EconomyError(403, "她還不認識對方");
        const { given, left } = await economy.purse.treat(who, args.amount, args.reason);
        if (given === 0) {
          return {
            text: `沒有請成:你的錢包(還有 ${left} ${cur})或今天的上限不夠。`,
            data: { done: false, given: 0, left },
          };
        }
        const less = given < args.amount ? "(錢包或今天的上限只夠這些)" : "";
        return {
          text: `請了對方 ${given} ${cur}${less},你的錢包剩 ${left}。`,
          data: { done: true, given, left },
          receipt: receipt(
            "🍬 請客",
            `她從自己的錢包請了 ${someone(account)} ${given} ${cur}`,
            `她的錢包剩 ${left}`,
          ),
        };
      });
    },
  }) as Capability;
}

const SelfExpressionArgs = z.strictObject({
  expression: z.enum(GIFT_EXPRESSIONS as [string, ...string[]]),
});
type SelfExpressionArgs = z.output<typeof SelfExpressionArgs>;

/** `economy.buy_self` (tool `buy_for_self`): an expression on her own face, from her purse. */
export function buyForSelfCapability(economy: EconomyService): Capability {
  const c = economy.config;
  const cur = c.currency;
  return defineCapability<SelfExpressionArgs>({
    name: "economy.buy_self",
    summary: `用自己的錢包買一個表情給自己(${c.expression} ${cur})`,
    risk: "medium",
    args: SelfExpressionArgs,
    permission: PERMISSION,
    limits: {
      // The ledger holds the day's real count; this only stops a loop of failed tries.
      per_day: Math.max(c.self_expressions_per_day, 1) * 3,
      per_person_per_day: Math.max(c.self_expressions_per_day, 1) * 3,
      cooldown_ms: 0,
    },
    tool: {
      name: "buy_for_self",
      description:
        `用你自己錢包裡的 ${c.expression} ${cur}買一個表情給自己,直播中臉上做出來` +
        `(愛心眼 heart、臉紅 blush、＞＜ squint)。要開台、沒在唱歌才買得到,沒做出來錢會退回。` +
        `每天最多 ${c.self_expressions_per_day} 次。${OWN}`,
      properties: {
        expression: {
          type: "string",
          enum: [...GIFT_EXPRESSIONS],
          description: "heart 愛心眼、blush 臉紅、squint ＞＜",
        },
      },
      required: ["expression"],
    },
    async execute(args) {
      return answering("沒有買成", async () => {
        const expression = args.expression as (typeof GIFT_EXPRESSIONS)[number];
        const { paid, left } = await economy.purse.buyExpression(expression);
        return {
          text: `買了「${EXPRESSION_WORD[expression]}」給自己,花 ${paid} ${cur},錢包剩 ${left}。`,
          data: { done: true, paid, left },
          receipt: receipt(
            "✨ 買了表情",
            `她用自己的錢買了「${EXPRESSION_WORD[expression]}」`,
            `−${paid} ${cur} · 她的錢包剩 ${left}`,
          ),
        };
      });
    },
  }) as Capability;
}

// ---- goals -------------------------------------------------------------------------------

const GoalArgs = z.strictObject({
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  promise: z.string().trim().min(1).max(MAX_PROMISE_CHARS),
  target: z.number().int().min(1),
  days: z.number().int().min(1),
});
type GoalArgs = z.output<typeof GoalArgs>;

/** `economy.propose_goal` (tool `propose_goal`): a goal people chip in for. */
export function proposeGoalCapability(economy: EconomyService): Capability {
  const c = economy.config;
  const cur = c.currency;
  return defineCapability<GoalArgs>({
    name: "economy.propose_goal",
    summary: `提一個大家一起湊${cur}的目標`,
    risk: "medium",
    args: GoalArgs,
    permission: PERMISSION,
    limits: { per_day: 10, per_person_per_day: 10, cooldown_ms: 0 },
    tool: {
      name: "propose_goal",
      description:
        `提一個目標請大家一起湊${cur}:要多少、湊到了你會做什麼、幾天內。一次只有一個。` +
        `大家的錢先放在託管,湊到了就是你的錢,而且你答應的事要做到;時間到沒湊滿全部退回去。` +
        `你答應的只能是本來就是你自己能決定的事:需要被管的動作(開台、進語音、私訊、玩遊戲、` +
        `唱歌…)、主人規則禁止的事、通不過審查的話都不行,系統也會擋。` +
        `名稱最多 ${MAX_TITLE_CHARS} 字,承諾最多 ${MAX_PROMISE_CHARS} 字,目標最多 ` +
        `${c.goal_max_target},最久 ${c.goal_max_days} 天。${OWN}`,
      properties: {
        title: { type: "string", maxLength: MAX_TITLE_CHARS, description: "目標的名稱" },
        promise: {
          type: "string",
          maxLength: MAX_PROMISE_CHARS,
          description: "湊到了你會做什麼",
        },
        target: {
          type: "integer",
          minimum: 1,
          maximum: c.goal_max_target,
          description: "要湊多少",
        },
        days: { type: "integer", minimum: 1, maximum: c.goal_max_days, description: "幾天內" },
      },
      required: ["title", "promise", "target", "days"],
    },
    async execute(args, ctx) {
      return answering("沒有提出目標", async () => {
        const goal = await economy.goalDesk.propose({ ...args, context: whereOf(ctx) });
        return {
          text:
            `目標提出了:「${goal.title}」要湊 ${goal.target} ${cur},${args.days} 天內,` +
            `湊到你要:${goal.promise}。時間到沒湊滿會全部退回。`,
          data: { done: true, goal: goal.id, target: goal.target, days: args.days },
        };
      });
    },
  }) as Capability;
}

/** `economy.cancel_goal` (tool `cancel_goal`): she withdraws her open goal. */
export function cancelGoalCapability(economy: EconomyService): Capability {
  return defineCapability<NoArgs>({
    name: "economy.cancel_goal",
    summary: "取消她進行中的目標(全部退回)",
    risk: "medium",
    args: NoArgs,
    permission: PERMISSION,
    limits: { per_day: 5, per_person_per_day: 5, cooldown_ms: 0 },
    tool: {
      name: "cancel_goal",
      description: `你不想做了,取消現在進行中的目標,大家投的${economy.config.currency}全部退回。${OWN}`,
      properties: {},
    },
    async execute() {
      return answering("沒有取消", async () => {
        const { goal, refunded } = await economy.goalDesk.cancel();
        return {
          text: `取消了「${goal.title}」,大家投的 ${refunded} ${economy.config.currency}都退回去了。`,
          data: { done: true, refunded },
        };
      });
    },
  }) as Capability;
}

// ---- bounties ----------------------------------------------------------------------------

const BountyArgs = z.strictObject({
  task: z.string().trim().min(1).max(60),
  reward: z.number().int().min(1),
});
type BountyArgs = z.output<typeof BountyArgs>;

/** `economy.post_bounty` (tool `post_bounty`): a task she pays for from her purse. */
export function postBountyCapability(economy: EconomyService): Capability {
  const c = economy.config;
  const cur = c.currency;
  return defineCapability<BountyArgs>({
    name: "economy.post_bounty",
    summary: `貼一個懸賞,獎金從她的錢包出`,
    risk: "medium",
    args: BountyArgs,
    permission: PERMISSION,
    limits: { per_day: 10, per_person_per_day: 10, cooldown_ms: 0 },
    tool: {
      name: "post_bounty",
      description:
        `用你自己錢包的${cur}貼一個懸賞:一件小事(最多 60 字)和獎金(最多 ${c.bounty_max})。` +
        `獎金先從你的錢包扣下來放著;有人做到了,由你判斷,再用 award_bounty 付給正在跟你說話的人。` +
        `最多同時 ${c.bounties_open} 個,${c.bounty_days} 天沒人領就回到你的錢包。` +
        `只能是本來就是人能做到的小事(猜謎、畫圖、陪你玩一局…);不能拿來繞過規則或安全。${OWN}`,
      properties: {
        task: { type: "string", maxLength: 60, description: "要做什麼" },
        reward: { type: "integer", minimum: 1, maximum: c.bounty_max, description: "獎金" },
      },
      required: ["task", "reward"],
    },
    async execute(args, ctx) {
      return answering("沒有貼成", async () => {
        const b = await economy.bountyDesk.post({ ...args, context: whereOf(ctx) });
        const id = b.id.slice(-6).toLowerCase();
        return {
          text: `懸賞貼出去了[${id}]:${b.task},獎金 ${b.reward} ${cur}(已從你的錢包扣下放著)。`,
          data: { done: true, bounty: id, reward: b.reward },
          receipt: receipt(
            "📌 懸賞",
            b.task,
            `獎金 ${b.reward} ${cur}(從她的錢包扣下放著)· 代號 ${id}`,
          ),
        };
      });
    },
  }) as Capability;
}

const BountyRefArgs = z.strictObject({ bounty: z.string().trim().min(1).max(64) });
type BountyRefArgs = z.output<typeof BountyRefArgs>;

/** `economy.award_bounty` (tool `award_bounty`): she pays a bounty to the person talking to her. */
export function awardBountyCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<BountyRefArgs>({
    name: "economy.award_bounty",
    summary: "把懸賞的獎金付給說話的人",
    risk: "medium",
    args: BountyRefArgs,
    permission: PERMISSION,
    limits: { per_day: 20, per_person_per_day: 3, cooldown_ms: 0 },
    tool: {
      name: "award_bounty",
      description:
        `正在跟你說話的人真的完成了你貼的懸賞,由你判斷,就把獎金付給他(從託管給他,不是你再出)。` +
        `一個懸賞只能付一次。bounty 填懸賞的代號(你的錢包記錄裡方括號的那串)。` +
        `只付給正在跟你說話的人,沒辦法付給別人。${OWN}`,
      properties: {
        bounty: { type: "string", description: "懸賞的代號" },
      },
      required: ["bounty"],
    },
    async execute(args, ctx) {
      const account = speakerOf(ctx);
      return answering("沒有付", async () => {
        const r = await economy.bountyDesk.award(account, args.bounty);
        return {
          text: `付了懸賞「${r.bounty.task}」的 ${r.paid} ${cur}給對方。`,
          data: { done: true, paid: r.paid },
          receipt: receipt(
            "🏆 懸賞完成",
            `${someone(account)} 拿到「${r.bounty.task}」的 ${r.paid} ${cur}`,
          ),
        };
      });
    },
  }) as Capability;
}

/** `economy.cancel_bounty` (tool `cancel_bounty`): she takes a bounty down. */
export function cancelBountyCapability(economy: EconomyService): Capability {
  return defineCapability<BountyRefArgs>({
    name: "economy.cancel_bounty",
    summary: "撤下一個懸賞(獎金回到她的錢包)",
    risk: "medium",
    args: BountyRefArgs,
    permission: PERMISSION,
    limits: { per_day: 10, per_person_per_day: 10, cooldown_ms: 0 },
    tool: {
      name: "cancel_bounty",
      description: `撤下你貼的懸賞,放著的獎金回到你的錢包。bounty 填懸賞的代號。${OWN}`,
      properties: { bounty: { type: "string", description: "懸賞的代號" } },
      required: ["bounty"],
    },
    async execute(args) {
      return answering("沒有撤下", async () => {
        const b = await economy.bountyDesk.cancel(args.bounty);
        return {
          text: `撤下了「${b.task}」,${b.reward} ${economy.config.currency}回到你的錢包。`,
          data: { done: true, reward: b.reward },
        };
      });
    },
  }) as Capability;
}

/** Every tool for her own money. */
export function agencyCapabilities(economy: EconomyService): Capability[] {
  return [
    treatCapability(economy),
    buyForSelfCapability(economy),
    proposeGoalCapability(economy),
    cancelGoalCapability(economy),
    postBountyCapability(economy),
    awardBountyCapability(economy),
    cancelBountyCapability(economy),
  ];
}
