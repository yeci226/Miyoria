// The `artifact` plugin's migrations (docs/design/v5-data.md §5).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// artifact` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The drift test proves the migrated database
// and the Drizzle tables agree. The tables carry the plugin's prefix and point only at their own
// and identity's tables.

import type { PluginSchema } from "../migrate.js";

const INIT = `CREATE TABLE \`artifact_blobs\` (
	\`sha256\` text PRIMARY KEY,
	\`size\` integer NOT NULL,
	\`location\` text DEFAULT 'local' NOT NULL,
	\`stored_at\` integer NOT NULL,
	CONSTRAINT "artifact_blobs_sha256_check" CHECK(length("sha256") = 64 AND "sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "artifact_blobs_size_check" CHECK("size" > 0)
) STRICT;

CREATE TABLE \`artifact_items\` (
	\`id\` text PRIMARY KEY,
	\`sha256\` text NOT NULL,
	\`size\` integer NOT NULL,
	\`mime\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`filename\` text NOT NULL,
	\`source\` text NOT NULL,
	\`plugin\` text NOT NULL,
	\`derived_from\` text,
	\`turn\` text,
	\`event_id\` text NOT NULL,
	\`made_for\` text,
	\`origin_session\` text,
	\`space_id\` text,
	\`room_id\` text,
	\`scope\` text NOT NULL,
	\`downloadable\` integer DEFAULT true NOT NULL,
	\`review\` text DEFAULT 'pending' NOT NULL,
	\`created_at\` integer NOT NULL,
	\`expires_at\` integer,
	\`kept_by\` text,
	\`deleted_at\` integer,
	CONSTRAINT \`fk_artifact_items_sha256_artifact_blobs_sha256_fk\` FOREIGN KEY (\`sha256\`) REFERENCES \`artifact_blobs\`(\`sha256\`),
	CONSTRAINT \`fk_artifact_items_derived_from_artifact_items_id_fk\` FOREIGN KEY (\`derived_from\`) REFERENCES \`artifact_items\`(\`id\`) ON DELETE SET NULL,
	CONSTRAINT \`fk_artifact_items_made_for_persons_id_fk\` FOREIGN KEY (\`made_for\`) REFERENCES \`persons\`(\`id\`),
	CONSTRAINT \`fk_artifact_items_space_id_spaces_id_fk\` FOREIGN KEY (\`space_id\`) REFERENCES \`spaces\`(\`id\`),
	CONSTRAINT \`fk_artifact_items_room_id_rooms_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`rooms\`(\`id\`),
	CONSTRAINT "artifact_items_kind_check" CHECK("kind" IN ('image','audio','video','document','text')),
	CONSTRAINT "artifact_items_source_check" CHECK("source" IN ('imagegen','sandbox','cards','sing','clip','doc','render')),
	CONSTRAINT "artifact_items_scope_check" CHECK("scope" IN ('public','space','room','dm','self','owner')),
	CONSTRAINT "artifact_items_review_check" CHECK("review" IN ('pending','passed','blocked','taken_down')),
	CONSTRAINT "artifact_items_kept_by_check" CHECK("kept_by" IN ('album','person','owner','cards')),
	CONSTRAINT "artifact_items_size_check" CHECK("size" > 0),
	CONSTRAINT "artifact_items_retention_check" CHECK(("kept_by" IS NULL) <> ("expires_at" IS NULL)),
	CONSTRAINT "artifact_items_song_cover_check" CHECK("source" <> 'sing' OR "downloadable" = 0)
) STRICT;

CREATE TABLE \`artifact_shares\` (
	\`id\` text PRIMARY KEY,
	\`artifact_id\` text NOT NULL,
	\`token_hash\` text NOT NULL CONSTRAINT \`artifact_shares_token_hash_key\` UNIQUE,
	\`audience\` text NOT NULL,
	\`person_id\` text,
	\`space_id\` text,
	\`mode\` text NOT NULL,
	\`event_id\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`expires_at\` integer,
	\`revoked_at\` integer,
	\`uses\` integer DEFAULT 0 NOT NULL,
	\`max_uses\` integer,
	\`last_used_at\` integer,
	CONSTRAINT \`fk_artifact_shares_artifact_id_artifact_items_id_fk\` FOREIGN KEY (\`artifact_id\`) REFERENCES \`artifact_items\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_artifact_shares_person_id_persons_id_fk\` FOREIGN KEY (\`person_id\`) REFERENCES \`persons\`(\`id\`),
	CONSTRAINT \`fk_artifact_shares_space_id_spaces_id_fk\` FOREIGN KEY (\`space_id\`) REFERENCES \`spaces\`(\`id\`),
	CONSTRAINT "artifact_shares_audience_check" CHECK("audience" IN ('person','space','link')),
	CONSTRAINT "artifact_shares_mode_check" CHECK("mode" IN ('stream','download')),
	CONSTRAINT "artifact_shares_target_check" CHECK(("audience" <> 'person' OR "person_id" IS NOT NULL) AND ("audience" <> 'space' OR "space_id" IS NOT NULL)),
	CONSTRAINT "artifact_shares_uses_check" CHECK("uses" >= 0 AND ("max_uses" IS NULL OR "max_uses" >= 1))
) STRICT;

CREATE INDEX \`artifact_items_person_idx\` ON \`artifact_items\` (\`made_for\`,\`created_at\`);

CREATE INDEX \`artifact_items_space_idx\` ON \`artifact_items\` (\`space_id\`,\`created_at\`);

CREATE INDEX \`artifact_items_blob_idx\` ON \`artifact_items\` (\`sha256\`);

CREATE INDEX \`artifact_items_expiry_idx\` ON \`artifact_items\` (\`expires_at\`) WHERE "artifact_items"."expires_at" IS NOT NULL AND "artifact_items"."deleted_at" IS NULL;

CREATE INDEX \`artifact_items_deleted_idx\` ON \`artifact_items\` (\`deleted_at\`) WHERE "artifact_items"."deleted_at" IS NOT NULL;

CREATE INDEX \`artifact_shares_artifact_idx\` ON \`artifact_shares\` (\`artifact_id\`);
`;

/** Artifacts, their blobs and their share tokens. */
export const artifactSchema: PluginSchema = {
  plugin: "artifact",
  requires: ["identity"],
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
