// The sponsor board (docs/design/economy.md §13): everyone she knows who spent coins on her lately,
// ranked by how much. On by default, and anyone can leave; never a balance. A person's linked
// accounts are one wallet and one line, and any account of theirs that left takes the person off.

import { type AccountRef, accountRefString, safeName, toTimestamp } from "@miyoria/types";
import type { EconomyService } from "./economy.js";
import { type BoardLine, PAID_ITEMS } from "./types.js";

/**
 * Ledger reasons that are coins spent on her: food, letters, expressions, frames, every paid item
 * (cards, song tickets, dedications, screen messages, fortunes), a goal's pledge, and a deal's
 * escrow once it was released to her (`deal_escrow` counts only then). Rows that were refunded do
 * not count, which is how a failed goal gives its pledges back. Coins given to other people
 * (`transfer_out`, a bounty's escrow, `purse_gift`) are not spent on her.
 */
export const BOARD_REASONS: readonly string[] = [
  ...new Set([
    "feed",
    "letter",
    "expression",
    "frame",
    ...PAID_ITEMS,
    "goal_pledge",
    "deal_escrow",
  ]),
];

/** Places the board shows at most. */
export const MAX_BOARD = 50;
const DEFAULT_BOARD = 20;
const DAY_MS = 86_400_000;
/** People who left the board, and people who spent anything, read at most. */
const MAX_LEFT = 5_000;
const MAX_SPENDERS = 5_000;

/** The board, biggest spender first; people who spent nothing in the window are not listed. */
export async function sponsorBoard(e: EconomyService, limit = DEFAULT_BOARD): Promise<BoardLine[]> {
  const places = Math.min(Math.max(Math.trunc(limit) || DEFAULT_BOARD, 1), MAX_BOARD);
  const ledger = e.ledger();
  const since = toTimestamp(e.now() - e.config.board_days * DAY_MS);
  const spent = await ledger.spent(e.profile, BOARD_REASONS, since, MAX_SPENDERS);
  if (spent.length === 0) return [];
  const left = new Set(
    (await ledger.offBoardAccounts(e.profile, MAX_LEFT)).map((a) => accountRefString(a)),
  );
  const by = new Map(spent.map((s) => [accountRefString(s.account), s.spent]));
  const seen = new Set<string>();
  const people: { name: string; spent: number }[] = [];
  for (const { account } of spent) {
    // Known and not blocked, like anywhere else: a blocked person is off the board.
    const who = await e.member(account);
    if (!who || seen.has(who.person.id)) continue;
    seen.add(who.person.id);
    if (who.wallet.some((a) => left.has(accountRefString(a)))) continue;
    const total = who.wallet.reduce((n, a) => n + (by.get(accountRefString(a)) ?? 0), 0);
    if (total > 0) people.push({ name: safeName(who.name), spent: total });
  }
  people.sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name));
  let rank = 0;
  let last = -1;
  return people.slice(0, places).map((p, i) => {
    if (p.spent !== last) {
      rank = i + 1;
      last = p.spent;
    }
    return { rank, name: p.name, spent: p.spent };
  });
}

/** Puts a member's whole wallet on the board or off it; `false` for a stranger. */
export async function setBoard(
  e: EconomyService,
  account: AccountRef,
  on: boolean,
): Promise<boolean> {
  const who = await e.member(account);
  if (!who) return false;
  await e.ledger().setOnBoard(e.profile, who.wallet, on);
  e.record(who, "economy.board", { on });
  return true;
}
