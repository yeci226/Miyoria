// What she is doing right now, for the overlay's activity line: derived from bus events and sent
// to the Stage node as `activity` messages.
//
// Highest priority first:
//   singing       a song plays (`Events.SingCue` started .. ended); progress runs on the overlay's
//                 clock from `elapsed_ms` / `duration_ms`
//   song_prepare  the song worker prepares one (`Events.SingPrepare`), with its stage and progress
//   synthesizing  a line of hers is at TTS (`Events.VoiceSynthesis`) and her turn has not spoken
//   thinking      a turn runs (`agent.turn.started` .. completed) and has not spoken yet
//   (hidden)      otherwise
//
// Once a turn's first line plays its subtitles say the rest, so the gaps between its sentences
// show nothing. Short-lived thinking / synthesizing (under `showDelayMs`) never shows.

import {
  type BusEvent,
  Events,
  is,
  isJsonObject,
  type JsonValue,
  parseSongCue,
  parseSongPrepare,
  type SongPrepare,
  safeName,
  type TurnId,
} from "@miyoria/types";
import type { Activity, ActivityKind, CoreMessage } from "../protocol.js";

/** Song titles on the overlay, in code points. */
const TITLE_CHARS = 48;

export const THINKING_LABEL = "思考中…";
export const SYNTH_LABEL = "產生語音…";
export const SINGING_LABEL = "正在唱";

const GPU_LABEL = "讓出顯示卡中";

/** Worker stages → what the overlay says. */
const STAGE_LABELS: Readonly<Record<string, string>> = {
  queued: "排隊中",
  resolve: "找歌中",
  download: "下載中",
  exclusive: GPU_LABEL,
  separate: "分離人聲",
  convert: "轉換歌聲",
  mix: "混音",
  lyrics: "找歌詞",
  video: "下載影片",
};
const PREPARE_LABEL = "準備歌曲";

/** The label of a song being prepared: the GPU hand-over, else the worker's stage. */
export function prepareLabel(p: SongPrepare): string {
  if (p.exclusive === "waiting" || p.exclusive === "offloading") return GPU_LABEL;
  return STAGE_LABELS[p.stage] ?? PREPARE_LABEL;
}

export interface ActivityOptions {
  /** Turns outside voice contexts show `thinking` too (like `subtitle_text_turns`). */
  textTurns?: boolean;
  /** Thinking / synthesizing that ends sooner than this is never shown (ms). */
  showDelayMs?: number;
  /** Least time between two progress updates of the same activity (ms). */
  progressMs?: number;
  /** A turn without `completed` stops counting after this long (ms). */
  turnTtlMs?: number;
  /** A line at TTS without `started` / `failed` stops counting after this long (ms). */
  synthTtlMs?: number;
}

interface Song {
  song: string;
  title: string;
  /** Clock time the song was at `offset` ms. */
  at: number;
  offset: number;
  duration: number | null;
}

interface Synth {
  turn: TurnId | null;
  since: number;
}

/** The hidden activity. */
const IDLE: Activity = {
  kind: null,
  label: "",
  detail: null,
  progress: null,
  elapsed_ms: null,
  duration_ms: null,
};

/** Smallest progress change worth a message. */
const PROGRESS_STEP = 0.005;
/** Turns and lines at TTS tracked at once. */
const MAX_TRACKED = 32;

/**
 * Folds bus events into her current activity and decides when to tell the node: a new kind,
 * label or song at once, progress of the same activity at most every `progressMs`. Call
 * `next(now)` after events and on a timer (delays and expiry need the clock to move).
 */
export class ActivityTracker {
  readonly #textTurns: boolean;
  readonly #showDelayMs: number;
  readonly #progressMs: number;
  readonly #turnTtlMs: number;
  readonly #synthTtlMs: number;
  /** Running turns: when they started, and whether a line of theirs played yet. */
  readonly #turns = new Map<TurnId, { since: number; spoke: boolean }>();
  /** Turns that already spoke (so a late `started` of theirs does not show thinking). */
  readonly #spoken = new Set<TurnId>();
  #synths: Synth[] = [];
  #song: Song | null = null;
  #prepare: SongPrepare | null = null;
  /** What was sent last, and when. */
  #sent: Activity = IDLE;
  #sentKey = "";
  #sentAt = Number.NEGATIVE_INFINITY;

  constructor(options: ActivityOptions = {}) {
    this.#textTurns = options.textTurns ?? false;
    this.#showDelayMs = options.showDelayMs ?? 250;
    this.#progressMs = options.progressMs ?? 250;
    this.#turnTtlMs = options.turnTtlMs ?? 120_000;
    this.#synthTtlMs = options.synthTtlMs ?? 30_000;
  }

