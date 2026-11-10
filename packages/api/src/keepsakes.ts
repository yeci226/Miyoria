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
  type KeepsakeCards,
  type KeepsakeFortune,
  type KeepsakeResult,
  type Keepsakes,
  type KeepsakeWho,
} from "@miyoria/types";
import { canIssue, issueCard, memberCards, posesFor } from "./card.js";
import { ApiError } from "./errors.js";
import { drawFortune, fortuneTodayOf } from "./fortune-routes.js";
import { cardHolder, cardView, cardWords, loadMemberOf, namesFor } from "./member.js";
import type { ApiState } from "./state.js";

const log = getLogger("api.keepsakes");

const BUSY = "太頻繁了,請稍後再試";
const FAILED = "現在沒辦法,請稍後再試";

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
    return { latest: cards.latest, today: cards.today, per_day: cards.per_day };
  }

  async issueCard(who: KeepsakeWho, key: string): Promise<KeepsakeResult<KeepsakeCard>> {
    const { state } = this;
    try {
      const member = await loadMemberOf(state, who.account);
      const names = member.hidden ? null : await namesFor(state, member);
      const holder = cardHolder(who, member);
      const view = cardView(state, member, names);
      const card = await issueCard(
        state,
        holder,
        view,
        async () =>
          (await canIssue(state, holder))
            ? cardWords(state, who.name, member, view, posesFor(view.affinity))
            : null,
        { pose: null, foil: false, key },
      );
      const actor = accountRefString(who.account);
      await state.auditAs(actor, "member.card", actor, { serial: card.serial }, true);
      const balance = await state
        .optional(EconomyKey)
        ?.wallet(who.account)
        .then((w) => w.balance)
        .catch(() => null);
      return { ok: true, value: card, charged: 0, balance: balance ?? null };
    } catch (error) {
      return refused(error);
    }
  }
}
