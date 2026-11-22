// The `karaoke` plugin's migrations (docs/design/v5-data.md §3.2, karaoke.md).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// karaoke` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle tables agree.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`karaoke_requests\` (
	\`id\` text PRIMARY KEY,
	\`person_id\` text NOT NULL,
	\`song_id\` text NOT NULL,
	\`created_at\` integer NOT NULL
) STRICT;

CREATE TABLE \`karaoke_results\` (
	\`session_id\` text PRIMARY KEY,
	\`song_id\` text NOT NULL,
	\`person_id\` text,
	\`total\` real NOT NULL,
	\`pitch\` real NOT NULL,
	\`stability\` real NOT NULL,
	\`rhythm\` real NOT NULL,
	\`expression\` real NOT NULL,
	\`unranked\` integer DEFAULT false NOT NULL,
	\`reasons\` text DEFAULT '[]' NOT NULL,
	\`detail\` text NOT NULL,
	\`client_total\` real,
	\`best_before\` real,
	\`comment_state\` text NOT NULL,
	\`comment\` text,
	\`channel\` text,
	\`noted_at\` integer,
	\`comment_at\` integer,
	\`created_at\` integer NOT NULL,
	CONSTRAINT "karaoke_results_comment_check" CHECK("comment_state" IN ('waiting', 'said', 'none'))
) STRICT;

CREATE TABLE \`karaoke_sessions\` (
	\`id\` text PRIMARY KEY,
	\`song_id\` text NOT NULL,
	\`person_id\` text,
	\`platform\` text NOT NULL,
	\`account_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`status\` text NOT NULL,
	\`started_at\` integer NOT NULL,
	\`expires_at\` integer NOT NULL,
	\`scored_at\` integer,
	CONSTRAINT "karaoke_sessions_status_check" CHECK("status" IN ('open', 'scored'))
) STRICT;

CREATE TABLE \`karaoke_songs\` (
	\`id\` text PRIMARY KEY,
	\`source_key\` text NOT NULL,
	\`source\` text NOT NULL,
	\`title\` text DEFAULT '' NOT NULL,
	\`artist\` text,
	\`duration_ms\` integer,
	\`status\` text NOT NULL,
	\`job\` text,
	\`worker_song\` text,
	\`error\` text,
	\`error_detail\` text,
	\`lyrics\` integer DEFAULT false NOT NULL,
	\`notes\` integer DEFAULT 0 NOT NULL,
	\`requested_by\` text,
	\`created_at\` integer NOT NULL,
	\`ready_at\` integer,
	\`used_at\` integer,
	CONSTRAINT "karaoke_songs_status_check" CHECK("status" IN ('preparing', 'ready', 'failed'))
) STRICT;

CREATE TABLE \`karaoke_tracks\` (
	\`session_id\` text PRIMARY KEY,
	\`hz\` integer NOT NULL,
	\`frames\` text NOT NULL,
	\`latency_ms\` integer NOT NULL,
	\`calibrated\` integer NOT NULL,
	\`browser\` text DEFAULT '' NOT NULL,
	\`submitted_at\` integer NOT NULL,
	\`purge_at\` integer NOT NULL
) STRICT;

CREATE INDEX \`karaoke_requests_person_idx\` ON \`karaoke_requests\` (\`person_id\`,\`created_at\`);

CREATE INDEX \`karaoke_results_person_idx\` ON \`karaoke_results\` (\`person_id\`,\`song_id\`,\`created_at\`);

CREATE INDEX \`karaoke_results_comment_idx\` ON \`karaoke_results\` (\`comment_state\`,\`channel\`,\`noted_at\`);

CREATE INDEX \`karaoke_sessions_account_idx\` ON \`karaoke_sessions\` (\`platform\`,\`account_id\`,\`started_at\`);

CREATE INDEX \`karaoke_sessions_person_idx\` ON \`karaoke_sessions\` (\`person_id\`);

CREATE UNIQUE INDEX \`karaoke_songs_source_idx\` ON \`karaoke_songs\` (\`source_key\`);

CREATE INDEX \`karaoke_songs_status_idx\` ON \`karaoke_songs\` (\`status\`,\`created_at\`);

CREATE INDEX \`karaoke_tracks_purge_idx\` ON \`karaoke_tracks\` (\`purge_at\`);
`;

