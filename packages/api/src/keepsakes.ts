// `KeepsakesKey`: cards and fortune slips for a command in Discord (docs/design/v4-plan.md §9.3).
//
// The same functions the member routes call, with the same checks (a stranger or a blocked person
// is answered as before, the day limit, the price, the refund), only the caller is an account and
// a name instead of a web session. A refusal is turned into words here so the command never sees
// an exception.

import { EconomyKey } from "@miyoria/economy";
import { errorMessage, getLogger } from "@miyoria/kernel";
import {
  type AccountRef,
  accountRefString,
  type KeepsakeCard,
  type KeepsakeCardOrder,
  type KeepsakeCards,
  type KeepsakeFortune,
  type KeepsakeResult,
  type Keepsakes,
  type KeepsakeWho,
} from "@miyoria/types";
import { canIssue, issueCard, memberCards, posesFor, rerollCard } from "./card.js";
import { ApiError } from "./errors.js";
import { drawFortune, fortuneTodayOf } from "./fortune-routes.js";
import { cardHolder, cardView, cardWords, loadMemberOf, namesFor } from "./member.js";
import type { ApiState } from "./state.js";

const log = getLogger("api.keepsakes");

const BUSY = "太頻繁了,請稍後再試";
const FAILED = "現在沒辦法,請稍後再試";
const NOT_OFFERED = "這個現在不能買";

function refused(error: unknown): { ok: false; status: number; message: string } {
  if (error instanceof ApiError) return { ok: false, status: error.status, message: error.message };
  log.warn({ error: errorMessage(error) }, "a keepsake failed");
  return { ok: false, status: 503, message: FAILED };
}

export class KeepsakeService implements Keepsakes {
  constructor(private readonly state: ApiState) {}

  async fortuneToday(
    account: AccountRef,
  ): Promise<{ fortune: KeepsakeFortune | null; price: number }> {
    return fortuneTodayOf(this.state, account);
  }

  async drawFortune(who: KeepsakeWho, key: string): Promise<KeepsakeResult<KeepsakeFortune>> {
    // Each draw asks a model: the same hourly allowance as on the page.
    const wait = this.state.publicSide.admitHeavy(`fortune:${accountRefString(who.account)}`);
    if (wait !== null) return { ok: false, status: 429, message: BUSY };
    try {
      const drawn = await drawFortune(this.state, who, key);
      return { ok: true, value: drawn.fortune, charged: drawn.charged, balance: drawn.balance };
    } catch (error) {
      return refused(error);
    }
  }

  async cardsToday(account: AccountRef): Promise<KeepsakeCards> {
    const who = await loadMemberOf(this.state, account);
    const holder = cardHolder({ account, name: "", avatar_url: null }, who);
    const cards = await memberCards(this.state, holder, cardView(this.state, who, null));
    return {
      latest: cards.latest,
      today: cards.today,
      per_day: cards.per_day,
      prices: { foil: cards.prices.foil, reroll: cards.prices.reroll },
      rerolls_left: cards.rerolls_left,
    };
  }

  async issueCard(
    who: KeepsakeWho,
    key: string,
    order: KeepsakeCardOrder = {},
  ): Promise<KeepsakeResult<KeepsakeCard>> {
    const foil = order.foil === true;
    return this.#card(who, "member.card", async (state, holder, view, write) => {
      const price = foil ? (await memberCards(state, holder, view)).prices.foil : 0;
      if (price === null) return { card: null, charged: 0 };
      const card = await issueCard(state, holder, view, write(true), { pose: null, foil, key });
      return { card, charged: price };
    });
  }

  async rerollCard(who: KeepsakeWho, key: string): Promise<KeepsakeResult<KeepsakeCard>> {
    return this.#card(who, "member.card.reroll", async (state, holder, view, write) => {
      const price = (await memberCards(state, holder, view)).prices.reroll;
      if (price === null) return { card: null, charged: 0 };
      const card = await rerollCard(state, holder, view, write(false), key);
      return { card, charged: price };
    });
  }

  /**
   * One card issued for `who` by `run`, audited as `action`, with what is left in the wallet.
   * `run` gets her writer (`checked`: only while the day's limit allows a card) and answers
   * `card: null` when the paid extra is not on offer.
   */
  async #card(
    who: KeepsakeWho,
    action: string,
    run: (
      state: ApiState,
      holder: ReturnType<typeof cardHolder>,
      view: ReturnType<typeof cardView>,
      write: (checked: boolean) => () => Promise<Awaited<ReturnType<typeof cardWords>> | null>,
    ) => Promise<{ card: KeepsakeCard | null; charged: number }>,
  ): Promise<KeepsakeResult<KeepsakeCard>> {
    const { state } = this;
    try {
      const member = await loadMemberOf(state, who.account);
      const names = member.hidden ? null : await namesFor(state, member);
      const holder = cardHolder(who, member);
      const view = cardView(state, member, names);
      const write = (checked: boolean) => async () =>
        !checked || (await canIssue(state, holder))
          ? cardWords(state, who.name, member, view, posesFor(view.affinity))
          : null;
      const { card, charged } = await run(state, holder, view, write);
      if (card === null) return { ok: false, status: 503, message: NOT_OFFERED };
      const actor = accountRefString(who.account);
      await state.auditAs(actor, action, actor, { serial: card.serial }, true);
      const balance = await state
        .optional(EconomyKey)
        ?.wallet(who.account)
        .then((w) => w.balance)
        .catch(() => null);
      return { ok: true, value: card, charged, balance: balance ?? null };
    } catch (error) {
      return refused(error);
    }
  }
}
