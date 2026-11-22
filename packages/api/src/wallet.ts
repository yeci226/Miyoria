// Coins on the member page (docs/design/economy.md): the `economy` module's wallet of the
// session's person, and nobody else's.
//
// * `GET /api/member/wallet`: balance, what they can still earn today, the shop, their frames.
// * `POST /api/member/checkin` `{ fortune? }`: once a local day (Discord's `/me` counts too); 409
//   after. `fortune: true` adds today's fortune slip, paid (the check-in stands if the slip fails);
//   on a day already checked in it buys the slip alone (`gained` 0, no second reward).
// * `POST /api/member/feed` `{ item, count? }`,
//   `POST /api/member/screen` `{ text }` (a message on the stream: 409 when she is not live), `POST /api/member/frame` `{ buy?, select? }`.
// * `GET /api/member/danmaku` (what a danmaku line costs them now, and why they cannot send one),
//   `POST /api/member/danmaku` `{ text }` (one line across her stream: 409 when she is not live;
//   given back by itself when the overlay did not show it).
// * `GET /api/member/quests`, `GET /api/member/predictions`, `POST /api/member/bet`: economy 2.0's
//   own, in `play-routes.ts` (joined to this group in `rpc.ts`).
// * `POST /api/member/transfer` `{ to_discord_id, amount }`: coins to another member on the
//   sender's own platform (403 in the same words for every reason they cannot take them);
//   `POST /api/member/board` `{ on }`: join or leave the sponsor board; `GET /api/member/board`
//   (`?space=`, `scope=all`): the board of one server's members or of everyone (built in
//   `board.ts`, beside `GET /api/public/board`).
//
// Spends take an `Idempotency-Key` header: the same key answers what it answered first. A
// stranger (and a blocked person) reads an empty wallet and gets 403 for every spend, in the same
// words; 402 is not enough coins, 429 a limit. Responses are built field by field.

import {
  type CheckinResult,
  type DanmakuView,
  type EarnLine,
  type Economy,
  EconomyError,
  EconomyKey,
  type FeedResult,
  type FramesResult,
  type LedgerLine,
  type ShopItem,
  type SpendResult,
  STRANGER,
  type TransferResult,
  type WalletExport,
  type WalletView,
} from "@miyoria/economy";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { type AccountRef, accountRefString, newId } from "@miyoria/types";
import { memberBoard } from "./board.js";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { checkinFortune } from "./fortune-routes.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";
import type { Watch } from "./watch.js";

const log = getLogger("api.wallet");

const NO_WALLET = "錢包現在打不開";
const MAX_KEY_CHARS = 128;

function accountOf(c: ApiContext): AccountRef {
  return (c.get("member") as SessionRecord).account;
}

/** The `Idempotency-Key` a request sent; a fresh one when there is none (no retry protection). */
export function keyOf(header: string | undefined): string {
  const key = header?.trim();
  if (key === undefined || key === "") return newId();
  if (key.length > MAX_KEY_CHARS || !/^[\x21-\x7e]+$/.test(key)) {
    throw ApiError.badRequest("invalid Idempotency-Key");
  }
  return key;
}

/** Runs `fn` against the wallet; its refusals become their status and words. */
export async function withWallet<T>(
  state: ApiState,
  fn: (economy: Economy) => Promise<T>,
): Promise<T> {
  const economy = state.optional(EconomyKey);
  if (!economy) throw ApiError.unavailable(NO_WALLET);
  try {
    return await fn(economy);
  } catch (error) {
    if (error instanceof EconomyError) throw new ApiError(error.status, error.message);
    if (error instanceof ApiError) throw error;
    log.warn({ error: errorMessage(error) }, "the wallet failed");
    throw ApiError.unavailable(NO_WALLET);
  }
}

// ---- field by field -----------------------------------------------------------------------

const earnLine = (e: EarnLine): EarnLine => ({
  reason: e.reason,
  label: e.label,
  amount: e.amount,
  earned_today: e.earned_today,
  cap: e.cap,
});

const shopItem = (s: ShopItem): ShopItem => ({
  id: s.id,
  kind: s.kind,
  label: s.label,
  price: s.price,
  available: s.available,
  why: s.why,
});

const ledgerLine = (l: LedgerLine): LedgerLine => ({ ts: l.ts, delta: l.delta, label: l.label });

function walletView(v: WalletView): WalletView {
  return {
    currency: v.currency,
    balance: v.balance,
    can_earn: v.can_earn,
    today_earned: v.today_earned,
    checked_in_today: v.checked_in_today,
    streak: v.streak,
    earn: v.earn.map(earnLine),
    shop: v.shop.map(shopItem),
    frames: { owned: [...v.frames.owned], selected: v.frames.selected },
    hungry: v.hungry,
    recent: v.recent.map(ledgerLine),
    on_board: v.on_board,
    transfer_fee: v.transfer_fee,
  };
}

const spendResult = (r: SpendResult): SpendResult => ({
  accepted: r.accepted,
  charged: r.charged,
  balance: r.balance,
  message: r.message,
});

const danmakuView = (v: DanmakuView): DanmakuView => ({
  open: v.open,
  live: v.live,
  currency: v.currency,
  price: v.price,
  max_chars: v.max_chars,
  cooldown_s: v.cooldown_s,
  per_day: v.per_day,
  sent_today: v.sent_today,
  wait_s: v.wait_s,
  balance: v.balance,
  why: v.why,
});

