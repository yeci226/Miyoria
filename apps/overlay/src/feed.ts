// The overlay feed: message parsing and the reducer that folds messages into display state.
// Everything here is pure (no DOM, no timers), so it is unit tested.
//
// Wire format (crates/miyoria-stage/src/overlay.rs):
//   {"type":"subtitle","turn":"…","text":"…","final":bool}
//   {"type":"emotion","name":"happy","intensity":0..1}
//   {"type":"speaking","state":"started"|"stopped"}
//   {"type":"status","core":bool,"vts":bool,"obs":bool,"scene":"…"|null,"streaming":bool}
//   {"type":"queue","items":[…]}
//   {"type":"levels","rms":0..1,"bands":[…]?}   her voice level, once per avatar frame (~60/s)
//   {"type":"notice","text":"準備歌曲中…"}       a status line; "" clears it (older Cores)
//   {"type":"activity","kind":"thinking"|"synthesizing"|"song_prepare"|"singing"|null,
//    "label":"…","detail":"…"|null,"progress":0..1|null,"elapsed_ms":n|null,"duration_ms":n|null}
//                                               what she is doing; kind null hides it
//   {"type":"gift","text":"Owen 餵了她一碗白飯"}  the gift line (the Stage merges gifts); "" hides it
//   {"type":"screen","kind":"message"|"dedication","name":"Owen","text":"加油","song":null|"春日影"}
//                                               a paid message or song dedication; not merged, queued here

export interface Subtitle {
  turn: string;
  text: string;
  final: boolean;
}

export interface Emotion {
  name: string;
  /** 0..1 */
  intensity: number;
}

export interface Status {
  core: boolean;
  vts: boolean;
  obs: boolean;
  scene: string | null;
  streaming: boolean;
}

/**
 * What she is doing, for the activity capsule. `progress` null = indeterminate; a song being sung
 * has `elapsedMs` (into the song when the message was sent) and `durationMs` instead, and its
 * progress runs on the overlay's clock.
 */
export interface Activity {
  /** `thinking`, `synthesizing`, `song_prepare`, `singing` (others are shown as indeterminate). */
  kind: string;
  label: string;
  /** The song it is about, if any. */
  detail: string | null;
  progress: number | null;
  elapsedMs: number | null;
  durationMs: number | null;
}

export interface QueueItem {
  /** What is queued (song / game request / topic). */
  title: string;
  /** Who asked for it. */
  by: string | null;
}

/** A paid message or dedication waiting for, or on, the screen. */
export interface ScreenCard {
  /** Counts up per card; a repeated message is still a new card. */
  id: number;
  kind: "message" | "dedication";
  /** Who paid. */
  name: string;
  text: string;
  /** A dedication's song title. */
  song: string | null;
}

export interface OverlayState {
  /** The WebSocket to the Stage is up. */
  connected: boolean;
  /** Her voice is playing right now. */
  speaking: boolean;
  /** Bumped on every accepted subtitle message; lets the view tell "same text again" from "nothing new". */
  subtitleSeq: number;
  /** null = nothing to show (never received, or cleared by an empty final). */
  subtitle: Subtitle | null;
  emotion: Emotion | null;
  status: Status | null;
  queue: QueueItem[];
  /** A status line such as 「準備歌曲中…」 from an older Core, or null. Shown in the activity capsule when there is no activity. */
  notice: string | null;
  activity: Activity | null;
  /** The gift line, or null. */
  gift: string | null;
  /** Screen cards in order; the first one is on the screen (or about to be), the rest wait. */
  screens: ScreenCard[];
  /** The id the next card gets. */
  screenSeq: number;
}

export type FeedMessage =
  | { type: "subtitle"; turn: string; text: string; final: boolean }
  | { type: "emotion"; name: string; intensity: number }
  | { type: "speaking"; state: "started" | "stopped" }
  | { type: "status"; status: Status }
  | { type: "queue"; items: QueueItem[] }
  /** High-rate audio level: drawn by the waveform, never part of the reduced state. */
  | { type: "levels"; rms: number; bands: number[] | null }

  | { type: "notice"; text: string }
  /** `null` hides the activity capsule. */
  | { type: "activity"; activity: Activity | null }
  /** The gift line (already merged by the Stage); `null` hides it. */
  | { type: "gift"; text: string | null }
  /** A paid message or dedication; the reducer queues it. */
  | { type: "screen"; kind: "message" | "dedication"; name: string; text: string; song: string | null };

/**
 * Everything the reducer accepts: feed messages, the connection state (reported by the transport)
 * and `screen_done` (from the view: the card with this id has been shown long enough).
 */
