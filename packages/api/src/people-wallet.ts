// An admin's hand on someone's coins (docs/design/economy.md §14):
//
// * `GET /api/people/{id}/wallet`: their balance and newest rows (panel access only).
// * `POST /api/people/{id}/wallet/adjust` `{ amount, note, key }`: adds (or, negative, takes)
//   coins as one `admin_adjust` row. Needs `admin.economy.adjust` (the bearer token has every
//   right); the same `key` twice answers the first. 402 when it would go below 0.

import { type Economy, MAX_ADJUST, MAX_ADJUST_NOTE_CHARS } from "@miyoria/economy";
import { IdentityStoreKey } from "@miyoria/store";
import { AuthorizerKey, isUlid, type PersonId } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { readJson } from "./extract.js";
import { json, param, type Route } from "./route.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";
import type { PersonWalletView, WalletAdjustResult } from "./types.js";
import { withWallet } from "./wallet.js";

export const NODE_ECONOMY_ADJUST = "admin.economy.adjust";

const HISTORY_ROWS = 20;
const MAX_KEY_CHARS = 128;

// Checked by hand below so a bad body is a 400, like the other wallet routes.
const BodySchema = z.object({
  amount: z.unknown().optional(),
  note: z.unknown().optional(),
  key: z.unknown().optional(),
});

function requireNode(state: ApiState, c: ApiContext): void {
  const principal = c.get("principal");
  if (principal.kind === "token") return;
  const authorizer = state.optional(AuthorizerKey);
  if (!authorizer?.allows(principal.record.account, NODE_ECONOMY_ADJUST)) {
    throw new ApiError(403, `this needs \`${NODE_ECONOMY_ADJUST}\``);
  }
}

async function accountOf(state: ApiState, c: ApiContext) {
  const id = param(c, "id");
  const upper = id.toUpperCase();
  const unknown = ApiError.notFound(`unknown person \`${id}\``);
  if (!isUlid(upper)) throw unknown;
  const identity = state.service(IdentityStoreKey, "identity store");
  const first = (await identity.accountsOf(upper as PersonId))[0];
  if (!first) throw unknown;
  return first.account;
}

async function wallet(state: ApiState, c: ApiContext): Promise<Response> {
  const account = await accountOf(state, c);
  const view = await withWallet(state, (economy) => economy.statement(account, HISTORY_ROWS));
  const body: PersonWalletView = {
    balance: view.balance,
    ledger: view.ledger.map((l) => ({ ts: l.ts, delta: l.delta, label: l.label })),
  };
  return json(body);
}

async function adjust(state: ApiState, c: ApiContext): Promise<Response> {
  requireNode(state, c);
  const body = await readJson(c, BodySchema);
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
  const account = await accountOf(state, c);
  const person = param(c, "id").toUpperCase();
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
  const out: WalletAdjustResult = {
    balance: result.balance,
    entry_id: result.entry_id,
    duplicate: result.duplicate,
  };
  return json(out);
}

export function personWalletRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/people/:id/wallet", handler: (c) => wallet(state, c) },
    { method: "POST", path: "/api/people/:id/wallet/adjust", handler: (c) => adjust(state, c) },
  ];
}
