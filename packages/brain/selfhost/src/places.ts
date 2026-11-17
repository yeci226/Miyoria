// Where `say` may go: a place she knows, named the way she can see it.
//
// - a channel or thread by its mention (`<#id>`), `#id` or bare id;
// - a channel or thread of the space she is in by its name (`#雜談` or `雜談`), as the platform
//   describes it (`PlatformSink.describe`, the panel's "server / channel");
// - a DM by `私訊:名字` (or `dm:名字`, `@名字`): the DM whose other person goes by that name.
//
// She knows a place when it has a transcript (she was there) or a place on the runner this
// process. Voice channels are never a `say` target: speaking there is the voice path's.

import type { TranscriptStore } from "@miyoria/memory/transcript";
import { type ContextKey, contextKeyEquals, safeName } from "@miyoria/types";
import { speakersOf } from "./prompt.js";

export interface PlaceBook {
  transcript: TranscriptStore;
  /** The places on the runner now, beside those with a transcript. */
  live(): readonly ContextKey[];
  /** The session of a place. */
  sessionOf(context: ContextKey): string;
  /** The platform's name of a place (`server / channel`), `null` when unknown. Unset: none. */
  describe?(context: ContextKey): Promise<string | null>;
}

const DM_PREFIX = /^(?:私訊|dm|DM)\s*[:：]\s*/;

function known(book: PlaceBook): ContextKey[] {
  const out: ContextKey[] = [...book.live()];
  for (const session of book.transcript.sessions()) {
    const context = book.transcript.contextOf(session);
    if (context !== null && !out.some((c) => contextKeyEquals(c, context))) out.push(context);
  }
  return out.filter((c) => c.kind !== "voice");
}

function sameName(a: string, b: string): boolean {
  const n = (s: string) => safeName(s).replace(/^@/, "").trim().toLowerCase();
  return n(a) !== "" && n(a) === n(b);
}

/** A channel's name as she may write it: no `#`, any case and width. */
function channelName(name: string): string {
  return name.normalize("NFKC").replace(/^#/, "").replace(/\s+/g, "").toLowerCase();
}

/** The place `name` means seen from `from`, or `null`. */
export async function resolvePlace(
  book: PlaceBook,
  name: string,
  from: ContextKey,
): Promise<ContextKey | null> {
  const raw = name.trim();
  if (raw === "") return null;
  const places = known(book);
  const dm = DM_PREFIX.exec(raw);
  if (dm !== null || raw.startsWith("@")) {
    const who = dm !== null ? raw.slice(dm[0].length) : raw.slice(1);
    for (const place of places) {
      if (place.kind !== "dm") continue;
      const tail = book.transcript.tail(book.sessionOf(place));
      if (speakersOf(tail.entries).some((s) => sameName(s.name, who))) return place;
    }
    return null;
  }
  const id = /^<#([^>\s]+)>$/.exec(raw)?.[1] ?? /^#?([^<>\s]+)$/.exec(raw)?.[1] ?? null;
  if (id !== null) {
    const matches = places.filter((p) => p.kind !== "dm" && p.channel === id);
    const found =
      matches.find((p) => p.platform === from.platform && p.scope === from.scope) ??
      matches.find((p) => p.platform === from.platform) ??
      matches[0] ??
      null;
    if (found !== null) return found;
  }
  return await byName(book, places, raw, from);
}

/** A channel or thread of `from`'s space whose name the platform gives as `raw`. */
async function byName(
  book: PlaceBook,
  places: readonly ContextKey[],
  raw: string,
  from: ContextKey,
): Promise<ContextKey | null> {
  const describe = book.describe;
  const want = channelName(raw);
  if (describe === undefined || from.scope === null || want === "") return null;
  const here = places.filter(
    (p) => p.kind !== "dm" && p.platform === from.platform && p.scope === from.scope,
  );
  const names = await Promise.all(here.map((p) => describe(p).catch(() => null)));
  const found = here.filter((_, i) => {
    const described = names[i] ?? null;
    if (described === null) return false;
    // `server / channel`: the channel's part.
    const own = described.split(" / ").at(-1) ?? described;
    return channelName(own) === want;
  });
  // Two places of the same name: she has to say which.
  return found.length === 1 ? (found[0] ?? null) : null;
}
