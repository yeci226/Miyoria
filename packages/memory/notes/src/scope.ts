// Where a line may be shown, in the event log's vocabulary (docs/design/v5-data.md §2.4):
//
// | scope    | names            | shown                                                      |
// |----------|------------------|------------------------------------------------------------|
// | `public` | nothing          | anywhere                                                   |
// | `self`   | nothing          | in her own prompts anywhere (her own notes with no place)  |
// | `space`  | a space id       | in the sessions of that space                              |
// | `room`   | a room id        | in that room                                               |
// | `dm`     | a person id      | in the DM session of that person                           |
// | `person` | a person id      | anywhere that person is present                            |
//
// Scope is kept per line, not per document. A document about a person collects what was said in
// a server, in another server and in their DM; §2.4 says what is derived inherits the narrowest
// scope among its inputs, so one scope for the whole document would either hide everything the
// moment a single DM line is added, or show a DM line in a channel. A document has no scope of
// its own: it is shown somewhere as the lines that may be shown there.
//
// The memory records (`memory_records`) still use the older vocabulary (`global`, `guild`,
// `channel`, `dm`, `person`) with platform ids instead of identity's. `toMemoryScope` and
// `toNoteScope` translate between the two through a `ScopeResolver`, so an episode written by the
// segment pass can be stored through the memory engine until that table is rebuilt.

import type { Db, MemoryScope } from "@miyoria/store";
import type { AccountRef, ContextKey, ContextKind, PersonId } from "@miyoria/types";
import type { NoteScopeType } from "./schema.js";

/** Where a line may be shown. */
export type NoteScope =
  | { type: "public" }
  | { type: "self" }
  | { type: "space"; space: string }
  | { type: "room"; room: string }
  | { type: "dm"; person: PersonId }
  | { type: "person"; person: PersonId };

/** The id a scope names (`scope_id`); `null` for `public` and `self`. */
export function scopeId(scope: NoteScope): string | null {
  switch (scope.type) {
    case "public":
    case "self":
      return null;
    case "space":
      return scope.space;
    case "room":
      return scope.room;
    case "dm":
    case "person":
      return scope.person;
  }
}

/** The scope of a stored `(scope, scope_id)` pair; `null` when the pair is not one. */
export function scopeOf(type: NoteScopeType, id: string | null): NoteScope | null {
  switch (type) {
    case "public":
    case "self":
      return id === null ? { type } : null;
    case "space":
      return id === null ? null : { type, space: id };
    case "room":
      return id === null ? null : { type, room: id };
    case "dm":
    case "person":
      return id === null ? null : { type, person: id as PersonId };
  }
}

export function sameScope(a: NoteScope, b: NoteScope): boolean {
  return a.type === b.type && scopeId(a) === scopeId(b);
}

/** A short label for listings (`space:01H…`, `dm`, `self`). */
export function noteScopeLabel(scope: NoteScope): string {
  const id = scopeId(scope);
  return id === null || scope.type === "dm" || scope.type === "person"
    ? scope.type
    : `${scope.type}:${id}`;
}

/** Where something is being read from: the place of a session and who is in it. */
export interface NotesViewer {
  /** The space of the session; `null` in a DM or at home. */
  space: string | null;
  /** The room of the session; `null` when it has none. */
  room: string | null;
  /** The person of a DM session; `null` anywhere else. */
  dm: PersonId | null;
  /** The people present. */
  present: readonly PersonId[];
}

/** Who reads: a place, or `owner` (the panel, her reflection): everything. */
export type NotesReader = NotesViewer | "owner";

/** Whether a line of `scope` may be shown to `reader`. */
export function visibleTo(scope: NoteScope, reader: NotesReader): boolean {
  if (reader === "owner") return true;
  switch (scope.type) {
    case "public":
    case "self":
      return true;
    case "space":
      return reader.space !== null && reader.space === scope.space;
    case "room":
      return reader.room !== null && reader.room === scope.room;
    case "dm":
      return reader.dm !== null && reader.dm === scope.person;
    case "person":
      return reader.present.includes(scope.person);
  }
}

/** The place a conversation happens in, as identity names it. */
export interface NotePlace {
  /** `null`: a DM, or a room outside any space. */
  space: string | null;
  room: string | null;
  /** The other side of a DM; `null` in a space. */
  dm: PersonId | null;
}

/**
 * The scope of what is learned in `place`, never wider than where it was said: a DM's lines stay
 * in that DM, a channel's in its space, a room outside any space in that room. `null`: the place
 * names nothing to scope by, and nothing may be written from it.
 */
export function placeScope(place: NotePlace): NoteScope | null {
  if (place.dm !== null) return { type: "dm", person: place.dm };
  if (place.space !== null) return { type: "space", space: place.space };
  if (place.room !== null) return { type: "room", room: place.room };
  return null;
}

/**
 * The scope of a line that takes the place of one of scope `old`, written from `place`: the
 * place's own, except that a line kept to this very room stays kept to it. A replacement is
 * never given the old line's scope when that is wider or elsewhere (`public`, `self`, `person`,
 * another space): what was said here is known only here.
 */
export function replacementScope(old: NoteScope, place: NotePlace): NoteScope | null {
  const here = placeScope(place);
  if (here === null) return null;
  if (here.type === "space" && old.type === "room" && old.room === place.room) return old;
  return here;
}

/** The viewer of a session in `place` with `present` people. */
export function viewerOf(place: NotePlace, present: readonly PersonId[]): NotesViewer {
  return { space: place.space, room: place.room, dm: place.dm, present };
}

