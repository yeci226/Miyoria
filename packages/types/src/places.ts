// The places a platform knows, for pickers (docs/design/v5-settings.md §2.5): the servers she is in
// and their rooms, with whether she can use each. A platform module provides it (Discord, from its
// connected guild cache); the panel's channel picker reads it through `GET /api/places/rooms`.

import { serviceKey } from "./service-key.js";

/** What kind of room: a text channel (announcement channels too), a voice channel, a thread. */
export type PlaceRoomKind = "text" | "voice" | "thread";

/** A server (Discord guild). */
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
  /** Rooms, in each server's own order; all servers when `space` is not given. */
  rooms(options?: { space?: string; kind?: PlaceRoomKind }): PlaceRoom[];
}

export const PlaceDirectoryKey = serviceKey<PlaceDirectory>("PlaceDirectory");
