// Places: the servers she is in, their rooms and their members, and settings that differ per place.
//
// Two layers live here (docs/design/v5-places.md):
//
// * `PlaceDirectory` (`PlaceDirectoryKey`): what a connected platform sees right now, for pickers
//   (docs/design/v5-settings.md §2.5). A platform module provides it (Discord, from its guild
//   cache); the panel's channel picker reads it through `GET /api/places/rooms`. Its ids are the
//   platform's own (a guild id, a channel id).
// * `Places` (`PlacesKey`) and `PlaceConfig` (`PlaceConfigKey`, through the kernel's
//   `placeConfig(ctx, Schema)`): identity's record of Spaces, Rooms and members, and a module's
//   config resolved for one place. Core provides both. Their Space and Room ids are identity's
//   (`spaces.id`, `rooms.id`, ULIDs), the ids every table and route stores.
//
// How a module finds its Space: a command or a turn `places.at(inv.context)`; a bus envelope
// carries `space_id`; a member route `memberSpace(state, person, query.space)`; an admin route
// `adminSpace(state, query.space)` (both `packages/api/src/space-param.ts`); a per-Space job loops
// `places.spaces()` and reads `cfg.for({ space_id })`.

import type { AccountRef, ContextKey } from "@miyoria/contracts/wire";
import type { PersonId } from "./ids.js";
import type { JsonValue } from "./json.js";
import { serviceKey } from "./service-key.js";

// ---- the platform's live view (pickers) -----------------------------------------------------

/** What kind of room: a text channel (announcement channels too), a voice channel, a thread. */
export type PlaceRoomKind = "text" | "voice" | "thread";

/** A server (Discord guild) as the platform sees it. `id` is the platform's (the guild id). */
export interface PlaceSpace {
  platform: string;
  id: string;
  name: string;
}

/** A room of a server. */
export interface PlaceRoom {
  platform: string;
  /** The channel id. */
  id: string;
  /** Its context key: `discord:<guild>:<channel>`. */
  context: string;
  name: string;
  kind: PlaceRoomKind;
  /** The server it is in; `id` is the guild id. */
  space: { id: string; name: string };
  /** The category it sits in, if any. */
  category: { id: string; name: string } | null;
  /** Its place in the server's list (categories first, then their channels). */
  position: number;
  /** She can see it and post (text) or join (voice) there. */
  usable: boolean;
  /** Why not, in zh-TW, when she cannot. */
  reason: string | null;
}

export interface PlaceDirectory {
  readonly platform: string;
  /** Whether the directory has a live view right now (the bot is connected). */
  ready(): boolean;
  spaces(): PlaceSpace[];
  /** Rooms, in each server's own order; all servers when `space` (a guild id) is not given. */
  rooms(options?: { space?: string; kind?: PlaceRoomKind }): PlaceRoom[];
}

export const PlaceDirectoryKey = serviceKey<PlaceDirectory>("PlaceDirectory");

// ---- identity's record: Spaces, Rooms, members ----------------------------------------------

/** A Space (a guild or group) she is in, as identity records it. */
export interface SpaceRef {
  /** Identity's id (`spaces.id`, a ULID): the id tables, settings and routes use. */
  id: string;
  /** `discord`. */
  platform: string;
  /** The platform's id: the Discord guild id. */
  external_id: string;
  /** The latest name she saw; the external id until she saw one. */
  name: string;
  /**
   * The install's original server (`spaces.is_primary`): the default wherever no Space is given
   * (an admin page, a row from before phase 6). At most one Space is primary; it never moves by
   * itself, not even when she leaves it.
   */
  primary: boolean;
  /**
   * A server she was already in before servers were told apart (`spaces.established`, identity
   * v4), or the first one of a fresh install; always true for the primary. It behaves as it always
   * did: the cluster's ambient settings, the file's emoji and sticker meanings, her talk levels.
   * A server first seen later is not established and starts quiet (a mention or a reply only)
   * until something is set for it. Not the default Space: that is `primary`.
   */
  established: boolean;
}

