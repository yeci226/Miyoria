// An admin's hand on someone's coins (docs/design/economy.md §14):
//
// * `GET /api/people/{id}/wallet`: their balance and newest rows (panel access only).
// * `POST /api/people/{id}/wallet/adjust` `{ amount, note, key }`: adds (or, negative, takes)
//   coins as one `admin_adjust` row. Needs `admin.economy.adjust` (the bearer token has every
//   right); the same `key` twice answers the first. 402 when it would go below 0.

import type {
  PersonWalletView,
  WalletAdjustRequest,
  WalletAdjustResult,
} from "@miyoria/contracts/api";
import { type Economy, MAX_ADJUST, MAX_ADJUST_NOTE_CHARS } from "@miyoria/economy";
import { IdentityStoreKey } from "@miyoria/store";
import { isUlid, type PersonId } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";
import { withWallet } from "./wallet.js";

const HISTORY_ROWS = 20;
const MAX_KEY_CHARS = 128;

async function accountOf(state: ApiState, id: string) {
  const upper = id.toUpperCase();
  const unknown = ApiError.notFound(`unknown person \`${id}\``);
  if (!isUlid(upper)) throw unknown;
  const identity = state.service(IdentityStoreKey, "identity store");
  const first = (await identity.accountsOf(upper as PersonId))[0];
  if (!first) throw unknown;
  return first.account;
}

async function wallet(state: ApiState, id: string): Promise<PersonWalletView> {
  const account = await accountOf(state, id);
  const view = await withWallet(state, (economy) => economy.statement(account, HISTORY_ROWS));
  return {
    balance: view.balance,
    ledger: view.ledger.map((l) => ({ ts: l.ts, delta: l.delta, label: l.label })),
  };
}

/** Needs `admin.economy.adjust` (the route's permission). Each field is checked by hand: a bad body is a 400. */
async function adjust(
  state: ApiState,
  c: ApiContext,
  id: string,
  body: WalletAdjustRequest,
): Promise<WalletAdjustResult> {
  const { amount, note, key } = body;
  if (
    typeof amount !== "number" ||
    !Number.isInteger(amount) ||
    amount === 0 ||
    Math.abs(amount) > MAX_ADJUST
  ) {
    throw ApiError.badRequest(`\`amount\` must be a non-zero integer up to ${MAX_ADJUST}`);
  }
  const text = typeof note === "string" ? note.trim() : "";
  if (text === "" || [...text].length > MAX_ADJUST_NOTE_CHARS) {
    throw ApiError.badRequest(`\`note\` must be 1 to ${MAX_ADJUST_NOTE_CHARS} characters`);
  }
  if (typeof key !== "string" || key === "" || key.length > MAX_KEY_CHARS) {
    throw ApiError.badRequest("`key` must be a short non-empty string");
  }
  const account = await accountOf(state, id);
  const person = id.toUpperCase();
  let result: Awaited<ReturnType<Economy["adjust"]>>;
  try {
    result = await withWallet(state, (economy) =>
      economy.adjust(account, amount, text, actorOf(c), key),
    );
  } catch (error) {
    await state.audit(c, "economy.adjust", person, { amount, note: text }, false);
    throw error;
  }
  if (!result.duplicate) {
    await state.audit(c, "economy.adjust", person, { amount, note: text }, true);
  }
  return { balance: result.balance, entry_id: result.entry_id, duplicate: result.duplicate };
}

/** The people wallet routes on the route table (`people.wallet`, `people.adjustWallet`). */
export const personWalletRpc = {
  wallet: os.people.wallet.handler(({ input, context }) => wallet(context.state, input.params.id)),
  adjustWallet: os.people.adjustWallet.handler(({ input, context }) =>
    adjust(context.state, context.c, input.params.id, input.body),
  ),
};
