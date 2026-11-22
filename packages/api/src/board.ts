// The sponsor board on the public side (docs/design/economy.md §13): `GET /api/public/board`.
//
// Only people who chose to be on it, by what they spent on her lately, as a display name and a
// number: no account id, no balance, nothing that says who is behind a name beyond the name they
// show. A name moderation does not pass is shown as 匿名. One body serves everyone for
// `cache_secs`, like the other public views, so traffic does not reach the ledger. Being looked at
// changes nothing about her. Joining or leaving is a member route (`POST /api/member/board`).
//
// The public board is everyone's and only that: a list per server on a public page would tell who
// is in which server. The member page also reads the board of one server's members
// (`GET /api/member/board`, `memberBoard` here, joined to the wallet group in `wallet.ts`).

import type { BoardScopeQueryIn, MemberBoard, PublicBoard } from "@miyoria/contracts/api";
import { type BoardLine, EconomyKey } from "@miyoria/economy";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { type PersonId, PlacesKey, safeName } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { memberPerson, memberSpace, placesOf } from "./space-param.js";
import type { ApiContext, ApiState } from "./state.js";

const log = getLogger("api.board");

/** Places the public page lists. */
export const PUBLIC_BOARD_PLACES = 20;
const HIDDEN_NAME = "匿名";

async function build(state: ApiState, members?: ReadonlySet<PersonId>): Promise<PublicBoard> {
  const economy = state.optional(EconomyKey);
  if (!economy) return { entries: [] };
  const lines: BoardLine[] = await economy.board(PUBLIC_BOARD_PLACES, members);
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

/**
 * Which list a member board shows (`BoardScopeQuery`): `scope=all` is everyone; otherwise the
 * server `?space=` names (`404` / `403` from `memberSpace`) or their own. Someone who is a member
 * nowhere (`member: false`), and a Core without identity's places, get everyone.
 */
export async function memberBoardScope(
  state: ApiState,
  c: ApiContext,
  query: BoardScopeQueryIn,
): Promise<{ space: { id: string; name: string } | null; members: ReadonlySet<PersonId> | null }> {
  if (query.scope === "all") return { space: null, members: null };
  if (state.optional(PlacesKey) === undefined) return { space: null, members: null };
  const person = await memberPerson(state, c);
  // She is in no server yet: there is only everyone's list.
  if (query.space == null && placesOf(state).spaces().length === 0) {
    return { space: null, members: null };
  }
  const space = memberSpace(state, person, query.space);
  if (!space.member) return { space: null, members: null };
  return { space: { id: space.id, name: space.name }, members: placesOf(state).members(space.id) };
}

/** `GET /api/member/board`: the sponsor board of one server's members, or of everyone. */
export async function memberBoard(
  state: ApiState,
  c: ApiContext,
  query: BoardScopeQueryIn,
): Promise<MemberBoard> {
  const { space, members } = await memberBoardScope(state, c, query);
  try {
    return { space, ...(await build(state, members ?? undefined)) };
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot build a member board");
    throw ApiError.unavailable("贊助排行榜現在打不開");
  }
}

/** `GET /api/public/board`; served only while the public side is on (see `rpc.ts`). */
export const boardRpc = {
  board: os.public.board.handler(async ({ context }) => {
    const { state, c } = context;
    const side = state.publicSide;
    const wait = side.admit(side.client(c));
    if (wait !== null) throw ApiError.tooMany(wait);
    context.resHeaders?.set(
      "cache-control",
      `public, max-age=${Math.ceil(side.config.cache_secs)}`,
    );
    context.resHeaders?.set("x-content-type-options", "nosniff");
    return board(state);
  }),
};
