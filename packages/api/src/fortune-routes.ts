// The fortune routes (docs/design/economy.md §13), on the member page:
//
// * `GET /api/member/fortune`: today's slip or `null`, and what one costs.
// * `POST /api/member/fortune` `{}` (with an `Idempotency-Key`): pays for today's slip, she writes it,
//   and it is kept; once per local day. She cannot write now (no model, a failure, nothing usable)
//   and the payment is given back, 503. Asking again after a slip exists answers that slip, charging
//   nothing.
//
// A retry with the key of an attempt that did not finish finds its charge already made: it is given
// back and the answer is 409, so a key never buys a slip twice and never gives one away.
// Only a person she knows and has not blocked may draw (403, as everywhere); the slip is built
// from what the page shows them (`fortune.ts`).

import type { IssuedFortune } from "@miyoria/contracts/api";
import { EconomyError, EconomyKey, FortuneStoreKey, STRANGER } from "@miyoria/economy";
import { LlmRouterKey } from "@miyoria/llm/llm";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { type AccountRef, accountRefString } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { type FortuneHolder, fortuneOfDay, keepFortune, writeFortune } from "./fortune.js";
import {
  accountsOf,
  cardView,
  loadMemberOf,
  type MemberContext,
  namesFor,
  shown,
  shownMemories,
} from "./member.js";
import { localDay } from "./public.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";
import { keyOf } from "./wallet.js";

const log = getLogger("api.fortune");

const NO_FORTUNE = "現在抽不了籤";
const WRITE_FAILED = "她現在寫不出來,魚幣已經退回";
const UNFINISHED = "上次抽籤沒有完成,魚幣已經退回,請再抽一次";
/** Memories she is shown for a slip at most. */
const MEMORIES_SHOWN = 5;

const session = (c: ApiContext): SessionRecord => c.get("member");

function holderOf(account: AccountRef, who: MemberContext): FortuneHolder {
  return { account, accounts: accountsOf(who), person: who.person?.id ?? null };
}

const today = (state: ApiState): number =>
  localDay(state.now(), state.publicSide.config.utc_offset_minutes);

/** Today's slip of `account` or `null`, and what drawing one costs. */
export async function fortuneTodayOf(
  state: ApiState,
  account: AccountRef,
): Promise<{ fortune: IssuedFortune | null; price: number }> {
  const who = await loadMemberOf(state, account);
  const economy = state.optional(EconomyKey);
  const found = who.hidden ? null : await fortuneOfDay(state, holderOf(account, who), today(state));
  return { fortune: found, price: economy?.price("fortune").price ?? 0 };
}

async function draw(
  state: ApiState,
  c: ApiContext,
  idempotencyKey: string | undefined,
): Promise<FortuneDrawn> {
  const key = keyOf(idempotencyKey);
  const { account, name } = session(c);
  // Each draw asks a model: the same hourly allowance as the other heavy things.
  const wait = state.publicSide.admitHeavy(`fortune:${accountRefString(account)}`);
  if (wait !== null) throw ApiError.tooMany(wait);
  return drawFortune(state, { account, name }, key);
}

/** What a draw answers (`POST /api/member/fortune`). */
export interface FortuneDrawn {
  fortune: IssuedFortune;
  charged: number;
  balance: number;
}

/**
 * Pays for today's slip, has it written and keeps it; refusals are `ApiError`s with the words to
 * show. Shared by the route and by the Discord command (`KeepsakesKey`).
 */
export async function drawFortune(
  state: ApiState,
  { account, name }: { account: AccountRef; name: string },
  key: string,
): Promise<FortuneDrawn> {
  const actor = accountRefString(account);
  const economy = state.optional(EconomyKey);
  if (!economy || !state.optional(FortuneStoreKey) || !state.optional(LlmRouterKey)) {
    throw ApiError.unavailable(NO_FORTUNE);
  }
  const who = await loadMemberOf(state, account);
  if (who.hidden || who.person === null) throw new ApiError(403, STRANGER);
  const holder = holderOf(account, who);
  const day = today(state);

  const had = await fortuneOfDay(state, holder, day);
  if (had) {
    return { fortune: had, charged: 0, balance: (await economy.wallet(account)).balance };
  }

  let bought: Awaited<ReturnType<typeof economy.purchase>>;
  try {
    bought = await economy.purchase(account, "fortune", key);
  } catch (error) {
    if (error instanceof EconomyError) throw new ApiError(error.status, error.message);
    throw error;
  }
  if (bought.duplicate) {
    await economy.refund(account, bought.entry_id).catch(() => false);
    throw new ApiError(409, UNFINISHED);
  }

  const give = async (): Promise<never> => {
    await economy.refund(account, bought.entry_id).catch((error: unknown) => {
      log.warn({ error: errorMessage(error) }, "cannot give a fortune's payment back");
      return false;
    });
    throw ApiError.unavailable(WRITE_FAILED);
  };

  const names = await namesFor(state, who);
  const memories = (await shownMemories(state, who, names)).slice(0, MEMORIES_SHOWN);
  let slip: Awaited<ReturnType<typeof writeFortune>> = null;
  try {
    slip = await writeFortune(
      state,
      {
        name,
        view: cardView(state, who, names),
        memories: memories.map((m) => m.text),
        date: new Date(state.now() + state.publicSide.config.utc_offset_minutes * 60_000)
          .toISOString()
          .slice(0, 10),
      },
      (text) => shown(state, text, names),
    );
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "writing a fortune failed");
  }
  if (slip === null) return give();

  let kept: Awaited<ReturnType<typeof keepFortune>> = null;
  try {
    kept = await keepFortune(state, holder, day, bought.entry_id, slip);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot keep a fortune");
    return give();
  }
  if (kept === null) {
    // Another request kept today's slip first: theirs stands, this payment goes back.
    await economy.refund(account, bought.entry_id).catch(() => false);
    const standing = await fortuneOfDay(state, holder, day);
    if (standing === null) throw ApiError.unavailable(NO_FORTUNE);
    return {
      fortune: standing,
      charged: 0,
      balance: (await economy.wallet(account)).balance,
    };
  }
  await state.auditAs(actor, "member.fortune", actor, { id: kept.id, rank: kept.rank }, true);
  return { fortune: kept, charged: bought.charged, balance: bought.balance };
}

/**
 * The fortune routes; served only while the public side is on (see `rpc.ts`). The draw's body must
 * be `{}`: nothing a request says reaches the slip.
 */
export const fortuneRpc = {
  today: os.fortune.today.handler(({ context: { state, c } }) => {
    return fortuneTodayOf(state, session(c).account);
  }),
  draw: os.fortune.draw.handler(({ input, context: { state, c } }) => {
    return draw(state, c, input.headers["idempotency-key"]);
  }),
};
