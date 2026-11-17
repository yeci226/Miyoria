// Her inner life, read-only: `GET /api/self` (drives, boredom, policy, agenda, mood, and her
// impressions of people from the heart's rows)
// and `GET /api/world` (what she perceives). Changes go through her own decisions (and, later,
// the action gate), not through these routes.

import type { FeelingView, SelfView, WorldView } from "@miyoria/contracts/api";
import { PeopleDirectoryKey } from "@miyoria/heart/person";
import { PlatformSinksKey, SelfStateKey, WorldStateKey } from "@miyoria/types";
import { os } from "./contract.js";
import { heartRows } from "./heart-rows.js";
import type { ApiState } from "./state.js";

/** Her impressions of people: the heart rows that have one, most recently changed first. */
function feelingsOf(state: ApiState): FeelingView[] {
  const heart = heartRows(state);
  if (heart === null) return [];
  const directory = state.optional(PeopleDirectoryKey);
  const out: FeelingView[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = heart.list({ offset, limit: 200 });
    for (const { person: p } of page.entries) {
      if (p.impression.trim() === "") continue;
      out.push({
        person: p.person_id,
        text: p.impression,
        updated_at: p.updated_at,
        display_name: directory?.displayName(p.person_id) ?? null,
      });
    }
    offset = page.next;
  }
  return out.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

function selfView(state: ApiState): SelfView {
  const self = state.service(SelfStateKey, "self module");
  return { ...self.snapshot(), feelings: feelingsOf(state) };
}

async function worldView(state: ApiState): Promise<WorldView> {
  const snapshot = state.service(WorldStateKey, "world module").snapshot();
  const sinks = state.optional(PlatformSinksKey);
  const channels = await Promise.all(
    snapshot.channels.map(async (c) => {
      let label: string | null = null;
      try {
        label = await state.labels.label(sinks, c.context);
      } catch {
        label = null;
      }
      return { ...c, label };
    }),
  );
  return { ...snapshot, channels };
}

/** `GET /api/self`, on the route table. */
export const selfRpc = os.self.handler(({ context }) => selfView(context.state));

/** `GET /api/world`, on the route table. */
export const worldRpc = os.world.handler(({ context }) => worldView(context.state));
