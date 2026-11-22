// The tables of the `karaoke` plugin (docs/design/karaoke.md 「做了什麼(第一步)」), as Drizzle
// definitions: `migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added, and
// the store's drift test (`packages/store/test/drizzle-schemas.test.ts`) keeps the two together.
//
// - `karaoke_songs`: one row per song asked for (by its link or search): its worker job, the
//   worker's karaoke id, whether it is ready, and what its reference holds.
// - `karaoke_requests`: one row per preparation a person started, for the daily limit.
// - `karaoke_sessions`: one singing of one song by one person (single-player in this milestone),
//   in the key the singer chose (`shift`, migration 2).
// - `karaoke_tracks`: the pitch track a session sent: 50 Hz, one byte a frame, base64; deleted
//   after a week (`purge_at`).
// - `karaoke_results`: Core's score of a session, and her comment on it; since migration 3 which
//   score it is (`source`: `estimate` from the browser's track, `voice` from the recording of the
//   singer) and what became of the recording (`voice_state`).
// - `karaoke_references`, `karaoke_reference_edits` (migration 5): a song's edited reference and
//   the record of its saves and restores.
//
// No foreign key to `persons`: a person who asks to be forgotten loses their sessions, tracks and
// results through the plugin's hook; a song stays (it is nobody's).

import { micros, spaces } from "@miyoria/store";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const karaokeSongs = sqliteTable(
  "karaoke_songs",
  {
    id: text().primaryKey(),
    /** `url:<link>` or `query:<words>`, normalised: the same request is the same song. */
    source_key: text().notNull(),
    /** The link or the words as given. */
    source: text().notNull(),
    title: text().notNull().default(""),
    artist: text(),
    duration_ms: integer(),
    status: text().notNull(),
    /** The worker's job while preparing, and its karaoke song once done. */
    job: text(),
    worker_song: text(),
    /** Why it failed: a sentence for people, and the worker's own words for the owner. */
    error: text(),
    error_detail: text(),
    lyrics: integer({ mode: "boolean" }).notNull().default(false),
    /** `found` (looked up) or `heard` (transcribed: shown as 聽寫); `null` without lyrics or before step 2. */
    lyrics_source: text(),
    notes: integer().notNull().default(0),
    /** The worker made a background video for it (migration 3). */
    video: integer({ mode: "boolean" }).notNull().default(false),
    /** Who asked for it first. */
    requested_by: text(),
    created_at: micros().notNull(),
    ready_at: micros(),
    /** Last sung: the files kept on Core go a day after. */
    used_at: micros(),
  },
  (t) => [
    uniqueIndex("karaoke_songs_source_idx").on(t.source_key),
    index("karaoke_songs_status_idx").on(t.status, t.created_at),
    check("karaoke_songs_status_check", sql`${t.status} IN ('preparing', 'ready', 'failed')`),
  ],
);

export const karaokeRequests = sqliteTable(
  "karaoke_requests",
  {
    id: text().primaryKey(),
    person_id: text().notNull(),
    song_id: text().notNull(),
    created_at: micros().notNull(),
  },
  (t) => [index("karaoke_requests_person_idx").on(t.person_id, t.created_at)],
);

export const karaokeSessions = sqliteTable(
  "karaoke_sessions",
  {
    id: text().primaryKey(),
    song_id: text().notNull(),
    /** `null` for an account she has no person for. */
    person_id: text(),
    platform: text().notNull(),
    account_id: text().notNull(),
    /** Their display name when they started (untrusted). */
    name: text().notNull(),
    status: text().notNull(),
    started_at: micros().notNull(),
    expires_at: micros().notNull(),
    scored_at: micros(),
    /** Semitones the singer moved the key by (-6..6): the backing and the reference both moved. */
    shift: integer().notNull().default(0),
    /** The room it was sung in (migration 4), `null` alone: the room tells her of it, not the session. */
    room_id: text(),
  },
  (t) => [
    index("karaoke_sessions_account_idx").on(t.platform, t.account_id, t.started_at),
    index("karaoke_sessions_person_idx").on(t.person_id),
    check("karaoke_sessions_status_check", sql`${t.status} IN ('open', 'scored')`),
  ],
);

