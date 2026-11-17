// The artifact tables' parts of the data categories (`data.ts`): the files she makes, as their
// records, their share tokens (never the token's hash) and their blobs' rows, dependents first.
// Deleting them leaves the bytes on disk to the sweep, which removes a blob file without a row once
// it is older than its grace. The inventory's breakdown is the live artifacts by kind, and
// `bytes`, the size of every stored blob.

import { type CategoryData, tablePart } from "../data.js";

export const artifactData: readonly CategoryData[] = [
  {
    category: "artifacts",
    parts: [
      tablePart("artifact_shares", "artifact_shares", "node", "created_at", "created_at, id", {
        id: "text",
        artifact_id: "text",
        audience: "text",
        person_id: "text",
        space_id: "text",
        mode: "text",
        event_id: "text",
        created_at: "ts",
        expires_at: "ts",
        revoked_at: "ts",
        uses: "num",
        max_uses: "num",
        last_used_at: "ts",
      }),
      tablePart("artifacts", "artifact_items", "node", "created_at", "created_at, id", {
        id: "text",
        sha256: "text",
        size: "num",
        mime: "text",
        kind: "text",
        filename: "text",
        source: "text",
        plugin: "text",
        derived_from: "text",
        turn: "text",
        event_id: "text",
        made_for: "text",
        origin_session: "text",
        space_id: "text",
        room_id: "text",
        scope: "text",
        downloadable: "bool",
        review: "text",
        created_at: "ts",
        expires_at: "ts",
        kept_by: "text",
        deleted_at: "ts",
      }),
      tablePart("artifact_blobs", "artifact_blobs", "node", "stored_at", "stored_at, sha256", {
        sha256: "text",
        size: "num",
        location: "text",
        stored_at: "ts",
      }),
    ],
    breakdown: {
      sql:
        "SELECT kind, COUNT(*) AS n FROM artifact_items WHERE deleted_at IS NULL GROUP BY kind " +
        "UNION ALL SELECT 'bytes' AS kind, COALESCE(SUM(size), 0) AS n FROM artifact_blobs",
      params: [],
    },
    // `ARTIFACT_EVENTS`: what was made, expired, taken down, swept and shared.
    keptEvents: "type GLOB 'artifact.*' OR type GLOB 'share.*'",
  },
];
