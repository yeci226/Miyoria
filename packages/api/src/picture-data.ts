// A member's own pictures (docs/design/v5-play.md §11.5), put together from exactly what their
// member page shows them and through the same views (`member.ts`, the keepsakes, the wallet): the
// ring's coarse position and the words for the bond, trust and familiarity, never their numbers;
// their own lines per day, their own song requests, their cards and coins. Someone she does not
// know, or will not show (blocked, no `/me memory`), gets no picture: the command answers in text.

import { EconomyKey, type LedgerLine } from "@miyoria/economy";
import { publicBond } from "@miyoria/heart/person";
import { CardsKey } from "@miyoria/play/cards";
import {
  CurrencyKey,
  DEFAULT_CURRENCY,
  type DexPictureData,
  KeepsakesKey,
  type MemberPictureKind,
  type MemberProfilePicture,
  type OddsPictureData,
  type PersonId,
  type PictureWho,
  type WalletPictureData,
  type WeekPictureData,
} from "@miyoria/types";
import { activity, cardView, loadMemberOf, namesFor, ownSongs } from "./member.js";
import type { MemberPicture } from "./pictures.js";
import { dateOf, localDay } from "./public.js";
import type { ApiState } from "./state.js";

/** Days a week picture covers, today last. */
export const WEEK_DAYS = 7;
const RARITIES = ["N", "R", "SR", "SSR"] as const;
/** Cards read for the counts at most. */
const MAX_CARDS = 500;

/** The local day numbers of the week ending today. */
function weekOf(state: ApiState): { first: number; today: number; offset: number } {
  const offset = state.publicSide.config.utc_offset_minutes;
  const today = localDay(state.now(), offset);
  return { first: today - WEEK_DAYS + 1, today, offset };
}

/** This week's coins in and out, by day and by reason, from their own ledger. */
export function weekLedger(
  ledger: readonly LedgerLine[],
  first: number,
  today: number,
  offset: number,
): Pick<WalletPictureData, "days" | "income" | "spending"> {
  const days = Array.from({ length: today - first + 1 }, (_, i) => ({
    date: dateOf(first + i),
    income: 0,
    spending: 0,
  }));
  const income = new Map<string, number>();
  const spending = new Map<string, number>();
  for (const line of ledger) {
    const ms = Date.parse(line.ts);
    if (!Number.isFinite(ms) || line.delta === 0) continue;
    const day = days[localDay(ms, offset) - first];
    if (day === undefined) continue;
    if (line.delta > 0) {
      day.income += line.delta;
      income.set(line.label, (income.get(line.label) ?? 0) + line.delta);
    } else {
      day.spending -= line.delta;
      spending.set(line.label, (spending.get(line.label) ?? 0) - line.delta);
    }
  }
  const list = (m: Map<string, number>) => [...m].map(([label, amount]) => ({ label, amount }));
  return { days, income: list(income), spending: list(spending) };
}

/** Cards by rarity, lowest first; anything else as 其他. */
function byRarity(rarities: readonly (string | null)[]): { rarity: string; count: number }[] {
  const counts = new Map<string, number>(RARITIES.map((r) => [r, 0]));
  for (const r of rarities) {
    const key = r !== null && counts.has(r) ? r : "其他";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .filter(([r, n]) => n > 0 || (RARITIES as readonly string[]).includes(r))
    .map(([rarity, count]) => ({ rarity, count }));
}

async function odds(state: ApiState, who: PictureWho): Promise<MemberPicture<"odds"> | null> {
  const table = await state.optional(KeepsakesKey)?.cardOdds();
  if (!table) return null;
  const currency =
    (await state.optional(EconomyKey)?.wallet(who.account))?.currency ??
    state.optional(CurrencyKey) ??
    DEFAULT_CURRENCY;
  const data: OddsPictureData = {
    currency,
    price: table.price,
    per_day: table.per_day,
    pity_after: table.pity_after,
    rarities: table.rarities,
    slots: table.slots,
  };
  return { kind: "odds", data, person: null };
}

/** Puts `kind` together for `who`; `null` when they may not have it or it has nothing to draw. */
export async function memberPicture(
  state: ApiState,
  who: PictureWho,
  kind: MemberPictureKind,
): Promise<MemberPicture | null> {
  if (kind === "odds") return odds(state, who);
  const member = await loadMemberOf(state, who.account);
  if (member.hidden || member.person === null) return null;
  const person: PersonId = member.person.id;
  const name = who.name;

  if (kind === "profile") {
    if (member.row === null) return null;
    const names = await namesFor(state, member);
    const card = cardView(state, member, names);
    const bond = publicBond(member.row);
    const data: MemberProfilePicture = {
      variant: "member",
      name,
      ring: {
        lap: bond.ring.lap,
        fraction: bond.ring.fraction,
        full: bond.ring.full,
        // How far under the ring a member's picture draws a bond below 0 (`/me profile`'s).
        below: bond.ring.below ? 0.25 : 0,
      },
      tier_label: bond.tier_label,
      next_label: bond.next_label,
      tier_progress: bond.tier_progress,
      closeness: card.affinity ?? bond.closeness,
      trust: card.trust ?? bond.trust,
      familiarity: card.familiarity ?? bond.familiarity,
      call_name: card.call_name,
      feeling: card.public_feeling,
    };
    return { kind, data, person };
  }

  const { first, today, offset } = weekOf(state);
  const economy = state.optional(EconomyKey);

  if (kind === "wallet") {
    if (!economy) return null;
    const view = await economy.wallet(who.account);
    const { ledger } = await economy.exportWallet(who.account);
    const data: WalletPictureData = {
      name,
      currency: view.currency,
      balance: view.balance,
      streak: view.streak,
      ...weekLedger(ledger, first, today, offset),
    };
    return { kind, data, person };
  }

  const cards = state.optional(CardsKey);

  if (kind === "week") {
    const days = (await activity(state, member)).slice(-WEEK_DAYS);
    const songs = ownSongs(state, member).filter((s) => {
      const ms = Date.parse(s.requested_at);
      return Number.isFinite(ms) && localDay(ms, offset) >= first;
    });
    const drawn = (cards?.cards(person, { limit: MAX_CARDS }) ?? []).filter(
      (c) => localDay(Date.parse(c.created_at), offset) >= first,
    );
    let coins: WeekPictureData["coins"] = null;
    if (economy) {
      const view = await economy.wallet(who.account);
      const { ledger } = await economy.exportWallet(who.account);
      const week = weekLedger(ledger, first, today, offset);
      coins = {
        currency: view.currency,
        earned: week.days.reduce((t, d) => t + d.income, 0),
        spent: week.days.reduce((t, d) => t + d.spending, 0),
      };
    }
    const data: WeekPictureData = {
      name,
      days,
      songs: songs.map((s) => ({ title: s.title, artist: s.artist })),
      song_count: songs.length,
      cards: byRarity(drawn.map((c) => c.rarity)).filter((r) => r.count > 0),
      coins,
    };
    return { kind, data, person };
  }

  // The dex: what `/me card action:圖鑑` shows, and their cards by rarity.
  const keepsakes = state.optional(KeepsakesKey);
  if (!keepsakes || !cards) return null;
  const book = await keepsakes.cardBook(who.account);
  if (!book.ok) return null;
  const owned = cards.cards(person, { limit: MAX_CARDS });
  const data: DexPictureData = {
    name,
    parts: book.value.parts,
    series: book.value.series,
    rarities: byRarity(owned.map((c) => c.rarity)),
    titles: book.value.titles,
    pity: book.value.pity,
  };
  return { kind: "dex", data, person };
}
