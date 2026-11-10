// What of her may reach the live page. The page is open to anyone, logged in or not, inside the
// server or not, so the rule is the strictest one that still lets her be seen:
//
// 1. Where. A turn, a line, an emotion marker or a speech event counts only when its place is a
//    channel of a server whose id the owner listed in `[modules.live] channels`. A DM never does,
//    even if listed; neither does a place outside a server, nor her own place for acting alone. A
//    thread counts only by its own id, because a thread's parent is not known here. Whatever does
//    not count is not shown and not even folded in: a turn in a DM does not make her look busy.
// 2. What. A line is shown only when moderation passes it and it names nobody: no Discord mention,
//    no long id, no per-call code, and none of the names anyone goes by (her own excepted). That
//    check fails closed, as on the member page (`public-text.ts`): when the names cannot be read
//    nothing is shown, and a line that turns out to name someone halfway is taken back.
// 3. Always. Her resting face (`affect.changed`) is how she feels, not what about, and a song she
//    sings is on the public song list already, so both are shown wherever they come from. The
//    lyrics are not: a song's words are not hers to publish.

import {
  type ContextKey,
  ephemeralHandlesIn,
  isJsonObject,
  type JsonValue,
  mentionsAnother,
  type NameSplit,
} from "@miyoria/types";

/** Whether a line said in `context` may be shown, by place alone. */
export function isPublicPlace(
  context: ContextKey | null | undefined,
  channels: ReadonlySet<string>,
): boolean {
  if (!context || context.kind === "dm") return false;
  if (context.scope === null || context.platform === "core") return false;
  return channels.has(context.channel);
}

/** The `context` field of a custom payload, if it is one. */
export function payloadContext(payload: JsonValue): ContextKey | null {
  if (!isJsonObject(payload) || !isJsonObject(payload.context)) return null;
  const { platform, scope, channel, kind } = payload.context;
  if (typeof platform !== "string" || typeof channel !== "string") return null;
  if (scope !== null && typeof scope !== "string") return null;
  if (kind !== "channel" && kind !== "thread" && kind !== "dm" && kind !== "voice") return null;
  return { platform, scope, channel, kind };
}

/** The `turn` field of a custom payload, if any. */
export function payloadTurn(payload: JsonValue): string | null {
  if (!isJsonObject(payload)) return null;
  return typeof payload.turn === "string" && payload.turn !== "" ? payload.turn : null;
}

export interface Screen {
  /** Every name she knows people by, hers excepted; `null` when they cannot be read. */
  names: () => readonly string[] | null;
  /** Her own names, which a line may carry. */
  own: readonly string[];
  /** Moderation's verdict on `text` as something shown; `null` when there is no moderation. */
  moderate: (text: string) => boolean | null;
}

/** Whether `text` may be shown to anyone (rule 2). */
export function mayShow(screen: Screen, text: string): boolean {
  const line = text.trim();
  if (line === "") return true;
  const others = screen.names();
  if (others === null) return false;
  if (ephemeralHandlesIn(line).length > 0) return false;
  const names: NameSplit = { own: screen.own, others };
  if (mentionsAnother(line, names)) return false;
  return screen.moderate(line) === true;
}