export type Action = FeedMessage | { type: "connection"; connected: boolean } | { type: "screen_done"; id: number };

export const MAX_QUEUE_ITEMS = 12;
/** Cards on the screen plus waiting; past this the oldest waiting one is dropped. */
export const MAX_SCREEN_CARDS = 5;
const MAX_NAME = 32;
const MAX_SCREEN_TEXT = 200;
const MAX_TEXT = 2000;
const MAX_TITLE = 160;
const MAX_LABEL = 40;
const MAX_DAY_MS = 86_400_000;

export function initialState(): OverlayState {
  return {
    connected: false,
    speaking: false,
    subtitleSeq: 0,
    subtitle: null,
    emotion: null,
    status: null,
    queue: [],
    notice: null,
    activity: null,
    gift: null,
    screens: [],
    screenSeq: 0,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function nonEmpty(v: unknown): string | null {
  const s = str(v)?.trim();
  return s ? s : null;
}

/** A finite number in [min, max], else null. */
function within(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : Math.min(n, 1);
}

/** First non-empty string among `keys` of `o`. */
function pick(o: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const s = nonEmpty(o[k]);
    if (s) return s;
  }
  return null;
}

/** The queue is described loosely ("items":[…]); accept plain strings or objects with the usual field names. */
export function parseQueueItem(raw: unknown): QueueItem | null {
  if (typeof raw === "string") {
    const title = raw.trim();
    return title ? { title: title.slice(0, MAX_TITLE), by: null } : null;
  }
  if (!isRecord(raw)) return null;
  const title = pick(raw, ["title", "text", "name", "song", "request", "goal", "label", "query"]);
  if (!title) return null;
  const by = pick(raw, ["by", "user", "requester", "requested_by", "author", "display_name", "from"]);
  return { title: title.slice(0, MAX_TITLE), by: by ? by.slice(0, 48) : null };
}

/** Parses one text frame. Unknown or malformed frames give null (the overlay must never throw on the feed). */
export function parseMessage(text: string): FeedMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case "subtitle": {
      const body = str(raw.text);
      if (body === null) return null;
      const turn = typeof raw.turn === "string" || typeof raw.turn === "number" ? String(raw.turn) : "";
      return { type: "subtitle", turn, text: body.slice(0, MAX_TEXT), final: raw.final === true };
    }
    case "emotion": {
      const name = nonEmpty(raw.name);
      if (!name) return null;
      const i = raw.intensity;
      return {
        type: "emotion",
        name: name.toLowerCase().slice(0, 32),
        intensity: typeof i === "number" && Number.isFinite(i) ? clamp01(i) : 1,
      };
    }
    case "speaking": {
      const state = raw.state;
      return state === "started" || state === "stopped" ? { type: "speaking", state } : null;
    }
    case "status":
      return {
        type: "status",
        status: {
          core: raw.core === true,
          vts: raw.vts === true,
          obs: raw.obs === true,
          scene: nonEmpty(raw.scene),
          streaming: raw.streaming === true,
        },
      };
    case "queue": {
      const items = raw.items;
      if (!Array.isArray(items)) return null;
      const out: QueueItem[] = [];
      for (const it of items) {
        const q = parseQueueItem(it);
        if (q) out.push(q);
        if (out.length >= MAX_QUEUE_ITEMS) break;
      }
      return { type: "queue", items: out };
    }
    case "levels": {
      const rms = raw.rms;
      if (typeof rms !== "number" || !Number.isFinite(rms)) return null;
      const b = raw.bands;
      const bands =
        Array.isArray(b) && b.length > 0 && b.length <= 16 && b.every((x) => typeof x === "number" && Number.isFinite(x))
          ? (b as number[]).map((x) => Math.max(x, 0))
          : null;
      return { type: "levels", rms: clamp01(rms), bands };
    }
    case "notice": {
      const body = str(raw.text);
      return body === null ? null : { type: "notice", text: body.trim().slice(0, MAX_TITLE) };
    }
    case "activity":
      return parseActivity(raw);
    case "gift": {
      const body = nonEmpty(raw.text);
      return { type: "gift", text: body ? body.slice(0, MAX_TITLE) : null };
    }
    case "screen": {
      const kind = raw.kind === "dedication" ? "dedication" : raw.kind === "message" ? "message" : null;
      const name = nonEmpty(raw.name);
      const text = nonEmpty(raw.text);
      if (kind === null || !name || !text) return null;
      const song = nonEmpty(raw.song)?.slice(0, MAX_TITLE) ?? null;
      // A dedication is about a song; without one it is a plain message.
      const dedication = kind === "dedication" && song !== null;
      return {
        type: "screen",
        kind: dedication ? "dedication" : "message",
        name: name.slice(0, MAX_NAME),
        text: text.slice(0, MAX_SCREEN_TEXT),
        song: dedication ? song : null,
      };
    }
    default:
      return null;
  }
}

