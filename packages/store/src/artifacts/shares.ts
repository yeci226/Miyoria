// Share tokens (docs/design/v5-data.md §5, v5-architecture §11.2): the only way an artifact will
// reach the web (`https://<file domain>/f/<token>`, a later step).
//
// - A token is 256 random bits (base64url, 43 characters). Only its sha256 is stored; the token
//   itself is returned once, by `create`. A lookup hashes what it is given, finds the row by that
//   hash and compares the two hashes with `timingSafeEqual`, so neither the token nor the stored
//   hash is ever compared byte by byte in a way whose time depends on how much matched.
// - A share has an audience (one person, a space's members, anyone with the link), an expiry
//   (default 7 days, never past the artifact's own), an optional use limit, and a mode: `stream`
//   or `download`. A song cover is never downloadable (v5-architecture §16 #11), so a share of one
//   is `stream` only: the route step serves `stream` without `Content-Disposition: attachment`
//   and without the save path.
// - The audience is never wider than where the artifact was made (§11.2, `share-policy.ts`): a
//   DM-made artifact is shared with its person only, a room's or a space's with that space or its
//   members, and only a `public` artifact by link, unless the share says `widen` (its person asked
//   for the link themself; the route checks who is asking). Widening never opens a space or
//   another person.
// - `use` counts one use atomically (the one counter that changes, §5) and refuses a token that is
//   revoked, expired or used up. Only a token's first use is an event (`share.opened`).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type ShareAudience,
  ShareCreated,
  type ShareCreatedData,
  type ShareMode,
  ShareOpened,
  ShareRevoked,
} from "@miyoria/contracts/events";
import { newId, type PersonId, type Timestamp, toTimestamp } from "@miyoria/types";
import { and, desc, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import { StoreError } from "../common.js";
import type { Db } from "../db.js";
import type { EventStore } from "../events/log.js";
import { isSpaceMember } from "./membership.js";
import {
  type ArtifactRow,
  type ArtifactShareRow,
  artifactItems,
  artifactShares,
  SHARE_AUDIENCES,
  SHARE_MODES,
} from "./schema.js";
import { type AudienceRefusal, audienceAllowed } from "./share-policy.js";

/** Where the share events are stamped from. */
const SHARE_SOURCE = "artifact";

/** How long a share lives when the caller names no expiry. */
export const DEFAULT_SHARE_TTL_MS = 7 * 24 * 3_600_000;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type ArtifactShare = ArtifactShareRow;

/** A share could not be made as asked; `reason` names the audience rule when it was one. */
export class ArtifactShareError extends StoreError {
  readonly reason: AudienceRefusal | null;

  constructor(message: string, reason: AudienceRefusal | null = null) {
    super(message);
    this.reason = reason;
  }
}

export interface ShareInput {
  audience: ShareAudience;
  /** The person of a `person` share. */
  person_id?: PersonId | null;
  /** The space of a `space` share. */
  space_id?: string | null;
  /** Default: `download` when the artifact may be downloaded, else `stream`. */
  mode?: ShareMode;
  /** How long it lives; `null`: as long as the artifact. Default 7 days. Capped by the artifact. */
  ttlMs?: number | null;
  /** How many uses it allows; `null`: no limit. */
  maxUses?: number | null;
  /** Who asked (the event's person) and in which turn. */
  requested_by?: PersonId | null;
  turn?: string | null;
  /**
   * Its person asked for the link audience themself (owner 2026-11-22: only they may widen their
   * own item). Opens `link` for an artifact made for a person in a DM, a room or a space, and
   * nothing else (`share-policy.ts`). The caller checks who is asking.
   */
  widen?: boolean;
}

/** Why a token does not open anything. */
export type ShareRefusal = "unknown" | "revoked" | "expired" | "used_up" | "gone";

export type ShareLookup =
  | { ok: true; share: ArtifactShare; artifact: ArtifactRow }
  | { ok: false; reason: ShareRefusal };

/** What the shares need of the artifact store. */
export interface ShareDeps {
  get(id: string): ArtifactRow | null;
  isLive(artifact: ArtifactRow): boolean;
}

/** sha256 (hex) of a token, as it is stored. */
export function shareTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The share tokens of one database's artifacts. */
export class ArtifactShares {
  readonly #db: Db;
  readonly #events: EventStore;
  readonly #deps: ShareDeps;
  readonly #byHash;
  readonly #byId;

  constructor(db: Db, events: EventStore, deps: ShareDeps) {
    this.#db = db;
    this.#events = events;
    this.#deps = deps;
    this.#byHash = db.orm
      .select()
      .from(artifactShares)
      .where(eq(artifactShares.token_hash, sql.placeholder("hash")))
      .prepare();
    this.#byId = db.orm
      .select()
      .from(artifactShares)
      .where(eq(artifactShares.id, sql.placeholder("id")))
      .prepare();
  }

  #now(): number {
    return this.#db.clock.now();
  }

  /** Whether `person` is a member of `space` (`membership.ts`). */
  isMember(person: PersonId, space: string): boolean {
    return isSpaceMember(this.#db, person, space);
  }

  /** Throws when the audience would be wider than where `artifact` was made (`share-policy.ts`). */
  #checkAudience(artifact: ArtifactRow, input: ShareInput): void {
    const verdict = audienceAllowed(
      artifact,
      input,
      (person, space) => this.isMember(person, space),
      input.widen === true,
    );
    if (!verdict.ok) throw new ArtifactShareError(verdict.message, verdict.reason);
  }

  /**
   * How many shares of artifacts made for `person` were created since `since` (revoked ones
   * included): the per-person daily quota counts what was handed out, not what is still live.
   */
  countFor(person: PersonId, since: Timestamp): number {
    this.#db.ensureOpen();
    const row = this.#db.orm
      .select({ n: sql<number>`count(*)` })
      .from(artifactShares)
      .innerJoin(artifactItems, eq(artifactItems.id, artifactShares.artifact_id))
      .where(and(eq(artifactItems.made_for, person), gte(artifactShares.created_at, since)))
      .get();
    return Number(row?.n ?? 0);
  }

  /** The shares of an artifact that still open something now (not revoked, expired, used up). */
  live(artifactId: string): ArtifactShare[] {
    const nowMs = this.#now();
    return this.list(artifactId).filter(
      (s) =>
        s.revoked_at === null &&
        (s.expires_at === null || Date.parse(s.expires_at) > nowMs) &&
        (s.max_uses === null || s.uses < s.max_uses),
    );
  }

  /** Revokes every live share of an artifact; one `share.revoked` each. Returns how many. */
  revokeAll(artifactId: string, reason: string, by: PersonId | null = null): number {
    let n = 0;
    for (const share of this.list(artifactId)) {
      if (share.revoked_at === null && this.revoke(share.id, reason, by)) n++;
    }
    return n;
  }

  /**
   * Makes a share of `artifactId` and returns it with its token: the only time the token is
   * seen. Commits the row and one `share.created` event together.
   */
  create(artifactId: string, input: ShareInput): { share: ArtifactShare; token: string } {
    if (!SHARE_AUDIENCES.includes(input.audience)) {
      throw new ArtifactShareError(`unknown audience \`${String(input.audience)}\``);
    }
    if (input.audience === "person" && !input.person_id) {
      throw new ArtifactShareError("a `person` share needs the person");
    }
    if (input.audience === "space" && !input.space_id) {
      throw new ArtifactShareError("a `space` share needs the space");
    }
    const maxUses = input.maxUses ?? null;
    if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1)) {
      throw new ArtifactShareError("a use limit must be 1 or more");
    }
    const ttl = input.ttlMs === undefined ? DEFAULT_SHARE_TTL_MS : input.ttlMs;
    if (ttl !== null && (!Number.isFinite(ttl) || ttl <= 0)) {
      throw new ArtifactShareError("a share's lifetime must be more than 0");
    }
    return this.#db.tx(() => {
      const artifact = this.#deps.get(artifactId);
      if (artifact === null || !this.#deps.isLive(artifact)) {
        throw new ArtifactShareError("no such artifact to share");
      }
      const mode = input.mode ?? (artifact.downloadable ? "download" : "stream");
      if (!SHARE_MODES.includes(mode)) throw new ArtifactShareError(`unknown mode \`${mode}\``);
      if (mode === "download" && !artifact.downloadable) {
        throw new ArtifactShareError("this artifact is never downloadable (a song cover): stream");
      }
      this.#checkAudience(artifact, input);
      const nowMs = this.#now();
      const at = toTimestamp(nowMs);
      let expiresMs = ttl === null ? null : nowMs + ttl;
      if (artifact.expires_at !== null) {
        const until = Date.parse(artifact.expires_at);
        expiresMs = expiresMs === null ? until : Math.min(expiresMs, until);
      }
      const expires = expiresMs === null ? null : toTimestamp(expiresMs);
      const token = randomBytes(32).toString("base64url");
      const id = newId();
      const eventId = newId();
      const share = this.#db.orm
        .insert(artifactShares)
        .values({
          id,
          artifact_id: artifact.id,
          token_hash: shareTokenHash(token),
          audience: input.audience,
          person_id: input.audience === "person" ? (input.person_id ?? null) : null,
          space_id: input.audience === "space" ? (input.space_id ?? null) : null,
          mode,
          event_id: eventId,
          created_at: at,
          expires_at: expires,
          max_uses: maxUses,
        })
        .returning()
        .get();
      const data: ShareCreatedData = {
        share_id: id,
        artifact_id: artifact.id,
        audience: share.audience,
        person_id: share.person_id,
        space_id: share.space_id,
        mode,
        expires_at: expires,
        max_uses: maxUses,
      };
      this.#events.appendNow({
        draft: {
          id: eventId,
          at,
          type: ShareCreated.type,
          v: ShareCreated.v,
          person_id: input.requested_by ?? null,
          turn: input.turn ?? null,
          key: `share:${id}`,
          data,
        },
        source: SHARE_SOURCE,
      });
      return { share, token };
    });
  }

  /** The row a presented token names, compared in constant time; `null` when none. */
  #rowOf(token: unknown): ArtifactShare | null {
    if (typeof token !== "string" || !TOKEN.test(token)) return null;
    const hash = shareTokenHash(token);
    this.#db.ensureOpen();
    const row = this.#byHash.get({ hash });
    if (row === undefined) return null;
    const a = Buffer.from(row.token_hash, "hex");
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && timingSafeEqual(a, b) ? row : null;
  }

  #check(share: ArtifactShare | null, nowMs: number): ShareLookup {
    if (share === null) return { ok: false, reason: "unknown" };
    if (share.revoked_at !== null) return { ok: false, reason: "revoked" };
    if (share.expires_at !== null && Date.parse(share.expires_at) <= nowMs) {
      return { ok: false, reason: "expired" };
    }
    if (share.max_uses !== null && share.uses >= share.max_uses) {
      return { ok: false, reason: "used_up" };
    }
    const artifact = this.#deps.get(share.artifact_id);
    if (artifact === null || !this.#deps.isLive(artifact)) return { ok: false, reason: "gone" };
    return { ok: true, share, artifact };
  }

  /** What a token opens now, without counting a use. */
  lookup(token: string): ShareLookup {
    return this.#check(this.#rowOf(token), this.#now());
  }

  /**
   * Counts one use of a token and returns what it opens; refused (and not counted) when it is
   * revoked, expired, used up, or its artifact is gone. The first use is one `share.opened`.
   */
  use(token: string): ShareLookup {
    return this.#db.tx(() => {
      const nowMs = this.#now();
      const found = this.#check(this.#rowOf(token), nowMs);
      if (!found.ok) return found;
      const at = toTimestamp(nowMs);
      const s = artifactShares;
      const updated = this.#db.orm
        .update(s)
        .set({ uses: sql`${s.uses} + 1`, last_used_at: at })
        .where(
          and(
            eq(s.id, found.share.id),
            isNull(s.revoked_at),
            or(isNull(s.expires_at), gt(s.expires_at, at)),
            or(isNull(s.max_uses), lt(s.uses, s.max_uses)),
          ),
        )
        .returning()
        .get();
      if (updated === undefined)
        return this.#check(this.#byId.get({ id: found.share.id }) ?? null, nowMs);
      if (updated.uses === 1) {
        this.#events.appendNow({
          draft: {
            id: newId(),
            at,
            type: ShareOpened.type,
            v: ShareOpened.v,
            key: `share:${updated.id}`,
            data: { share_id: updated.id, artifact_id: updated.artifact_id },
          },
          source: SHARE_SOURCE,
        });
      }
      return { ok: true, share: updated, artifact: found.artifact };
    });
  }

  /** A share by id. */
  get(id: string): ArtifactShare | null {
    this.#db.ensureOpen();
    return this.#byId.get({ id }) ?? null;
  }

  /** The shares of an artifact, newest first. */
  list(artifactId: string): ArtifactShare[] {
    return this.#db.orm
      .select()
      .from(artifactShares)
      .where(eq(artifactShares.artifact_id, artifactId))
      .orderBy(desc(artifactShares.id))
      .all();
  }

  /** Revokes a share; one `share.revoked` event. `false`: unknown or already revoked. */
  revoke(id: string, reason: string, by: PersonId | null = null): boolean {
    return this.#db.tx(() => {
      const at: Timestamp = toTimestamp(this.#now());
      const row = this.#db.orm
        .update(artifactShares)
        .set({ revoked_at: at })
        .where(and(eq(artifactShares.id, id), isNull(artifactShares.revoked_at)))
        .returning()
        .get();
      if (row === undefined) return false;
      this.#events.appendNow({
        draft: {
          id: newId(),
          at,
          type: ShareRevoked.type,
          v: ShareRevoked.v,
          person_id: by,
          key: `share:${id}`,
          data: { share_id: id, artifact_id: row.artifact_id, reason },
        },
        source: SHARE_SOURCE,
      });
      return true;
    });
  }
}
