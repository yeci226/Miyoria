// What the memory module added in V4 (docs/design/v4-plan.md §5), read-only:
//
// * `GET /api/notebook`: the pages of her notebook, newest change first. Only pages she wrote for
//   herself (no place) are readable here: a page written in a DM or in a guild belongs to that
//   place and the notebook only reads it from there, so the panel does not show it.
// * `GET /api/notebook/page?path=`: one such page with its text.
// * `GET /api/recent?context=`: the "just now" timeline as she reads it from `context` (a JSON
//   context key): what she did and what happened around her lately. Lines from a DM are left out
//   and counted, because the panel is not where she may quote them.

import {
  type JustNowEntry,
  JustNowKey,
  type NotebookEntry,
  NotebookKey,
  type NotebookPage,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { contextParam, readQuery } from "./extract.js";
import { json, type Route } from "./route.js";
import type { ApiState } from "./state.js";

const PageQuery = z.object({ path: z.string().min(1).max(300) });
const RecentQuery = z.object({ context: z.string().optional() });

/** Pages a person may read from nowhere: her own. */
const HER_OWN = { context: null } as const;

export interface RecentView {
  entries: JustNowEntry[];
  /** Lines left out because they came from a DM. */
  private_hidden: number;
}

function notebook(state: ApiState) {
  return state.service(NotebookKey, "memory module (her notebook)");
}

export function memoryV4Routes(state: ApiState): Route[] {
  return [
    {
      method: "GET",
      path: "/api/notebook",
      handler: () => {
        const pages: NotebookEntry[] = notebook(state).index(HER_OWN);
        return json({ pages });
      },
    },
    {
      method: "GET",
      path: "/api/notebook/page",
      handler: (c) => {
        const { path } = readQuery(c, PageQuery);
        const page: NotebookPage | null = notebook(state).read(path, HER_OWN);
        if (page === null) throw ApiError.notFound(`no page \`${path.slice(0, 80)}\` of hers`);
        return json(page);
      },
    },
    {
      method: "GET",
      path: "/api/recent",
      handler: async (c) => {
        const { context } = readQuery(c, RecentQuery);
        const where = contextParam(context);
        if (where === null) throw ApiError.badRequest("`context` is required");
        const timeline = state.service(JustNowKey, "memory module (the just-now timeline)");
        const all = await timeline.entries({
          context: where,
          present: [],
          now: toTimestamp(state.now()),
        });
        const view: RecentView = {
          entries: all.filter((e) => !e.private),
          private_hidden: all.filter((e) => e.private).length,
        };
        return json(view);
      },
    },
  ];
}
