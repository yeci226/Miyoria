// `KeepsakesKey`: cards and fortune slips for a command in Discord (docs/design/v4-plan.md §9.3).
//
// The same functions the member routes call, with the same checks (a stranger or a blocked person
// is answered as before, the day limit, the price, the refund), only the caller is an account and
// a name instead of a web session. A refusal is turned into words here so the command never sees
// an exception.

import type { IssuedCard } from "@miyoria/contracts/api";
import { EconomyKey, STRANGER } from "@miyoria/economy";
import { CARD_TEXTS, CardsKey } from "@miyoria/play/cards";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  accountRefString,
  type KeepsakeCard,
  type KeepsakeCardBook,
  type KeepsakeCardImage,
  type KeepsakeCardOrder,
  type KeepsakeCards,
  type KeepsakeFortune,
  type KeepsakeOdds,
  type KeepsakeResult,
  type Keepsakes,
  type KeepsakeWho,
  sameAccount,
} from "@miyoria/types";
import { claimDropCard, issueDaily, memberCards, publicCard } from "./card.js";
import { keepsakeFor } from "./card-faces.js";
import { cardOdds } from "./cards-routes.js";
import { ApiError } from "./errors.js";
import { drawFortune, fortuneTodayOf } from "./fortune-routes.js";
import {
  cardHolder,
  cardView,
  cardWords,
  loadMemberOf,
  type MemberContext,
  namesFor,
} from "./member.js";
import { cardPng } from "./og.js";
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
    const given = await keepsakeFor(this.state, who, nameOf(who, account), null);
    const holder = cardHolder({ account, name: "", avatar_url: null }, who);
    const cards = await memberCards(this.state, holder);
    return {
      latest: cards.latest ? keepsakeCard(cards.latest) : null,
      today: cards.today,
      per_day: cards.per_day,
      prices: { card: cards.prices.card, foil: cards.prices.foil },
      pity: cards.pity,
      ...(given === null ? {} : { keepsake: keepsakeCard(given) }),
    };
  }

  async issueCard(
    who: KeepsakeWho,
    key: string,
    order: KeepsakeCardOrder = {},
  ): Promise<KeepsakeResult<KeepsakeCard>> {
    const { state } = this;
    const foil = order.foil === true;
    try {
      const member = await loadMemberOf(state, who.account);
      const names = member.hidden ? null : await namesFor(state, member);
      const holder = cardHolder(who, member);
      const view = cardView(state, member, names);
      const { card, charged } = await issueDaily(
        state,
        holder,
        view,
        () => cardWords(state, who.name, member, view),
        { foil, key },
        member.hidden,
      );
      const actor = accountRefString(who.account);
      await state.auditAs(actor, "member.card", actor, { serial: card.serial }, true);
      const balance = await state
        .optional(EconomyKey)
        ?.wallet(who.account)
        .then((w) => w.balance)
        .catch(() => null);
      return { ok: true, value: keepsakeCard(card), charged, balance: balance ?? null };
    } catch (error) {
      return refused(error);
    }
  }

  async claimDrop(who: KeepsakeWho, drop: string): Promise<KeepsakeResult<KeepsakeCard>> {
    const { state } = this;
    try {
      const member = await loadMemberOf(state, who.account);
      const names = member.hidden ? null : await namesFor(state, member);
      const view = cardView(state, member, names);
      const card = await claimDropCard(
        state,
        cardHolder(who, member),
        view,
        () => cardWords(state, who.name, member, view),
        drop,
        member.hidden,
      );
      const actor = accountRefString(who.account);
      await state.auditAs(actor, "member.card.drop", actor, { serial: card.serial, drop }, true);
      return { ok: true, value: keepsakeCard(card), charged: 0, balance: null };
    } catch (error) {
      return refused(error);
    }
  }

  async cardImage(serial: string): Promise<KeepsakeCardImage | null> {
    try {
      const card = await publicCard(this.state, serial);
      if (card === null) return null;
      const data = await cardPng(this.state, card);
      return { name: `miyoria-card-${card.serial}.png`, data, contentType: "image/png" };
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot draw a card for a chat reply");
      return null;
    }
  }

  async cardBook(account: AccountRef): Promise<KeepsakeResult<KeepsakeCardBook>> {
    const cards = this.state.optional(CardsKey);
    if (!cards) return { ok: false, status: 503, message: FAILED };
    try {
      const member = await loadMemberOf(this.state, account);
      await keepsakeFor(this.state, member, nameOf(member, account), null);
      const person = member.person?.id ?? null;
      const pity = person
        ? cards.pity(person)
        : { since: 0, pity: cards.config.pity, until: cards.config.pity };
      if (person === null) {
        return {
          ok: true,
          value: {
            series: [],
            parts: { owned: 0, total: 0 },
            titles: [],
            legacy: [],
            pity,
            wishlist: [],
          },
          charged: 0,
          balance: null,
        };
      }
      const dex = cards.dex(person);
      const catalogue = cards.catalogue();
      const byId = new Map(catalogue.map((p) => [p.id, p.name]));
      const collectable = catalogue.filter((p) => p.enabled && !p.blank && !p.drop_only);
      return {
        ok: true,
        value: {
          series: dex.series.map((s) => ({
            name: s.name,
            owned: s.owned,
            total: s.total,
            title: s.title,
            complete: s.complete,
          })),
          parts: { owned: dex.parts.length, total: collectable.length },
          titles: dex.titles.map((t) => t.title),
          legacy: dex.legacy.items.map((i) => ({ name: i.name, count: i.count })),
          pity,
          wishlist: cards.wishlist(person).map((id) => byId.get(id) ?? id),
        },
        charged: 0,
        balance: null,
      };
    } catch (error) {
      return refused(error);
    }
  }

  async cardOdds(): Promise<KeepsakeOdds | null> {
    const cards = this.state.optional(CardsKey);
    if (!cards) return null;
    const odds = cardOdds(cards);
    return {
      rarities: odds.rarities.map((r) => ({ rarity: r.rarity, shown: r.shown })),
      pity_after: odds.pity?.after ?? null,
      price: odds.price,
      per_day: odds.per_day,
      slots: odds.slots.map((s) => ({
        name: s.name,
        parts: s.parts.map((p) => ({ name: p.name, rarity: p.rarity, shown: p.shown })),
      })),
    };
  }

  async setCardWishlist(
    who: KeepsakeWho,
    parts: readonly string[],
  ): Promise<KeepsakeResult<string[]>> {
    const cards = this.state.optional(CardsKey);
    if (!cards) return { ok: false, status: 503, message: FAILED };
    try {
      const member = await loadMemberOf(this.state, who.account);
      const person = member.person?.id ?? null;
      if (person === null) return { ok: false, status: 403, message: STRANGER };
      const catalogue = cards.catalogue();
      const ids: string[] = [];
      for (const asked of parts) {
        const want = asked.trim();
        // Typed in chat: full-width brackets and spaces read as the catalogue's own.
        const plain = want.normalize("NFKC");
        const part = catalogue.find(
          (p) => !p.blank && (p.id === want || p.name.normalize("NFKC") === plain),
        );
        if (!part) return { ok: false, status: 400, message: `${CARD_TEXTS.unknown_part}:${want}` };
        ids.push(part.id);
      }
      const problem = cards.setWishlist(person, ids);
      if (problem !== null) return { ok: false, status: 400, message: CARD_TEXTS[problem] };
      const names = new Map(catalogue.map((p) => [p.id, p.name]));
      return {
        ok: true,
        value: cards.wishlist(person).map((id) => names.get(id) ?? id),
        charged: 0,
        balance: null,
      };
    } catch (error) {
      return refused(error);
    }
  }
}

/** The name `account` was last seen with, for a card given with no command name to hand. */
function nameOf(who: MemberContext, account: AccountRef): string {
  const seen = who.person?.accounts.find((a) => sameAccount(a.account, account));
  return seen?.display_name ?? who.person?.display_name ?? "";
}

/** A card as a chat reply shows it. */
function keepsakeCard(card: IssuedCard): KeepsakeCard {
  return {
    serial: card.serial,
    number: card.number,
    issued_at: card.issued_at,
    relationship: card.relationship,
    line: card.line,
    stamp: card.stamp,
    fields: card.fields,
    foil: card.foil,
    rarity: card.rarity,
    parts: card.parts.map((p) => p.name),
    expression: card.expression,
    ...(card.kind === undefined ? {} : { kind: card.kind }),
  };
}