/** A room (channel, thread, voice room, DM) as identity records it. */
export interface RoomRef {
  /** Identity's id (`rooms.id`). */
  id: string;
  platform: string;
  /** The platform's id: the channel id. */
  external_id: string;
  /** Its Space (identity's id); `null` for a DM. */
  space_id: string | null;
  /** A thread's channel (`rooms.id`), when known. */
  parent_id: string | null;
  kind: "text" | "voice" | "thread" | "forum" | "stage" | "dm";
  name: string | null;
}

/** Where a context is, as identity's rows: what `Places.at` returns. Read-only: nothing is created. */
export interface PlaceAt {
  /** `null` for a DM. */
  space_id: string | null;
  /** `rooms.id`. */
  room_id: string;
  /** A thread's channel (`rooms.id`), when the platform said which; `null` otherwise. */
  parent_room_id: string | null;
  /** The session key: `discord:<guild>:<channel>`, `discord:dm:<person>`, ... */
  session: string;
}

/** What changed in the places, for caches: a Space appeared, was renamed, left or came back, or a room appeared or moved. */
export interface PlacesChange {
  kind: "space" | "room";
  space_id: string | null;
  room_id: string | null;
}

/**
 * Identity's Spaces, Rooms and members (Core provides it under `PlacesKey`). Every call is
 * synchronous and cheap enough for a request or a turn; nothing is cached by the caller.
 *
 * "Active" means she is still in the Space (`spaces.left_at` is null). Lists are in a stable order:
 * the primary first, then by when she joined, then by id.
 */
export interface Places {
  /** The primary Space while she is in it; `null` when there is none or she left it. */
  primary(): SpaceRef | null;
  /** Every active Space. */
  spaces(): SpaceRef[];
  /** One active Space by identity's id; `null` when unknown or left. */
  space(id: string): SpaceRef | null;
  /** One room by identity's id; `null` when unknown. */
  room(id: string): RoomRef | null;
  /** The rows of a context (`null` when its room was never seen, or a DM's person is unknown). Writes nothing. */
  at(ctx: ContextKey): PlaceAt | null;
  /** The active Space of a platform's server (`"discord"`, a guild id); `null` when unknown or left. */
  ofGuild(platform: string, externalId: string): SpaceRef | null;
  /**
   * The Space a platform's channel is in (identity's id), from the rooms she has seen; `null` for
   * an unknown channel or a DM. Left Spaces count: the channel is still theirs.
   */
  channelSpace(platform: string, channelId: string): string | null;
  /** The persons with an account that is a member of `space` and has not left it. */
  members(space: string): ReadonlySet<PersonId>;
  /** The active Spaces `person` is a member of (through any of their accounts). */
  spacesOf(person: PersonId): SpaceRef[];
  /**
   * Whether `person` is a member of `space` through one of their accounts and has not left it. A
   * member is an account that acted there (`space_members`): wrote a message, used a command, a
   * control or a modal, or was seen in one of its voice channels (`memberSeen`). Whether she
   * herself is still in the Space does not matter here. The rule behind a share's `space` audience.
   */
  isMember(person: PersonId, space: string): boolean;
  /**
   * She is in a server: records it (created on first sight; the first Space an install ever sees
   * becomes primary), updates its name, and clears a `left` mark. Returns identity's id.
   */
  seen(platform: string, externalId: string, name: string | null): string;
  /** She left a server (or was removed): marks it left. Rows stay; an unknown server is ignored. */
  left(platform: string, externalId: string): void;
  /**
   * An account acted in a Space without writing there (a message records itself): a command, a
   * button, a select or a modal there, or being seen in one of its voice channels. The account is
   * recorded (a person on first sight, named `name` when given) and made a member, or a member
   * again after leaving, as a message would. Idempotent and cheap: a membership seen within the
   * last minute is not written again. An unknown Space is ignored. The platform module calls it
   * for people only, never for bots or her own accounts.
   */
  memberSeen(space: string, account: AccountRef, name?: string | null): void;
  /** An account left a Space: its membership is marked left (the next time they act there clears it). */
  memberLeft(space: string, account: AccountRef): void;
  /** Calls `listener` after a change; returns the unsubscribe. */
  onChange(listener: (change: PlacesChange) => void): () => void;
}

