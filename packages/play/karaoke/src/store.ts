// The `karaoke` plugin's tables on the store's database (`schema.ts`): songs, the daily requests,
// sessions, tracks and results (`KaraokeStore`). Every write is one `Db.tx`; a scored session is
// its track, its result, the session marked scored and one `karaoke.scored` event, together.
//
// Core's store opens this plugin (`STORE_PLUGINS`); the module `karaoke` (`module.ts`) owns it.
// A person who asks to be forgotten loses their sessions, tracks, results and requests; the songs
// stay (nobody's), with who asked for them cleared. A merge moves them. Rooms (step 4) keep what
// the coins need across a restart: the room and its opening charge, its rounds, and what each
// settled round pays whom. An edited reference (step 6) is the song's, so it stays when the person
// who saved it is forgotten; their person and name on it and on its record are cleared.

import {
  type CategoryData,
  type Db,
  type EventStore,
  type PersonHookResult,
  type PersonMerge,
  type StorePlugin,
  tablePart,
} from "@miyoria/store";
import { newId, type PersonId, type Timestamp, toTimestamp } from "@miyoria/types";
import { and, count, desc, eq, gte, inArray, isNull, lte, max, sql } from "drizzle-orm";
import { type KaraokeScoredData, karaokeScoredWrite } from "./events.js";
import { karaokeSchema } from "./migrations.js";
import {
  karaokeReferenceEdits,
  karaokeReferences,
  karaokeRequests,
  karaokeResults,
  karaokeRoomPayouts,
  karaokeRoomRounds,
  karaokeRooms,
  karaokeSessions,
  karaokeSongs,
  karaokeTracks,
} from "./schema.js";

export type SongStatus = "preparing" | "ready" | "failed";
export type CommentState = "waiting" | "said" | "none";
export type VoiceState = "none" | "waiting" | "scoring" | "scored" | "failed";

/** What the recording's score changes of a result row. */
export type VoicePatch = Pick<
  ResultRow,
  | "total"
  | "pitch"
  | "stability"
  | "rhythm"
  | "expression"
  | "unranked"
  | "reasons"
  | "detail"
  | "checks"
>;

export type SongRow = typeof karaokeSongs.$inferSelect;
export type SessionRow = typeof karaokeSessions.$inferSelect;
export type TrackRow = typeof karaokeTracks.$inferSelect;
export type ResultRow = typeof karaokeResults.$inferSelect;
export type RoomRow = typeof karaokeRooms.$inferSelect;
export type RoundRow = typeof karaokeRoomRounds.$inferSelect;
export type PayoutRow = typeof karaokeRoomPayouts.$inferSelect;
export type RoomCharge = "charging" | "charged" | "free" | "failed";
export type PayoutKey = Pick<PayoutRow, "room_id" | "round" | "person_id" | "kind">;
export type OverrideRow = typeof karaokeReferences.$inferSelect;
export type EditRow = typeof karaokeReferenceEdits.$inferSelect;

/** What a song row may change once it is made. */
export type SongPatch = Partial<Omit<SongRow, "id" | "source_key" | "source" | "created_at">>;

/** What the song row says of the reference that is sung (its lyrics and notes). */
export type SongSung = Pick<SongRow, "lyrics" | "lyrics_source" | "notes">;

/** Who saved or restored a song's reference, and when. */
export interface EditBy {
  person: PersonId | null;
  name: string;
  at: number;
}

const at = (ms: number): Timestamp => toTimestamp(ms);

export class KaraokeStore {
  readonly #db: Db;
  readonly #events: EventStore;

  constructor(db: Db, events: EventStore) {
    this.#db = db;
    this.#events = events;
  }

