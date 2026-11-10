// Coins on the member page (docs/design/economy.md): the `economy` module's wallet of the
// session's person, and nobody else's.
//
// * `GET /api/member/wallet`: balance, what they can still earn today, the shop, their frames.
// * `POST /api/member/checkin` `{}`: once a local day (Discord's `/me` counts too); 409 after.
// * `POST /api/member/feed` `{ item, count? }`, `POST /api/member/letter` `{ text }`,
//   `POST /api/member/expression` `{ expression }`,
//   `POST /api/member/screen` `{ text }` (a message on the stream: 409 when she is not live), `POST /api/member/frame` `{ buy?, select? }`.
// * `POST /api/member/transfer` `{ to_discord_id, amount }`: coins to another member (403 in the
//   same words for every reason they cannot take them); `POST /api/member/board` `{ on }`: join or
//   leave the sponsor board (`GET /api/public/board` is in `board.ts`).
//
// Spends take an `Idempotency-Key` header: the same key answers what it answered first. A
// stranger (and a blocked person) reads an empty wallet and gets 403 for every spend, in the same
// words; 402 is not enough coins, 429 a limit. Responses are built field by field.

import {
  type CheckinResult,
  type DealView,
  type EarnLine,
  type Economy,
  EconomyError,
  EconomyKey,
  FEED_ITEMS,
  type FeedResult,
  type FramesResult,
  GIFT_EXPRESSIONS,
  type LedgerLine,
  MAX_FEED_COUNT,
  type ShopItem,
  type SpendResult,
  STRANGER,
  type TransferResult,
  type WalletExport,
  type WalletView,
} from "@miyoria/economy";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { type AccountRef, accountRefString, newId } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { readJson } from "./extract.js";
import { tooMany } from "./public.js";
import { json, type Route } from "./route.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";

const log = getLogger("api.wallet");

const NO_WALLET = "錢包現在打不開";
const MAX_KEY_CHARS = 128;

const CheckinSchema = z.strictObject({});
const FeedSchema = z.strictObject({
  item: z.enum(FEED_ITEMS as [string, ...string[]]),
  count: z.number().int().min(1).max(MAX_FEED_COUNT).optional(),
});
const LetterSchema = z.strictObject({ text: z.string().max(2_000) });
const ScreenSchema = z.strictObject({ text: z.string().max(500) });
const ExpressionSchema = z.strictObject({
  expression: z.enum(GIFT_EXPRESSIONS as [string, ...string[]]),
});
const TransferSchema = z.strictObject({
  /** The receiver is named by their Discord user id, in the body only. */
  to_discord_id: z.string().regex(/^[0-9]{1,25}$/),
  amount: z.number().int().min(1).max(1_000_000),
});
const BoardSchema = z.strictObject({ on: z.boolean() });
const FrameSchema = z.strictObject({
  buy: z.string().max(64).optional(),
  select: z.string().max(64).nullable().optional(),
});

function accountOf(c: ApiContext): AccountRef {
  return (c.get("member") as SessionRecord).account;
}

/** The request's `Idempotency-Key`; a fresh one when there is none (no retry protection). */
export function keyOf(c: ApiContext): string {
  const key = c.req.header("idempotency-key")?.trim();
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

const dealView = (d: DealView): DealView => ({
  task: d.task,
  reward_label: d.reward_label,
  status: d.status,
  due_at: d.due_at,
});

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
    deals: v.deals.map(dealView),
    on_board: v.on_board,
  };
}

const spendResult = (r: SpendResult): SpendResult => ({
  accepted: r.accepted,
  charged: r.charged,
  balance: r.balance,
  message: r.message,
});

const feedResult = (r: FeedResult): FeedResult => ({
  accepted: r.accepted,
  eaten: r.eaten,
  charged: r.charged,
  balance: r.balance,
  message: r.message,
});

const transferResult = (r: TransferResult): TransferResult => ({
  sent: r.sent,
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

/** Runs `handler` unless this account has been asking too much. */
function limited(state: ApiState, handler: (c: ApiContext) => Promise<Response>) {
  return async (c: ApiContext): Promise<Response> => {
    const wait = state.publicSide.admitMember(accountRefString(accountOf(c)));
    return wait !== null ? tooMany(wait) : handler(c);
  };
}

/** The wallet routes; none when `[modules.api.public] enabled` is off. */
export function walletRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/member/wallet",
      handler: limited(state, async (c) =>
        json(walletView(await withWallet(state, (e) => e.wallet(accountOf(c))))),
      ),
    },
    {
      method: "POST",
      path: "/api/member/checkin",
      handler: limited(state, async (c) => {
        await readJson(c, CheckinSchema);
        return json(checkinResult(await withWallet(state, (e) => e.checkin(accountOf(c)))));
      }),
    },
    {
      method: "POST",
      path: "/api/member/feed",
      handler: limited(state, async (c) => {
        const body = await readJson(c, FeedSchema);
        const key = keyOf(c);
        const item = body.item as (typeof FEED_ITEMS)[number];
        const r = await withWallet(state, (e) => e.feed(accountOf(c), item, body.count ?? 1, key));
        return json(feedResult(r));
      }),
    },
    {
      method: "POST",
      path: "/api/member/letter",
      handler: limited(state, async (c) => {
        const { text } = await readJson(c, LetterSchema);
        const key = keyOf(c);
        return json(spendResult(await withWallet(state, (e) => e.letter(accountOf(c), text, key))));
      }),
    },
    {
      method: "POST",
      path: "/api/member/screen",
      handler: limited(state, async (c) => {
        const { text } = await readJson(c, ScreenSchema);
        const key = keyOf(c);
        const r = await withWallet(state, (e) => e.screenMessage(accountOf(c), text, key));
        return json(spendResult(r));
      }),
    },
    {
      method: "POST",
      path: "/api/member/expression",
      handler: limited(state, async (c) => {
        const body = await readJson(c, ExpressionSchema);
        const key = keyOf(c);
        const expression = body.expression as (typeof GIFT_EXPRESSIONS)[number];
        const r = await withWallet(state, (e) => e.expression(accountOf(c), expression, key));
        return json(spendResult(r));
      }),
    },
    {
      method: "POST",
      path: "/api/member/transfer",
      handler: limited(state, async (c) => {
        const body = await readJson(c, TransferSchema);
        const key = keyOf(c);
        const to: AccountRef = { platform: "discord", id: body.to_discord_id };
        const r = await withWallet(state, (e) => e.transfer(accountOf(c), to, body.amount, key));
        return json(transferResult(r));
      }),
    },
    {
      method: "POST",
      path: "/api/member/board",
      handler: limited(state, async (c) => {
        const { on } = await readJson(c, BoardSchema);
        const done = await withWallet(state, (e) => e.setOnBoard(accountOf(c), on));
        if (!done) throw new ApiError(403, STRANGER);
        return json({ on_board: on });
      }),
    },
    {
      method: "POST",
      path: "/api/member/frame",
      handler: limited(state, async (c) => {
        const body = await readJson(c, FrameSchema);
        const key = keyOf(c);
        const req: { buy?: string; select?: string | null } = {};
        if (body.buy !== undefined) req.buy = body.buy;
        if (body.select !== undefined) req.select = body.select;
        return json(framesResult(await withWallet(state, (e) => e.frame(accountOf(c), req, key))));
      }),
    },
  ];
  return routes.map((r) => ({ ...r, member: true }));
}
