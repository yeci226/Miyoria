// What she is doing right now, for the overlay's activity line: derived from bus events and sent
// to the Stage node as `activity` messages.
//
// The main line, highest priority first:
//   singing       a song plays (`Events.SingCue` started .. ended); progress runs on the overlay's
//                 clock from `elapsed_ms` / `duration_ms`; gives up `singGraceMs` after the song
//                 should have ended when its `ended` cue never came
//   synthesizing  a line of hers is at TTS (`Events.VoiceSynthesis`) and her turn has not spoken
//   tool          a tool of hers runs (`Events.AgentToolRunning`): a short generic label per tool
//                 group, never its arguments
//   thinking      a turn runs (`agent.turn.started` .. completed) and has not spoken yet
//   game          she plays a game (`game.director.session` started .. stopped)
//   song_prepare  the song worker prepares one (`Events.SingPrepare`), but only when nothing above
//                 is going on; otherwise it is the `secondary` line beside the main one
//   (hidden)      otherwise
//
// Once a turn's first line plays its subtitles say the rest, so the gaps between its sentences
// show nothing. Short-lived thinking / synthesizing / tool use (under `showDelayMs`) never shows.
//
// The song being prepared is one at a time and stays the same until it ends (the publisher does not
// flip between songs); its progress never goes back, and a different song starts from its own.

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
export const GAME_LABEL = "玩遊戲中";
/** The worker (or the link to it) cannot be reached: reported by the `sing` module as this stage. */
export const UNREACHABLE_STAGE = "unreachable";
export const UNREACHABLE_LABEL = "連不上";
/** What the song line says while the song is prepared beside something else. */
export const PREPARE_SIDE_LABEL = "準備歌曲";
/** A song with no title yet and nobody known to have asked. */
export const UNKNOWN_SONG = "連結";

/**
 * Worker stages → what the overlay says, in words a viewer understands (no hardware, no model
 * names). Every stage of `SONG_PREPARE_STAGES` has one (a test checks that).
 */
export const STAGE_LABELS: Readonly<Record<string, string>> = {
  queued: "排隊中",
  resolve: "找歌中",
  download: "下載中",
  exclusive: "等待中",
  gpu_wait: "等待中",
  separate: "分離人聲",
  lead: "分離主唱",
  convert: "轉換歌聲",
  convert_backing: "轉換和聲",
  mix: "混音",
  beats: "抓節拍",
  lyrics: "找歌詞",
  video: "下載影片",
  reference: "分析旋律",
  encode: "製作伴奏",
  lyrics_asr: "對歌詞",
  lyrics_align: "對歌詞",
  fetch: "拿歌中",
  [UNREACHABLE_STAGE]: UNREACHABLE_LABEL,
};
/** A stage nobody gave a label to (a newer worker). */
const PREPARE_LABEL = "準備歌曲";
/** Waiting, handing over, lost or on its way to Core (made already): no bar, a shimmer. */
const NO_BAR_STAGES: ReadonlySet<string> = new Set([
  "queued",
  "exclusive",
  "gpu_wait",
  "fetch",
  UNREACHABLE_STAGE,
  "",
]);

/** The label of a song being prepared: the GPU hand-over, else the worker's stage. */
export function prepareLabel(p: SongPrepare): string {
  if (p.exclusive === "waiting" || p.exclusive === "offloading")
    return STAGE_LABELS.gpu_wait as string;
  return STAGE_LABELS[p.stage] ?? PREPARE_LABEL;
}

/** Whether the stage has no progress to show (it waits, or the worker is out of reach). */
function waiting(p: SongPrepare): boolean {
  return NO_BAR_STAGES.has(p.stage) || p.exclusive === "waiting" || p.exclusive === "offloading";
}

/**
 * Tools that are her speaking or bookkeeping, not "using a tool" to a viewer: they never show.
 */
const SILENT_TOOLS: ReadonlySet<string> = new Set([
  "say",
  "speak",
  "react",
  "text",
  "chat",
  "message_dm",
  "find_tools",
  "list_tools",
]);

/** A short generic label for a tool, by its group. Never the arguments, never the tool's own name. */
export function toolLabel(tool: string): string | null {
  if (SILENT_TOOLS.has(tool)) return null;
  if (tool.startsWith("web_")) return "查資料中";
  if (tool.startsWith("sing_")) return "處理點歌中";
  if (tool.startsWith("game_") || tool.startsWith("party_")) return "操作遊戲中";
  if (tool.startsWith("memory") || tool === "reflect" || tool.startsWith("skill_")) return "回想中";
  return "使用工具中";
}