export const karaokeTracks = sqliteTable(
  "karaoke_tracks",
  {
    session_id: text().primaryKey(),
    hz: integer().notNull(),
    /** One byte a frame (0 = not voiced, else MIDI 24 + a quarter semitone a step), base64. */
    frames: text().notNull(),
    latency_ms: integer().notNull(),
    calibrated: integer({ mode: "boolean" }).notNull(),
    browser: text().notNull().default(""),
    submitted_at: micros().notNull(),
    purge_at: micros().notNull(),
    /** The recording's pitch, placed in song time, in the same form (migration 3); never the sound. */
    voice_frames: text(),
  },
  (t) => [index("karaoke_tracks_purge_idx").on(t.purge_at)],
);

export const karaokeResults = sqliteTable(
  "karaoke_results",
  {
    session_id: text().primaryKey(),
    song_id: text().notNull(),
    person_id: text(),
    total: real().notNull(),
    pitch: real().notNull(),
    stability: real().notNull(),
    rhythm: real().notNull(),
    expression: real().notNull(),
    /** Flagged as not sung: shown, never a best; `reasons` (JSON) are the owner's to see. */
    unranked: integer({ mode: "boolean" }).notNull().default(false),
    reasons: text().notNull().default("[]"),
    /** The whole result as JSON (the API's `KaraokeResult` without the comment). */
    detail: text().notNull(),
    client_total: real(),
    best_before: real(),
    /** `waiting`, `said`, `none`. */
    comment_state: text().notNull(),
    comment: text(),
    /** The channel she was told to comment in, and when she was told. */
    channel: text(),
    noted_at: micros(),
    comment_at: micros(),
    created_at: micros().notNull(),
    /** `estimate` (the browser's track) or `voice` (the recording: the official score). */
    source: text().notNull().default("estimate"),
    /** `none`, `waiting`, `scoring`, `scored`, `failed`: what became of the recording. */
    voice_state: text().notNull().default("none"),
    /** Core's score of the browser's track, kept when the recording's replaces it. */
    estimate_total: real(),
    /** What the checks of the recording found, shown to the singer (JSON: `quiet`, `bleed`). */
    checks: text().notNull().default("[]"),
  },
  (t) => [
    index("karaoke_results_person_idx").on(t.person_id, t.song_id, t.created_at),
    index("karaoke_results_comment_idx").on(t.comment_state, t.channel, t.noted_at),
    check("karaoke_results_comment_check", sql`${t.comment_state} IN ('waiting', 'said', 'none')`),
  ],
);

/**
 * A room (migration 4, docs/design/karaoke.md 「做了什麼第四步」): what has to outlive a restart of
 * Core so the coins come out right. Who is in it, the song and the live scores are in memory only;
 * a restart closes every open room.
 *
 * - `charge`: `charging` (the row is written before the opener is charged, so a crash in between
 *   still knows to give back whatever was taken), `charged`, `free` (no price), `failed` (not
 *   charged: nothing to give back).
 * - `sung`: a round of it was sung through (results settled): then the opening is never given back.
 * - `refund`: `none`, `due` (to give back: written with the room's end, in the same transaction),
 *   `done`.
 * - `space_id` (migration 6, docs/design/v5-places.md §10): the server the room was opened in
 *   (identity's `spaces.id`); its list, its notice and her comments are that server's. Rooms from
 *   before have the primary Space; `null` only without any Space (a store without identity).
 */
export const karaokeRooms = sqliteTable(
  "karaoke_rooms",
  {
    id: text().primaryKey(),
    code: text().notNull(),
    opener_person: text(),
    opener_platform: text().notNull(),
    opener_account: text().notNull(),
    opener_name: text().notNull(),
    state: text().notNull(),
    charge: text().notNull(),
    price: integer().notNull(),
    sung: integer({ mode: "boolean" }).notNull().default(false),
    rounds: integer().notNull().default(0),
    refund: text().notNull().default("none"),
    close_reason: text(),
    created_at: micros().notNull(),
    closed_at: micros(),
    space_id: text().references(() => spaces.id),
  },
  (t) => [
    index("karaoke_rooms_state_idx").on(t.state, t.created_at),
    check("karaoke_rooms_state_check", sql`${t.state} IN ('open', 'closed')`),
    check(
      "karaoke_rooms_charge_check",
      sql`${t.charge} IN ('charging', 'charged', 'free', 'failed')`,
    ),
    check("karaoke_rooms_refund_check", sql`${t.refund} IN ('none', 'due', 'done')`),
  ],
);

