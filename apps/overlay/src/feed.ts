// The overlay feed: message parsing and the reducer that folds messages into display state.
// Everything here is pure (no DOM, no timers), so it is unit tested.
//
// Wire format (the contract is `@miyoria/contracts/overlay`):
//   {"type":"subtitle","turn":"…","text":"…","final":bool}
//   {"type":"emotion","name":"happy","intensity":0..1}
//   {"type":"speaking","state":"started"|"stopped"}
//   {"type":"status","core":bool,"vts":bool,"obs":bool,"scene":"…"|null,"streaming":bool}
//   {"type":"queue","items":[…]}                demo only (src/demo.ts); Core never sends it, the contract has no such message
//   {"type":"levels","rms":0..1,"bands":[…]?}   her voice level, once per avatar frame (~60/s)
//   {"type":"notice","text":"準備歌曲中…"}       a status line; "" clears it (older Cores)
//   {"type":"activity","kind":"thinking"|"synthesizing"|"tool"|"game"|"song_prepare"|"singing"|null,
//    "label":"…","detail":"…"|null,"progress":0..1|null,"elapsed_ms":n|null,"duration_ms":n|null,
//    "secondary":{"label":"…","detail":"…"|null,"progress":0..1|null}?}
//                                               what she is doing; kind null hides it; `secondary`:
//                                               a song being prepared beside the main line
//   {"type":"gift","text":"Owen 餵了她一碗白飯"}  the gift line (the Stage merges gifts); "" hides it
//   {"type":"screen","name":"Owen","text":"加油"}
//                                               a paid message; not merged, queued here
//   {"type":"touch","x":0..1,"y":0..1,"part":"head"|"face"|"body"|"screen"}
//                                               a viewer touched the stream; drawn at (x·W, y·H), not kept in state
//   {"type":"danmaku","id":"…","name":"Owen"|null,"text":"…","max_on_screen":n,"queue_max":n,"max_wait_ms":n}
//                                               a paid line that crosses the screen (src/danmaku.ts); the page answers it
//   {"type":"danmaku_clear"}                    every danmaku line off the screen, the waiting ones dropped
//   {"type":"karaoke","room":"K7PQ2M"|null,"state":"lobby"|"countdown"|"singing"|"results",…,
//    "queue":[…],"join_url":"https://…"|null,"qr_while_singing":bool,"settling":{"waiting":[…]}|null}
//                                               the karaoke room on the stream (src/karaoke-view.ts); room null ends it;
//                                               board lines carry "parts" (results) and "pitch" (the lanes)
//   {"type":"karaoke_lyrics","room","round","song","lyrics":{…}|null,"video":"karaoke/video?r=…"|null,
//    "backing":{"path":"karaoke/backing?r=…","format":"pcm"|"m4a","rate":n}|null,"notes":[{start,end,midi}]}
//                                               the words, background video, backing and reference notes of a round
//   {"type":"karaoke_voice","room","round","at_ms":n,"audio":"<base64 µ-law 16 kHz>"}
//                                               a piece of the relayed singer's voice, played and forgotten

import type { OverlayMessage } from "@miyoria/contracts/overlay";
import type {
  WorkersKaraokeLineStatus,
  WorkersKaraokeLineV2,
  WorkersKaraokeLyricsV2,
  WorkersKaraokePiece,
} from "@miyoria/contracts/workers";
import { parseTouch } from "./touch.js";
import { MAX_BANDS } from "./wave.js";

// The frames Core sends are written once, in `@miyoria/contracts/overlay`. This page takes that
// contract as types only (`import type`: no schema library reaches the bundle) and keeps its own
// hand-written parser, which is checked against it below: a message added to or removed from the
// contract, or a field of one changed, stops this file from compiling until the parser follows.

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

/** One frame of the contract, by its `type`. */
type Wire<K extends OverlayMessage["type"]> = Extract<OverlayMessage, { type: K }>;

/** The overlay's own view of a `status` frame: the contract's fields without `type` (the flags are never missing here). */
export type Status = Omit<Wire<"status">, "type">;

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
  /** A song being prepared beside the main line (a small second indicator), or `null`. */
  secondary?: ActivitySide | null;
}

