// Which list a board command shows (phase 6, docs/design/v5-places.md §2): a board exists for
// everyone and narrowed to one server's members. `/me board` and `/me market rich` take the same
// option, `範圍: 這個伺服器|全部`; in a server the default is that server's list, in a DM everyone's.
// The coins behind either list are the one global wallet; only who is listed differs.

import type { ContextKey, PersonId, Places } from "@miyoria/types";
import { ArgKind, type ArgSpec, argSpec } from "./spec.js";

/** The option's name. */
export const BOARD_SCOPE_ARG = "範圍";
/** Its two choices: this server's members, everyone. */
export const BOARD_SCOPES = ["這個伺服器", "全部"] as const;

/** The `範圍` option of a board command. */
export function boardScopeArg(): ArgSpec {
  return argSpec(
    BOARD_SCOPE_ARG,
    "看這個伺服器的榜還是全部的(預設:伺服器裡是這個伺服器,私訊是全部)",
    ArgKind.choice(BOARD_SCOPES),
    { required: false },
  );
}

/** What a board command shows. */
export interface BoardScope {
  /** The server whose members are listed (identity's `spaces.id`); `null`: everyone. */
  space: string | null;
  /** Those members; `null`: everyone. */
  members: ReadonlySet<PersonId> | null;
  /** A muted line under the list saying which list it is; `""` without `Places` (one list). */
  label: string;
}

/**
 * The list a board command run in `context` shows with `asked` (the option's value, or `null`):
 * `全部` is everyone; otherwise, in a server she knows, that server's members; a DM, or a server
 * she has no record of, is everyone.
 */
export function boardScope(
  places: Places | undefined,
  context: ContextKey,
  asked: string | null,
): BoardScope {
  if (!places) return { space: null, members: null, label: "" };
  const everyone: BoardScope = { space: null, members: null, label: "範圍:全部" };
  if (asked === "全部" || context.scope === null) {
    if (asked === "這個伺服器" && context.scope === null) {
      return { ...everyone, label: "私訊裡沒有伺服器,這是全部的榜" };
    }
    return everyone;
  }
  const space =
    places.at(context)?.space_id ?? places.ofGuild(context.platform, context.scope)?.id ?? null;
  if (space === null) return everyone;
  return {
    space,
    members: places.members(space),
    label: `範圍:這個伺服器(${BOARD_SCOPE_ARG}選「全部」看所有人)`,
  };
}
