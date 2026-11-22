// The sponsor board (docs/design/economy.md §13): everyone she knows who spent coins on her lately,
// ranked by how much. On by default, and anyone can leave; never a balance. A person is one wallet
// and one line (their linked accounts, and whoever they absorbed), and leaving takes them off.
// There is one board for everyone, and the same board narrowed to one server's members (phase 6):
// the spending is the same global wallet either way, only who is listed differs.

import {
  type AccountRef,
  CARD_REASONS,
  type PersonId,
  safeName,
  toTimestamp,
} from "@miyoria/types";
import type { EconomyService } from "./economy.js";
import { type BoardLine, PAID_ITEMS } from "./types.js";

/**
 * Ledger reasons that are coins spent on her: food, frames, every paid item
 * (cards, screen messages, fortunes), the daily cards, and the rows of what is not sold any more (a goal's pledge, a
 * song ticket, a dedication, the escrow of a deal she kept, a card re-drawn or its picture picked). Rows that were refunded do not count, which is how a failed goal gives its pledges back. Coins given to other people
 * (`transfer_out`, a bounty's escrow, `purse_gift`) are not spent on her.
 */
export const BOARD_REASONS: readonly string[] = [
  ...new Set([
    "feed",
    // A gift named in words (gifts.ts); one she said no to was refunded, so it does not count.
    "gift",
    "frame",
    CARD_REASONS.daily,
    ...PAID_ITEMS,
    "goal_pledge",
    "song_ticket",
    "dedication",
    "deal_escrow",
    "card_reroll",
    "card_pose",
  ]),
];

/** Places the board shows at most. */
export const MAX_BOARD = 50;
const DEFAULT_BOARD = 20;
const DAY_MS = 86_400_000;
/** People who left the board, and people who spent anything, read at most. */
const MAX_LEFT = 5_000;
const MAX_SPENDERS = 5_000;

/**
 * The board, biggest spender first; people who spent nothing in the window are not listed.
 * `members`: only these persons (a server's members, `Places.members`); everyone without.
 */
export async function sponsorBoard(
  e: EconomyService,
  limit = DEFAULT_BOARD,
  members?: ReadonlySet<PersonId>,
): Promise<BoardLine[]> {
  const places = Math.min(Math.max(Math.trunc(limit) || DEFAULT_BOARD, 1), MAX_BOARD);
  const ledger = e.ledger();
  const since = toTimestamp(e.now() - e.config.board_days * DAY_MS);
  const spent = await ledger.spent(e.profile, BOARD_REASONS, since, MAX_SPENDERS);
  if (spent.length === 0) return [];
  const left = new Set(await ledger.offBoard(e.profile, MAX_LEFT));
  const seen = new Set<string>();
  const people: { name: string; spent: number }[] = [];
  for (const { account, spent: total } of spent) {
    // Known and not blocked, like anywhere else: a blocked person is off the board. Who they are
    // to her is asked through their first account.
    const who = account === null ? null : await e.member(account);
    if (!who || seen.has(who.person.id)) continue;
    seen.add(who.person.id);
    if (left.has(who.wallet)) continue;
    if (members && !members.has(who.person.id)) continue;
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
