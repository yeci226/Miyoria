// Which server a member block of the economy is about, and for a board which of its two forms
// (docs/design/v5-places.md §2): one server's members (`這個伺服器`, the default for someone who is
// a member somewhere) or everyone (`全部`, as on the public site). The coins and prices behind
// either list are the same global ones; only who is listed differs.
//
//     const s = useOwnSpace();                     // predictions, bounties: one server of theirs
//     const b = useBoardScope();                   // a board: a server of theirs, or everyone
//     <BoardScopePicker scope={b} />
//     useQuery({ queryKey: [...BOARD, ...b.key], queryFn: () => api.rpc.wallet.boardView({ query: b.query }) });
//
// `space` is sent only when it is one of theirs: someone who is a member nowhere asks with none
// and gets the Core's default (a server's id that is not theirs would be a 403).

import { useState } from "react";
import { Segmented } from "@/components/ui/segmented";
import { SpacePicker, useMemberSpace } from "./member-space";

/** The server of a member block: one of theirs, or `undefined` (the Core's default). */
export function useOwnSpace() {
  const s = useMemberSpace();
  const space = s.space !== null && s.spaces.some((x) => x.id === s.space) ? s.space : undefined;
  return { ...s, space, key: [space ?? null] as const };
}

export type BoardScope = "space" | "all";

const SCOPES: { value: BoardScope; label: string }[] = [
  { value: "space", label: "這個伺服器" },
  { value: "all", label: "全部" },
];

export function useBoardScope() {
  const own = useOwnSpace();
  const [picked, setScope] = useState<BoardScope>("space");
  // Someone who is a member nowhere has only everyone's list.
  const scope: BoardScope = own.spaces.length === 0 ? "all" : picked;
  const query = scope === "all" ? { scope } : own.space === undefined ? {} : { space: own.space };
  return { ...own, scope, setScope, query, key: [scope, scope === "all" ? null : (own.space ?? null)] as const };
}

/**
 * The two forms of a board, and which of their servers when it is one server's. Nothing for
 * someone who is a member nowhere (they only have everyone's); the server choice only with two or
 * more servers.
 */
export function BoardScopePicker({ scope: b }: { scope: ReturnType<typeof useBoardScope> }) {
  if (b.spaces.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented label="範圍" value={b.scope} options={SCOPES} onChange={b.setScope} />
      {b.scope === "space" && <SpacePicker value={b.space ?? null} spaces={b.spaces} onChange={b.setSpace} />}
    </div>
  );
}
