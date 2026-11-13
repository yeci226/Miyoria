// The live feed on the page side: the wire types of `GET /api/public/live` (packages/types
// `live.ts`), the reducer that folds them into what the page draws, and the connection.
//
// The stream needs no header and no login, so a plain `EventSource` follows it. A stream the
// Core refuses (503 while the `live` module is off, 429 past a limit) closes for good in the
// browser, so this file reconnects with backoff itself.

export type LivePlace = "offline" | "idle" | "in_voice" | "live" | "playing" | "singing";
export type LiveActivityKind = "thinking" | "synthesizing" | "song_prepare" | "singing";

export interface LivePresence {
  place: LivePlace;
  game: string | null;
}
export interface LiveActivity {
  kind: LiveActivityKind;
  label: string;
  detail: string | null;
  progress: number | null;
}
export interface LiveEmotion {
  name: string;
  intensity: number;
}
export interface LiveLine {
  id: number;
  text: string;
  final: boolean;
  via: "voice" | "text";
}
export interface LivePats {
  recent: number;
  open: boolean;
}
/** The OBS picture: `src` is the playlist's path on the Core while OBS publishes, else `null`. */
export interface LiveVideo {
  on: boolean;
  src: string | null;
}
export type LivePart = "head" | "face" | "body" | "screen";
/** Where on the video frame, 0..1 from the top left. */
export interface LiveSpot {
  x: number;
  y: number;
}
export interface LiveSnapshot {
  presence: LivePresence;
  activity: LiveActivity | null;
  speaking: boolean;
  emotion: LiveEmotion;
  line: LiveLine | null;
  pats: LivePats;
  video: LiveVideo;
}

export type LiveEvent =
  | { type: "hello"; snapshot: LiveSnapshot }
  | { type: "presence"; presence: LivePresence }
  | { type: "activity"; activity: LiveActivity | null }
  | { type: "speaking"; speaking: boolean }
  | { type: "emotion"; emotion: LiveEmotion }
  | { type: "line"; line: LiveLine }
  | { type: "video"; video: LiveVideo }
  | { type: "pat"; pats: LivePats; spot?: LiveSpot; part?: LivePart };

export const LIVE_PATH = "/api/public/live";
export const PAT_PATH = "/api/member/live/pat";

export type Link = "connecting" | "open" | "lost";

export interface LiveView {
  link: Link;
  /** `null` until the first `hello`. */
  now: LiveSnapshot | null;
  /** Bumped whenever someone (anyone) pats her, so a picture can show where others patted her. */
  patSeq: number;
  /** Where the latest pat landed on the video, `null` when it carried no spot. */
  patSpot: LiveSpot | null;
}

export type LiveAction = LiveEvent | { type: "link"; link: Link };

export const initialView: LiveView = { link: "connecting", now: null, patSeq: 0, patSpot: null };

export function liveReducer(view: LiveView, action: LiveAction): LiveView {
  if (action.type === "link") return action.link === view.link ? view : { ...view, link: action.link };
  if (action.type === "hello") return { ...view, link: "open", now: action.snapshot };
  const now = view.now;
  if (now === null) return view;
  switch (action.type) {
    case "presence":
      return { ...view, now: { ...now, presence: action.presence } };
    case "activity":
      return { ...view, now: { ...now, activity: action.activity } };
    case "speaking":
      return { ...view, now: { ...now, speaking: action.speaking } };
    case "emotion":
      return { ...view, now: { ...now, emotion: action.emotion } };
    case "line":
      // A late update of an older line does not push the newer one away.
      if (now.line !== null && action.line.id < now.line.id) return view;
      return { ...view, now: { ...now, line: action.line } };
    case "video":
      return { ...view, now: { ...now, video: action.video } };
    case "pat": {
      const more = action.pats.recent > now.pats.recent;
      return {
        ...view,
        now: { ...now, pats: action.pats },
        patSeq: view.patSeq + (more ? 1 : 0),
        patSpot: action.spot ?? null,
      };
    }
  }
}

const TYPES = new Set(["hello", "presence", "activity", "speaking", "emotion", "line", "video", "pat"]);

/** One `data:` payload, or `null` when it is not a live event. */
export function parseLiveEvent(data: string): LiveEvent | null {
  try {
    const v = JSON.parse(data) as { type?: unknown } | null;
    if (v && typeof v.type === "string" && TYPES.has(v.type)) return v as LiveEvent;
  } catch {
    // not JSON
  }
  return null;
}

/** What `connectLive` needs of an `EventSource`; tests pass their own. */
export interface SourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}
export type SourceFactory = (url: string) => SourceLike;

const CLOSED = 2;

const defaultFactory: SourceFactory | null =
  typeof EventSource === "undefined" ? null : (url) => new EventSource(url, { withCredentials: true });

/** 2 s, 4 s, … up to a minute, with some spread so a restart is not met by every page at once. */
export function retryDelay(attempt: number): number {
  const base = Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Follows the feed until `signal` aborts. The browser retries a dropped stream by itself; a
 * refused one (`readyState` closed) is retried here.
 */
export function connectLive(
  url: string,
  dispatch: (action: LiveAction) => void,
  signal: AbortSignal,
  factory: SourceFactory | null = defaultFactory,
): void {
  if (factory === null) {
    dispatch({ type: "link", link: "lost" });
    return;
  }
  const make = factory;
  let attempt = 0;
  let source: SourceLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    if (signal.aborted) return;
    dispatch({ type: "link", link: "connecting" });
    const s = make(url);
    source = s;
    for (const type of TYPES) {
      s.addEventListener(type, (ev) => {
        const event = parseLiveEvent(ev.data);
        if (!event) return;
        if (event.type === "hello") attempt = 0;
        dispatch(event);
      });
    }
    s.onerror = () => {
      if (signal.aborted) return;
      dispatch({ type: "link", link: "lost" });
      if (s.readyState !== CLOSED) return;
      s.close();
      attempt += 1;
      timer = setTimeout(open, retryDelay(attempt));
    };
  };
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      source?.close();
    },
    { once: true },
  );
  open();
}
