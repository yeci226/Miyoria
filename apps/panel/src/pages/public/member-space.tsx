// Which server a member block is about (docs/design/v5-places.md §6): the person's own servers from
// `GET /api/member/spaces`, the one they picked last in this browser, else the Core's default.
// The public site has no router, so the choice is page state, remembered per browser.
//
//     const { space, spaces, setSpace } = useMemberSpace();
//     <SpacePicker value={space} spaces={spaces} onChange={setSpace} />
//     useQuery({ queryKey: [...AUCTION, space], queryFn: () => api.rpc.market.auction({ query: { space: space ?? undefined } }) });
//
// `SpacePicker` draws nothing for someone in one server or none, so a single-server install looks
// as it did.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Space } from "@miyoria/contracts/api";
import { isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { readStorage, writeStorage } from "@/lib/storage";

export const MEMBER_SPACES = ["member", "spaces"] as const;
const SPACE_KEY = "miyoria.member.space";
/** Up to this many servers side by side; more go in a select. */
const SEGMENTED_MAX = 4;

/** Their servers. A Core without the route answers as a single-server one. */
export function useMemberSpaces() {
  const api = useApi();
  return useQuery({
    queryKey: MEMBER_SPACES,
    queryFn: async ({ signal }) => {
      try {
        return await api.rpc.member.spaces(undefined, { signal });
      } catch (e) {
        if (isNotProvided(e)) return { spaces: [], default: null };
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: (n, e) => !isNotProvided(e) && n < 2,
  });
}

export interface MemberSpaceState {
  /** The server the block is about; `null` while unknown, or when the Core has none (leave `space` out). */
  space: string | null;
  spaces: Space[];
  setSpace: (id: string) => void;
  loading: boolean;
}

export function useMemberSpace(): MemberSpaceState {
  const query = useMemberSpaces();
  const [picked, setPicked] = useState<string | null>(() => readStorage(SPACE_KEY));
  const spaces = query.data?.spaces ?? [];
  const space = spaces.some((s) => s.id === picked) ? picked : (query.data?.default ?? null);
  const setSpace = (id: string) => {
    setPicked(id);
    writeStorage(SPACE_KEY, id);
  };
  return { space, spaces, setSpace, loading: query.isPending };
}

/**
 * A choice of the person's servers, for a block that is per server. Nothing at all with one server
 * or none. Up to four as a `Segmented`, more in a `Select` (as the settings' choices are drawn).
 */
export function SpacePicker({
  value,
  spaces,
  onChange,
  label = "伺服器",
  className,
}: {
  value: string | null;
  spaces: readonly Space[];
  onChange: (id: string) => void;
  label?: string;
  className?: string;
}) {
  if (spaces.length <= 1) return null;
  if (spaces.length <= SEGMENTED_MAX) {
    return (
      <Segmented
        label={label}
        value={value}
        options={spaces.map((s) => ({ value: s.id, label: s.name, title: s.name }))}
        onChange={onChange}
        className={className}
      />
    );
  }
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger aria-label={label} size="sm" className={className ?? "w-48"}>
        <SelectValue placeholder="選一個伺服器" />
      </SelectTrigger>
      <SelectContent>
        {spaces.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
