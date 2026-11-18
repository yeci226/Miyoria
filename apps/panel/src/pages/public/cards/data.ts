// The member's card queries (`cards` group of the route table) and the one catalogue the dex and the
// wishlist pick from.
//
// The catalogue is the Core's (`GET /api/member/cards/catalogue`): every part with its series and
// whether it is blank, drop-only, enabled or wishable. A Core without that route still shows the
// dex: then only the parts they have.

import { useQuery } from "@tanstack/react-query";
import type { CardCatalogue, CardDex } from "@miyoria/contracts/api";
import { isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import type { Rarity, Slot } from "./labels";
import { RARITIES, SLOTS } from "./labels";

/** Everything under `["member", "cards"]` is refreshed after a new card. */
export const CARD_KEYS = {
  mine: ["member", "cards", "mine"] as const,
  dex: ["member", "cards", "dex"] as const,
  pity: ["member", "cards", "pity"] as const,
  wishlist: ["member", "cards", "wishlist"] as const,
  catalogue: ["member", "cards", "catalogue"] as const,
  odds: ["public", "cards", "odds"] as const,
};

/** An older Core has no such route: asking again will not change that. */
const retry = (n: number, e: Error) => !isNotProvided(e) && n < 2;

export function useMyCards() {
  const api = useApi();
  return useQuery({ queryKey: CARD_KEYS.mine, queryFn: ({ signal }) => api.rpc.cards.mine(undefined, { signal }), retry });
}

export function useDex() {
  const api = useApi();
  return useQuery({ queryKey: CARD_KEYS.dex, queryFn: ({ signal }) => api.rpc.cards.dex(undefined, { signal }), retry });
}

export function usePity() {
  const api = useApi();
  return useQuery({ queryKey: CARD_KEYS.pity, queryFn: ({ signal }) => api.rpc.cards.pity(undefined, { signal }), retry });
}

export function useWishlist() {
  const api = useApi();
  return useQuery({ queryKey: CARD_KEYS.wishlist, queryFn: ({ signal }) => api.rpc.cards.wishlist(undefined, { signal }), retry });
}

export function useCatalogue() {
  const api = useApi();
  return useQuery({
    queryKey: CARD_KEYS.catalogue,
    queryFn: ({ signal }) => api.rpc.cards.catalogue(undefined, { signal }),
    retry,
    staleTime: 10 * 60_000,
  });
}

export function useOdds() {
  const api = useApi();
  return useQuery({
    queryKey: CARD_KEYS.odds,
    queryFn: ({ signal }) => api.rpc.cards.odds(undefined, { signal }),
    retry,
    staleTime: 10 * 60_000,
  });
}

/** One part of the catalogue, and what this person has of it. */
export interface CatalogPart {
  id: string;
  slot: Slot;
  name: string;
  rarity: Rarity;
  /** Series id, or null. */
  series: string | null;
  /** It can go on the wishlist (the Core's word). */
  wishable: boolean;
  /** How many of their cards had it; 0: not yet. */
  count: number;
  first_at: string | null;
}

/**
 * Every part the dex shows, owned or not, in slot order, rarest last within a slot: the catalogue's
 * collectable parts (not blank; a disabled one only once they have it), a drop-only one too. Without
 * the catalogue (an older Core), only the parts they have.
 */
export function catalogOf(dex: CardDex, catalogue: CardCatalogue | undefined): CatalogPart[] {
  const owned = new Map(dex.parts.map((p) => [p.id, p]));
  const out = new Map<string, CatalogPart>();
  for (const p of catalogue?.parts ?? []) {
    const mine = owned.get(p.id);
    if (p.blank || (!p.enabled && !mine)) continue;
    out.set(p.id, {
      id: p.id,
      slot: p.slot,
      name: p.name,
      rarity: p.rarity,
      series: p.series,
      wishable: p.wishable,
      count: mine?.count ?? 0,
      first_at: mine?.first_at ?? null,
    });
  }
  for (const p of dex.parts) {
    if (out.has(p.id)) continue;
    out.set(p.id, { ...p, wishable: catalogue === undefined, count: p.count, first_at: p.first_at });
  }
  return [...out.values()].sort(
    (a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot) || RARITIES.indexOf(a.rarity) - RARITIES.indexOf(b.rarity) || a.id.localeCompare(b.id),
  );
}

/** Each series' name, the catalogue's (every series) over the dex's (those with parts). */
export function seriesNames(dex: CardDex, catalogue: CardCatalogue | undefined): Map<string, string> {
  return new Map([...dex.series.map((s) => [s.id, s.name] as const), ...(catalogue?.series ?? []).map((s) => [s.id, s.name] as const)]);
}