/** `GET /api/member/danmaku` as a view (also the `danmaku` push topic): the member's own. */
export function danmakuWatch(state: ApiState, c: ApiContext): Watch<DanmakuView> {
  const account = accountOf(c);
  return {
    key: `danmaku:${accountRefString(account)}`,
    build: async () => danmakuView(await withWallet(state, (e) => e.danmakuView(account))),
  };
}

const feedResult = (r: FeedResult): FeedResult => ({
  accepted: r.accepted,
  eaten: r.eaten,
  charged: r.charged,
  balance: r.balance,
  message: r.message,
});

const transferResult = (r: TransferResult): TransferResult => ({
  sent: r.sent,
  fee: r.fee,
  balance: r.balance,
  to: r.to,
});

const framesResult = (r: FramesResult): FramesResult => ({
  owned: [...r.owned],
  selected: r.selected,
  balance: r.balance,
});

const checkinResult = (r: CheckinResult): CheckinResult => ({
  gained: r.gained,
  streak: r.streak,
  balance: r.balance,
});

/** Their wallet for the export: a stranger's is empty. */
export async function walletExport(state: ApiState, account: AccountRef): Promise<WalletExport> {
  const economy = state.optional(EconomyKey);
  if (!economy) return { balance: 0, ledger: [] };
  try {
    const w = await economy.exportWallet(account);
    return { balance: w.balance, ledger: w.ledger.map(ledgerLine) };
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot export a wallet");
    return { balance: 0, ledger: [] };
  }
}

// ---- routes -------------------------------------------------------------------------------

/** The wallet routes; served only while the public side is on (see `rpc.ts`). `rpc.ts` adds `walletPlayRpc`. */
export const walletRpc = {
  view: os.wallet.view.handler(async ({ context: { state, c } }) => {
    return walletView(await withWallet(state, (e) => e.wallet(accountOf(c))));
  }),
  checkin: os.wallet.checkin.handler(async ({ input, context: { state, c } }) => {
    const account = accountOf(c);
    const asked = input.body.fortune === true;
    // A day already checked in still buys the slip alone: no second check-in, nothing earned.
    const today = asked ? await withWallet(state, (e) => e.wallet(account)) : null;
    const done =
      today?.checked_in_today === true
        ? { gained: 0, streak: today.streak, balance: today.balance }
        : checkinResult(await withWallet(state, (e) => e.checkin(account)));
    if (!asked) return done;
    // The paid add-on: the check-in stands whatever happens to the slip.
    const { name } = c.get("member") as SessionRecord;
    const { balance, ...slip } = await checkinFortune(state, { account, name });
    return { ...done, ...slip, balance: balance ?? done.balance };
  }),
  feed: os.wallet.feed.handler(async ({ input, context: { state, c } }) => {
    const key = keyOf(input.headers["idempotency-key"]);
    const { item, count } = input.body;
    const r = await withWallet(state, (e) => e.feed(accountOf(c), item, count ?? 1, key));
    return feedResult(r);
  }),
  screen: os.wallet.screen.handler(async ({ input, context: { state, c } }) => {
    const key = keyOf(input.headers["idempotency-key"]);
    const { text } = input.body;
    return spendResult(await withWallet(state, (e) => e.screenMessage(accountOf(c), text, key)));
  }),
  danmakuView: os.wallet.danmakuView.handler(async ({ context: { state, c } }) => {
    return danmakuWatch(state, c).build();
  }),
  danmaku: os.wallet.danmaku.handler(async ({ input, context: { state, c } }) => {
    const key = keyOf(input.headers["idempotency-key"]);
    const { text } = input.body;
    return spendResult(await withWallet(state, (e) => e.danmaku(accountOf(c), text, key)));
  }),
  transfer: os.wallet.transfer.handler(async ({ input, context: { state, c } }) => {
    const key = keyOf(input.headers["idempotency-key"]);
    const { to_discord_id, amount } = input.body;
    // The receiver is on the sender's platform: the id the page asks for is that platform's.
    const from = accountOf(c);
    const to: AccountRef = { platform: from.platform, id: to_discord_id };
    return transferResult(await withWallet(state, (e) => e.transfer(from, to, amount, key)));
  }),
  board: os.wallet.board.handler(async ({ input, context: { state, c } }) => {
    const { on } = input.body;
    const done = await withWallet(state, (e) => e.setOnBoard(accountOf(c), on));
    if (!done) throw new ApiError(403, STRANGER);
    return { on_board: on };
  }),
  boardView: os.wallet.boardView.handler(({ input, context: { state, c } }) =>
    memberBoard(state, c, input?.query ?? {}),
  ),
  frame: os.wallet.frame.handler(async ({ input, context: { state, c } }) => {
    const key = keyOf(input.headers["idempotency-key"]);
    const { buy, select } = input.body;
    const req: { buy?: string; select?: string | null } = {};
    if (buy !== undefined) req.buy = buy;
    if (select !== undefined) req.select = select;
    return framesResult(await withWallet(state, (e) => e.frame(accountOf(c), req, key)));
  }),
};