  #write<T>(fn: () => T): T {
    this.#db.ensureOpen();
    return this.#db.tx(fn);
  }

  #read() {
    this.#db.ensureOpen();
    return this.#db.orm;
  }

  // ---- songs --------------------------------------------------------------------------------

  song(id: string): SongRow | null {
    return this.#read().select().from(karaokeSongs).where(eq(karaokeSongs.id, id)).get() ?? null;
  }

  songBySource(key: string): SongRow | null {
    return (
      this.#read().select().from(karaokeSongs).where(eq(karaokeSongs.source_key, key)).get() ?? null
    );
  }

  /** Songs in `status`, newest first. */
  songsIn(status: SongStatus, limit = 500): SongRow[] {
    return this.#read()
      .select()
      .from(karaokeSongs)
      .where(eq(karaokeSongs.status, status))
      .orderBy(desc(karaokeSongs.created_at))
      .limit(limit)
      .all();
  }

  /** What `person` asked for since `since` that is not ready (preparing, or failed). */
  pendingOf(person: PersonId, since: number): SongRow[] {
    return this.#read()
      .select()
      .from(karaokeSongs)
      .where(
        and(
          eq(karaokeSongs.requested_by, person),
          inArray(karaokeSongs.status, ["preparing", "failed"]),
          gte(karaokeSongs.created_at, at(since)),
        ),
      )
      .orderBy(desc(karaokeSongs.created_at))
      .all();
  }

  /** A new song asked for by `person`, and the request that counts against their day. */
  addSong(
    song: { id: string; source_key: string; source: string; title: string },
    person: PersonId | null,
    now: number,
  ): SongRow {
    return this.#write(() => {
      this.#db.orm
        .insert(karaokeSongs)
        .values({
          ...song,
          status: "preparing",
          requested_by: person,
          created_at: at(now),
        })
        .run();
      return this.song(song.id) as SongRow;
    });
  }

  /** A failed song asked for again: preparing once more. */
  retrySong(id: string, person: PersonId | null): void {
    this.patchSong(id, {
      status: "preparing",
      job: null,
      error: null,
      error_detail: null,
      requested_by: person,
    });
  }

  patchSong(id: string, patch: SongPatch): void {
    this.#write(() => {
      this.#db.orm.update(karaokeSongs).set(patch).where(eq(karaokeSongs.id, id)).run();
    });
  }

  addRequest(person: PersonId, song: string, now: number): void {
    this.#write(() => {
      this.#db.orm
        .insert(karaokeRequests)
        .values({ id: newId(), person_id: person, song_id: song, created_at: at(now) })
        .run();
    });
  }

  requestsSince(person: PersonId, since: number): number {
    const row = this.#read()
      .select({ n: count() })
      .from(karaokeRequests)
      .where(and(eq(karaokeRequests.person_id, person), gte(karaokeRequests.created_at, at(since))))
      .get();
    return row?.n ?? 0;
  }

  /** Ready songs last used (or made) before `before`. */
  idleReady(before: number): SongRow[] {
    const limit = Date.parse(at(before));
    return this.songsIn("ready", 10_000).filter(
      (s) => Date.parse(s.used_at ?? s.ready_at ?? s.created_at) < limit,
    );
  }

  // ---- sessions -----------------------------------------------------------------------------

  addSession(row: Omit<SessionRow, "status" | "scored_at">): SessionRow {
    return this.#write(() => {
      this.#db.orm
        .insert(karaokeSessions)
        .values({ ...row, status: "open" })
        .run();
      this.#db.orm
        .update(karaokeSongs)
        .set({ used_at: row.started_at })
        .where(eq(karaokeSongs.id, row.song_id))
        .run();
      return this.session(row.id) as SessionRow;
    });
  }

  session(id: string): SessionRow | null {
    return (
      this.#read().select().from(karaokeSessions).where(eq(karaokeSessions.id, id)).get() ?? null
    );
  }

  /**
   * Sessions that will take no result any more (a room's round settled without one): they expire
   * now, so a late submit is refused. Only sessions still open; returns how many.
   */
  expireSessions(ids: readonly string[], now: number): number {
    if (ids.length === 0) return 0;
    return this.#write(() =>
      Number(
        this.#db.orm
          .update(karaokeSessions)
          .set({ expires_at: at(now - 1) })
          .where(and(inArray(karaokeSessions.id, [...ids]), eq(karaokeSessions.status, "open")))
          .run().changes,
      ),
    );
  }

  // ---- results ------------------------------------------------------------------------------

  /**
   * A session scored: its track, its result, the session marked, and one `karaoke.scored`, in
   * one transaction. `false` when the session was scored already (a second submit).
   */
  scored(track: TrackRow, result: ResultRow, event: KaraokeScoredData): boolean {
    return this.#write(() => {
      const moved = this.#db.orm
        .update(karaokeSessions)
        .set({ status: "scored", scored_at: result.created_at })
        .where(and(eq(karaokeSessions.id, track.session_id), eq(karaokeSessions.status, "open")))
        .run().changes;
      if (Number(moved) === 0) return false;
      this.#db.orm.insert(karaokeTracks).values(track).run();
      this.#db.orm.insert(karaokeResults).values(result).run();
      this.#events.appendNow(karaokeScoredWrite(event, result.person_id, result.created_at));
      return true;
    });
  }

  /** A session's track (the browser's), while it is kept. */
  track(session: string): TrackRow | null {
    return (
      this.#read()
        .select()
        .from(karaokeTracks)
        .where(eq(karaokeTracks.session_id, session))
        .get() ?? null
    );
  }

  /**
   * The recording of a session arrived: `waiting` → `scoring`, once. `false` when it was not
   * waiting for one (none expected, sent already, or given up on).
   */
  claimVoice(session: string): boolean {
    return this.#write(
      () =>
        Number(
          this.#db.orm
            .update(karaokeResults)
            .set({ voice_state: "scoring" })
            .where(
              and(
                eq(karaokeResults.session_id, session),
                eq(karaokeResults.voice_state, "waiting"),
              ),
            )
            .run().changes,
        ) > 0,
    );
  }

  /**
   * The recording scored: the result becomes the official one (`source: voice`), its pitch is kept
   * beside the browser's track, and one more `karaoke.scored`, in one transaction. `false` when the
   * session was not being scored (given up on meanwhile).
   */
  voiceScored(
    session: string,
    patch: VoicePatch,
    frames: string | null,
    event: KaraokeScoredData,
    now: number,
  ): boolean {
    return this.#write(() => {
      const moved = this.#db.orm
        .update(karaokeResults)
        .set({ ...patch, source: "voice", voice_state: "scored" })
        .where(
          and(eq(karaokeResults.session_id, session), eq(karaokeResults.voice_state, "scoring")),
        )
        .run().changes;
      if (Number(moved) === 0) return false;
      if (frames !== null) {
        this.#db.orm
          .update(karaokeTracks)
          .set({ voice_frames: frames })
          .where(eq(karaokeTracks.session_id, session))
          .run();
      }
      const row = this.result(session) as ResultRow;
      this.#events.appendNow(karaokeScoredWrite(event, row.person_id, at(now)));
      return true;
    });
  }

  /** The recording of a session did not get scored: the result stays the estimate. */
  voiceFailed(session: string): void {
    this.#write(() => {
      this.#db.orm
        .update(karaokeResults)
        .set({ voice_state: "failed" })
        .where(
          and(
            eq(karaokeResults.session_id, session),
            inArray(karaokeResults.voice_state, ["waiting", "scoring"]),
          ),
        )
        .run();
    });
  }

  /** Results still waiting for their recording that were made before `before`. */
  voiceOverdue(before: number): ResultRow[] {
    return this.#read()
      .select()
      .from(karaokeResults)
      .where(
        and(eq(karaokeResults.voice_state, "waiting"), lte(karaokeResults.created_at, at(before))),
      )
      .all();
  }

  /** Results she has not been told of yet (waiting for the official score), oldest first. */
  untold(): ResultRow[] {
    return this.#read()
      .select()
      .from(karaokeResults)
      .where(isNull(karaokeResults.noted_at))
      .orderBy(karaokeResults.created_at)
      .all();
  }

  /** She is told of a result now: `false` when she was told already. */
  markNoted(session: string, now: number): boolean {
    return this.#write(
      () =>
        Number(
          this.#db.orm
            .update(karaokeResults)
            .set({ noted_at: at(now) })
            .where(and(eq(karaokeResults.session_id, session), isNull(karaokeResults.noted_at)))
            .run().changes,
        ) > 0,
    );
  }

  result(session: string): ResultRow | null {
    return (
      this.#read()
        .select()
        .from(karaokeResults)
        .where(eq(karaokeResults.session_id, session))
        .get() ?? null
    );
  }

  /** A person's results, newest first. */
  resultsOf(person: PersonId, limit: number): ResultRow[] {
    return this.#read()
      .select()
      .from(karaokeResults)
      .where(eq(karaokeResults.person_id, person))
      .orderBy(desc(karaokeResults.created_at))
      .limit(limit)
      .all();
  }

  /** A person's best ranked total on each song they sang, and how often they sang it. */
  bestsOf(person: PersonId): Map<string, { best: number | null; sung: number }> {
    const rows = this.#read()
      .select({
        song: karaokeResults.song_id,
        sung: count(),
      })
      .from(karaokeResults)
      .where(eq(karaokeResults.person_id, person))
      .groupBy(karaokeResults.song_id)
      .all();
    const bests = this.#read()
      .select({ song: karaokeResults.song_id, best: max(karaokeResults.total) })
      .from(karaokeResults)
      .where(and(eq(karaokeResults.person_id, person), eq(karaokeResults.unranked, false)))
      .groupBy(karaokeResults.song_id)
      .all();
    const out = new Map<string, { best: number | null; sung: number }>();
    for (const r of rows) out.set(r.song, { best: null, sung: r.sung });
    for (const b of bests) {
      const entry = out.get(b.song);
      if (entry !== undefined) entry.best = b.best;
    }
    return out;
  }

  /** Results waiting for her comment in `channel`, told since `since`, oldest first. */
  waitingIn(channel: string, since: number): ResultRow[] {
    return this.#read()
      .select()
      .from(karaokeResults)
      .where(
        and(
          eq(karaokeResults.comment_state, "waiting"),
          eq(karaokeResults.channel, channel),
          gte(karaokeResults.noted_at, at(since)),
        ),
      )
      .orderBy(karaokeResults.noted_at)
      .all();
  }

  setComment(session: string, state: CommentState, text: string | null, now: number): void {
    this.#write(() => {
      this.#db.orm
        .update(karaokeResults)
        .set({ comment_state: state, comment: text, comment_at: state === "said" ? at(now) : null })
        .where(eq(karaokeResults.session_id, session))
        .run();
    });
  }

  /** Comments still waiting that were asked for before `before`: she did not make one. */
  giveUpComments(before: number): number {
    return this.#write(() =>
      Number(
        this.#db.orm
          .update(karaokeResults)
          .set({ comment_state: "none" })
          .where(
            and(
              eq(karaokeResults.comment_state, "waiting"),
              lte(karaokeResults.noted_at, at(before)),
            ),
          )
          .run().changes,
      ),
    );
  }

  /** The latest results, for the owner. */
  /** The latest results, with who sang, the song, the track and the server of its room (if any). */
  latest(limit: number): (ResultRow & {
    name: string;
    title: string;
    track: TrackRow | null;
    space: string | null;
  })[] {
    const rows = this.#read()
      .select()
      .from(karaokeResults)
      .orderBy(desc(karaokeResults.created_at))
      .limit(limit)
      .all();
    return rows.map((r) => {
      const session = this.session(r.session_id);
      const room = session?.room_id == null ? null : this.room(session.room_id);
      return {
        ...r,
        space: room?.space_id ?? null,
        name: session?.name ?? "",
        title: this.song(r.song_id)?.title ?? "",
        track:
          this.#read()
            .select()
            .from(karaokeTracks)
            .where(eq(karaokeTracks.session_id, r.session_id))
            .get() ?? null,
      };
    });
  }

  // ---- rooms (step 4) -------------------------------------------------------------------------

  addRoom(row: Omit<RoomRow, "sung" | "rounds" | "refund" | "close_reason" | "closed_at">): void {
    this.#write(() => {
      this.#db.orm.insert(karaokeRooms).values(row).run();
    });
  }

  room(id: string): RoomRow | null {
    return this.#read().select().from(karaokeRooms).where(eq(karaokeRooms.id, id)).get() ?? null;
  }

  /** Rooms still open (a restart closes them all). */
  openRooms(): RoomRow[] {
    return this.#read().select().from(karaokeRooms).where(eq(karaokeRooms.state, "open")).all();
  }

  /** The opening charge's outcome. */
  setCharge(id: string, charge: RoomCharge): void {
    this.#write(() => {
      this.#db.orm.update(karaokeRooms).set({ charge }).where(eq(karaokeRooms.id, id)).run();
    });
  }

  /**
   * A room ends: closed with its reason, and its opening `due` to be given back when no round of
   * it was sung through and it was (or may have been) charged, in one transaction. `false` when it
   * was closed already. Any round still `singing` becomes `void`.
   */
  closeRoom(id: string, reason: string, now: number): boolean {
    return this.#write(() => {
      const row = this.room(id);
      if (row === null || row.state !== "open") return false;
      const owes = !row.sung && (row.charge === "charged" || row.charge === "charging");
      this.#db.orm
        .update(karaokeRooms)
        .set({
          state: "closed",
          close_reason: reason.slice(0, 200),
          closed_at: at(now),
          refund: owes ? "due" : row.refund,
        })
        .where(eq(karaokeRooms.id, id))
        .run();
      this.#db.orm
        .update(karaokeRoomRounds)
        .set({ state: "void", settled_at: at(now) })
        .where(and(eq(karaokeRoomRounds.room_id, id), eq(karaokeRoomRounds.state, "singing")))
        .run();
      return true;
    });
  }

  /** Rooms whose opening is still to be given back. */
  refundsDue(): RoomRow[] {
    return this.#read().select().from(karaokeRooms).where(eq(karaokeRooms.refund, "due")).all();
  }

  refundDone(id: string): void {
    this.#write(() => {
      this.#db.orm
        .update(karaokeRooms)
        .set({ refund: "done" })
        .where(and(eq(karaokeRooms.id, id), eq(karaokeRooms.refund, "due")))
        .run();
    });
  }

  /** A round starts: its row, and the room's count of rounds. */
  addRound(row: Omit<RoundRow, "state" | "settled_at" | "result">): void {
    this.#write(() => {
      this.#db.orm
        .insert(karaokeRoomRounds)
        .values({ ...row, state: "singing" })
        .run();
      this.#db.orm
        .update(karaokeRooms)
        .set({ rounds: row.round })
        .where(eq(karaokeRooms.id, row.room_id))
        .run();
    });
  }

  round(room: string, round: number): RoundRow | null {
    return (
      this.#read()
        .select()
        .from(karaokeRoomRounds)
        .where(and(eq(karaokeRoomRounds.room_id, room), eq(karaokeRoomRounds.round, round)))
        .get() ?? null
    );
  }

  /**
   * A round's ranking is final: the round settled with it, what it pays written `due`, and the
   * room marked sung (its opening is kept from now on), in one transaction. `false` when the round
   * was not singing (settled already, or void).
   */
  settleRound(
    room: string,
    round: number,
    result: string,
    payouts: Omit<PayoutRow, "state" | "paid" | "paid_at">[],
    now: number,
  ): boolean {
    return this.#write(() => {
      const moved = this.#db.orm
        .update(karaokeRoomRounds)
        .set({ state: "settled", settled_at: at(now), result })
        .where(
          and(
            eq(karaokeRoomRounds.room_id, room),
            eq(karaokeRoomRounds.round, round),
            eq(karaokeRoomRounds.state, "singing"),
          ),
        )
        .run().changes;
      if (Number(moved) === 0) return false;
      for (const p of payouts) {
        this.#db.orm
          .insert(karaokeRoomPayouts)
          .values({ ...p, state: "due", paid: 0 })
          .run();
      }
      this.#db.orm.update(karaokeRooms).set({ sung: true }).where(eq(karaokeRooms.id, room)).run();
      return true;
    });
  }

  /** A round that cannot finish: nothing is paid for it. */
  voidRound(room: string, round: number, now: number): void {
    this.#write(() => {
      this.#db.orm
        .update(karaokeRoomRounds)
        .set({ state: "void", settled_at: at(now) })
        .where(
          and(
            eq(karaokeRoomRounds.room_id, room),
            eq(karaokeRoomRounds.round, round),
            eq(karaokeRoomRounds.state, "singing"),
          ),
        )
        .run();
    });
  }

  /** Payouts written but not answered by the wallet yet (oldest first). */
  payoutsDue(): PayoutRow[] {
    return this.#read()
      .select()
      .from(karaokeRoomPayouts)
      .where(eq(karaokeRoomPayouts.state, "due"))
      .orderBy(karaokeRoomPayouts.created_at)
      .all();
  }

  payoutsOf(room: string, round: number): PayoutRow[] {
    return this.#read()
      .select()
      .from(karaokeRoomPayouts)
      .where(and(eq(karaokeRoomPayouts.room_id, room), eq(karaokeRoomPayouts.round, round)))
      .all();
  }

  /** The wallet answered a payout. */
  payoutDone(p: PayoutKey, state: "paid" | "capped" | "refused", paid: number, now: number): void {
    this.#write(() => {
      this.#db.orm
        .update(karaokeRoomPayouts)
        .set({ state, paid, paid_at: at(now) })
        .where(
          and(
            eq(karaokeRoomPayouts.room_id, p.room_id),
            eq(karaokeRoomPayouts.round, p.round),
            eq(karaokeRoomPayouts.person_id, p.person_id),
            eq(karaokeRoomPayouts.kind, p.kind),
            eq(karaokeRoomPayouts.state, "due"),
          ),
        )
        .run();
    });
  }

  // ---- edited references (step 6) -----------------------------------------------------------

  /** The song's edited reference, `null` while the worker's is sung. */
  override(song: string): OverrideRow | null {
    return (
      this.#read()
        .select()
        .from(karaokeReferences)
        .where(eq(karaokeReferences.song_id, song))
        .get() ?? null
    );
  }

  /** The highest revision the song's reference ever had (its edit now, or any save before). */
  #lastRevision(song: string): number {
    const now = this.override(song)?.revision ?? 0;
    const before = this.#db.orm
      .select({ n: max(karaokeReferenceEdits.revision) })
      .from(karaokeReferenceEdits)
      .where(eq(karaokeReferenceEdits.song_id, song))
      .get();
    return Math.max(now, before?.n ?? 0);
  }

  /**
   * An edit saved as the song's reference over revision `expected` (`0`: the worker's), with its
   * record and the song row's lyrics and notes made the edit's, in one transaction. The new
   * revision counts on from the song's last one, so a revision is never used twice (a save over
   * an edit someone restored in between is refused). `null` when the song's reference is not at
   * `expected` any more.
   */
  saveOverride(
    song: string,
    expected: number,
    edit: Pick<OverrideRow, "reference" | "pitch_shift" | "base_hash" | "worker_hash">,
    counts: { lines: number; notes: number },
    sung: SongSung,
    by: EditBy,
  ): number | null {
    return this.#write(() => {
      const o = this.#db.orm;
      if ((this.override(song)?.revision ?? 0) !== expected) return null;
      const revision = this.#lastRevision(song) + 1;
      const row: OverrideRow = {
        song_id: song,
        ...edit,
        revision,
        saved_person: by.person,
        saved_name: by.name,
        saved_at: at(by.at),
      };
      o.insert(karaokeReferences)
        .values(row)
        .onConflictDoUpdate({ target: karaokeReferences.song_id, set: row })
        .run();
      o.insert(karaokeReferenceEdits)
        .values({
          id: newId(),
          song_id: song,
          action: "save",
          revision,
          lines: counts.lines,
          notes: counts.notes,
          pitch_shift: edit.pitch_shift,
          person_id: by.person,
          name: by.name,
          at: at(by.at),
        })
        .run();
      o.update(karaokeSongs).set(sung).where(eq(karaokeSongs.id, song)).run();
      return revision;
    });
  }

  /**
   * The song's edit dropped (the worker's reference is sung again), with its record and the song
   * row's lyrics and notes made the worker's, in one transaction: `none` when there is no edit,
   * `moved` when it is not at revision `expected`.
   */
  dropOverride(
    song: string,
    expected: number,
    sung: SongSung,
    by: EditBy,
  ): "done" | "none" | "moved" {
    return this.#write(() => {
      const o = this.#db.orm;
      const row = this.override(song);
      if (row === null) return "none";
      if (row.revision !== expected) return "moved";
      o.delete(karaokeReferences).where(eq(karaokeReferences.song_id, song)).run();
      o.insert(karaokeReferenceEdits)
        .values({
          id: newId(),
          song_id: song,
          action: "restore",
          revision: 0,
          lines: 0,
          notes: sung.notes,
          pitch_shift: 0,
          person_id: by.person,
          name: by.name,
          at: at(by.at),
        })
        .run();
      o.update(karaokeSongs).set(sung).where(eq(karaokeSongs.id, song)).run();
      return "done";
    });
  }

  /** The hash of the latest worker's reference Core read for a song with an edit. */
  setWorkerHash(song: string, hash: string): void {
    this.#write(() => {
      this.#db.orm
        .update(karaokeReferences)
        .set({ worker_hash: hash })
        .where(eq(karaokeReferences.song_id, song))
        .run();
    });
  }

  /** The song's latest saves and restores, newest first. */
  edits(song: string, limit = 20): EditRow[] {
    return (
      this.#read()
        .select()
        .from(karaokeReferenceEdits)
        .where(eq(karaokeReferenceEdits.song_id, song))
        // Ids are ULIDs made in order: two in the same microsecond keep theirs.
        .orderBy(desc(karaokeReferenceEdits.at), desc(karaokeReferenceEdits.id))
        .limit(limit)
        .all()
    );
  }

  /** How many results were recorded on a song. */
  resultsOn(song: string): number {
    const row = this.#read()
      .select({ n: count() })
      .from(karaokeResults)
      .where(eq(karaokeResults.song_id, song))
      .get();
    return row?.n ?? 0;
  }

  // ---- upkeep -------------------------------------------------------------------------------

  /** Tracks past their week: deleted (the results stay). */
  purgeTracks(now: number): number {
    return this.#write(() =>
      Number(
        this.#db.orm
          .delete(karaokeTracks)
          .where(lte(karaokeTracks.purge_at, at(now)))
          .run().changes,
      ),
    );
  }

  forgetPerson(ids: readonly PersonId[]): Record<string, number> {
    if (ids.length === 0) return {};
    const list = [...ids];
    return this.#write(() => {
      const o = this.#db.orm;
      const sessions = o
        .select({ id: karaokeSessions.id })
        .from(karaokeSessions)
        .where(inArray(karaokeSessions.person_id, list))
        .all()
        .map((s) => s.id);
      const tracks =
        sessions.length === 0
          ? 0
          : Number(
              o.delete(karaokeTracks).where(inArray(karaokeTracks.session_id, sessions)).run()
                .changes,
            );
      return {
        karaoke_tracks: tracks,
        karaoke_results: Number(
          o.delete(karaokeResults).where(inArray(karaokeResults.person_id, list)).run().changes,
        ),
        karaoke_sessions: Number(
          o.delete(karaokeSessions).where(inArray(karaokeSessions.person_id, list)).run().changes,
        ),
        karaoke_requests: Number(
          o.delete(karaokeRequests).where(inArray(karaokeRequests.person_id, list)).run().changes,
        ),
        karaoke_songs: Number(
          o
            .update(karaokeSongs)
            .set({ requested_by: null })
            .where(inArray(karaokeSongs.requested_by, list))
            .run().changes,
        ),
        // What was paid stays in the ledger; the room's own record of it goes with them.
        karaoke_room_payouts: Number(
          o.delete(karaokeRoomPayouts).where(inArray(karaokeRoomPayouts.person_id, list)).run()
            .changes,
        ),
        karaoke_rooms: Number(
          o
            .update(karaokeRooms)
            .set({ opener_person: null, opener_name: "" })
            .where(inArray(karaokeRooms.opener_person, list))
            .run().changes,
        ),
        // An edit stays (the song is nobody's); who made it goes.
        karaoke_references: Number(
          o
            .update(karaokeReferences)
            .set({ saved_person: null, saved_name: "" })
            .where(inArray(karaokeReferences.saved_person, list))
            .run().changes,
        ),
        karaoke_reference_edits: Number(
          o
            .update(karaokeReferenceEdits)
            .set({ person_id: null, name: "" })
            .where(inArray(karaokeReferenceEdits.person_id, list))
            .run().changes,
        ),
      };
    });
  }

  merge(keep: PersonId, absorb: PersonId): PersonHookResult {
    if (keep === absorb) return { counts: {} };
    return this.#write((): PersonHookResult => {
      const o = this.#db.orm;
      const moved = (n: { changes: number | bigint }) => Number(n.changes);
      return {
        counts: {
          karaoke_sessions: moved(
            o
              .update(karaokeSessions)
              .set({ person_id: keep })
              .where(eq(karaokeSessions.person_id, absorb))
              .run(),
          ),
          karaoke_results: moved(
            o
              .update(karaokeResults)
              .set({ person_id: keep })
              .where(eq(karaokeResults.person_id, absorb))
              .run(),
          ),
          karaoke_requests: moved(
            o
              .update(karaokeRequests)
              .set({ person_id: keep })
              .where(eq(karaokeRequests.person_id, absorb))
              .run(),
          ),
          karaoke_songs: moved(
            o
              .update(karaokeSongs)
              .set({ requested_by: keep })
              .where(eq(karaokeSongs.requested_by, absorb))
              .run(),
          ),
          karaoke_rooms: moved(
            o
              .update(karaokeRooms)
              .set({ opener_person: keep })
              .where(eq(karaokeRooms.opener_person, absorb))
              .run(),
          ),
          karaoke_references: moved(
            o
              .update(karaokeReferences)
              .set({ saved_person: keep })
              .where(eq(karaokeReferences.saved_person, absorb))
              .run(),
          ),
          karaoke_reference_edits: moved(
            o
              .update(karaokeReferenceEdits)
              .set({ person_id: keep })
              .where(eq(karaokeReferenceEdits.person_id, absorb))
              .run(),
          ),
          // Two rows of one round for one person cannot both stay (the key): the absorbed one's
          // go, the ledger keeps what was paid.
          karaoke_room_payouts: moved(
            o
              .update(karaokeRoomPayouts)
              .set({ person_id: keep })
              .where(
                and(
                  eq(karaokeRoomPayouts.person_id, absorb),
                  sql`NOT EXISTS (SELECT 1 FROM karaoke_room_payouts k WHERE k.person_id = ${keep} AND k.room_id = ${karaokeRoomPayouts.room_id} AND k.round = ${karaokeRoomPayouts.round} AND k.kind = ${karaokeRoomPayouts.kind})`,
                ),
              )
              .run(),
          ),
          karaoke_room_payouts_dropped: moved(
            o.delete(karaokeRoomPayouts).where(eq(karaokeRoomPayouts.person_id, absorb)).run(),
          ),
        },
      };
    });
  }
}