  onEvent(event: BusEvent, now: number): void {
    if (is(Events.AgentTurnStarted, event)) {
      const { turn, context } = event.data;
      if (context.kind !== "voice" && !this.#textTurns) return;
      if (this.#spoken.has(turn)) return;
      if (this.#turns.size >= MAX_TRACKED) {
        const oldest = this.#turns.keys().next().value;
        if (oldest !== undefined) this.#turns.delete(oldest);
      }
      this.#turns.set(turn, { since: now, spoke: false });
      return;
    } else if (is(Events.AgentTurnCompleted, event)) {
      this.#turns.delete(event.data.turn);
      this.#synths = this.#synths.filter((s) => s.turn !== event.data.turn);
      return;
    } else if (is(Events.VoicePlaybackEvent, event)) {
      const { turn, state } = event.data;
      if (state !== "started" && state !== "failed") return;
      // The line that was at TTS: the oldest of the same turn.
      const i = this.#synths.findIndex((s) => s.turn === turn);
      if (i >= 0) this.#synths.splice(i, 1);
      if (state === "started" && turn !== null) {
        const t = this.#turns.get(turn);
        if (t) t.spoke = true;
        this.#markSpoken(turn);
      }
      return;
    } else {
      const topic = event.type;
      const payload = event.data as JsonValue;
      if (topic === Events.VoiceSynthesis.type) {
        const p = isJsonObject(payload) ? payload : {};
        const turn = typeof p.turn === "string" && p.turn !== "" ? p.turn : null;
        if (this.#synths.length >= MAX_TRACKED) this.#synths.shift();
        this.#synths.push({ turn, since: now });
      } else if (topic === Events.SingPrepare.type) {
        const p = parseSongPrepare(payload);
        if (p !== null) this.#prepare = p.no === null ? null : p;
      } else if (topic === Events.SingCue.type) {
        this.#onSong(payload, now);
      }
      return;
    }
  }

  #markSpoken(turn: TurnId): void {
    this.#spoken.add(turn);
    if (this.#spoken.size > MAX_TRACKED) {
      const oldest = this.#spoken.values().next().value;
      if (oldest !== undefined) this.#spoken.delete(oldest);
    }
  }

  #onSong(payload: Parameters<typeof parseSongCue>[0], now: number): void {
    const cue = parseSongCue(payload);
    if (cue === null) return;
    if (cue.state === "started") {
      this.#song = {
        song: cue.song,
        title: cue.title,
        at: now,
        offset: cue.offset_ms ?? 0,
        duration: cue.duration_ms ?? null,
      };
    } else if (cue.state === "ended" && this.#song?.song === cue.song) {
      this.#song = null;
    }
  }

  /** Her activity at `now`, plus a key that changes when it is a different one. */
  #current(now: number): { activity: Activity; key: string } {
    const song = this.#song;
    if (song !== null) {
      const title = cleanTitle(song.title);
      return {
        activity: {
          kind: "singing",
          label: SINGING_LABEL,
          detail: title,
          progress: null,
          elapsed_ms: Math.max(0, Math.round(song.offset + now - song.at)),
          duration_ms: song.duration,
        },
        // A song (or the same one again) restarts the overlay's clock.
        key: `singing\0${song.song}\0${song.at}`,
      };
    }
    const prepare = this.#prepare;
    if (prepare !== null) {
      const label = prepareLabel(prepare);
      const detail = cleanTitle(prepare.title);
      return {
        activity: {
          kind: "song_prepare",
          label,
          detail,
          progress: prepare.progress,
          elapsed_ms: null,
          duration_ms: null,
        },
        key: `song_prepare\0${prepare.no}\0${label}\0${detail}`,
      };
    }
    this.#expire(now);
    const shown = (since: number) => now - since >= this.#showDelayMs;
    const kind: ActivityKind | null = this.#synths.some(
      (s) => shown(s.since) && (s.turn === null || !this.#spoken.has(s.turn)),
    )
      ? "synthesizing"
      : [...this.#turns.values()].some((t) => !t.spoke && shown(t.since))
        ? "thinking"
        : null;
    if (kind === null) return { activity: IDLE, key: "" };
    return {
      activity: {
        kind,
        label: kind === "thinking" ? THINKING_LABEL : SYNTH_LABEL,
        detail: null,
        progress: null,
        elapsed_ms: null,
        duration_ms: null,
      },
      key: kind,
    };
  }

  #expire(now: number): void {
    for (const [turn, t] of this.#turns) {
      if (now - t.since >= this.#turnTtlMs) this.#turns.delete(turn);
    }
    this.#synths = this.#synths.filter((s) => now - s.since < this.#synthTtlMs);
  }

  /**
   * The `activity` message to send now, or `null` when the node already shows what she is doing
   * (or a progress update has to wait for `progressMs`).
   */
  next(now: number): CoreMessage | null {
    const { activity, key } = this.#current(now);
    if (key === this.#sentKey) {
      const from = this.#sent.progress;
      const to = activity.progress;
      if (from === to || from === null || to === null) return null;
      const settled = to === 1 || to === 0;
      if (Math.abs(to - from) < PROGRESS_STEP && !settled) return null;
      if (now - this.#sentAt < this.#progressMs) return null;
    }
    this.#sent = activity;
    this.#sentKey = key;
    this.#sentAt = now;
    return { type: "activity", ...activity };
  }

  /** The current activity for a node that just connected, or `null` when there is none. */
  resume(now: number): CoreMessage | null {
    const { activity, key } = this.#current(now);
    this.#sent = activity;
    this.#sentKey = key;
    this.#sentAt = now;
    return activity.kind === null ? null : { type: "activity", ...activity };
  }
}

/** A song title as one short inert line, or `null` when there is none. */
function cleanTitle(title: string): string | null {
  return title.trim() === "" ? null : safeName(title, TITLE_CHARS);
}
