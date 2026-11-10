// The live page (docs/design/v4-plan.md §9.2): her, in a browser, as it happens.
//
// The `live` module folds the bus into a small public picture of her (where she is, what she is
// doing, her face, the line she is saying) and pushes every change to whoever watches. A member
// may pat her head from the page; pats are counted, limited and gathered into Observations. Both
// sides are here so the API can serve the feed without depending on the module.
//
// Everything in a `LiveEvent` may be seen by anyone, logged in or not: the module decides what
// gets in (see `packages/live/src/privacy.ts`), nothing downstream filters again.

import type { AccountRef } from "./platform.js";
import { serviceKey } from "./service-key.js";

/** Where she is, as the public status says it. */
export type LivePlace = "offline" | "idle" | "in_voice" | "live" | "playing" | "singing";

export interface LivePresence {
  place: LivePlace;
  /** A game id from the config while she plays one (`minecraft`), else `null`. */
  game: string | null;
}

/** What she is busy with this moment; the overlay's activity line. */
export type LiveActivityKind = "thinking" | "synthesizing" | "song_prepare" | "singing";

export interface LiveActivity {
  kind: LiveActivityKind;
  /** Short zh-TW words for it (`思考中…`). */
  label: string;
  /** The song it is about, screened; `null` for none. */
  detail: string | null;
  /** 0..1, `null` when it cannot be told. */
  progress: number | null;
}

/** Her face: an emotion name of her avatar (`happy`, `shy`, ...) and how strongly. */
export interface LiveEmotion {
  name: string;
  /** 0..1 */
  intensity: number;
}

/**
 * The line she is saying or just typed somewhere public. It grows while she speaks (`final`
 * false) and is final once she is done; a line taken back (it turned out to name someone) comes
 * again with `text` empty.
 */
export interface LiveLine {
  /** Counts up per line; the same line keeps its id while it grows. */
  id: number;
  text: string;
  final: boolean;
  /** Spoken in voice or written in a channel. */
  via: "voice" | "text";
}

/** Head-pats as anyone may see them: counts, never who. */
export interface LivePats {
  /** Pats in the last minute, everyone together. */
  recent: number;
  /** Members may pat her (`[modules.live] pats`). */
  open: boolean;
}

/** Her picture, when OBS is publishing: the page plays `src` (LL-HLS through the api). */
export interface LiveVideo {
  on: boolean;
  /** `/api/public/live/video/index.m3u8` while `on`, else `null`. */
  src: string | null;
}

/** What a touch landed on, judged from where it fell on the video frame. */
export type LivePart = "head" | "face" | "body" | "screen";

/** Where a touch fell: 0..1 on the video frame, origin top-left. */
export interface LiveSpot {
  x: number;
  y: number;
}

/** Custom bus topic of one accepted touch from the picture; the stage draws a hand there. */
export const LIVE_TOUCH_TOPIC = "live.touch";

/** Payload of `LIVE_TOUCH_TOPIC`: where and on what, never who. */
export interface LiveTouch extends LiveSpot {
  part: LivePart;
}

export interface LiveSnapshot {
  presence: LivePresence;
  activity: LiveActivity | null;
  speaking: boolean;
  emotion: LiveEmotion;
  line: LiveLine | null;
  pats: LivePats;
  /** `{ on: false, src: null }` while video is off or OBS is not publishing. */
  video: LiveVideo;
}

/** One change, as the page receives it (SSE `event:` is `type`, `data:` the rest as JSON). */
export type LiveEvent =
  | { type: "hello"; snapshot: LiveSnapshot }
  | { type: "presence"; presence: LivePresence }
  | { type: "activity"; activity: LiveActivity | null }
  | { type: "speaking"; speaking: boolean }
  | { type: "emotion"; emotion: LiveEmotion }
  | { type: "line"; line: LiveLine }
  /** Somebody patted her just now; `spot` and `part` are there when the pat came from the picture. */
  | { type: "pat"; pats: LivePats; spot?: LiveSpot; part?: LivePart }
  /** Her picture came or went. */
  | { type: "video"; video: LiveVideo };

/** Who pats: the logged-in account and the name their session carries. */
export interface LivePatter {
  account: AccountRef;
  name: string;
  /** Where on the picture; none for the keyboard button (counts as her head). */
  spot?: LiveSpot;
}

export type LivePatOutcome =
  /** Counted (a blocked person's pat is accepted the same way and goes nowhere). */
  | { status: "ok"; pats: LivePats }
  /** Pats are off. */
  | { status: "closed" }
  /** Too many from this person, or from everyone together. */
  | { status: "too_many"; wait_ms: number };

/** Provided by the `live` module. */
export interface LiveFeed {
  /** What she looks like right now. */
  snapshot(): LiveSnapshot;
  /**
   * Calls `listener` with every event from now on, until the returned function is called.
   * `null` when the feed has as many watchers as it takes.
   */
  follow(listener: (event: LiveEvent) => void): (() => void) | null;
  /** A pat from a member. */
  pat(by: LivePatter): Promise<LivePatOutcome>;
  /**
   * Internal, never serialized: where the api proxies her picture from (`upstream` ends with `/`)
   * and whether it is on. `null` when video is not configured.
   */
  video(): { on: boolean; upstream: string; secret: string; max_viewers: number } | null;
}

export const LiveFeedKey = serviceKey<LiveFeed>("LiveFeed");