/** Step 2: the key a session is sung in, and where a song's lyrics came from. */
const KEY_AND_LYRICS = `ALTER TABLE \`karaoke_sessions\` ADD \`shift\` integer DEFAULT 0 NOT NULL;
ALTER TABLE \`karaoke_songs\` ADD \`lyrics_source\` text;
`;

/**
 * Step 3: a song's background video, and the official score from a recording of the singer (which
 * score a result is, what became of the recording, the estimate it replaced, what its checks found,
 * and its pitch beside the browser's).
 */
const VIDEO_AND_VOICE = `ALTER TABLE \`karaoke_results\` ADD \`source\` text DEFAULT 'estimate' NOT NULL;
ALTER TABLE \`karaoke_results\` ADD \`voice_state\` text DEFAULT 'none' NOT NULL;
ALTER TABLE \`karaoke_results\` ADD \`estimate_total\` real;
ALTER TABLE \`karaoke_results\` ADD \`checks\` text DEFAULT '[]' NOT NULL;
ALTER TABLE \`karaoke_songs\` ADD \`video\` integer DEFAULT false NOT NULL;
ALTER TABLE \`karaoke_tracks\` ADD \`voice_frames\` text;
`;

/**
 * Step 4: rooms, their rounds and what the rounds pay, and the room a session was sung in. (Written
 * in drizzle-kit's form by hand: its pending mode asks whether a new table is a rename; the drift
 * test checks it against the tables.)
 */
const ROOMS = `CREATE TABLE \`karaoke_rooms\` (
	\`id\` text PRIMARY KEY,
	\`code\` text NOT NULL,
	\`opener_person\` text,
	\`opener_platform\` text NOT NULL,
	\`opener_account\` text NOT NULL,
	\`opener_name\` text NOT NULL,
	\`state\` text NOT NULL,
	\`charge\` text NOT NULL,
	\`price\` integer NOT NULL,
	\`sung\` integer DEFAULT false NOT NULL,
	\`rounds\` integer DEFAULT 0 NOT NULL,
	\`refund\` text DEFAULT 'none' NOT NULL,
	\`close_reason\` text,
	\`created_at\` integer NOT NULL,
	\`closed_at\` integer,
	CONSTRAINT "karaoke_rooms_state_check" CHECK("state" IN ('open', 'closed')),
	CONSTRAINT "karaoke_rooms_charge_check" CHECK("charge" IN ('charging', 'charged', 'free', 'failed')),
	CONSTRAINT "karaoke_rooms_refund_check" CHECK("refund" IN ('none', 'due', 'done'))
) STRICT;

CREATE TABLE \`karaoke_room_rounds\` (
	\`room_id\` text NOT NULL,
	\`round\` integer NOT NULL,
	\`song_id\` text NOT NULL,
	\`shift\` integer DEFAULT 0 NOT NULL,
	\`state\` text NOT NULL,
	\`started_at\` integer NOT NULL,
	\`settled_at\` integer,
	\`result\` text,
	CONSTRAINT \`karaoke_room_rounds_pk\` PRIMARY KEY(\`room_id\`, \`round\`),
	CONSTRAINT "karaoke_room_rounds_state_check" CHECK("state" IN ('singing', 'settled', 'void'))
) STRICT;

CREATE TABLE \`karaoke_room_payouts\` (
	\`room_id\` text NOT NULL,
	\`round\` integer NOT NULL,
	\`person_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`platform\` text NOT NULL,
	\`account_id\` text NOT NULL,
	\`amount\` integer NOT NULL,
	\`state\` text NOT NULL,
	\`paid\` integer DEFAULT 0 NOT NULL,
	\`created_at\` integer NOT NULL,
	\`paid_at\` integer,
	CONSTRAINT \`karaoke_room_payouts_pk\` PRIMARY KEY(\`room_id\`, \`round\`, \`person_id\`, \`kind\`),
	CONSTRAINT "karaoke_room_payouts_kind_check" CHECK("kind" IN ('prize', 'finish')),
	CONSTRAINT "karaoke_room_payouts_state_check" CHECK("state" IN ('due', 'paid', 'capped', 'refused'))
) STRICT;

ALTER TABLE \`karaoke_sessions\` ADD \`room_id\` text;

CREATE INDEX \`karaoke_rooms_state_idx\` ON \`karaoke_rooms\` (\`state\`,\`created_at\`);

CREATE INDEX \`karaoke_room_rounds_state_idx\` ON \`karaoke_room_rounds\` (\`state\`);

CREATE INDEX \`karaoke_room_payouts_state_idx\` ON \`karaoke_room_payouts\` (\`state\`);
`;

