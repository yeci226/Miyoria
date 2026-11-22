// The fortune slip (docs/design/economy.md §13), on the member page:
//
// * `GET /api/member/fortune`: today's slip or `null`, and what one costs.
// * A slip is drawn only as the paid add-on of the daily check-in (`checkinFortune`, asked with
//   `POST /api/member/checkin { fortune: true }`; Discord's `/me checkin fortune:true` goes through
//   `KeepsakesKey`). It is paid, she writes it and it is kept, once per local day. She cannot
//   write now and the payment is given back, 503. Asking again after a slip exists answers that
//   slip, charging nothing.
//
// A retry with the key of an attempt that did not finish finds its charge already made: it is given
// back and the answer is 409, so a key never buys a slip twice and never gives one away.
// Only a person she knows and has not blocked may draw (403, as everywhere); the slip is built
// from what the page shows them (`fortune.ts`).

import type { IssuedFortune } from "@miyoria/contracts/api";
import { EconomyError, EconomyKey, FortuneStoreKey, STRANGER } from "@miyoria/economy";
import { LlmRouterKey } from "@miyoria/llm/llm";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  accountRefString,
  CharacterKey,
  CurrencyKey,
  DEFAULT_CHARACTER,
  DEFAULT_CURRENCY,
  newId,
} from "@miyoria/types";
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

const log = getLogger("api.fortune");

const NO_FORTUNE = "現在抽不了籤";
/** The slip was not written: the coins (`coin`) went back. */
const writeFailed = (coin: string, her: string) => `${her}現在寫不出來,${coin}已經退回`;
const TOO_OFTEN = "太頻繁了,請稍後再試";
const unfinished = (coin: string) => `上次抽籤沒有完成,${coin}已經退回,請再抽一次`;
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

/** What a draw answers. */
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
  const coin = state.optional(CurrencyKey) ?? DEFAULT_CURRENCY;
  const her = (state.optional(CharacterKey) ?? DEFAULT_CHARACTER).pronoun;
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
    throw new ApiError(409, unfinished(coin));
  }

  const give = async (): Promise<never> => {
    await economy.refund(account, bought.entry_id).catch((error: unknown) => {
      log.warn({ error: errorMessage(error) }, "cannot give a fortune's payment back");
      return false;
    });
    throw ApiError.unavailable(writeFailed(coin, her));
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
        names,
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

/** What the paid add-on of a check-in adds to its answer (`POST /api/member/checkin`). */
export interface CheckinFortune {
  fortune?: IssuedFortune;
  fortune_charged?: number;
  fortune_note?: string;
  /** The balance after the slip's price; absent when nothing was charged. */
  balance?: number;
}

/**
 * The fortune slip asked with a check-in: pays and draws it; a refusal (short of coins, she cannot
 * write now, too often) is a note, never an error, because the check-in itself already stands.
 */
export async function checkinFortune(
  state: ApiState,
  who: { account: AccountRef; name: string },
): Promise<CheckinFortune> {
  const wait = state.publicSide.admitHeavy(`fortune:${accountRefString(who.account)}`);
  if (wait !== null) return { fortune_note: TOO_OFTEN };
  try {
    const drawn = await drawFortune(state, who, `checkin:${newId()}`);
    return {
      fortune: drawn.fortune,
      fortune_charged: drawn.charged,
      balance: drawn.balance,
    };
  } catch (error) {
    if (error instanceof ApiError) return { fortune_note: error.message };
    log.warn({ error: errorMessage(error) }, "a check-in's fortune failed");
    return { fortune_note: NO_FORTUNE };
  }
}

/** The fortune route; served only while the public side is on (see `rpc.ts`). */
export const fortuneRpc = {
  today: os.fortune.today.handler(({ context: { state, c } }) => {
    return fortuneTodayOf(state, session(c).account);
  }),
};