/**
 * A round of a room: `singing` while it runs, `settled` once its ranking is final (its payouts
 * written with it), `void` when it could not finish (she left, Core restarted): nothing paid.
 */
export const karaokeRoomRounds = sqliteTable(
  "karaoke_room_rounds",
  {
    room_id: text().notNull(),
    round: integer().notNull(),
    song_id: text().notNull(),
    shift: integer().notNull().default(0),
    state: text().notNull(),
    started_at: micros().notNull(),
    settled_at: micros(),
    /** The final ranking (`KaraokeRoomResult`, JSON) once settled. */
    result: text(),
  },
  (t) => [
    primaryKey({ name: "karaoke_room_rounds_pk", columns: [t.room_id, t.round] }),
    index("karaoke_room_rounds_state_idx").on(t.state),
    check("karaoke_room_rounds_state_check", sql`${t.state} IN ('singing', 'settled', 'void')`),
  ],
);

/**
 * What a settled round pays one person: written `due` with the settling, then `paid` (or
 * `capped`, `refused`) once the wallet answered. A `due` row after a restart is paid again: the
 * wallet's key (`<room>:<round>:<person>`) makes that the same payment.
 */
export const karaokeRoomPayouts = sqliteTable(
  "karaoke_room_payouts",
  {
    room_id: text().notNull(),
    round: integer().notNull(),
    person_id: text().notNull(),
    kind: text().notNull(),
    platform: text().notNull(),
    account_id: text().notNull(),
    amount: integer().notNull(),
    state: text().notNull(),
    paid: integer().notNull().default(0),
    created_at: micros().notNull(),
    paid_at: micros(),
  },
  (t) => [
    primaryKey({
      name: "karaoke_room_payouts_pk",
      columns: [t.room_id, t.round, t.person_id, t.kind],
    }),
    index("karaoke_room_payouts_state_idx").on(t.state),
    check("karaoke_room_payouts_kind_check", sql`${t.kind} IN ('prize', 'finish')`),
    check(
      "karaoke_room_payouts_state_check",
      sql`${t.state} IN ('due', 'paid', 'capped', 'refused')`,
    ),
  ],
);

/**
 * A song's edited reference (migration 5, docs/design/karaoke.md 「做了什麼第六步」): one row per
 * song a panel admin corrected. The worker's `reference.json` on Core stays as the worker wrote it
 * (and goes with the song's files a day after it was last sung); this row is what everyone sings
 * against while it exists, and a restore deletes it.
 *
 * - `reference`: the composed reference (`WorkersKaraokeReferenceV2`, JSON): the worker's with the
 *   edit's lyrics and notes and the curve moved by `pitch_shift`.
 * - `revision`: 1, 2, ... one more on each save (counting on from the song's last save after a
 *   restore), what a save names to replace.
 * - `base_hash`: SHA-256 (hex) of the worker's `reference.json` the save was built on;
 *   `worker_hash`: of the latest one Core has read. They differ once the worker's changed.
 * - `saved_person` / `saved_name`: who saved it (the name then; untrusted), cleared when they ask
 *   to be forgotten (the edit stays: the song is nobody's).
 */
export const karaokeReferences = sqliteTable("karaoke_references", {
  song_id: text().primaryKey(),
  reference: text().notNull(),
  pitch_shift: integer().notNull().default(0),
  revision: integer().notNull(),
  base_hash: text().notNull(),
  worker_hash: text(),
  saved_person: text(),
  saved_name: text().notNull(),
  saved_at: micros().notNull(),
});

/**
 * Every save and restore of a song's reference (migration 5): what was done, the revision it made
 * (`0` for a restore), the edited lines and the notes in what was saved, and who (cleared like
 * `karaoke_references.saved_person` when they ask to be forgotten).
 */
export const karaokeReferenceEdits = sqliteTable(
  "karaoke_reference_edits",
  {
    id: text().primaryKey(),
    song_id: text().notNull(),
    action: text().notNull(),
    revision: integer().notNull(),
    lines: integer().notNull(),
    notes: integer().notNull(),
    pitch_shift: integer().notNull(),
    person_id: text(),
    name: text().notNull(),
    at: micros().notNull(),
  },
  (t) => [
    index("karaoke_reference_edits_song_idx").on(t.song_id, t.at),
    check("karaoke_reference_edits_action_check", sql`${t.action} IN ('save', 'restore')`),
  ],
);