/** What happens beside the main line: its label, the song and one overall progress (`null`: waiting). */
export interface ActivitySide {
  label: string;
  detail: string | null;
  progress: number | null;
}

export interface QueueItem {
  /** What is queued (song / game request / topic). */
  title: string;
  /** Who asked for it. */
  by: string | null;
}

/** A paid message waiting for, or on, the screen. */
export interface ScreenCard {
  /** Counts up per card; a repeated message is still a new card. */
  id: number;
  /** Who paid. */
  name: string;
  text: string;
}

/** Where a karaoke room on the stream is. */
export type KaraokeRoomState = "lobby" | "countdown" | "singing" | "results";

/** One person in the room. `color` 0..7 (5–7 are the first three again, drawn hollow). */
export interface KaraokeMember {
  name: string;
  color: number;
  role: "singer" | "spectator";
  ready: boolean;
  opener: boolean;
}

/**
 * One singer on the board: the live ranking while sung (`move` since the last board), the final
 * one with the results (`winner`, `coins`, `finished`). `source` null: no score yet.
 */
export interface KaraokeLine {
  name: string;
  color: number;
  rank: number | null;
  total: number | null;
  source: "voice" | "estimate" | null;
  move: "up" | "down" | "same";
  winner: boolean;
  coins: number;
  finished: boolean;
  /** Their voice is the one the stream plays now (`karaoke_voice`). */
  onAir: boolean;
  /** With the results: the four parts of their official score (`null` without a result). */
  parts: KaraokeParts | null;
  /** Their pitch lately, for the pitch lanes (`null` without any, and after the round). */
  pitch: KaraokePitch | null;
  /** Cheers they got this round from the people watching (an older Core sends none). */
  cheers: number;
}

/** What someone watching cheered a singer with: 「加油」「好聽」「太強了」「安可」. */
export type KaraokeCheerKind = "cheer" | "nice" | "wow" | "encore";

/** A cheer for a singer (`to` names them as the board does), from `by`; `id` is never reused. */
export interface KaraokeCheer {
  id: string;
  kind: KaraokeCheerKind;
  to: { name: string; color: number };
  by: { name: string; color: number };
}

/** The four parts of a score (out of 60, 15, 15 and 10); `null`: not given. */
export interface KaraokeParts {
  pitch: number | null;
  stability: number | null;
  rhythm: number | null;
  expression: number | null;
}

/**
 * A singer's pitch lately: frame `i` of `midi` at song time `(from + i) / 50` seconds, a MIDI note
 * with a quarter-semitone step, `null` where nothing is voiced.
 */
export interface KaraokePitch {
  from: number;
  midi: (number | null)[];
}

/** One song waiting in the room's queue: who added it, and whether it is ready to sing. */
export interface KaraokeQueueEntry {
  title: string;
  artist: string | null;
  by: string;
  state: "ready" | "preparing" | "failed";
}

/** The song is over and the round is being settled: whose result is still waited for. */
export interface KaraokeSettling {
  waiting: string[];
}

/** A reference note of the round, in its key: song seconds and a MIDI note (with a fraction). */
export interface KaraokeNote {
  start: number;
  end: number;
  midi: number;
}

export interface KaraokeSong {
  id: string;
  title: string;
  artist: string | null;
  durationMs: number | null;
}

/**
 * The karaoke room on the stream, as the overlay uses it. `positionMs`: where the song is (on the
 * stream) at the moment the frame was sent, negative while it counts down; `null` outside a round.
 */
export interface KaraokeScene {
  room: string;
  state: KaraokeRoomState;
  /** The round now (1-based, 0 before the first) and how many the room may still start. */
  round: number;
  roundsLeft: number;
  song: KaraokeSong | null;
  shift: number;
  members: KaraokeMember[];
  positionMs: number | null;
  board: KaraokeLine[];
  note: string | null;
  currency: string;
  air: KaraokeAir;
  /** The next few songs after `song` (an older Core sends none). */
  queue: KaraokeQueueEntry[];
  /** The room's join link for the scene's QR code (an http(s) URL), or `null`: no QR. */
  joinUrl: string | null;
  /** The QR code stays, small, while a round is sung too. */
  qrWhileSinging: boolean;
  /** The song is over and the round is being settled, or `null`. */
  settling: KaraokeSettling | null;
  /** The round's latest cheers, oldest first (each shown once, by its id). */
  cheers: KaraokeCheer[];
}

