// The `legacy` tables' parts of the data categories (`data.ts`): relationships, their changes and
// the member page's cards (snapshots of the relationship, which go with it), and what she called
// each person (`call_names`, cleared while the relationship stays). Since phase 4 step 5 nothing
// writes `relationships` or `relationship_deltas` (the heart's `heart_person` holds what she feels
// and what she calls people; only the heart's migration reads them): they are listed here so the
// data page can still export and delete them. Step 14 of v5-data §8 removes them with the schema.

import type { CategoryData } from "../data.js";
import { tablePart } from "../data.js";

export const legacyData: readonly CategoryData[] = [
  {
    category: "relationships",
    parts: [
      tablePart("relationships", "relationships", "profile", "updated_at", "person_id", {
        person_id: "text",
        affinity: "num",
        trust: "num",
        familiarity: "num",
        tags: "json",
        notes: "text",
        call_name: "text",
        interactions: "num",
        last_interaction: "ts",
        updated_at: "ts",
      }),
      tablePart("relationship_deltas", "relationship_deltas", "profile", "at", "seq", {
        person_id: "text",
        at: "ts",
        affinity: "num",
        trust: "num",
        familiarity: "num",
        reason: "text",
      }),
      tablePart("member_cards", "member_cards", "profile", "issued_at", "issued_at, serial", {
        serial: "text",
        author_platform: "text",
        author_id: "text",
        person_id: "text",
        issued_at: "ts",
        snapshot: "json",
      }),
    ],
  },
  {
    category: "call_names",
    parts: [{ kind: "call_names", id: "call_names", table: "relationships", rows: "profile" }],
  },
];