/**
 * Step 6: a song's edited reference and the record of its saves and restores. (Written in
 * drizzle-kit's form by hand, like migration 4; the drift test checks it against the tables.)
 */
const REFERENCE_EDITS = `CREATE TABLE \`karaoke_references\` (
	\`song_id\` text PRIMARY KEY,
	\`reference\` text NOT NULL,
	\`pitch_shift\` integer DEFAULT 0 NOT NULL,
	\`revision\` integer NOT NULL,
	\`base_hash\` text NOT NULL,
	\`worker_hash\` text,
	\`saved_person\` text,
	\`saved_name\` text NOT NULL,
	\`saved_at\` integer NOT NULL
) STRICT;

CREATE TABLE \`karaoke_reference_edits\` (
	\`id\` text PRIMARY KEY,
	\`song_id\` text NOT NULL,
	\`action\` text NOT NULL,
	\`revision\` integer NOT NULL,
	\`lines\` integer NOT NULL,
	\`notes\` integer NOT NULL,
	\`pitch_shift\` integer NOT NULL,
	\`person_id\` text,
	\`name\` text NOT NULL,
	\`at\` integer NOT NULL,
	CONSTRAINT "karaoke_reference_edits_action_check" CHECK("action" IN ('save', 'restore'))
) STRICT;

CREATE INDEX \`karaoke_reference_edits_song_idx\` ON \`karaoke_reference_edits\` (\`song_id\`,\`at\`);
`;

/**
 * Step 6 of phase 6 (docs/design/v5-places.md §10): a room belongs to the server it was opened in.
 * A room row names no channel or server of its own (its notice's channel was never kept), so every
 * room from before goes to the primary Space (identity v2 chose it); a database with no Space yet
 * keeps `NULL`. A column only: no row moves or goes. Songs, references and scores stay each
 * person's, in every server.
 */
const SPACES = `ALTER TABLE \`karaoke_rooms\` ADD \`space_id\` text REFERENCES spaces(id);

UPDATE karaoke_rooms SET space_id = (SELECT id FROM spaces WHERE is_primary = 1)
WHERE space_id IS NULL;
`;

/**
 * The songs, requests, sessions, tracks and results; since migration 4 the rooms; since migration
 * 5 the edited references; since migration 6 the server of a room.
 */
export const karaokeSchema: PluginSchema = {
  plugin: "karaoke",
  requires: ["identity"],
  migrations: [
    { version: 1, name: "init", sql: INIT },
    { version: 2, name: "key_and_lyrics", sql: KEY_AND_LYRICS },
    { version: 3, name: "video_and_voice", sql: VIDEO_AND_VOICE },
    { version: 4, name: "rooms", sql: ROOMS },
    { version: 5, name: "reference_edits", sql: REFERENCE_EDITS },
    { version: 6, name: "spaces", sql: SPACES },
  ],
};