// ---- the older vocabulary ----------------------------------------------------------------------

/** Looks platform ids up as identity's and back. Each answers `null` for what it does not know. */
export interface ScopeResolver {
  /** The space of a guild. */
  spaceOf(platform: string, guild: string): string | null;
  guildOf(space: string): { platform: string; guild: string } | null;
  /** The room of a context (its channel). */
  roomOf(context: ContextKey): string | null;
  contextOf(room: string): ContextKey | null;
  personOf(account: AccountRef): PersonId | null;
  /** An account of `person`, on `platform` when given. */
  accountOf(person: PersonId, platform?: string): AccountRef | null;
}

/**
 * A note scope as the memory records write it:
 *
 * | new      | old                                   |
 * |----------|---------------------------------------|
 * | `public` | `global`                              |
 * | `self`   | `global`                              |
 * | `space`  | `guild` (platform, guild)             |
 * | `room`   | `channel` (the room's context)        |
 * | `dm`     | `dm` (an account of the person)       |
 * | `person` | `person`                              |
 *
 * `null` when the resolver does not know the space, room or account: the caller must not fall
 * back to something wider.
 */
export function toMemoryScope(
  scope: NoteScope,
  resolver: ScopeResolver,
  platform?: string,
): MemoryScope | null {
  switch (scope.type) {
    case "public":
    case "self":
      return { type: "global" };
    case "space": {
      const guild = resolver.guildOf(scope.space);
      return guild === null ? null : { type: "guild", ...guild };
    }
    case "room": {
      const context = resolver.contextOf(scope.room);
      return context === null ? null : { type: "channel", context };
    }
    case "dm": {
      const account = resolver.accountOf(scope.person, platform);
      return account === null ? null : { type: "dm", account };
    }
    case "person":
      return { type: "person", person: scope.person };
  }
}

/**
 * A memory scope as a note scope, the table above read the other way. `global` is `self` for a
 * note of hers about herself (`own`), `public` otherwise, so `self` does not survive a round
 * trip unless the caller says so again. A `channel` is its `room`, a DM's channel included: a DM
 * room is shown only in that DM. `null` when the resolver does not know the guild, channel or
 * account.
 */
export function toNoteScope(
  scope: MemoryScope,
  resolver: ScopeResolver,
  own = false,
): NoteScope | null {
  switch (scope.type) {
    case "global":
      return { type: own ? "self" : "public" };
    case "guild": {
      const space = resolver.spaceOf(scope.platform, scope.guild);
      return space === null ? null : { type: "space", space };
    }
    case "channel": {
      const room = resolver.roomOf(scope.context);
      return room === null ? null : { type: "room", room };
    }
    case "dm": {
      const person = resolver.personOf(scope.account);
      return person === null ? null : { type: "dm", person };
    }
    case "person":
      return { type: "person", person: scope.person };
  }
}

const CONTEXT_KIND: Readonly<Record<string, ContextKind>> = {
  text: "channel",
  forum: "channel",
  stage: "voice",
  voice: "voice",
  thread: "thread",
  dm: "dm",
};

/**
 * A `ScopeResolver` over identity's tables (`spaces`, `rooms`, `accounts`), read only. A person
 * merged into another resolves to the one they were merged into.
 */
export function identityResolver(db: Db): ScopeResolver {
  const live = (person: string): PersonId => {
    let id = person;
    for (let i = 0; i < 8; i++) {
      const row = db.get("SELECT merged_into FROM persons WHERE id = $id", { id });
      if (row === undefined || row.merged_into === null) break;
      id = String(row.merged_into);
    }
    return id as PersonId;
  };
  return {
    spaceOf(platform, guild) {
      const row = db.get(
        "SELECT id FROM spaces WHERE platform = $platform AND external_id = $guild",
        { platform, guild },
      );
      return row === undefined ? null : String(row.id);
    },
    guildOf(space) {
      const row = db.get("SELECT platform, external_id FROM spaces WHERE id = $space", { space });
      return row === undefined
        ? null
        : { platform: String(row.platform), guild: String(row.external_id) };
    },
    roomOf(context) {
      const row = db.get(
        "SELECT id FROM rooms WHERE platform = $platform AND external_id = $channel",
        { platform: context.platform, channel: context.channel },
      );
      return row === undefined ? null : String(row.id);
    },
    contextOf(room) {
      const row = db.get(
        `SELECT r.platform, r.external_id, r.kind, s.external_id AS guild
           FROM rooms r LEFT JOIN spaces s ON s.id = r.space_id WHERE r.id = $room`,
        { room },
      );
      if (row === undefined) return null;
      return {
        platform: String(row.platform),
        scope: row.guild === null ? null : String(row.guild),
        channel: String(row.external_id),
        kind: CONTEXT_KIND[String(row.kind)] ?? "channel",
      };
    },
    personOf(account) {
      const row = db.get(
        "SELECT person_id FROM accounts WHERE platform = $platform AND external_id = $id",
        { platform: account.platform, id: account.id },
      );
      return row === undefined || row.person_id === null ? null : live(String(row.person_id));
    },
    accountOf(person, platform) {
      const row = db.get(
        `SELECT platform, external_id FROM accounts
          WHERE person_id = $person AND ($platform IS NULL OR platform = $platform)
          ORDER BY last_seen DESC, id LIMIT 1`,
        { person, platform: platform ?? null },
      );
      return row === undefined
        ? null
        : { platform: String(row.platform), id: String(row.external_id) };
    },
  };
}
