// Economy 2.0 on the member page (docs/design/v5-architecture.md §9.4), in the `wallet` group: the
// session's person and nobody else's.
//
// * `GET /api/member/quests`: today's three quests. The first look of the day has her think of the
//   one she picks for them (`QuestPickerKey`, `quest-words.ts`); someone she does not know reads
//   no quests.
// * `GET /api/member/predictions` (`?space=`): what is open to stake on in a server they are in
//   (their own by default) and what was settled lately there, how each settles and who settled it
//   (never which operator), and their own stake. Someone who is a member nowhere reads the primary
//   server's, and a bet of theirs is refused with the reason.
// * `POST /api/member/bet` `{ prediction, option, amount }` with an `Idempotency-Key`: a stake;
//   the economy's refusals are their status and sentence, as in Discord.
//
// Read through `Economy2Key` (the economy module); without it, a 503 that names it. Responses are
// built field by field.

import type { QuestsView } from "@miyoria/economy";
import { type AccountRef, PlacesKey } from "@miyoria/types";
import { os } from "./contract.js";
import { economyView, predictionView } from "./economy.js";
import { ApiError } from "./errors.js";
import type { SessionRecord } from "./session.js";
import { memberPerson, memberSpace } from "./space-param.js";
import type { ApiContext, ApiState } from "./state.js";
import { keyOf } from "./wallet.js";

function accountOf(c: ApiContext): AccountRef {
  return (c.get("member") as SessionRecord).account;
}

/** The economy's refusals keep their status and words; anything else reads as unavailable. */
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") throw new ApiError(status, (error as Error).message);
    throw ApiError.unavailable("economy module (economy 2.0) is not available");
  }
}

/** A quests view field by field, with the currency. */
export function questsView(currency: string, v: QuestsView) {
  return {
    currency,
    quests: v.quests.map((q) => ({
      id: q.id,
      label: q.label,
      hint: q.hint,
      done: q.done,
      by: q.by,
    })),
    reward: v.reward,
    bonus: v.bonus,
    bonus_done: v.bonus_done,
    earned_today: v.earned_today,
    cap: v.cap,
  };
}

/**
 * The servers a member list covers: the one `requested` names or their own (`memberSpace`: 404,
 * 403); `undefined` (no filter) on a Core without identity's places or with no server at all.
 */
export async function memberSpaces(
  state: ApiState,
  c: ApiContext,
  requested: string | undefined,
): Promise<string[] | undefined> {
  const places = state.optional(PlacesKey);
  if (places === undefined) return undefined;
  if (requested == null && places.spaces().length === 0) return undefined;
  return [memberSpace(state, await memberPerson(state, c), requested).id];
}

/** Joins `walletRpc` (`wallet.ts`): served only while the public side is on. */
export const walletPlayRpc = {
  quests: os.wallet.quests.handler(async ({ context: { state, c } }) => {
    const v2 = economyView(state);
    return questsView(v2.currency, await guard(() => v2.quests(accountOf(c), { pick: true })));
  }),
  predictions: os.wallet.predictions.handler(async ({ input, context: { state, c } }) => {
    const v2 = economyView(state);
    const spaces = await memberSpaces(state, c, input?.query.space);
    const list = await guard(() => v2.predictions(accountOf(c), spaces));
    return { currency: v2.currency, predictions: list.map((p) => predictionView(p, false)) };
  }),
  bet: os.wallet.bet.handler(async ({ input, context: { state, c } }) => {
    const v2 = economyView(state);
    const key = `web:${keyOf(input.headers["idempotency-key"])}`;
    const { prediction, option, amount } = input.body;
    const r = await guard(() => v2.placeBet(accountOf(c), prediction, option, amount, key));
    return {
      prediction: r.prediction,
      question: r.question,
      option: r.option,
      amount: r.amount,
      balance: r.balance,
      duplicate: r.duplicate,
    };
  }),
};