/** Where the karaoke tables sit in the data categories: what people did with her. */
const karaokeData: readonly CategoryData[] = [
  {
    category: "relationships",
    parts: [
      tablePart("karaoke_songs", "karaoke_songs", "node", "created_at", "created_at, id", {
        id: "text",
        source_key: "text",
        source: "text",
        title: "text",
        artist: "text",
        duration_ms: "num",
        status: "text",
        job: "text",
        worker_song: "text",
        error: "text",
        error_detail: "text",
        lyrics: "bool",
        lyrics_source: "text",
        notes: "num",
        video: "bool",
        requested_by: "text",
        created_at: "ts",
        ready_at: "ts",
        used_at: "ts",
      }),
      tablePart("karaoke_requests", "karaoke_requests", "node", "created_at", "created_at, id", {
        id: "text",
        person_id: "text",
        song_id: "text",
        created_at: "ts",
      }),
      tablePart("karaoke_sessions", "karaoke_sessions", "node", "started_at", "started_at, id", {
        id: "text",
        song_id: "text",
        person_id: "text",
        platform: "text",
        account_id: "text",
        name: "text",
        status: "text",
        started_at: "ts",
        expires_at: "ts",
        scored_at: "ts",
        shift: "num",
        room_id: "text",
      }),
      tablePart("karaoke_rooms", "karaoke_rooms", "node", "created_at", "created_at, id", {
        id: "text",
        code: "text",
        opener_person: "text",
        opener_platform: "text",
        opener_account: "text",
        opener_name: "text",
        state: "text",
        charge: "text",
        price: "num",
        sung: "bool",
        rounds: "num",
        refund: "text",
        close_reason: "text",
        created_at: "ts",
        closed_at: "ts",
      }),
      tablePart(
        "karaoke_room_rounds",
        "karaoke_room_rounds",
        "node",
        "started_at",
        "started_at, room_id, round",
        {
          room_id: "text",
          round: "num",
          song_id: "text",
          shift: "num",
          state: "text",
          started_at: "ts",
          settled_at: "ts",
          result: "text",
        },
      ),
      tablePart(
        "karaoke_room_payouts",
        "karaoke_room_payouts",
        "node",
        "created_at",
        "created_at, room_id, round, person_id, kind",
        {
          room_id: "text",
          round: "num",
          person_id: "text",
          kind: "text",
          platform: "text",
          account_id: "text",
          amount: "num",
          state: "text",
          paid: "num",
          created_at: "ts",
          paid_at: "ts",
        },
      ),
      tablePart(
        "karaoke_references",
        "karaoke_references",
        "node",
        "saved_at",
        "saved_at, song_id",
        {
          song_id: "text",
          reference: "text",
          pitch_shift: "num",
          revision: "num",
          base_hash: "text",
          worker_hash: "text",
          saved_person: "text",
          saved_name: "text",
          saved_at: "ts",
        },
      ),
      tablePart("karaoke_reference_edits", "karaoke_reference_edits", "node", "at", "at, id", {
        id: "text",
        song_id: "text",
        action: "text",
        revision: "num",
        lines: "num",
        notes: "num",
        pitch_shift: "num",
        person_id: "text",
        name: "text",
        at: "ts",
      }),
      tablePart(
        "karaoke_tracks",
        "karaoke_tracks",
        "node",
        "submitted_at",
        "submitted_at, session_id",
        {
          session_id: "text",
          hz: "num",
          frames: "text",
          latency_ms: "num",
          calibrated: "bool",
          browser: "text",
          submitted_at: "ts",
          purge_at: "ts",
          voice_frames: "text",
        },
      ),
      tablePart(
        "karaoke_results",
        "karaoke_results",
        "node",
        "created_at",
        "created_at, session_id",
        {
          session_id: "text",
          song_id: "text",
          person_id: "text",
          total: "num",
          pitch: "num",
          stability: "num",
          rhythm: "num",
          expression: "num",
          unranked: "bool",
          reasons: "text",
          detail: "text",
          client_total: "num",
          best_before: "num",
          comment_state: "text",
          comment: "text",
          channel: "text",
          noted_at: "ts",
          comment_at: "ts",
          created_at: "ts",
          source: "text",
          voice_state: "text",
          estimate_total: "num",
          checks: "text",
        },
      ),
    ],
  },
];

/** The `karaoke` plugin's tables and code (`StorePlugin`). */
export const karaokeTables: StorePlugin<KaraokeStore> = {
  schema: karaokeSchema,
  open: ({ db, events }) => new KaraokeStore(db, events),
  data: karaokeData,
  forgetPerson: (opened, request) => ({ counts: opened.forgetPerson(request.ids) }),
  mergePerson: (opened, { keep, absorb }: PersonMerge) => opened.merge(keep, absorb),
};