export const PlacesKey = serviceKey<Places>("Places");

// ---- a module's config, per place -----------------------------------------------------------

/**
 * Where to resolve a config for: a context (a command's or a turn's), identity's ids, or nothing
 * (the cluster value). Given a room, its Space is the room's own, whatever `space_id` says.
 */
export type PlaceWhere =
  | ContextKey
  | { space_id?: string | null; room_id?: string | null }
  | null
  | undefined;

/** A place whose settings for this module changed, or a Space that appeared or went (`room_id` null). */
export interface PlaceConfigChange {
  space_id: string | null;
  room_id: string | null;
}

/**
 * A module's config section resolved for a place (docs/design/v5-places.md §3). Get one with the
 * kernel's `placeConfig(ctx, Schema)` in `start`; read it where the value is used, never once at
 * start, because a place setting takes effect at once, without a restart.
 *
 * Only fields marked `scope: "space"` or `scope: "room"` (`setting({...})` meta) differ per place.
 * For such a field the value is the first set of: the room's (`place_settings` scope `room`), the
 * room's parent channel's (for a thread), the Space's, then the cluster value (the file with the
 * panel's layer), then the schema default. A `space` field skips the two room layers. A field
 * with `merge: "union"` takes the union of every layer instead (a room cannot lift what the
 * cluster forbids). A channel value that is not in the Space resolved for is dropped (a list
 * loses that channel, a single channel falls back to the schema default), so a channel set once
 * for the whole cluster never makes a second server post into the first.
 */
export interface PlaceConfig<T> {
  /** The cluster value: the module's section as it started (file plus the panel's layer). */
  base(): T;
  /**
   * The value for `where`. Cheap (cached until a place setting or a place changes); the object
   * returned is shared, so treat it as read-only. With no Space (`null`, a DM) it is `base()`.
   */
  for(where: PlaceWhere): T;
  /** Called after a change that may change `for`; returns the unsubscribe. Removed when the module stops. */
  onChange(listener: (change: PlaceConfigChange) => void): () => void;
}

/** One field that may differ per place, as the kernel reads it from the schema's meta. */
export interface PlaceField {
  /** Path in the module's section: `["auction_channel"]`; dotted it is the `place_settings` key. */
  keys: string[];
  scope: "space" | "room";
  merge: "replace" | "union";
  /** A `channel` field: how it stores a channel (`id`: a bare id; `context`: `discord:<guild>:<channel>`). */
  channel: { ref: "id" | "context"; multiple: boolean } | null;
}

/** What the kernel's `placeConfig` hands Core. */
export interface PlaceConfigRequest<T> {
  /** The module id: the `plugin` of its `place_settings` rows. */
  module: string;
  /** The module's raw section (its `ctx.rawConfig`). */
  section: JsonValue | null;
  fields: readonly PlaceField[];
  /** The module's schema: a section to `T` (throws when it does not fit). */
  parse(section: JsonValue | null): T;
  /** The module's stop signal: listeners go with it. */
  signal?: AbortSignal;
}

/** Core's side of `PlaceConfig` (`PlaceConfigKey`); modules call the kernel's `placeConfig` instead. */
export interface PlaceConfigService {
  open<T>(request: PlaceConfigRequest<T>): PlaceConfig<T>;
}

export const PlaceConfigKey = serviceKey<PlaceConfigService>("PlaceConfig");
