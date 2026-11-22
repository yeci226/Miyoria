// `look(place)`: what waits for her in another place (a Space), in detail (docs/design/
// v5-places.md §9). At home her inbox shows the other places only merged, one line each with a
// count; this reads one of them, as far as the place rule of memory allows from where she is.
//
// The rule is memory's own (`disclose`, packages/memory/memory/src/places.ts), with the run's
// place as the viewer, the home place included: home belongs to no Space for her inbox, but the
// place she writes in at home is a real channel or DM whose readers would hear what she says.
//
// * Each item's origin is its place, or for an item of the Space with no place (a voice event put
//   in her home) the Space itself. An item is shown only when `disclose(origin, viewer)` is
//   `show`: from a channel of the same server (unless the owner hid that channel or someone here
//   cannot see it); from a DM, only what the person she is talking with took part in. Another
//   server seen from a server's channel is never shown.
// * Nothing shown: the call is refused, visibly, with how many there are (as the merged line
//   says). An unknown place, or one she has left, is refused too.
// * At most `LOOK_MAX` items, the newest. The answer starts with `ELSEWHERE_MARK` and says whose
//   they are and where they may be told; memory's segment pass leaves such an answer out, so what
//   she read never becomes a note of the place she read it in.
// * Reading marks nothing seen: the items still wait for a run in their own place.

import { defineTool, type Tool, type ToolContext, type ToolResult } from "@miyoria/llm/tools";
import { disclose, ELSEWHERE_MARK, type Viewer } from "@miyoria/memory/memory";
import {
  type ContextKey,
  dataBlock,
  type JsonValue,
  type Places,
  type SpaceRef,
} from "@miyoria/types";
import { z } from "zod";
import type { InboxRow } from "./initiative-schema.js";
import { INBOX_LABELS, LOOK_TOOL } from "./initiative-texts.js";
import { localWhen } from "./schedule.js";

export const LOOK = "look";
/** Items one look shows at most. */
export const LOOK_MAX = 8;
/** Items one look reads to choose them from (the newest). */
const LOOK_SCAN = 50;

export interface LookDeps {
  store: {
    unseenOfSpace(space: string, max: number): InboxRow[];
    countOfSpace(space: string): number;
  };
  /** Identity's Spaces; `null`: Core has none. */
  places(): Places | null;
  /** The viewer of the place rule for a run at `ctx.context`. */
  viewer(ctx: ToolContext): Viewer;
  /** Her clock (`localWhen`). */
  offsetMinutes: number;
}

const Params = z.object({ place: z.string().describe(LOOK_TOOL.place) });

const refused = (text: string): ToolResult => ({ ok: false, code: "denied", stage: "place", text });

/** A name as she may write it: any case and width, no spaces. */
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** The active Space `name` means: its id, its guild id, or its one name. */
export function findSpace(places: Places, name: string): SpaceRef | null {
  const raw = name.trim();
  if (raw === "") return null;
  const spaces = places.spaces();
  const exact = spaces.find((s) => s.id === raw || s.external_id === raw);
  if (exact !== undefined) return exact;
  const named = spaces.filter((s) => norm(s.name) === norm(raw));
  return named.length === 1 ? (named[0] ?? null) : null;
}

/** Where an item happened, for the place rule: its place, else its Space as a place. */
function originOf(row: InboxRow, space: SpaceRef): ContextKey {
  return (
    row.context ?? {
      platform: space.platform,
      scope: space.external_id,
      channel: "",
      kind: "channel",
    }
  );
}

/** Whether `row` may be shown to `viewer`. */
export function lookable(row: InboxRow, space: SpaceRef, viewer: Viewer): boolean {
  const involves = row.person === null ? [] : [row.person];
  // An item with no channel of its own has no channel anyone could be kept out of.
  const as = row.context === null ? { ...viewer, access: null } : viewer;
  return disclose(originOf(row, space), as, involves) === "show";
}

export function lookTool(deps: LookDeps): Tool {
  const run = async (ctx: ToolContext, raw: JsonValue): Promise<ToolResult> => {
    const args = Params.safeParse(raw);
    if (!args.success || args.data.place.trim() === "") {
      return { ok: false, code: "failed", stage: null, text: LOOK_TOOL.empty };
    }
    const name = args.data.place.trim();
    const places = deps.places();
    if (places === null) return refused(LOOK_TOOL.noPlaces);
    const space = findSpace(places, name);
    if (space === null) return refused(LOOK_TOOL.unknown(name));
    const total = deps.store.countOfSpace(space.id);
    if (total === 0) return { ok: true, text: LOOK_TOOL.nothing(space.name) };
    const viewer = deps.viewer(ctx);
    const rows = deps.store.unseenOfSpace(space.id, LOOK_SCAN);
    const shown = rows.filter((r) => lookable(r, space, viewer));
    if (shown.length === 0) return refused(LOOK_TOOL.refused(space.name, total));
    const listed = shown.slice(0, LOOK_MAX).reverse();
    const lines = listed.map((r) => {
      const at = localWhen(Date.parse(r.created_at), deps.offsetMinutes);
      return `- ${at} ${INBOX_LABELS[r.kind]}:${r.text.replace(/\s+/g, " ")}`;
    });
    const withheld = rows.length - shown.length;
    const older = total - rows.length + (shown.length - listed.length);
    const tail = [
      withheld > 0 ? LOOK_TOOL.withheld(withheld) : null,
      older > 0 ? LOOK_TOOL.older(older) : null,
    ].filter((t): t is string => t !== null);
    return {
      ok: true,
      text: [
        `${ELSEWHERE_MARK}${LOOK_TOOL.origin(space.name)}`,
        dataBlock("look", LOOK_TOOL.title(space.name), lines.join("\n")),
        ...tail,
      ].join("\n"),
    };
  };
  const tool = defineTool({
    name: LOOK,
    description: LOOK_TOOL.description,
    parameters: Params,
    effect: "read",
    speed: "instant",
    risk: "low",
    group: "schedule",
    core: true,
    next: true,
    readOnly: true,
    framed: true,
    async call(ctx, raw) {
      const result = await run(ctx, raw);
      if (!result.ok) throw new Error(result.text);
      return result.text;
    },
  });
  return { ...tool, result: run };
}
