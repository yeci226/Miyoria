// The two open namespaces of the bus (docs/design/v5-contracts.md §3, K12a): the events a game
// adapter sends about its game, `game.<id>.<kind>`, and whatever an extension publishes on its
// own topics, `ext.<id>.…`. Both are families (`game.*.*`, `ext.**`): the topic is built from
// parts, and the extension host publishes them with the payload the extension sent, parsed as
// JSON. `game.<id>.task.*` and `ext.<id>.task.*` are task events and belong to `**.task.*`
// (`task.ts`); the director's own topics (`game.director.*`, `game.chat.link`) are registered by
// name (`play.ts`).
//
// Tiers (v5-data §2.5): a game adapter's events are what happens in the game, observations that
// fold into daily counts (`ambient`). An extension's events are its own: kept 90 days (`short`).
// No default scope for either: the session decides.

import { z } from "zod";
import { JsonValueSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/**
 * What a game adapter says happened: `game.<id>.<type>`, the topic taking its last words from
 * `type` (`death`, `chat`, `player.joined`). `data` is whatever the adapter attaches; `important`
 * marks what is worth live commentary.
 */
export const GameAdapterEventSchema = z
  .object({
    /** The topic suffix. */
    type: z.string(),
    data: JsonValueSchema.optional(),
    important: z.boolean().optional(),
  })
  .meta({ id: "EventsGameAdapterEvent" });
export type GameAdapterEventData = z.output<typeof GameAdapterEventSchema>;

export const GameAdapterEvent = defineEvent({
  type: "game.*.*",
  v: 1,
  data: GameAdapterEventSchema,
  tier: "ambient",
});

/** An extension's own event: any JSON value the extension sent. */
export const ExtensionEvent = defineEvent({
  type: "ext.**",
  v: 1,
  data: JsonValueSchema,
  tier: "short",
});

/** Both open namespaces. */
export const EXTENSION_EVENTS = [GameAdapterEvent, ExtensionEvent] as const;