function parseActivity(raw: Record<string, unknown>): FeedMessage | null {
  if (raw.kind === null) return { type: "activity", activity: null };
  const kind = str(raw.kind);
  if (kind === null || !/^[a-z_]{1,32}$/.test(kind)) return null;
  const label = nonEmpty(raw.label);
  // Nothing to say: same as hidden.
  if (!label) return { type: "activity", activity: null };
  const progress = typeof raw.progress === "number" && Number.isFinite(raw.progress) ? clamp01(raw.progress) : null;
  const durationMs = within(raw.duration_ms, 1, MAX_DAY_MS);
  return {
    type: "activity",
    activity: {
      kind,
      label: label.slice(0, MAX_LABEL),
      detail: nonEmpty(raw.detail)?.slice(0, MAX_TITLE) ?? null,
      progress,
      elapsedMs: durationMs === null ? null : (within(raw.elapsed_ms, 0, MAX_DAY_MS) ?? 0),
      durationMs,
    },
  };
}

function sameActivity(a: Activity | null, b: Activity | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.progress === b.progress &&
    a.elapsedMs === b.elapsedMs &&
    a.durationMs === b.durationMs
  );
}

/** What the capsule shows: the activity, else an older Core's notice (indeterminate), else nothing. */
export function shownActivity(state: Pick<OverlayState, "activity" | "notice">): Activity | null {
  if (state.activity) return state.activity;
  if (state.notice === null) return null;
  return { kind: "notice", label: state.notice, detail: null, progress: null, elapsedMs: null, durationMs: null };
}

export function reduce(state: OverlayState, action: Action): OverlayState {
  switch (action.type) {
    case "connection":
      // A dropped feed means nobody is driving the overlay: stop claiming she is talking.
      return action.connected
        ? { ...state, connected: true }
        : { ...state, connected: false, speaking: false, activity: null, gift: null, screens: [] };
    case "speaking":
      return { ...state, speaking: action.state === "started" };
    case "emotion":
      return { ...state, emotion: { name: action.name, intensity: action.intensity } };
    case "status":
      return { ...state, status: action.status };
    case "queue":
      return { ...state, queue: action.items };
    case "notice": {
      const notice = action.text === "" ? null : action.text;
      return notice === state.notice ? state : { ...state, notice };
    }
    case "activity":
      return sameActivity(state.activity, action.activity) ? state : { ...state, activity: action.activity };
    case "gift":
      return action.text === state.gift ? state : { ...state, gift: action.text };
    case "screen":
      return reduceScreen(state, action);
    case "screen_done": {
      // Only the card on the screen can be done; a late or repeated ack is nothing.
      const [head, ...rest] = state.screens;
      return head !== undefined && head.id === action.id ? { ...state, screens: rest } : state;
    }
    case "subtitle":
      return reduceSubtitle(state, action);
    case "levels":
      return state;
  }
}

/** Queues the card; over the cap the oldest one that is only waiting goes (never the one on screen). */
function reduceScreen(state: OverlayState, m: Extract<FeedMessage, { type: "screen" }>): OverlayState {
  const id = state.screenSeq + 1;
  const card: ScreenCard = { id, kind: m.kind, name: m.name, text: m.text, song: m.song };
  const screens = [...state.screens, card];
  if (screens.length > MAX_SCREEN_CARDS) screens.splice(1, 1);
  return { ...state, screens, screenSeq: id };
}

function reduceSubtitle(state: OverlayState, m: Extract<FeedMessage, { type: "subtitle" }>): OverlayState {
  const cur = state.subtitle;
  const same = cur !== null && cur.turn === m.turn;
  // A late partial of a turn that already ended must not reopen it.
  if (same && cur.final && !m.final) return state;
  // Nothing changed (the Stage re-sends the latest subtitle to a new client, and may repeat finals).
  if (same && cur.text === m.text && cur.final === m.final) return state;
  const subtitle: Subtitle | null = m.text.trim() === "" && m.final ? null : { turn: m.turn, text: m.text, final: m.final };
  return { ...state, subtitle, subtitleSeq: state.subtitleSeq + 1 };
}
