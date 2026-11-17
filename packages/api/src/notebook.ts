// What the memory module added in V4 (docs/design/v4-plan.md §5), read-only:
//
// * `GET /api/notebook`: the pages of her notebook, newest change first. Only pages she wrote for
//   herself (no place) are readable here: a page written in a DM or in a guild belongs to that
//   place and the notebook only reads it from there, so the panel does not show it.
// * `GET /api/notebook/page?path=`: one such page with its text.
// * `GET /api/recent?context=`: the "just now" timeline as she reads it from `context` (a JSON
//   context key): what she did and what happened around her lately. Lines from a DM are left out
//   and counted, because the panel is not where she may quote them.

import { JustNowKey, NotebookKey, toTimestamp } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { contextParam } from "./extract.js";
import type { ApiState } from "./state.js";

/** Pages a person may read from nowhere: her own. */
const HER_OWN = { context: null } as const;

function notebook(state: ApiState) {
  return state.service(NotebookKey, "memory module (her notebook)");
}

/** The notebook routes on the route table (`@miyoria/contracts/api`). */
export const notebookRpc = {
  pages: os.notebook.pages.handler(({ context }) => ({
    pages: notebook(context.state).index(HER_OWN),
  })),
  page: os.notebook.page.handler(({ input, context }) => {
    const { path } = input.query;
    const page = notebook(context.state).read(path, HER_OWN);
    if (page === null) throw ApiError.notFound(`no page \`${path.slice(0, 80)}\` of hers`);
    return page;
  }),
};

export const recentRpc = os.recent.handler(async ({ input, context }) => {
  const where = contextParam(input.query.context);
  if (where === null) throw ApiError.badRequest("`context` is required");
  const state = context.state;
  const timeline = state.service(JustNowKey, "memory module (the just-now timeline)");
  const all = await timeline.entries({
    context: where,
    present: [],
    now: toTimestamp(state.now()),
  });
  return {
    entries: all.filter((e) => !e.private),
    private_hidden: all.filter((e) => e.private).length,
  };
});
