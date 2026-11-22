// The artifact store (docs/design/v5-data.md §5, v5-architecture §11.2): the files she makes, as
// immutable content plus a record.
//
// Ingest. Bytes come from a buffer, a stream or an existing file and are written to a temporary
// file under the store's root, hashed and measured as they are written, synced, then renamed into
// their content-addressed place (`paths.ts`); the same bytes already there are not stored twice.
// Their type is sniffed from the content (`media.ts`); a declared type the content contradicts, an
// unknown type and a size over the kind's limit are refused. The row, its blob's row and the
// `artifact.created` event then commit in one transaction. If that transaction fails, a blob this
// ingest placed and nothing else uses is removed at once; after a crash the sweep removes it.
//
// Reading. By id, with the visibility rule of `visibility.ts` applied here; a stream of the bytes;
// a listing with the filters §5 indexes (person, space, expiry) and a few more.
//
// Retention. An artifact expires 7 days after it is made (v5-architecture §16 #11) unless it is
// kept: put in an album, kept by its person, the owner or the cards (then it does not expire).
// Song covers are never downloadable: the row says so (`downloadable`, held by a CHECK), and a
// share of one can only stream (`shares.ts`).
//
// The sweep (daily; safe to run at any time and to run again after a crash at any point):
// 1. Artifacts past their expiry are marked deleted, their shares revoked, and each is one
//    `artifact.expired` event.
// 2. Deleted rows older than the grace (24 h) are removed for good (their shares go with them).
// 3. A blob no artifact row uses, stored longer ago than the grace, loses its row, then its file.
//    Row first: a crash between the two leaves a file without a row, which step 4 removes.
// 4. A blob file without a row, older than the grace, is removed: a crash after the rename and
//    before the commit, or a wipe of the rows. A blob row without its file is counted as missing.
// 5. A temporary file older than the grace, of no ingest of this process, is removed.
// What steps 2 to 5 removed is one `artifact.swept` event, the daily count.
//
// A blob that an ingest has placed but not yet committed is never collected: the ingest holds a
// pin on its hash from before it looks for an existing file until after its commit, and the sweep
// checks the pin and deletes in one synchronous step, which no ingest can interleave with (the
// commit is synchronous too, and JavaScript runs one of them at a time). A temporary file still
// being written is in the ingest's own set, which the sweep skips. One process owns a root: pins
// are in memory, and a second process would rely on the grace alone.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, type ReadStream, rmSync, statSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ARTIFACT_EVENTS,
  ArtifactCreated,
  type ArtifactCreatedData,
  ArtifactDeleted,
  ArtifactExpired,
  type ArtifactKeptBy,
  type ArtifactKind,
  type ArtifactSource,
  ArtifactSwept,
  type ArtifactSweptData,
  ArtifactTakenDown,
  type EventScope,
} from "@miyoria/contracts/events";
import { getLogger } from "@miyoria/runtime/kernel";
import {
  isUlid,
  newId,
  type PersonId,
  serviceKey,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { and, desc, eq, gt, gte, isNotNull, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { StoreError } from "../common.js";
import type { Db } from "../db.js";
import type { EventStore, LoggedEvent } from "../events/log.js";
import { HOME_SESSION } from "../identity/identity.js";
import { rooms, sessions } from "../identity/schema.js";
import { ArtifactTypeError, decideType, SNIFF_BYTES, sniff, TextCheck } from "./media.js";
import { BlobLayout, cleanFilename, isSha256 } from "./paths.js";
import { ArtifactPlaces } from "./places.js";
import {
  ARTIFACT_SOURCES,
  type ArtifactRow,
  artifactBlobs,
  artifactItems,
  artifactShares,
  KEPT_BY,
  SONG_COVER_SOURCE,
} from "./schema.js";
import { ArtifactShares } from "./shares.js";
import { type ArtifactViewer, isLive, maySee } from "./visibility.js";

const log = getLogger("store.artifacts");

/** The source stamped on the store's own events (expiry, sweep, take-down, shares). */
export const ARTIFACT_EVENT_SOURCE = "artifact";

const HOUR_MS = 3_600_000;

/** The event types of the audit trail (`history`). */
const HISTORY_TYPES = ARTIFACT_EVENTS.map((e) => e.type).filter((t) => t !== ArtifactSwept.type);
const MIB = 1024 * 1024;

/** How long an artifact that is not kept lives (v5-architecture §16 #11). */
export const DEFAULT_LIFETIME_MS = 7 * 24 * HOUR_MS;

/** How long the sweep waits before removing what nothing uses (§5: "for 24 hours"). */
export const DEFAULT_GRACE_MS = 24 * HOUR_MS;

/** The largest content of each kind, in bytes. */
export const DEFAULT_SIZE_LIMITS: Readonly<Record<ArtifactKind, number>> = {
  image: 32 * MIB,
  audio: 128 * MIB,
  video: 512 * MIB,
  document: 64 * MIB,
  text: 8 * MIB,
};

/** One artifact's record. */
export type Artifact = ArtifactRow;

export interface ArtifactStoreOptions {
  /** The directory the bytes live under (`data/artifacts`). Created when first needed. */
  root: string;
  /** Per-kind size limits, over the defaults. */
  limits?: Partial<Record<ArtifactKind, number>>;
  /** How long an artifact that is not kept lives. Default 7 days. */
  lifetimeMs?: number;
  /** Per-source lifetimes, over `lifetimeMs` (none by default: §5 has no per-kind lifetime). */
  lifetimes?: Partial<Record<ArtifactSource, number>>;
  /** The sweep's grace for deleted rows, unused blobs and stray files. Default 24 hours. */
  graceMs?: number;
  /**
   * Called once an ingest's blob is in place and before its row commits. Tests use it to race the
   * sweep against an ingest.
   */
  onPlaced?: (sha256: string) => void | Promise<void>;
}

/** Where an artifact was made: a session and its place, as identity resolved them. */
export interface ArtifactPlace {
  /** The session key (`discord:<g>:<c>`, `discord:dm:<person>`, `home`); `null`: home. */
  session: string | null;
  space_id: string | null;
  room_id: string | null;
}

/** What an ingest records besides the bytes. */
export interface ArtifactInput {
  source: ArtifactSource;
  /** The plugin storing it (also the event's source). */
  plugin: string;
  /** The name a caller or the model gave it; cleaned, and given the sniffed type's extension. */
  filename?: string | null;
  /** The type the caller believes it is: checked against the content, never trusted. */
  mime?: string | null;
  /** Where it was made; `null`: her own, at home. */
  place?: ArtifactPlace | null;
  /**
   * Who may see it. Default: the place's (`room` in a guild room, `dm` in a DM, `self` at home).
   * Never wider than the place: nothing made in a DM is seen in a space.
   */
  scope?: EventScope | null;
  /** The person it was made for (a DM's person when not given). */
  made_for?: PersonId | null;
  turn?: string | null;
  /** The artifact this one is a cleaned or re-encoded copy of. */
  derived_from?: string | null;
  /** Keep it from the start (an album, the cards): it does not expire. */
  keep?: ArtifactKeptBy | null;
  /**
   * When it expires (epoch ms), in place of a lifetime from now: a cleaned copy expires with its
   * original. Ignored when `keep` is set.
   */
  expiresAtMs?: number | null;
  /** The sha256 a remote host announced for these bytes: refused when they differ. */
  sha256?: string | null;
  signal?: AbortSignal;
}

/** Which artifacts `list` returns; every field narrows. Newest first. */
export interface ArtifactFilter {
  made_for?: PersonId;
  space_id?: string;
  room_id?: string;
  source?: ArtifactSource;
  kind?: ArtifactKind;
  plugin?: string;
  /** Only copies of this artifact (a cleaned or re-encoded one). */
  derived_from?: string;
  /** Only kept ones (`true`), or only expiring ones (`false`). */
  kept?: boolean;
  /** Only those in an album. */
  album?: boolean;
  /** Made at or after. */
  since?: Timestamp;
  /** Made before. */
  until?: Timestamp;
  /** Expiring at or before (kept ones never do). */
  expiresBy?: Timestamp;
  /** Also deleted rows still within the grace. Default false. */
  includeDeleted?: boolean;
  /** Only what this viewer may see (`visibility.ts`). */
  viewer?: ArtifactViewer;
  /** Made before the artifact with this id (paging). */
  before?: string;
  /** Default 50, at most 500. */
  limit?: number;
}

/** What an ingest was checked to record. */
interface IngestPlan {
  source: ArtifactSource;
  plugin: string;
  session: string | null;
  space: string | null;
  room: string | null;
  scope: EventScope;
  madeFor: PersonId | null;
  turn: string | null;
  derivedFrom: string | null;
  keep: ArtifactKeptBy | null;
  expiresAtMs: number | null;
}

/** What one sweep did. */
export interface SweepResult extends ArtifactSweptData {
  /** Artifacts that expired in this run (one `artifact.expired` event each). */
  expired: number;
}

/** The artifact was not found, or the viewer may not see it. */
export class ArtifactNotFoundError extends StoreError {}

/** The artifact's row is there but its bytes are not. */
export class ArtifactBlobMissingError extends StoreError {}

/** The content is larger than its kind allows. */
export class ArtifactTooLargeError extends StoreError {}

/** The bytes are not what a remote host announced. */
export class ArtifactHashMismatchError extends StoreError {}

/** What an ingest was asked to record does not fit where it was made. */
export class ArtifactInputError extends StoreError {}

const TIME = (ms: number): Timestamp => toTimestamp(ms);

function nonNegative(value: number | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new StoreError(`${what} must be 0 or more`);
  return value;
}

/** `error` is a file-system error with this code. */
function fsCode(error: unknown, ...codes: string[]): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && codes.includes(code);
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (fsCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** Makes a directory's entries durable after a rename (POSIX; Windows cannot open a directory). */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort: some file systems refuse fsync on a directory.
  }
}

async function* chunksOf(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/** The artifacts of one database (one character), their bytes under one root. */
export class ArtifactStore {
  readonly layout: BlobLayout;
  /** Share tokens of these artifacts. */
  readonly shares: ArtifactShares;
  /** Contexts as places and viewers (`places.ts`). */
  readonly places: ArtifactPlaces;
  readonly #db: Db;
  readonly #events: EventStore;
  readonly #limits: Record<ArtifactKind, number>;
  readonly #maxLimit: number;
  readonly #lifetimeMs: number;
  readonly #lifetimes: Partial<Record<ArtifactSource, number>>;
  readonly #graceMs: number;
  readonly #onPlaced: ((sha256: string) => void | Promise<void>) | null;
  /** Hashes an ingest is placing or committing, with how many ingests hold each. */
  readonly #pins = new Map<string, number>();
  /** Temporary files being written. */
  readonly #temps = new Set<string>();
  #sweeping: Promise<SweepResult> | null = null;
  readonly #byId;

  constructor(db: Db, events: EventStore, options: ArtifactStoreOptions) {
    this.#db = db;
    this.#events = events;
    this.layout = new BlobLayout(options.root);
    this.#limits = { ...DEFAULT_SIZE_LIMITS };
    for (const [kind, bytes] of Object.entries(options.limits ?? {})) {
      if (bytes === undefined) continue;
      if (!Number.isSafeInteger(bytes) || bytes < 1) {
        throw new StoreError(`the size limit of ${kind} must be a positive integer`);
      }
      this.#limits[kind as ArtifactKind] = bytes;
    }
    this.#maxLimit = Math.max(...Object.values(this.#limits));
    this.#lifetimeMs = nonNegative(options.lifetimeMs, DEFAULT_LIFETIME_MS, "lifetimeMs");
    this.#lifetimes = {};
    for (const [source, ms] of Object.entries(options.lifetimes ?? {})) {
      if (!ARTIFACT_SOURCES.includes(source as ArtifactSource)) {
        throw new StoreError(`unknown artifact source \`${source}\``);
      }
      this.#lifetimes[source as ArtifactSource] = nonNegative(ms, 0, `the lifetime of ${source}`);
    }
    this.#graceMs = nonNegative(options.graceMs, DEFAULT_GRACE_MS, "graceMs");
    this.#onPlaced = options.onPlaced ?? null;
    this.#byId = db.orm
      .select()
      .from(artifactItems)
      .where(eq(artifactItems.id, sql.placeholder("id")))
      .prepare();
    this.places = new ArtifactPlaces(db);
    this.shares = new ArtifactShares(db, events, {
      get: (id) => this.get(id),
      isLive: (artifact) => this.#isLive(artifact),
    });
  }

  /** The size limit of a kind, in bytes. */
  limit(kind: ArtifactKind): number {
    return this.#limits[kind];
  }

  /** How long an artifact of `source` lives when it is not kept. */
  lifetime(source: ArtifactSource): number {
    return this.#lifetimes[source] ?? this.#lifetimeMs;
  }

  #nowMs(): number {
    return this.#db.clock.now();
  }

  #isLive(artifact: Artifact): boolean {
    return isLive(artifact, this.#nowMs());
  }

  // ---- pins -----------------------------------------------------------------------------------

  #pin(sha256: string): void {
    this.#pins.set(sha256, (this.#pins.get(sha256) ?? 0) + 1);
  }

  #unpin(sha256: string): void {
    const n = (this.#pins.get(sha256) ?? 0) - 1;
    if (n <= 0) this.#pins.delete(sha256);
    else this.#pins.set(sha256, n);
  }

  /** Whether an ingest is placing or committing this blob. */
  isPinned(sha256: string): boolean {
    return this.#pins.has(sha256);
  }

  // ---- ingest ---------------------------------------------------------------------------------

  /** Stores `data` as an artifact. */
  async ingest(data: Uint8Array, input: ArtifactInput): Promise<Artifact> {
    return this.ingestStream(chunksOf(data), input);
  }

  /**
   * Stores the file at `path` as an artifact (copied; the file is left as it is). Refuses a
   * symbolic link or anything that is not a regular file.
   */
  async ingestFile(path: string, input: ArtifactInput): Promise<Artifact> {
    if (typeof path !== "string" || path === "" || path.includes("\0")) {
      throw new ArtifactInputError("ingestFile needs a file path");
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (cause) {
      throw new ArtifactInputError("cannot read the file to ingest", { cause });
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ArtifactInputError("only a regular file can be ingested (not a link or a folder)");
    }
    // What is opened must be the file just looked at, not a link put in its place since.
    const handle = await open(path, "r");
    let opened: Awaited<ReturnType<typeof handle.stat>>;
    try {
      opened = await handle.stat();
    } catch (error) {
      await handle.close();
      throw error;
    }
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) {
      await handle.close();
      throw new ArtifactInputError("the file changed while it was being opened");
    }
    return this.ingestStream(handle.createReadStream({ signal: input.signal }), input);
  }

  /** Stores the bytes of `stream` as an artifact. */
  async ingestStream(stream: AsyncIterable<Uint8Array>, input: ArtifactInput): Promise<Artifact> {
    let plan: IngestPlan;
    try {
      plan = this.#plan(input);
    } catch (error) {
      // Not read at all: a file stream would keep its descriptor open.
      (stream as { destroy?: () => void }).destroy?.();
      throw error;
    }
    const temp = this.layout.tempPath();
    this.#temps.add(temp);
    try {
      const written = await this.#write(stream, temp, input);
      const type = decideType(written.head, written.text, input.mime);
      if (written.size > this.#limits[type.kind]) {
        throw new ArtifactTooLargeError(
          `the ${type.kind} is ${written.size} bytes, over its limit of ${this.#limits[type.kind]}`,
        );
      }
      if (input.sha256 != null && input.sha256.toLowerCase() !== written.sha256) {
        throw new ArtifactHashMismatchError(
          "the bytes are not the ones announced (sha256 differs)",
        );
      }
      return await this.#place(temp, written.sha256, written.size, () =>
        this.#commit(plan, {
          sha256: written.sha256,
          size: written.size,
          mime: type.mime,
          kind: type.kind,
          filename: cleanFilename(input.filename, type.extension),
        }),
      );
    } catch (error) {
      (stream as { destroy?: () => void }).destroy?.();
      throw error;
    } finally {
      this.#temps.delete(temp);
      await rm(temp, { force: true }).catch((error: unknown) => {
        log.warn({ err: String(error) }, "cannot remove an artifact's temporary file");
      });
    }
  }

  /** Checks what an ingest records, before any byte is written. */
  #plan(input: ArtifactInput): IngestPlan {
    if (!ARTIFACT_SOURCES.includes(input.source)) {
      throw new ArtifactInputError(`unknown artifact source \`${String(input.source)}\``);
    }
    if (typeof input.plugin !== "string" || input.plugin.trim() === "") {
      throw new ArtifactInputError("an artifact needs the plugin that stores it");
    }
    if (input.keep != null && !KEPT_BY.includes(input.keep)) {
      throw new ArtifactInputError(`unknown keeper \`${String(input.keep)}\``);
    }
    if (input.sha256 != null && !isSha256(input.sha256.toLowerCase())) {
      throw new ArtifactInputError("an announced sha256 must be 64 hex digits");
    }
    if (input.derived_from != null && !isUlid(input.derived_from)) {
      throw new ArtifactInputError("derived_from must be an artifact id");
    }
    const place = input.place ?? null;
    const session = place?.session ?? null;
    const home = session === null || session === HOME_SESSION;
    const space = home ? null : (place?.space_id ?? null);
    const room = home ? null : (place?.room_id ?? null);
    let madeFor = input.made_for ?? null;
    let allowed: readonly EventScope[];
    let fallback: EventScope;
    if (home) {
      allowed = ["public", "self", "owner", "dm"];
      fallback = "self";
    } else if (space !== null) {
      allowed = ["public", "space", "room", "dm", "self", "owner"];
      fallback = room === null ? "space" : "room";
    } else {
      // A DM: never anything a space or the public sees.
      allowed = ["dm", "self", "owner"];
      fallback = "dm";
      madeFor ??= this.#dmPerson(session);
    }
    const scope = input.scope ?? fallback;
    if (!allowed.includes(scope)) {
      throw new ArtifactInputError(`an artifact made here cannot be \`${scope}\`: too wide`);
    }
    if (scope === "room" && room === null) {
      throw new ArtifactInputError("a `room` artifact needs the room it was made in");
    }
    if (scope === "dm" && madeFor === null) {
      throw new ArtifactInputError("a `dm` artifact needs the person it was made for");
    }
    if (room !== null) {
      const found = this.#db.orm
        .select({ space_id: rooms.space_id })
        .from(rooms)
        .where(eq(rooms.id, room))
        .get();
      if (found !== undefined && found.space_id !== space) {
        throw new ArtifactInputError("the room is not in the space given with it");
      }
    }
    return {
      source: input.source,
      plugin: input.plugin.trim(),
      session,
      space,
      room,
      scope,
      madeFor,
      turn: input.turn ?? null,
      derivedFrom: input.derived_from ?? null,
      keep: input.keep ?? null,
      expiresAtMs:
        input.expiresAtMs != null && Number.isFinite(input.expiresAtMs) ? input.expiresAtMs : null,
    };
  }

  /** The person of a DM session, from identity. */
  #dmPerson(session: string | null): PersonId | null {
    if (session === null) return null;
    const row = this.#db.orm
      .select({ person_id: sessions.person_id })
      .from(sessions)
      .where(eq(sessions.key, session))
      .get();
    return row?.person_id ?? null;
  }

  /** Writes `stream` to `temp`, hashing, measuring and sniffing it on the way; synced. */
  async #write(stream: AsyncIterable<Uint8Array>, temp: string, input: ArtifactInput) {
    await mkdir(this.layout.tmp, { recursive: true });
    const hash = createHash("sha256");
    const text = new TextCheck();
    const head = new Uint8Array(SNIFF_BYTES);
    let headLength = 0;
    let size = 0;
    let limit = this.#maxLimit;
    const handle = await open(temp, "wx");
    try {
      for await (const raw of stream) {
        input.signal?.throwIfAborted();
        const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
        if (chunk.length === 0) continue;
        size += chunk.length;
        if (headLength < SNIFF_BYTES) {
          const take = Math.min(SNIFF_BYTES - headLength, chunk.length);
          head.set(chunk.subarray(0, take), headLength);
          headLength += take;
          if (headLength === SNIFF_BYTES) {
            // The kind is known from here on (or it can only be text): its own limit applies.
            limit = this.#limits[sniff(head)?.kind ?? "text"];
          }
        }
        if (size > limit) {
          throw new ArtifactTooLargeError(`the content is over its size limit of ${limit} bytes`);
        }
        hash.update(chunk);
        text.push(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          offset += bytesWritten;
        }
      }
      input.signal?.throwIfAborted();
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (size === 0) throw new ArtifactTypeError("an artifact cannot be empty");
    return {
      sha256: hash.digest("hex"),
      size,
      head: head.subarray(0, headLength),
      text: text.end(),
    };
  }

  /**
   * Moves `temp` into the blob's place (or drops it when the same bytes are there), then runs
   * `commit`, with the hash pinned throughout. A blob this call placed is removed again when the
   * commit fails and nothing else uses it.
   */
  async #place<T>(temp: string, sha256: string, size: number, commit: () => T): Promise<T> {
    const target = this.layout.blobPath(sha256);
    this.#pin(sha256);
    try {
      await mkdir(dirname(target), { recursive: true });
      let placed = false;
      const existing = await statOrNull(target);
      if (existing?.isFile() && existing.size === size) {
        await rm(temp, { force: true });
      } else {
        try {
          await rename(temp, target);
          placed = true;
          await syncDir(dirname(target));
        } catch (error) {
          // Another ingest of the same bytes got there first (Windows refuses to replace a file
          // that is open): theirs is as good as ours.
          const now = await statOrNull(target);
          if (!(now?.isFile() && now.size === size)) throw error;
          await rm(temp, { force: true });
        }
      }
      await this.#onPlaced?.(sha256);
      try {
        return commit();
      } catch (error) {
        if (placed) this.#dropIfUnused(sha256, target);
        throw error;
      }
    } finally {
      this.#unpin(sha256);
    }
  }

  /** Removes a blob file at once when no row and no other ingest uses it. Synchronous. */
  #dropIfUnused(sha256: string, target: string): void {
    if ((this.#pins.get(sha256) ?? 0) > 1) return;
    const row = this.#db.orm
      .select({ sha256: artifactBlobs.sha256 })
      .from(artifactBlobs)
      .where(eq(artifactBlobs.sha256, sha256))
      .get();
    if (row !== undefined) return;
    try {
      rmSync(target, { force: true });
    } catch (error) {
      log.warn({ err: String(error), sha256 }, "cannot remove an uncommitted blob; the sweep will");
    }
  }

  /** The row, its blob's row and the `artifact.created` event, in one transaction. */
  #commit(
    plan: IngestPlan,
    content: { sha256: string; size: number; mime: string; kind: ArtifactKind; filename: string },
  ): Artifact {
    return this.#db.tx(() => {
      const nowMs = this.#nowMs();
      const at = TIME(nowMs);
      const id = newId();
      const eventId = newId();
      const expires =
        plan.keep !== null
          ? null
          : TIME(Math.max(nowMs + 1, plan.expiresAtMs ?? nowMs + this.lifetime(plan.source)));
      const downloadable = plan.source !== SONG_COVER_SOURCE;
      const orm = this.#db.orm;
      orm
        .insert(artifactBlobs)
        .values({ sha256: content.sha256, size: content.size, location: "local", stored_at: at })
        .onConflictDoNothing()
        .run();
      const row = orm
        .insert(artifactItems)
        .values({
          id,
          sha256: content.sha256,
          size: content.size,
          mime: content.mime,
          kind: content.kind,
          filename: content.filename,
          source: plan.source,
          plugin: plan.plugin,
          derived_from: plan.derivedFrom,
          turn: plan.turn,
          event_id: eventId,
          made_for: plan.madeFor,
          origin_session: plan.session,
          space_id: plan.space,
          room_id: plan.room,
          scope: plan.scope,
          downloadable,
          created_at: at,
          expires_at: expires,
          kept_by: plan.keep,
        })
        .returning()
        .get();
      const data: ArtifactCreatedData = {
        artifact_id: id,
        sha256: content.sha256,
        size: content.size,
        mime: content.mime,
        kind: content.kind,
        filename: content.filename,
        source: plan.source,
        plugin: plan.plugin,
        made_for: plan.madeFor,
        derived_from: plan.derivedFrom,
        expires_at: expires,
        kept_by: plan.keep,
        downloadable,
      };
      this.#events.appendNow({
        draft: {
          id: eventId,
          at,
          type: ArtifactCreated.type,
          v: ArtifactCreated.v,
          scope: plan.scope,
          session: plan.session,
          space_id: plan.space,
          room_id: plan.room,
          person_id: plan.madeFor,
          turn: plan.turn,
          key: `artifact:${id}`,
          data,
        },
        source: plan.plugin,
      });
      return row;
    });
  }

  // ---- reading --------------------------------------------------------------------------------

  /** An artifact's record by id, whatever its state; `null` for an unknown or malformed id. */
  get(id: string): Artifact | null {
    if (typeof id !== "string" || !isUlid(id)) return null;
    this.#db.ensureOpen();
    return this.#byId.get({ id }) ?? null;
  }

  /** The parent of a thread room, for the visibility rule. */
  #parentOf(room: string | null): string | null {
    if (room === null) return null;
    const row = this.#db.orm
      .select({ parent_id: rooms.parent_id })
      .from(rooms)
      .where(eq(rooms.id, room))
      .get();
    return row?.parent_id ?? null;
  }

  /** Whether `viewer` may see `artifact` now. */
  visibleTo(artifact: Artifact, viewer: ArtifactViewer): boolean {
    const parent = artifact.scope === "room" ? this.#parentOf(artifact.room_id) : null;
    return maySee({ ...artifact, room_parent_id: parent }, viewer, this.#nowMs());
  }

  /** An artifact `viewer` may see now, or `null` (unknown, gone, or not theirs to see). */
  find(id: string, viewer: ArtifactViewer): Artifact | null {
    const artifact = this.get(id);
    return artifact !== null && this.visibleTo(artifact, viewer) ? artifact : null;
  }

  /**
   * The bytes of an artifact `viewer` may see. Throws `ArtifactNotFoundError` when they may not
   * (or it is gone), `ArtifactBlobMissingError` when its file is missing.
   */
  async openFor(
    id: string,
    viewer: ArtifactViewer,
  ): Promise<{ artifact: Artifact; stream: ReadStream }> {
    const artifact = this.find(id, viewer);
    if (artifact === null) throw new ArtifactNotFoundError("no such artifact");
    return { artifact, stream: await this.openContent(artifact) };
  }

  /**
   * A stream of an artifact's bytes, with no visibility check: for callers that checked already
   * (a share token's lookup). Throws `ArtifactBlobMissingError` when the file is missing.
   */
  async openContent(
    artifact: Artifact,
    range?: { start: number; end: number },
  ): Promise<ReadStream> {
    const path = this.layout.blobPath(artifact.sha256);
    const info = await statOrNull(path);
    if (info === null || !info.isFile()) {
      throw new ArtifactBlobMissingError(`the bytes of artifact ${artifact.id} are missing`);
    }
    // An inclusive byte range (a video's seek), or the whole file.
    return range === undefined
      ? createReadStream(path)
      : createReadStream(path, { start: range.start, end: range.end });
  }

  /** Whether `artifact` is still there to be seen now: not deleted, expired or withdrawn. */
  isLive(artifact: Artifact): boolean {
    return this.#isLive(artifact);
  }

  /**
   * All the bytes of an artifact, with no visibility check (for callers that checked already).
   * Throws `ArtifactBlobMissingError` when the file is missing.
   */
  async readContent(artifact: Artifact, signal?: AbortSignal): Promise<Uint8Array> {
    const stream = await this.openContent(artifact);
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        chunks.push(chunk as Buffer);
      }
    } finally {
      stream.destroy();
    }
    return Buffer.concat(chunks);
  }

  /** Artifacts matching `filter`, newest first. */
  list(filter: ArtifactFilter = {}): Artifact[] {
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 50)), 500);
    const nowMs = this.#nowMs();
    const t = artifactItems;
    const where: SQL[] = [];
    if (filter.made_for !== undefined) where.push(eq(t.made_for, filter.made_for));
    if (filter.space_id !== undefined) where.push(eq(t.space_id, filter.space_id));
    if (filter.room_id !== undefined) where.push(eq(t.room_id, filter.room_id));
    if (filter.source !== undefined) where.push(eq(t.source, filter.source));
    if (filter.kind !== undefined) where.push(eq(t.kind, filter.kind));
    if (filter.plugin !== undefined) where.push(eq(t.plugin, filter.plugin));
    if (filter.derived_from !== undefined) where.push(eq(t.derived_from, filter.derived_from));
    if (filter.kept === true) where.push(isNotNull(t.kept_by));
    if (filter.kept === false) where.push(isNull(t.kept_by));
    if (filter.album === true) where.push(eq(t.kept_by, "album"));
    if (filter.since !== undefined) where.push(gte(t.created_at, filter.since));
    if (filter.until !== undefined) where.push(lt(t.created_at, filter.until));
    if (filter.expiresBy !== undefined) where.push(lte(t.expires_at, filter.expiresBy));
    if (filter.includeDeleted !== true) where.push(isNull(t.deleted_at));
    const viewer = filter.viewer;
    if (viewer !== undefined && viewer.owner !== true) {
      // What the rule needs to be true for anyone but the owner; the rule itself decides below.
      where.push(isNull(t.deleted_at));
      where.push(sql`${t.review} NOT IN ('blocked', 'taken_down')`);
      where.push(or(isNull(t.expires_at), gt(t.expires_at, TIME(nowMs))) as SQL);
    }
    const out: Artifact[] = [];
    let before = filter.before !== undefined && isUlid(filter.before) ? filter.before : null;
    const page = viewer === undefined ? limit : Math.max(limit, 100);
    for (;;) {
      const rows = this.#db.orm
        .select({ item: t, parent: rooms.parent_id })
        .from(t)
        .leftJoin(rooms, eq(rooms.id, t.room_id))
        .where(and(...where, ...(before === null ? [] : [lt(t.id, before)])))
        .orderBy(desc(t.id))
        .limit(page)
        .all();
      for (const { item, parent } of rows) {
        if (
          viewer === undefined ||
          maySee({ ...item, room_parent_id: parent ?? null }, viewer, nowMs)
        ) {
          out.push(item);
          if (out.length === limit) return out;
        }
      }
      if (rows.length < page) return out;
      before = rows[rows.length - 1]?.item.id ?? null;
      if (before === null) return out;
    }
  }

  // ---- retention ------------------------------------------------------------------------------

  /** Keeps an artifact (it stops expiring); `album`: it is in an album. `false`: not live. */
  keep(id: string, by: ArtifactKeptBy): boolean {
    if (!KEPT_BY.includes(by)) throw new ArtifactInputError(`unknown keeper \`${String(by)}\``);
    return this.#db.tx(() => {
      const artifact = this.get(id);
      if (artifact === null || !isLive(artifact, this.#nowMs())) return false;
      // Its cleaned copies are what its links hand out: they are kept with it.
      for (const target of [id, ...this.#copiesOf(id)]) {
        this.#db.orm
          .update(artifactItems)
          .set({ kept_by: by, expires_at: null })
          .where(eq(artifactItems.id, target))
          .run();
      }
      return true;
    });
  }

  /** Stops keeping an artifact: it expires a lifetime from now. `false`: not kept or not live. */
  release(id: string): boolean {
    return this.#db.tx(() => {
      const artifact = this.get(id);
      if (artifact === null || artifact.kept_by === null) return false;
      if (!isLive(artifact, this.#nowMs())) return false;
      const expires = TIME(this.#nowMs() + this.lifetime(artifact.source));
      for (const target of [id, ...this.#copiesOf(id)]) {
        this.#db.orm
          .update(artifactItems)
          .set({ kept_by: null, expires_at: expires })
          .where(eq(artifactItems.id, target))
          .run();
      }
      return true;
    });
  }

  /** The ids of the copies made from an artifact (cleaned, re-encoded) that are not deleted. */
  #copiesOf(id: string): string[] {
    return this.#db.orm
      .select({ id: artifactItems.id })
      .from(artifactItems)
      .where(and(eq(artifactItems.derived_from, id), isNull(artifactItems.deleted_at)))
      .all()
      .map((r) => r.id);
  }

  /** Revokes every live share of an artifact; returns how many. Inside the caller's `tx`. */
  #revokeShares(artifactId: string, at: Timestamp): number {
    return this.#db.orm
      .update(artifactShares)
      .set({ revoked_at: at })
      .where(and(eq(artifactShares.artifact_id, artifactId), isNull(artifactShares.revoked_at)))
      .returning({ id: artifactShares.id })
      .all().length;
  }

  /**
   * Takes an artifact down (the owner's decision): nobody but the owner sees it, its shares are
   * revoked, and one `artifact.taken_down` event records who and why. `false`: unknown or
   * already taken down.
   */
  takeDown(id: string, by: string, reason: string): boolean {
    return this.#db.tx(() => {
      const artifact = this.get(id);
      if (artifact === null || artifact.review === "taken_down") return false;
      const at = TIME(this.#nowMs());
      // Its cleaned copies go down with it: they are the same picture.
      let revoked = 0;
      for (const target of [id, ...this.#copiesOf(id)]) {
        this.#db.orm
          .update(artifactItems)
          .set({ review: "taken_down" })
          .where(eq(artifactItems.id, target))
          .run();
        revoked += this.#revokeShares(target, at);
      }
      this.#events.appendNow({
        draft: {
          id: newId(),
          at,
          type: ArtifactTakenDown.type,
          v: ArtifactTakenDown.v,
          key: `artifact:${id}`,
          data: { artifact_id: id, by, reason, shares_revoked: revoked },
        },
        source: ARTIFACT_EVENT_SOURCE,
      });
      return true;
    });
  }

  /**
   * Deletes an artifact for its own person (the member page): it is gone for everyone at once, its
   * shares (and those of its cleaned copies) are revoked, and one `artifact.deleted` event records
   * who. The sweep removes the row and the bytes after the grace. `false`: unknown, already gone,
   * or not made for `person`.
   */
  deleteFor(id: string, person: PersonId): boolean {
    return this.#db.tx(() => {
      const artifact = this.get(id);
      if (artifact === null || artifact.made_for !== person || artifact.deleted_at !== null) {
        return false;
      }
      const at = TIME(this.#nowMs());
      let revoked = 0;
      for (const target of [id, ...this.#copiesOf(id)]) {
        this.#db.orm
          .update(artifactItems)
          .set({ deleted_at: at })
          .where(eq(artifactItems.id, target))
          .run();
        revoked += this.#revokeShares(target, at);
      }
      this.#events.appendNow({
        draft: {
          id: newId(),
          at,
          type: ArtifactDeleted.type,
          v: ArtifactDeleted.v,
          person_id: person,
          key: `artifact:${id}`,
          data: { artifact_id: id, by: `person:${person}`, shares_revoked: revoked },
        },
        source: ARTIFACT_EVENT_SOURCE,
      });
      return true;
    });
  }

  /**
   * The audit trail of the artifacts and their shares, newest first: what was made, shared (as an
   * attachment or a link), opened, revoked, deleted, taken down, expired.
   */
  history(options: { limit?: number; before?: string } = {}): LoggedEvent[] {
    return this.#events.query({
      types: HISTORY_TYPES,
      order: "desc",
      limit: Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 500),
      ...(options.before === undefined ? {} : { before: options.before }),
    }) as LoggedEvent[];
  }

  // ---- the sweep ------------------------------------------------------------------------------

  /** Runs the sweep (see the file comment). A sweep already running is joined, not repeated. */
  sweep(): Promise<SweepResult> {
    this.#sweeping ??= this.#sweep().finally(() => {
      this.#sweeping = null;
    });
    return this.#sweeping;
  }

  async #sweep(): Promise<SweepResult> {
    const nowMs = this.#nowMs();
    const cutoffMs = nowMs - this.#graceMs;
    const result: SweepResult = {
      expired: this.#expire(nowMs),
      rows_removed: this.#purgeDeleted(TIME(cutoffMs)),
      blobs_removed: 0,
      bytes_freed: 0,
      orphan_files_removed: 0,
      temp_files_removed: 0,
      missing_blobs: 0,
    };
    const blobs = this.#collectBlobs(TIME(cutoffMs));
    result.blobs_removed = blobs.removed;
    result.bytes_freed = blobs.bytes;
    const disk = await this.#scanBlobs(cutoffMs);
    result.orphan_files_removed = disk.orphans;
    result.missing_blobs = disk.missing;
    result.temp_files_removed = await this.#scanTemps(cutoffMs);
    const { expired: _, ...counts } = result;
    if (Object.values(counts).some((n) => n > 0)) {
      this.#events.appendNow({
        draft: {
          id: newId(),
          at: TIME(nowMs),
          type: ArtifactSwept.type,
          v: ArtifactSwept.v,
          data: counts,
        },
        source: ARTIFACT_EVENT_SOURCE,
      });
    }
    if (result.missing_blobs > 0) {
      log.warn({ missing: result.missing_blobs }, "artifact blobs are missing their files");
    }
    log.debug({ ...result }, "artifact sweep finished");
    return result;
  }

  /** Step 1: artifacts past their expiry are marked deleted, in batches. */
  #expire(nowMs: number): number {
    const at = TIME(nowMs);
    const t = artifactItems;
    let total = 0;
    for (;;) {
      const n = this.#db.tx(() => {
        const due = this.#db.orm
          .select({ id: t.id, sha256: t.sha256, expires_at: t.expires_at })
          .from(t)
          .where(and(isNotNull(t.expires_at), isNull(t.deleted_at), lte(t.expires_at, at)))
          .orderBy(t.expires_at)
          .limit(200)
          .all();
        for (const row of due) {
          this.#db.orm.update(t).set({ deleted_at: at }).where(eq(t.id, row.id)).run();
          const revoked = this.#revokeShares(row.id, at);
          this.#events.appendNow({
            draft: {
              id: newId(),
              at,
              type: ArtifactExpired.type,
              v: ArtifactExpired.v,
              key: `artifact:${row.id}`,
              data: {
                artifact_id: row.id,
                sha256: row.sha256,
                expires_at: row.expires_at ?? at,
                shares_revoked: revoked,
              },
            },
            source: ARTIFACT_EVENT_SOURCE,
          });
        }
        return due.length;
      });
      total += n;
      if (n < 200) return total;
    }
  }

  /** Step 2: deleted rows past the grace go for good (their shares cascade). */
  #purgeDeleted(cutoff: Timestamp): number {
    const t = artifactItems;
    return this.#db.tx(
      () =>
        this.#db.orm
          .delete(t)
          .where(and(isNotNull(t.deleted_at), lte(t.deleted_at, cutoff)))
          .returning({ id: t.id })
          .all().length,
    );
  }

  /**
   * Step 3: blobs no row uses, stored before `cutoff`: row, then file. Synchronous, so no ingest
   * pins or commits in between.
   */
  #collectBlobs(cutoff: Timestamp): { removed: number; bytes: number } {
    const b = artifactBlobs;
    const unused = sql`NOT EXISTS (SELECT 1 FROM ${artifactItems} WHERE ${artifactItems.sha256} = ${b.sha256})`;
    const candidates = this.#db.orm
      .select({ sha256: b.sha256, size: b.size })
      .from(b)
      .where(and(unused, lte(b.stored_at, cutoff)))
      .all();
    let removed = 0;
    let bytes = 0;
    for (const blob of candidates) {
      if (this.#pins.has(blob.sha256)) continue;
      const gone = this.#db.tx(
        () =>
          this.#db.orm
            .delete(b)
            .where(and(eq(b.sha256, blob.sha256), unused))
            .returning({ sha256: b.sha256 })
            .all().length,
      );
      if (gone === 0) continue;
      removed++;
      bytes += blob.size;
      try {
        rmSync(this.layout.blobPath(blob.sha256), { force: true });
      } catch (error) {
        // The row is gone: the next sweep finds the file as an orphan.
        log.warn({ err: String(error), sha256: blob.sha256 }, "cannot remove a blob file");
      }
    }
    return { removed, bytes };
  }

  /**
   * Step 4: blob files without a row, older than `cutoffMs`, are removed; blob rows without a
   * file are counted. Names that are not blob names are left alone.
   */
  async #scanBlobs(cutoffMs: number): Promise<{ orphans: number; missing: number }> {
    const seen = new Set<string>();
    let orphans = 0;
    const hex2 = /^[0-9a-f]{2}$/;
    const level1 = await readdir(this.layout.blobs).catch(() => [] as string[]);
    for (const aa of level1) {
      if (!hex2.test(aa)) continue;
      const level2 = await readdir(join(this.layout.blobs, aa)).catch(() => [] as string[]);
      for (const bb of level2) {
        if (!hex2.test(bb)) continue;
        const names = await readdir(join(this.layout.blobs, aa, bb)).catch(() => [] as string[]);
        for (const name of names) {
          if (!isSha256(name) || name.slice(0, 2) !== aa || name.slice(2, 4) !== bb) continue;
          seen.add(name);
          const path = this.layout.blobPath(name);
          const info = await statOrNull(path);
          if (info === null || !info.isFile() || info.mtimeMs > cutoffMs) continue;
          // From here to the unlink nothing awaits: no ingest pins or commits in between.
          if (this.#pins.has(name) || this.#hasBlobRow(name)) continue;
          try {
            rmSync(path, { force: true });
            seen.delete(name);
            orphans++;
          } catch (error) {
            log.warn({ err: String(error), sha256: name }, "cannot remove an orphan blob file");
          }
        }
      }
    }
    let missing = 0;
    const rows = this.#db.orm.select({ sha256: artifactBlobs.sha256 }).from(artifactBlobs).all();
    for (const { sha256 } of rows) {
      if (seen.has(sha256)) continue;
      // Placed and committed while the scan ran, perhaps: look again.
      if (existsSync(this.layout.blobPath(sha256))) continue;
      missing++;
    }
    return { orphans, missing };
  }

  #hasBlobRow(sha256: string): boolean {
    return (
      this.#db.orm
        .select({ sha256: artifactBlobs.sha256 })
        .from(artifactBlobs)
        .where(eq(artifactBlobs.sha256, sha256))
        .get() !== undefined
    );
  }

  /** Step 5: temporary files of no running ingest, older than `cutoffMs`. */
  async #scanTemps(cutoffMs: number): Promise<number> {
    let removed = 0;
    const names = await readdir(this.layout.tmp).catch(() => [] as string[]);
    for (const name of names) {
      const path = this.layout.tempFile(name);
      if (path === null || this.#temps.has(path)) continue;
      let info: ReturnType<typeof statSync>;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info === undefined || !info.isFile() || info.mtimeMs > cutoffMs) continue;
      if (this.#temps.has(path)) continue;
      try {
        rmSync(path, { force: true });
        removed++;
      } catch (error) {
        log.warn({ err: String(error) }, "cannot remove a stale temporary file");
      }
    }
    return removed;
  }
}

/** The app's artifact store, when its database has one (a file database; not `:memory:`). */
export const ArtifactStoreKey = serviceKey<ArtifactStore>("ArtifactStore");
