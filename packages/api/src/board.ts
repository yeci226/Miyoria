// The sponsor board on the public side (docs/design/economy.md §13): `GET /api/public/board`.
//
// Only people who chose to be on it, by what they spent on her lately, as a display name and a
// number: no account id, no balance, nothing that says who is behind a name beyond the name they
// show. A name moderation does not pass is shown as 匿名. One body serves everyone for
// `cache_secs`, like the other public views, so traffic does not reach the ledger. Being looked at
// changes nothing about her. Joining or leaving is a member route (`POST /api/member/board`).

import type { PublicBoard } from "@miyoria/contracts/api";
import { type BoardLine, EconomyKey } from "@miyoria/economy";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { safeName } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { clientKey } from "./public.js";
import type { ApiState } from "./state.js";

const log = getLogger("api.board");

/** Places the public page lists. */
export const PUBLIC_BOARD_PLACES = 20;
const HIDDEN_NAME = "匿名";

async function build(state: ApiState): Promise<PublicBoard> {
  const economy = state.optional(EconomyKey);
  if (!economy) return { entries: [] };
  const lines: BoardLine[] = await economy.board(PUBLIC_BOARD_PLACES);
  return {
    entries: lines.slice(0, PUBLIC_BOARD_PLACES).map((l) => {
      const name = safeName(l.name);
      return {
        rank: l.rank,
        name: state.publicSide.passes(state, name) ? name : HIDDEN_NAME,
        spent: l.spent,
      };
    }),
  };
}

/** What the board last answered, and when: it is built at most once per `cache_secs`. */
const held = new WeakMap<ApiState, { at: number; value: PublicBoard }>();

async function board(state: ApiState): Promise<PublicBoard> {
  const side = state.publicSide;
  const now = state.now();
  const hit = held.get(state);
  if (hit && now - hit.at < side.config.cache_secs * 1000) return hit.value;
  let value: PublicBoard;
  try {
    value = await build(state);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot build the board");
    value = { entries: [] };
  }
  held.set(state, { at: now, value });
  return value;
}

/** `GET /api/public/board`; served only while the public side is on (see `rpc.ts`). */
export const boardRpc = {
  board: os.public.board.handler(async ({ context }) => {
    const { state, c } = context;
    const side = state.publicSide;
    const wait = side.admit(clientKey(c));
    if (wait !== null) throw ApiError.tooMany(wait);
    context.resHeaders?.set(
      "cache-control",
      `public, max-age=${Math.ceil(side.config.cache_secs)}`,
    );
    context.resHeaders?.set("x-content-type-options", "nosniff");
    return board(state);
  }),
};
