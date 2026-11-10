// What the last run left open (docs/design/v3-architecture.md §5: 重啟從日誌重建活動狀態).
//
// The log has lifecycle lines around each run: `system:boot` when the `facts` module starts and
// `system:shutdown` when the core goes down in order. While it goes down the game module says the
// session stopped (its extension stopped, its director closed), which is only the core leaving,
// so whatever a run says after its shutdown line does not count. A run that was killed has no such
// line and no "stopped" either: its last word is simply a session that is still running.
//
// A run that was itself still waiting to pick a session up leaves that in its boot line, so two
// quick restarts in a row do not lose the game.

import {
  type ContextKey,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type LogEvent,
  type RestoredGame,
} from "@miyoria/types";
import { observationBody } from "./context.js";

/** Source of the lifecycle lines. */
export const LIFECYCLE_SOURCE = "core.lifecycle";
/** Source of game session lines. */
export const GAME_SESSION_SOURCE = "game.session";

export const BOOT_KEY = "system:boot";
export const SHUTDOWN_KEY = "system:shutdown";
export const RESTORE_KEY_PREFIX = "activity:restore:";

/** A `ContextKey` from a bus payload, or `null`. */
export function parseContext(value: JsonValue | undefined): ContextKey | null {
  if (!isJsonObject(value)) return null;
  const { platform, scope, channel, kind } = value;
  if (typeof platform !== "string" || typeof channel !== "string") return null;
  if (kind !== "channel" && kind !== "thread" && kind !== "dm" && kind !== "voice") return null;
  return { platform, scope: typeof scope === "string" ? scope : null, channel, kind };
}

/** The `custom` payload an observation came from, or `null`. */
function payloadOf(event: LogEvent): JsonObject | null {
  const origin = observationBody(event)?.origin?.event;
  if (!isJsonObject(origin) || !isJsonObject(origin.data)) return null;
  const payload = origin.data.payload;
  return isJsonObject(payload) ? payload : null;
}

function keyOf(event: LogEvent): string | null {
  return observationBody(event)?.observation.attention_key ?? null;
}

function restoredFrom(value: JsonValue | undefined): RestoredGame | null {
  if (!isJsonObject(value)) return null;
  const { game, name, context, since } = value;
  if (typeof game !== "string" || typeof since !== "string") return null;
  return {
    game,
    name: typeof name === "string" ? name : game,
    context: parseContext(context),
    since,
  };
}

function sessionStarted(event: LogEvent, payload: JsonObject): RestoredGame | null {
  const game = payload.game;
  if (typeof game !== "string") return null;
  const name = typeof payload.game_name === "string" ? payload.game_name : game;
  return { game, name, context: parseContext(payload.context), since: event.at };
}

/**
 * The session the last run left open. `events`: the lines of `LIFECYCLE_SOURCE` and
 * `GAME_SESSION_SOURCE`, newest first, reaching back at least to the last run's boot line.
 */
export function recoverGame(events: readonly LogEvent[]): RestoredGame | null {
  const run: LogEvent[] = [];
  let boot: LogEvent | null = null;
  for (const event of events) {
    if (keyOf(event) === BOOT_KEY) {
      boot = event;
      break;
    }
    run.push(event);
  }
  const shutdown = run.findIndex((e) => keyOf(e) === SHUTDOWN_KEY);
  for (const event of run.slice(shutdown + 1)) {
    const payload = payloadOf(event);
    if (payload === null) continue;
    if (event.source === GAME_SESSION_SOURCE) {
      if (payload.state === "started") return sessionStarted(event, payload);
      if (payload.state === "stopped") return null;
    } else if (keyOf(event)?.startsWith(RESTORE_KEY_PREFIX) && payload.outcome !== "resumed") {
      return null;
    }
  }
  return boot !== null && isJsonObject(boot.body) ? restoredFrom(boot.body.restoring) : null;
}