/**
 * What this scene plays into the stream during the round: the backing, and whose voice (or none).
 * `delayMs`: how far the stream runs behind the singers (already in `positionMs`). The gains (0..1,
 * the voice up to 4): the backing, the voice, and both while she speaks.
 */
export interface KaraokeAir {
  backing: boolean;
  relay: string | null;
  delayMs: number;
  backingGain: number;
  voiceGain: number;
  duckGain: number;
}

/** The round's backing: a URL on this page's own server, raw s16le mono (`pcm`) or AAC (`m4a`). */
export interface KaraokeBacking {
  url: string;
  format: "pcm" | "m4a";
  rate: number;
}

/**
 * The words, the background video and the backing (URLs on this page's own server, or `null`) of
 * a round.
 */
export interface KaraokeLyrics {
  room: string;
  round: number;
  song: string;
  lyrics: WorkersKaraokeLyricsV2 | null;
  video: string | null;
  backing: KaraokeBacking | null;
  /** The round's reference notes for the pitch lanes, in time order (an older Core sends none). */
  notes: KaraokeNote[];
}

/** A piece of the relayed singer's voice: µ-law at 16 kHz, base64, its first sample at `atMs`. */
export interface KaraokeVoice {
  room: string;
  round: number;
  atMs: number;
  audio: string;
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

/**
 * What the parser gives the rest of the overlay for each contract message, keyed by the
 * contract's `type` tags (a tag missing here, or one the contract no longer has, is a compile
 * error). Messages the page uses as they are come from the contract itself; the three it
 * re-shapes take the contract's frame as input and give the overlay's own view type:
 * - `status`: the flags go under `status`;
 * - `activity`: snake_case fields become the camelCase `Activity`, `null` hides the capsule;
 * - `gift`: an empty line becomes `null`;
 * - `levels`: absent or unusable `bands` become `null`.
 * `touch` is the contract's frame too (the local `Touch` is checked against it in `parseTouch`).
 */
interface Parsed {
  subtitle: Wire<"subtitle">;
  emotion: Wire<"emotion">;
  speaking: Wire<"speaking">;
  status: { type: "status"; status: Status };
  /** High-rate audio level: drawn by the waveform, never part of the reduced state. */
  levels: Omit<Wire<"levels">, "bands"> & { bands: number[] | null };
  notice: Wire<"notice">;
  /** `null` hides the activity capsule. */
  activity: { type: "activity"; activity: Activity | null };
  /** The gift line (already merged by the Stage); `null` hides it. */
  gift: { type: "gift"; text: string | null };
  /** A paid message; the reducer queues it. */
  screen: Wire<"screen">;
  /** A viewer's touch on the picture: drawn once by the view, never part of the reduced state. */
  touch: Wire<"touch">;
  /** A paid line for the danmaku layer (src/danmaku.ts), never part of the reduced state. */
  danmaku: Wire<"danmaku">;
  /** Every danmaku line off the screen. */
  danmaku_clear: Wire<"danmaku_clear">;
  /** The karaoke room on the stream (src/karaoke-view.ts); `null` ends the scene. Not reduced. */
  karaoke: { type: "karaoke"; scene: KaraokeScene | null };
  /** The words and picture of a round. Not reduced. */
  karaoke_lyrics: { type: "karaoke_lyrics"; lyrics: KaraokeLyrics };
  /** A piece of the relayed voice, played by the scene and never kept. Not reduced. */
  karaoke_voice: { type: "karaoke_voice"; voice: KaraokeVoice };
}

/**
 * DEMO ONLY, not part of the contract: `?demo` (src/demo.ts) emits a request queue to show the
 * panel. Core never sends one, but the parser still reads it so the demo and tests go through it.
 */
export interface DemoQueueMessage {
  type: "queue";
  items: QueueItem[];
}

export type FeedMessage = Parsed[keyof Parsed] | DemoQueueMessage;

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
const MAX_DANMAKU_ID = 64;
const MAX_DANMAKU_TEXT = 100;
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

type Raw = Record<string, unknown>;

/**
 * One parser per message of the contract. Typed as a mapped type over the contract's `type`
 * tags, so the table must be complete, and each parser's result must fit `Parsed`.
 */
const PARSERS: { [K in OverlayMessage["type"]]: (raw: Raw) => Parsed[K] | null } = {
  subtitle(raw) {
    const body = str(raw.text);
    if (body === null) return null;
    const turn = typeof raw.turn === "string" || typeof raw.turn === "number" ? String(raw.turn) : "";
    return { type: "subtitle", turn, text: body.slice(0, MAX_TEXT), final: raw.final === true };
  },
  emotion(raw) {
    const name = nonEmpty(raw.name);
    if (!name) return null;
    const i = raw.intensity;
    return {
      type: "emotion",
      name: name.toLowerCase().slice(0, 32),
      intensity: typeof i === "number" && Number.isFinite(i) ? clamp01(i) : 1,
    };
  },
  speaking(raw) {
    const state = raw.state;
    return state === "started" || state === "stopped" ? { type: "speaking", state } : null;
  },
  status(raw) {
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
  },
  levels(raw) {
    const rms = raw.rms;
    if (typeof rms !== "number" || !Number.isFinite(rms)) return null;
    const b = raw.bands;
    const bands =
      Array.isArray(b) && b.length > 0 && b.length <= MAX_BANDS && b.every((x) => typeof x === "number" && Number.isFinite(x))
        ? (b as number[]).map((x) => Math.max(x, 0))
        : null;
    return { type: "levels", rms: clamp01(rms), bands };
  },
  notice(raw) {
    const body = str(raw.text);
    return body === null ? null : { type: "notice", text: body.trim().slice(0, MAX_TITLE) };
  },
  activity: parseActivity,
  gift(raw) {
    const body = nonEmpty(raw.text);
    return { type: "gift", text: body ? body.slice(0, MAX_TITLE) : null };
  },
  screen(raw) {
    const name = nonEmpty(raw.name);
    const text = nonEmpty(raw.text);
    if (!name || !text) return null;
    return {
      type: "screen",
      name: name.slice(0, MAX_NAME),
      text: text.slice(0, MAX_SCREEN_TEXT),
    };
  },
  touch(raw) {
    const touch = parseTouch(raw);
    return touch === null ? null : { type: "touch", ...touch };
  },
  danmaku: parseDanmaku,
  danmaku_clear() {
    return { type: "danmaku_clear" };
  },
  karaoke: parseKaraoke,
  karaoke_lyrics: parseKaraokeLyrics,
  karaoke_voice: parseKaraokeVoice,
};

// ---- karaoke -----------------------------------------------------------------------------------

const KARAOKE_CODE_MAX = 12;
const KARAOKE_NAME_MAX = 60;
const KARAOKE_TITLE_MAX = 200;
const KARAOKE_MEMBERS_MAX = 64;
const KARAOKE_BOARD_MAX = 16;
const KARAOKE_QUEUE_MAX = 5;
const KARAOKE_JOIN_URL_MAX = 200;
const KARAOKE_NOTES_MAX = 8_000;
/** Most base64 of a board line's recent pitch (as the contract), and the last frame it may start at (a day). */
const KARAOKE_PITCH_MAX_CHARS = 2_000;
const KARAOKE_PITCH_FROM_MAX = 50 * 86_400;
/** Pitch frames: 0 is not voiced, else MIDI 24 plus a quarter semitone a step (`encodeTrack`). */
const TRACK_MIDI_BASE = 24;
const TRACK_STEPS = 4;
const QUEUE_STATES: readonly KaraokeQueueEntry["state"][] = ["ready", "preparing", "failed"];
const LYRIC_LINES_MAX = 2000;
const LYRIC_PIECES_MAX = 400;
const LYRIC_TEXT_MAX = 500;
const KARAOKE_STATES: readonly KaraokeRoomState[] = ["lobby", "countdown", "singing", "results"];
const LINE_STATUSES: readonly WorkersKaraokeLineStatus[] = ["matched", "uncertain", "failed", "unchecked"];

/** A whole number in [min, max], else `fallback`. */
function whole(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

/** A finite number, else null. */
function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function cut(v: unknown, max: number): string | null {
  return nonEmpty(v)?.slice(0, max) ?? null;
}

function parseMember(raw: unknown): KaraokeMember | null {
  if (!isRecord(raw)) return null;
  const name = cut(raw.name, KARAOKE_NAME_MAX);
  if (!name) return null;
  return {
    name,
    color: whole(raw.color, 0, 7, 0),
    role: raw.role === "spectator" ? "spectator" : "singer",
    ready: raw.ready === true,
    opener: raw.opener === true,
  };
}

function parseBoardLine(raw: unknown): KaraokeLine | null {
  if (!isRecord(raw)) return null;
  const name = cut(raw.name, KARAOKE_NAME_MAX);
  if (!name) return null;
  const total = within(raw.total, 0, 110);
  return {
    name,
    color: whole(raw.color, 0, 7, 0),
    rank: whole(raw.rank, 1, 999, 0) || null,
    total,
    source: raw.source === "voice" || raw.source === "estimate" ? raw.source : null,
    move: raw.move === "up" || raw.move === "down" ? raw.move : "same",
    winner: raw.winner === true,
    coins: whole(raw.coins, 0, 1_000_000, 0),
    finished: raw.finished === true,
    onAir: raw.on_air === true,
    parts: parseParts(raw.parts),
    pitch: parsePitch(raw.pitch),
    cheers: whole(raw.cheers, 0, 1_000_000, 0),
  };
}

const CHEER_KINDS: readonly KaraokeCheerKind[] = ["cheer", "nice", "wow", "encore"];
const KARAOKE_CHEERS_MAX = 12;

/** Someone in a cheer: a name and a colour; else none. */
function parseWho(raw: unknown): { name: string; color: number } | null {
  if (!isRecord(raw)) return null;
  const name = cut(raw.name, KARAOKE_NAME_MAX);
  return name ? { name, color: whole(raw.color, 0, 7, 0) } : null;
}

function parseCheer(raw: unknown): KaraokeCheer | null {
  if (!isRecord(raw)) return null;
  const id = cut(raw.id, 32);
  const kind = CHEER_KINDS.find((k) => k === raw.kind);
  const to = parseWho(raw.to);
  const by = parseWho(raw.by);
  if (!id || kind === undefined || to === null || by === null) return null;
  return { id, kind, to, by };
}

/** The four parts of a result; a part that is not a number in 0..100 is not given. */
function parseParts(raw: unknown): KaraokeParts | null {
  if (!isRecord(raw)) return null;
  return {
    pitch: within(raw.pitch, 0, 100),
    stability: within(raw.stability, 0, 100),
    rhythm: within(raw.rhythm, 0, 100),
    expression: within(raw.expression, 0, 100),
  };
}

/** A board line's recent pitch: base64 of one byte a frame from frame `from`; else none. */
export function parsePitch(raw: unknown): KaraokePitch | null {
  if (!isRecord(raw)) return null;
  const from = whole(raw.from, 0, KARAOKE_PITCH_FROM_MAX, -1);
  const track = str(raw.track);
  if (from < 0 || track === null || track.length === 0 || track.length > KARAOKE_PITCH_MAX_CHARS) return null;
  if (track.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(track)) return null;
  let bytes: string;
  try {
    bytes = atob(track);
  } catch {
    return null;
  }
  const midi: (number | null)[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes.charCodeAt(i);
    midi[i] = b === 0 ? null : TRACK_MIDI_BASE + (b - 1) / TRACK_STEPS;
  }
  return { from, midi };
}

function parseQueueEntry(raw: unknown): KaraokeQueueEntry | null {
  if (!isRecord(raw)) return null;
  const title = cut(raw.title, KARAOKE_TITLE_MAX);
  const state = QUEUE_STATES.find((s) => s === raw.state);
  if (!title || state === undefined) return null;
  return { title, artist: cut(raw.artist, KARAOKE_TITLE_MAX), by: cut(raw.by, KARAOKE_NAME_MAX) ?? "", state };
}

/** The join link for the QR code: an absolute http(s) URL within the contract's length; else none. */
export function joinUrl(v: unknown): string | null {
  const s = nonEmpty(v);
  if (!s || s.length > KARAOKE_JOIN_URL_MAX) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

function parseSettling(raw: unknown): KaraokeSettling | null {
  if (!isRecord(raw)) return null;
  return { waiting: list(raw.waiting, KARAOKE_BOARD_MAX, (v) => cut(v, KARAOKE_NAME_MAX)) };
}

function parseNote(raw: unknown): KaraokeNote | null {
  if (!isRecord(raw)) return null;
  const start = within(raw.start, 0, MAX_DAY_MS / 1000);
  const end = within(raw.end, 0, MAX_DAY_MS / 1000);
  const midi = within(raw.midi, 0, 127);
  if (start === null || end === null || midi === null || end < start) return null;
  return { start, end, midi };
}

function parseSong(raw: unknown): KaraokeSong | null {
  if (!isRecord(raw)) return null;
  const title = cut(raw.title, KARAOKE_TITLE_MAX);
  if (!title) return null;
  return {
    id: str(raw.id)?.slice(0, 200) ?? "",
    title,
    artist: cut(raw.artist, KARAOKE_TITLE_MAX),
    durationMs: within(raw.duration_ms, 1, MAX_DAY_MS),
  };
}

function list<T>(raw: unknown, max: number, parse: (v: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const v of raw.slice(0, max)) {
    const item = parse(v);
    if (item !== null) out.push(item);
  }
  return out;
}

/**
 * `karaoke` frame: `room: null` ends the scene; a frame without a usable room code or state is
 * skipped. Everything else is clamped or dropped item by item, so one odd member or line does
 * not take the room off the stream.
 */
function parseKaraoke(raw: Raw): Parsed["karaoke"] | null {
  if (raw.room === null) return { type: "karaoke", scene: null };
  const room = nonEmpty(raw.room);
  const state = KARAOKE_STATES.find((s) => s === raw.state);
  if (!room || room.length > KARAOKE_CODE_MAX || state === undefined) return null;
  const air = isRecord(raw.air) ? raw.air : {};
  return {
    type: "karaoke",
    scene: {
      room,
      state,
      round: whole(raw.round, 0, 10_000, 0),
      roundsLeft: whole(raw.rounds_left, 0, 10_000, 0),
      song: parseSong(raw.song),
      shift: whole(raw.shift, -12, 12, 0),
      members: list(raw.members, KARAOKE_MEMBERS_MAX, parseMember),
      positionMs: within(raw.position_ms, -MAX_DAY_MS, MAX_DAY_MS),
      board: list(raw.board, KARAOKE_BOARD_MAX, parseBoardLine),
      note: cut(raw.note, MAX_TITLE),
      currency: str(raw.currency)?.trim().slice(0, 16) ?? "",
      air: {
        backing: air.backing === true,
        relay: cut(air.relay, KARAOKE_NAME_MAX),
        delayMs: whole(air.delay_ms, 0, 60_000, 0),
        // A gain that is not one plays nothing rather than too loud.
        backingGain: within(air.backing_gain, 0, 1) ?? 0,
        voiceGain: within(air.voice_gain, 0, 4) ?? 0,
        duckGain: within(air.duck_gain, 0, 1) ?? 0,
      },
      queue: list(raw.queue, KARAOKE_QUEUE_MAX, parseQueueEntry),
      joinUrl: joinUrl(raw.join_url),
      qrWhileSinging: raw.qr_while_singing === true,
      settling: parseSettling(raw.settling),
      cheers: list(raw.cheers, KARAOKE_CHEERS_MAX, parseCheer),
    },
  };
}

function parsePiece(raw: unknown): WorkersKaraokePiece | null {
  if (!isRecord(raw)) return null;
  const text = str(raw.text);
  if (text === null) return null;
  return {
    text: text.slice(0, LYRIC_TEXT_MAX),
    sung: raw.sung === true,
    start: finite(raw.start),
    end: finite(raw.end),
    reading: cut(raw.reading, 64),
    roman: cut(raw.roman, 64),
  };
}

/** One line of version-2 lyrics; one with a piece that is not one shows as its plain text. */
function parseLyricLine(raw: unknown): WorkersKaraokeLineV2 | null {
  if (!isRecord(raw)) return null;
  const start = finite(raw.start);
  const text = str(raw.text);
  if (start === null || text === null) return null;
  let pieces: WorkersKaraokePiece[] | null = null;
  if (Array.isArray(raw.pieces) && raw.pieces.length <= LYRIC_PIECES_MAX) {
    const parsed = raw.pieces.map(parsePiece);
    if (parsed.every((p) => p !== null)) pieces = parsed as WorkersKaraokePiece[];
  }
  return {
    start,
    end: finite(raw.end),
    text: text.slice(0, LYRIC_TEXT_MAX),
    status: LINE_STATUSES.find((s) => s === raw.status) ?? "unchecked",
    source: raw.source === "heard" ? "heard" : "found",
    similarity: finite(raw.similarity),
    heard: null,
    aligned: raw.aligned === true && pieces !== null,
    pieces,
    edited: raw.edited === true,
  };
}

/** The lyrics of a reference (version 2's shape), lines in time order; anything else is none. */
function parseLyricsBody(raw: unknown): WorkersKaraokeLyricsV2 | null {
  if (!isRecord(raw)) return null;
  const lines = list(raw.lines, LYRIC_LINES_MAX, parseLyricLine);
  // The two lines shown are found by start time.
  lines.sort((a, b) => a.start - b.start);
  return {
    provider: cut(raw.provider, 64),
    source: raw.source === "heard" ? "heard" : "found",
    language: cut(raw.language, 16),
    timing: raw.timing === "char" ? "char" : "line",
    check: null,
    lines,
  };
}

/**
 * A media URL (the video, the backing) the page may load: relative to the page, or plain http(s);
 * anything else is none.
 */
export function videoUrl(v: unknown): string | null {
  const s = nonEmpty(v);
  if (!s || s.length > 2048) return null;
  try {
    const u = new URL(s, "http://overlay.invalid/overlay/");
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/** `karaoke_lyrics` frame: skipped without its room and round; unusable lyrics are none. */
function parseKaraokeLyrics(raw: Raw): Parsed["karaoke_lyrics"] | null {
  const room = nonEmpty(raw.room);
  const round = whole(raw.round, 1, 10_000, 0);
  if (!room || room.length > KARAOKE_CODE_MAX || round === 0) return null;
  return {
    type: "karaoke_lyrics",
    lyrics: {
      room,
      round,
      song: str(raw.song)?.slice(0, 200) ?? "",
      lyrics: parseLyricsBody(raw.lyrics),
      video: videoUrl(raw.video),
      backing: parseBacking(raw.backing),
      // The lanes find the notes in view by time.
      notes: list(raw.notes, KARAOKE_NOTES_MAX, parseNote).sort((a, b) => a.start - b.start),
    },
  };
}

/** The `backing` of a `karaoke_lyrics` frame (`path` is the page's URL for it); else none. */
function parseBacking(raw: unknown): KaraokeBacking | null {
  if (!isRecord(raw)) return null;
  const url = videoUrl(raw.path);
  const format = raw.format === "pcm" || raw.format === "m4a" ? raw.format : null;
  const rate = whole(raw.rate, 8_000, 192_000, 0);
  if (url === null || format === null || rate === 0) return null;
  return { url, format, rate };
}

/** Most base64 one `karaoke_voice` carries (two seconds of µ-law). */
const VOICE_MAX_CHARS = 44_000;

/** `karaoke_voice` frame: skipped unless it has its round, a time and base64 audio. */
function parseKaraokeVoice(raw: Raw): Parsed["karaoke_voice"] | null {
  const room = nonEmpty(raw.room);
  const round = whole(raw.round, 1, 10_000, 0);
  const atMs = within(raw.at_ms, -MAX_DAY_MS, MAX_DAY_MS);
  const audio = str(raw.audio);
  if (!room || room.length > KARAOKE_CODE_MAX || round === 0 || atMs === null) return null;
  if (audio === null || audio.length === 0 || audio.length > VOICE_MAX_CHARS) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) return null;
  return { type: "karaoke_voice", voice: { room, round, atMs, audio } };
}

/**
 * `danmaku` frame. A line without a usable id or text cannot be shown or answered: null. The
 * limits are clamped to the contract's ranges (a number that is not one falls back to the usual
 * setting), so a line with an odd limit is still shown and answered rather than lost.
 */
function parseDanmaku(raw: Raw): Parsed["danmaku"] | null {
  const id = str(raw.id);
  const text = nonEmpty(raw.text);
  if (!id || id.length > MAX_DANMAKU_ID || !text) return null;
  const limit = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), min), max) : fallback;
  return {
    type: "danmaku",
    id,
    name: nonEmpty(raw.name)?.slice(0, MAX_NAME) ?? null,
    text: text.slice(0, MAX_DANMAKU_TEXT),
    max_on_screen: limit(raw.max_on_screen, 12, 1, 50),
    queue_max: limit(raw.queue_max, 20, 0, 200),
    max_wait_ms: limit(raw.max_wait_ms, 30_000, 0, 600_000),
  };
}

/** The demo's queue frame: loose on purpose ("items":[…]); see `DemoQueueMessage`. */
function parseQueueMessage(raw: Raw): DemoQueueMessage | null {
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

/** Parses one text frame. Unknown or malformed frames give null (the overlay must never throw on the feed). */
export function parseMessage(text: string): FeedMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const type = raw.type;
  if (type === "queue") return parseQueueMessage(raw);
  if (typeof type !== "string" || !Object.hasOwn(PARSERS, type)) return null;
  return (PARSERS[type as OverlayMessage["type"]] as (raw: Raw) => FeedMessage | null)(raw);
}

/** `activity` frame (contract) in, the overlay's `Activity` (camelCase) out. */
function parseActivity(raw: Raw): Parsed["activity"] | null {
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
      ...sideOf(raw.secondary),
    },
  };
}

