// `Places` over identity's tables (docs/design/v5-places.md): the Spaces she is in, the primary
// one, where a context is, who is a member where. Core provides it as `PlacesKey`; the share
// policy's membership rule (`artifacts/membership.ts`) is `isMember` here.

import type {
  AccountRef,
  ContextKey,
  PersonId,
  PlaceAt,
  Places,
  PlacesChange,
  RoomRef,
  SpaceRef,
} from "@miyoria/types";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db.js";
import { type Identity, onPlaceRows } from "./identity.js";
import { accounts, rooms, type SpaceRow, spaceMembers, spaces } from "./schema.js";

function ref(row: SpaceRow): SpaceRef {
  return {
    id: row.id,
    platform: row.platform,
    external_id: row.external_id,
    name: row.name,
    primary: row.is_primary,
    established: row.established || row.is_primary,
  };
}

/** Whether `person` is a member of `space` through one of their accounts, and has not left. */
export function isMemberOf(db: Db, person: PersonId, space: string): boolean {
  if (typeof space !== "string" || space === "") return false;
  db.ensureOpen();
  const row = db.orm
    .select({ space_id: spaceMembers.space_id })
    .from(spaceMembers)
    .innerJoin(accounts, eq(accounts.id, spaceMembers.account_id))
    .where(
      and(
        eq(spaceMembers.space_id, space),
        eq(accounts.person_id, person),
        isNull(spaceMembers.left_at),
      ),
    )
    .get();
  return row !== undefined;
}

/** Identity's places on one database. */
export class SpacePlaces implements Places {
  readonly #db: Db;
  readonly #identity: Identity;

  constructor(db: Db, identity: Identity) {
    this.#db = db;
    this.#identity = identity;
  }

  /** Active spaces, primary first, then by when she joined, then by id. */
  #active(where = sql`1 = 1`): SpaceRef[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(spaces)
      .where(and(isNull(spaces.left_at), where))
      .orderBy(desc(spaces.is_primary), asc(spaces.joined_at), asc(spaces.id))
      .all()
      .map(ref);
  }

  primary(): SpaceRef | null {
    return this.#active(eq(spaces.is_primary, true))[0] ?? null;
  }

  spaces(): SpaceRef[] {
    return this.#active();
  }

  space(id: string): SpaceRef | null {
    if (typeof id !== "string" || id === "") return null;
    return this.#active(eq(spaces.id, id))[0] ?? null;
  }

  room(id: string): RoomRef | null {
    if (typeof id !== "string" || id === "") return null;
    this.#db.ensureOpen();
    const row = this.#db.orm
      .select({
        id: rooms.id,
        platform: rooms.platform,
        external_id: rooms.external_id,
        space_id: rooms.space_id,
        parent_id: rooms.parent_id,
        kind: rooms.kind,
        name: rooms.name,
      })
      .from(rooms)
      .where(eq(rooms.id, id))
      .get();
    return row ?? null;
  }

  at(ctx: ContextKey): PlaceAt | null {
    this.#db.ensureOpen();
    const room = this.#db.orm
      .select({ id: rooms.id, space_id: rooms.space_id, parent_id: rooms.parent_id })
      .from(rooms)
      .where(and(eq(rooms.platform, ctx.platform), eq(rooms.external_id, ctx.channel)))
      .get();
    if (!room) return null;
    const session = this.#identity.sessionOf(ctx);
    if (session === null) return null;
    return {
      space_id: room.space_id,
      room_id: room.id,
      parent_room_id: ctx.kind === "thread" ? room.parent_id : null,
      session,
    };
  }

  ofGuild(platform: string, externalId: string): SpaceRef | null {
    return (
      this.#active(and(eq(spaces.platform, platform), eq(spaces.external_id, externalId)))[0] ??
      null
    );
  }

  channelSpace(platform: string, channelId: string): string | null {
    this.#db.ensureOpen();
    const room = this.#db.orm
      .select({ space_id: rooms.space_id })
      .from(rooms)
      .where(and(eq(rooms.platform, platform), eq(rooms.external_id, channelId)))
      .get();
    return room?.space_id ?? null;
  }

  members(space: string): ReadonlySet<PersonId> {
    this.#db.ensureOpen();
    const rows = this.#db.orm
      .selectDistinct({ person: accounts.person_id })
      .from(spaceMembers)
      .innerJoin(accounts, eq(accounts.id, spaceMembers.account_id))
      .where(
        and(
          eq(spaceMembers.space_id, space),
          isNull(spaceMembers.left_at),
          isNotNull(accounts.person_id),
        ),
      )
      .all();
    return new Set(rows.map((r) => r.person as PersonId));
  }

  spacesOf(person: PersonId): SpaceRef[] {
    const mine = sql`${spaces.id} IN (
      SELECT ${spaceMembers.space_id} FROM ${spaceMembers}
      INNER JOIN ${accounts} ON ${accounts.id} = ${spaceMembers.account_id}
      WHERE ${accounts.person_id} = ${person} AND ${spaceMembers.left_at} IS NULL)`;
    return this.#active(mine);
  }

  isMember(person: PersonId, space: string): boolean {
    return isMemberOf(this.#db, person, space);
  }

  seen(platform: string, externalId: string, name: string | null): string {
    return this.#identity.seenSpace(platform, externalId, name);
  }

  left(platform: string, externalId: string): void {
    this.#identity.leftSpace(platform, externalId);
  }

  memberSeen(space: string, account: AccountRef, name?: string | null): void {
    this.#identity.memberSeen(space, account, name ?? null);
  }

  memberLeft(space: string, account: AccountRef): void {
    this.#identity.memberLeft(space, account);
  }

  onChange(listener: (change: PlacesChange) => void): () => void {
    return onPlaceRows(this.#db, listener);
  }
}
