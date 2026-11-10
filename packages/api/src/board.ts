// The sponsor board on the public side (docs/design/economy.md §13): `GET /api/public/board`.
//
// Only people who chose to be on it, by what they spent on her lately, as a display name and a
// number: no account id, no balance, nothing that says who is behind a name beyond the name they
// show. A name moderation does not pass is shown as 匿名. One body serves everyone for
// `cache_secs`, like the other public views, so traffic does not reach the ledger. Being looked at
// changes nothing about her. Joining or leaving is a member route (`POST /api/member/board`).

import { type BoardLine, EconomyKey } from "@miyoria/economy";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { safeName } from "@miyoria/types";
import { clientKey, tooMany } from "./public.js";
import type { Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";

const log = getLogger("api.board");

/** Places the public page lists. */
export const PUBLIC_BOARD_PLACES = 20;
const HIDDEN_NAME = "匿名";

/** The body of the public board, field by field. */
export interface PublicBoard {
  entries: { rank: number; name: string; spent: number }[];
}

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

/** The public board route; none when `[modules.api.public] enabled` is off. */
export function boardRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  let held: { at: number; body: string } | null = null;
  const serve = async (c: ApiContext): Promise<Response> => {
    const side = state.publicSide;
    const wait = side.admit(clientKey(c));
    if (wait !== null) return tooMany(wait);
    const now = state.now();
    if (held === null || now - held.at >= side.config.cache_secs * 1000) {
      try {
        held = { at: now, body: JSON.stringify(await build(state)) };
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "cannot build the board");
        held = { at: now, body: JSON.stringify({ entries: [] } satisfies PublicBoard) };
      }
    }
    return new Response(held.body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${Math.ceil(side.config.cache_secs)}`,
        "x-content-type-options": "nosniff",
      },
    });
  };
  return [{ method: "GET", path: "/api/public/board", public: true, handler: serve }];
}