export interface ActivityOptions {
  /** Turns outside voice contexts show `thinking` too (like `subtitle_text_turns`). */
  textTurns?: boolean;
  /** Thinking / synthesizing / tool use that ends sooner than this is never shown (ms). */
  showDelayMs?: number;
  /** Least time between two progress updates of the same activity (ms). */
  progressMs?: number;
  /** A turn without `completed` stops counting after this long (ms). */
  turnTtlMs?: number;
  /** A line at TTS without `started` / `failed` stops counting after this long (ms). */
  synthTtlMs?: number;
  /** A tool call without `ended` stops counting after this long (ms). */
  toolTtlMs?: number;
  /** A song whose `ended` cue never came stops showing this long after it should have ended (ms). */
  singGraceMs?: number;
  /** The longest a song with no known length shows (ms). */
  singMaxMs?: number;
  /** How long an unreachable worker is shown as such before the song line goes (ms). */
  unreachableMs?: number;
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

/** The song being prepared, as the tracker keeps it. */
interface Preparing {
  no: number;
  title: string;
  by: string | null;
  stage: string;
  exclusive: string | null;
  /** Overall progress; never goes back while the song stays the same. */
  progress: number;
  /** When the worker was last reported unreachable (the stage became `unreachable`). */
  lostAt: number | null;
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
/** Turns, lines at TTS and tool calls tracked at once. */
const MAX_TRACKED = 32;

/** Whether a progress change is worth a message (and is not held back by the throttle). */
function moved(from: number | null, to: number | null): boolean {
  if (from === to) return false;
  // A bar appearing or going away.
  if (from === null || to === null) return true;
  const settled = to === 1 || to === 0;
  return Math.abs(to - from) >= PROGRESS_STEP || settled;
}

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
  readonly #toolTtlMs: number;
  readonly #singGraceMs: number;
  readonly #singMaxMs: number;
  readonly #unreachableMs: number;
  /** Running turns: when they started, and whether a line of theirs played yet. */
  readonly #turns = new Map<TurnId, { since: number; spoke: boolean }>();
  /** Turns that already spoke (so a late `started` of theirs does not show thinking). */
  readonly #spoken = new Set<TurnId>();
  /** Running tool calls (`turn\0tool` → since and label). */
  readonly #tools = new Map<string, { since: number; label: string }>();
  #synths: Synth[] = [];
  #song: Song | null = null;
  #prepare: Preparing | null = null;
  #game: string | null = null;
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
    this.#toolTtlMs = options.toolTtlMs ?? 120_000;
    this.#singGraceMs = options.singGraceMs ?? 30_000;
    this.#singMaxMs = options.singMaxMs ?? 15 * 60_000;
    this.#unreachableMs = options.unreachableMs ?? 60_000;
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
      for (const key of this.#tools.keys()) {
        if (key.startsWith(`${event.data.turn}\0`)) this.#tools.delete(key);
      }
      return;
    } else if (is(Events.AgentToolRunning, event)) {
      const { turn, context, tool, state } = event.data;
      const key = `${turn}\0${tool}`;
      const label = toolLabel(tool);
      if (state === "ended" || label === null) {
        this.#tools.delete(key);
      } else if (context.kind === "voice" || this.#textTurns) {
        if (this.#tools.size >= MAX_TRACKED) {
          const oldest = this.#tools.keys().next().value;
          if (oldest !== undefined) this.#tools.delete(oldest);
        }
        this.#tools.set(key, { since: now, label });
      }
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
    } else if (is(Events.GameDirectorSession, event)) {
      const { state, game, game_name } = event.data;
      if (state === "started") this.#game = cleanTitle(game_name) ?? cleanTitle(game) ?? "";
      else this.#game = null;
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
        this.#onPrepare(parseSongPrepare(payload), now);
      } else if (topic === Events.SingCue.type) {
        this.#onSong(payload, now);
      }
      return;
    }
  }

  #onPrepare(p: SongPrepare | null, now: number): void {
    if (p === null) return;
    if (p.no === null) {
      this.#prepare = null;
      return;
    }
    const before = this.#prepare;
    // A different song starts from its own progress; the same one never goes back.
    const same = before !== null && before.no === p.no;
    this.#prepare = {
      no: p.no,
      title: p.title,
      by: p.by ?? null,
      stage: p.stage,
      exclusive: p.exclusive,
      progress: same ? Math.max(before.progress, p.progress) : p.progress,
      lostAt:
        p.stage === UNREACHABLE_STAGE
          ? same && before.lostAt !== null
            ? before.lostAt
            : now
          : null,
    };
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

  /** The song being prepared as a line of its own, or `null` (nothing, or the worker is long lost). */
  #preparing(
    now: number,
  ): { label: string; detail: string | null; progress: number | null; key: string } | null {
    const p = this.#prepare;
    if (p === null) return null;
    if (p.lostAt !== null && now - p.lostAt >= this.#unreachableMs) return null;
    const detail =
      cleanTitle(p.title) ??
      (p.by !== null && cleanTitle(p.by) !== null ? `${cleanTitle(p.by)} 點的歌` : UNKNOWN_SONG);
    const asPrepare: SongPrepare = {
      no: p.no,
      title: p.title,
      stage: p.stage,
      progress: p.progress,
      exclusive: p.exclusive,
    };
    return {
      label: prepareLabel(asPrepare),
      detail,
      progress: waiting(asPrepare) ? null : p.progress,
      key: `${p.no}\0${prepareLabel(asPrepare)}\0${detail}`,
    };
  }

  /** Her activity at `now`, plus a key that changes when it is a different one. */
  #current(now: number): { activity: Activity; key: string } {
    const song = this.#song;
    if (song !== null) {
      const left =
        song.duration === null ? this.#singMaxMs : Math.max(0, song.duration - song.offset);
      if (now - song.at >= left + this.#singGraceMs) this.#song = null;
    }
    this.#expire(now);
    const prep = this.#preparing(now);
    const shown = (since: number) => now - since >= this.#showDelayMs;
    const main = this.#main(now, shown);
    if (main === null) {
      if (prep === null) return { activity: IDLE, key: "" };
      return {
        activity: {
          kind: "song_prepare",
          label: prep.label,
          detail: prep.detail,
          progress: prep.progress,
          elapsed_ms: null,
          duration_ms: null,
        },
        key: `song_prepare\0${prep.key}`,
      };
    }
    if (prep === null) return main;
    const label =
      this.#prepare?.stage === UNREACHABLE_STAGE ? UNREACHABLE_LABEL : PREPARE_SIDE_LABEL;
    return {
      activity: {
        ...main.activity,
        secondary: { label, detail: prep.detail, progress: prep.progress },
      },
      key: `${main.key}\0+\0${this.#prepare?.no}\0${label}\0${prep.detail}`,
    };
  }

  /** The main line: singing, synthesizing, a tool, thinking, a game; `null` when there is none. */
  #main(
    now: number,
    shown: (since: number) => boolean,
  ): { activity: Activity; key: string } | null {
    const song = this.#song;
    if (song !== null) {
      return {
        activity: {
          kind: "singing",
          label: SINGING_LABEL,
          detail: cleanTitle(song.title),
          progress: null,
          elapsed_ms: Math.max(0, Math.round(song.offset + now - song.at)),
          duration_ms: song.duration,
        },
        // A song (or the same one again) restarts the overlay's clock.
        key: `singing\0${song.song}\0${song.at}`,
      };
    }
    const simple = (kind: ActivityKind, label: string, detail: string | null = null) => ({
      activity: { kind, label, detail, progress: null, elapsed_ms: null, duration_ms: null },
      key: `${kind}\0${label}\0${detail ?? ""}`,
    });
    if (
      this.#synths.some((s) => shown(s.since) && (s.turn === null || !this.#spoken.has(s.turn)))
    ) {
      return simple("synthesizing", SYNTH_LABEL);
    }
    const tool = [...this.#tools.values()].find((t) => shown(t.since));
    if (tool !== undefined) return simple("tool", tool.label);
    if ([...this.#turns.values()].some((t) => !t.spoke && shown(t.since))) {
      return simple("thinking", THINKING_LABEL);
    }
    if (this.#game !== null)
      return simple("game", GAME_LABEL, this.#game === "" ? null : this.#game);
    return null;
  }

  #expire(now: number): void {
    for (const [turn, t] of this.#turns) {
      if (now - t.since >= this.#turnTtlMs) this.#turns.delete(turn);
    }
    for (const [key, t] of this.#tools) {
      if (now - t.since >= this.#toolTtlMs) this.#tools.delete(key);
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
      const mainMoved = moved(this.#sent.progress, activity.progress);
      const sideMoved = moved(
        this.#sent.secondary?.progress ?? null,
        activity.secondary?.progress ?? null,
      );
      if (!mainMoved && !sideMoved) return null;
      if (now - this.#sentAt < this.#progressMs) return null;
    }
    this.#sent = activity;
    this.#sentKey = key;
    this.#sentAt = now;
    return { type: "activity", ...activity };
  }

  /** The message `next` just returned could not be sent: the next call gives it again. */
  unsent(): void {
    this.#sentKey = "\0unsent";
    this.#sentAt = Number.NEGATIVE_INFINITY;
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
