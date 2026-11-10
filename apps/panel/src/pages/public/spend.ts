// What the wallet blocks of the member page share: the wallet query, patching it after a spend,
// one fresh key per click, and how a refusal is said.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isNotProvided } from "@/api/http";
import type { WalletView } from "@/api/types";
import { useApi } from "@/app/connection";
import { fmtInt } from "@/lib/format";
import { notify } from "@/lib/notify";

export const WALLET = ["member", "wallet"] as const;
const POLL_MS = 60_000;

/** One fresh key per click: a retry of the same request is charged once, a second click is a second spend. */
export function newKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function useWallet() {
  const api = useApi();
  return useQuery({
    queryKey: WALLET,
    queryFn: ({ signal }) => api.memberWallet({ signal }),
    refetchInterval: POLL_MS,
    // An older Core has no such route: asking again will not change that.
    retry: (n, e) => !isNotProvided(e) && n < 2,
  });
}

/** Lets a result patch what is on screen at once; the refetch that follows has the final say. */
export function usePatchWallet() {
  const client = useQueryClient();
  return {
    patch: (fn: (w: WalletView) => WalletView) =>
      client.setQueryData<WalletView>(WALLET, (old) => (old ? fn(old) : old)),
    refresh: () => client.invalidateQueries({ queryKey: WALLET }),
  };
}

export const priceText = (price: number, currency: string) => `${fmtInt(price)} ${currency}`;

/** A spend that answers with a message: a refusal is a notice, not an error. */
export function say(r: { accepted: boolean; message: string }) {
  if (r.accepted) notify.ok(r.message);
  else notify.info(r.message);
}