function sideOf(v: unknown): { secondary: ActivitySide } | null {
  const side = parseSide(v);
  return side === null ? null : { secondary: side };
}

/** The `secondary` of an `activity` frame; anything unusable is no secondary line. */
function parseSide(v: unknown): ActivitySide | null {
  if (v === null || typeof v !== "object") return null;
  const side = v as Raw;
  const label = nonEmpty(side.label);
  if (!label) return null;
  const progress =
    typeof side.progress === "number" && Number.isFinite(side.progress) ? clamp01(side.progress) : null;
  return { label: label.slice(0, MAX_LABEL), detail: nonEmpty(side.detail)?.slice(0, MAX_TITLE) ?? null, progress };
}

function sameSide(a: ActivitySide | null, b: ActivitySide | null): boolean {
  if (a === null || b === null) return a === b;
  return a.label === b.label && a.detail === b.detail && a.progress === b.progress;
}

function sameActivity(a: Activity | null, b: Activity | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.progress === b.progress &&
    a.elapsedMs === b.elapsedMs &&
    a.durationMs === b.durationMs &&
    sameSide(a.secondary ?? null, b.secondary ?? null)
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
    case "touch":
    case "danmaku":
    case "danmaku_clear":
    case "karaoke":
    case "karaoke_lyrics":
    case "karaoke_voice":
      return state;
  }
}

/** Queues the card; over the cap the oldest one that is only waiting goes (never the one on screen). */
function reduceScreen(state: OverlayState, m: Extract<FeedMessage, { type: "screen" }>): OverlayState {
  const id = state.screenSeq + 1;
  const card: ScreenCard = { id, name: m.name, text: m.text };
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
