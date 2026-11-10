// Turns bus events into Core → Stage messages.

import {
  AFFECT_CHANGED_TOPIC,
  type Event,
  isJsonObject,
  type JsonValue,
  type PlaybackState,
  parseSongCue,
  SONG_TOPIC,
  SPEECH_PAUSE_TOPIC,
  type TurnId,
  VOICE_UPCOMING_TOPIC,
} from "@miyoria/types";
import {
  type CoreMessage,
  GIFT_LABEL_MAX,
  GIFT_NAME_MAX,
  SCREEN_NAME_MAX,
  SCREEN_SONG_MAX,
  SCREEN_TEXT_MAX,
} from "../protocol.js";
import { parseTouch, TOUCH_TOPIC } from "../touch.js";

/** Topic of the agent's emotion markers. */
export const EMOTION_TOPIC = "agent.emotion";
/** Topic of a gift to her (`{name, item, count, label}`), shown on the overlay. */
export const GIFT_TOPIC = "economy.gift";
/** Topic of a paid screen message or dedication (`{kind, name, text, song}`). */
export const SCREEN_TOPIC = "economy.screen";
/** How much a feeling must change before her resting face follows it. */
const RESTING_STEP = 0.1;
/**
 * Topic of the written sentence of a line she spoke first (`voice_first`, e.g. the Japanese
 * voice line and its Chinese subtitle): `{turn, context, spoken, text}`.
 */
export const SUBTITLE_TOPIC = "agent.subtitle";

/** Turns whose subtitles are tracked at once. */
const MAX_TURNS = 16;

interface TurnSubtitle {
  turn: TurnId;
  /** Text of the playbacks started so far (the segments joined). */
  spoken: string;
  /** One entry per started playback: its text, or its written sentence once known. */
  segments: string[];
  /** Written sentences that arrived before their line played: spoken line → subtitle. */
  written: Map<string, string>;
  /** Playbacks started and not yet ended. */
  active: number;
  /** Lines shown before they started (`voice.upcoming`): their text and segment. */
  early: { text: string; index: number }[];
  completed: boolean;
  finalized: boolean;
}

/** An emotion marker of a voice turn, waiting for its sentence to play. */
interface PendingEmotion {
  name: string;
  intensity: number;
}

interface TurnEmotions {
  /** Emotion → intensity of its latest marker. */
  byName: Map<string, number>;
  latest: PendingEmotion;
}

export interface ForwarderOptions {
  /** The scene a song's video plays in (the `sing` scene the director switches to), if any. */
  singScene?: () => string | null;
  /** Clock of `resumeSongVideo` (ms). */
  now?: () => number;
}

/** The song video playing: its `play` message, and when that was sent. */
interface SongVideo {
  msg: Extract<CoreMessage, { type: "song_video" }>;
  sentAt: number;
}

/** The beat of the song playing: its `beat` message, and when that was sent. */
interface SongBeat {
  msg: Extract<CoreMessage, { type: "beat" }>;
  sentAt: number;
}

const clampIntensity = (i: unknown): number =>
  typeof i === "number" && Number.isFinite(i) ? Math.min(Math.max(i, 0), 1) : 1;

/**
 * Subscribed topics → messages, with the subtitle bookkeeping.
 *
 * Subtitles follow her speech: every started playback appends its text and sends a non-final
 * `subtitle`; once the turn completed and no playback of it is running, the text is sent again
 * with `final: true`. A line announced as upcoming (`VOICE_UPCOMING_TOPIC`, a little before it
 * plays, so the subtitle lands with her voice where the picture runs late) is appended then, and
 * its start appends nothing; one that never starts is taken out again when the turn's subtitle
 * is final. Turns outside voice contexts produce one final subtitle when `textTurns` is set.
 *
 * Emotions of voice turns are sent when the sentence spoken with them starts playing (the
 * marker is parsed a sentence or more ahead of the audio): `voice.playback` `started` carries
 * the sentence's emotion, and the marker's intensity is remembered until then. Playbacks from
 * older voice modules (no `emotion` field) show the turn's latest marker instead. Emotions of
 * other turns are sent at once.
 *
 * What she shows of how she feels (`affect.changed`) is her resting face, sent as `resting` when
 * it changes, also while she says nothing: what she feels reaches her face without a tag. A line
 * spoken in it without a marker of its own shows it as strongly as she feels it.
 *
 * Songs (`SONG_TOPIC`) with a video also send `song_video` `play` when they start and `stop`
 * when they end; a node that connects mid-song gets the `play` again (`resumeSongVideo`). Songs
 * with a known beat send `beat` the same way (empty `times_ms` at the end; `resumeBeat`).
 */
export class Forwarder {
  readonly #textTurns: boolean;
  readonly #turns: TurnSubtitle[] = [];
  readonly #emotions = new Map<TurnId, TurnEmotions>();
  readonly #singScene: () => string | null;
  readonly #now: () => number;
  #video: SongVideo | null = null;
  #beat: SongBeat | null = null;
  #resting: PendingEmotion | null = null;

  constructor(textTurns: boolean, options: ForwarderOptions = {}) {
    this.#textTurns = textTurns;
    this.#singScene = options.singScene ?? (() => null);
    this.#now = options.now ?? Date.now;
  }

  /** The `play` of the song video still playing, for a node that just connected. */
  resumeSongVideo(): CoreMessage | null {
    const v = this.#video;
    if (v === null) return null;
    const offset = (v.msg.offset_ms ?? 0) + Math.max(this.#now() - v.sentAt, 0);
    return { ...v.msg, offset_ms: Math.round(offset) };
  }

  /** The `beat` of the song still playing, for a node that just connected. */
  resumeBeat(): CoreMessage | null {
    const b = this.#beat;
    if (b === null) return null;
    return {
      ...b.msg,
      offset_ms: Math.round(b.msg.offset_ms + Math.max(this.#now() - b.sentAt, 0)),
    };
  }

  /** Her resting face, for a node that just connected. */
  resumeResting(): CoreMessage | null {
    return this.#resting === null ? null : { type: "emotion", ...this.#resting, resting: true };
  }

  #onAffect(payload: JsonValue): CoreMessage[] {
    const p = isJsonObject(payload) ? payload : {};
    const shown = isJsonObject(p.shown) ? p.shown : null;
    const tag = typeof shown?.tag === "string" ? shown.tag.trim().toLowerCase() : "";
    const felt = (Array.isArray(p.top) ? p.top : []).find(
      (e) => isJsonObject(e) && e.name === shown?.from,
    );
    const next: PendingEmotion =
      tag === ""
        ? { name: "neutral", intensity: 0 }
        : { name: tag, intensity: isJsonObject(felt) ? clampIntensity(felt.intensity) : 1 };
    const last = this.#resting ?? { name: "neutral", intensity: 0 };
    const same =
      last.name === next.name && Math.abs(last.intensity - next.intensity) < RESTING_STEP;
    if (same) return [];
    this.#resting = next;
    return [{ type: "emotion", ...next, resting: true }];
  }

  #entry(turn: TurnId): TurnSubtitle {
    const found = this.#turns.find((t) => t.turn === turn);
    if (found) return found;
    if (this.#turns.length >= MAX_TURNS) this.#turns.shift();
    const e: TurnSubtitle = {
      turn,
      spoken: "",
      segments: [],
      written: new Map(),
      active: 0,
      early: [],
      completed: false,
      finalized: false,
    };
    this.#turns.push(e);
    return e;
  }

  #onEmotion(payload: JsonValue): CoreMessage[] {
    const p = isJsonObject(payload) ? payload : {};
    const raw = p.emotion ?? p.name;
    const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (name === "") return [];
    const intensity = clampIntensity(p.intensity);
    const context = isJsonObject(p.context) ? p.context : null;
    const turn = typeof p.turn === "string" && p.turn !== "" ? p.turn : null;
    if (context?.kind !== "voice" || turn === null) return [{ type: "emotion", name, intensity }];
    // A voice turn: wait for the sentence to play.
    let e = this.#emotions.get(turn);
    if (!e) {
      if (this.#emotions.size >= MAX_TURNS) {
        const oldest = this.#emotions.keys().next().value;
        if (oldest !== undefined) this.#emotions.delete(oldest);
      }
      e = { byName: new Map(), latest: { name, intensity } };
      this.#emotions.set(turn, e);
    }
    e.byName.set(name, intensity);
    e.latest = { name, intensity };
    return [];
  }

  /** The emotion to show when a playback of `turn` starts. */
  #playbackEmotion(turn: TurnId | null, emotion: string | null | undefined): CoreMessage[] {
    const pending = turn === null ? undefined : this.#emotions.get(turn);
    if (emotion === undefined) {
      // An older voice module: the turn's latest marker, once.
      if (!pending || turn === null) return [];
      this.#emotions.delete(turn);
      return [{ type: "emotion", ...pending.latest }];
    }
    const name = emotion?.trim().toLowerCase() ?? "";
    if (name === "") return [];
    const resting = this.#resting?.name === name ? this.#resting.intensity : 1;
    return [{ type: "emotion", name, intensity: pending?.byName.get(name) ?? resting }];
  }

  onEvent(event: Event): CoreMessage[] {
    switch (event.type) {
      case "custom":
        if (event.data.topic === SONG_TOPIC) return this.#onSong(event.data.payload);
        if (event.data.topic === SPEECH_PAUSE_TOPIC) return pauseNotice(event.data.payload);
        if (event.data.topic === SUBTITLE_TOPIC) return this.#onWritten(event.data.payload);
        if (event.data.topic === VOICE_UPCOMING_TOPIC) return this.#onUpcoming(event.data.payload);
        if (event.data.topic === GIFT_TOPIC) return giftMessage(event.data.payload);
        if (event.data.topic === TOUCH_TOPIC) return touchMessage(event.data.payload);
        if (event.data.topic === SCREEN_TOPIC) return screenMessage(event.data.payload);
        if (event.data.topic === AFFECT_CHANGED_TOPIC) return this.#onAffect(event.data.payload);
        return event.data.topic === EMOTION_TOPIC ? this.#onEmotion(event.data.payload) : [];
      case "voice_playback": {
        const { turn, state, text, emotion } = event.data;
        const out = this.#onPlayback(turn, state, text);
        if (state === "started") out.push(...this.#playbackEmotion(turn, emotion));
        return out;
      }
      case "agent_turn_completed": {
        const { turn, context, text } = event.data;
        const voice = context.kind === "voice";
        const e = this.#entry(turn);
        e.completed = true;
        if (voice || e.spoken !== "") {
          // A line shown early is about to play: the subtitle is final after it.
          if (e.active === 0 && e.early.length === 0 && e.spoken !== "" && !e.finalized) {
            e.finalized = true;
            return [subtitle(turn, e.spoken, true)];
          }
        } else if (this.#textTurns && text.trim() !== "" && !e.finalized) {
          e.finalized = true;
          return [subtitle(turn, text.trim(), true)];
        }
        return [];
      }
      default:
        return [];
    }
  }

  #onPlayback(turn: TurnId | null, state: PlaybackState, rawText: string): CoreMessage[] {
    const text = rawText.trim();
    if (state === "started") {
      const out: CoreMessage[] = [{ type: "speaking", state: "started" }];
      if (turn !== null) {
        const e = this.#entry(turn);
        e.active += 1;
        e.finalized = false;
        const early = e.early.findIndex((x) => x.text === text);
        if (early >= 0) {
          e.early.splice(early, 1); // shown already
        } else {
          // A line whose written sentence is known already shows that instead.
          const shown = e.written.get(text) ?? text;
          e.written.delete(text);
          if (shown !== "") e.segments.push(shown);
        }
        e.spoken = joined(e.segments);
        if (e.spoken !== "") out.push(subtitle(turn, e.spoken, false));
      } else if (text !== "") {
        out.push({ type: "subtitle", turn: "", text, final: false });
      }
      return out;
    }
    const out: CoreMessage[] = [{ type: "speaking", state: "stopped" }];
    if (turn !== null) {
      const e = this.#entry(turn);
      // `failed` without `started` (TTS failed) has nothing running; a line shown early that
      // fails so is taken out of the subtitle.
      const early = state === "failed" ? e.early.find((x) => x.text === text) : undefined;
      if (early !== undefined) {
        dropEarly(e, [early]);
        out.push(subtitle(turn, e.spoken, false));
      } else if (state !== "failed" || e.active > 0) {
        e.active = Math.max(e.active - 1, 0);
      }
      if (
        e.completed &&
        e.active === 0 &&
        e.early.length === 0 &&
        e.spoken !== "" &&
        !e.finalized
      ) {
        e.finalized = true;
        out.push(subtitle(turn, e.spoken, true));
      }
    } else if (text !== "" && state !== "failed") {
      out.push({ type: "subtitle", turn: "", text, final: true });
    }
    return out;
  }

  /**
   * A line about to play (`VOICE_UPCOMING_TOPIC`): its subtitle goes up now. Its `started`
   * then appends nothing.
   */
  #onUpcoming(payload: JsonValue): CoreMessage[] {
    const p = isJsonObject(payload) ? payload : {};
    const turn = typeof p.turn === "string" && p.turn !== "" ? p.turn : null;
    const text = typeof p.text === "string" ? p.text.trim() : "";
    if (turn === null || text === "") return [];
    const e = this.#entry(turn);
    if (e.early.some((x) => x.text === text)) return [];
    const shown = e.written.get(text) ?? text;
    e.written.delete(text);
    e.early.push({ text, index: e.segments.length });
    e.segments.push(shown);
    e.finalized = false;
    e.spoken = joined(e.segments);
    return [subtitle(turn, e.spoken, false)];
  }

  /**
   * A line she spoke before writing it got its written sentence (`agent.subtitle`): the voice
   * line (e.g. Japanese) in the subtitle is swapped for it (e.g. Chinese) and the subtitle is
   * sent again (final when the turn's subtitle was final already). One that arrives before the
   * line played is kept for that playback.
   */
  #onWritten(payload: JsonValue): CoreMessage[] {
    const p = isJsonObject(payload) ? payload : {};
    const turn = typeof p.turn === "string" && p.turn !== "" ? p.turn : null;
    const spoken = typeof p.spoken === "string" ? p.spoken.trim() : "";
    const written = typeof p.text === "string" ? p.text.trim() : "";
    if (turn === null || spoken === "" || written === "" || spoken === written) return [];
    const e = this.#entry(turn);
    const i = e.segments.indexOf(spoken);
    if (i < 0) {
      e.written.set(spoken, written);
      return [];
    }
    e.segments[i] = written;
    e.spoken = joined(e.segments);
    return [subtitle(turn, e.spoken, e.finalized)];
  }

  /**
   * A song she sings: she is speaking while it plays, each lyrics line is its own final
   * subtitle (an empty line clears it), the end clears it; its video plays from start to end.
   */
  #onSong(payload: JsonValue): CoreMessage[] {
    const cue = parseSongCue(payload);
    if (cue === null) return [];
    switch (cue.state) {
      case "started": {
        const out: CoreMessage[] = [{ type: "speaking", state: "started" }];
        this.#video = null;
        if (cue.video !== undefined) {
          const scene = this.#singScene();
          const msg: SongVideo["msg"] = {
            type: "song_video",
            action: "play",
            song: cue.song,
            path: cue.video,
            offset_ms: cue.offset_ms ?? 0,
            ...(scene === null ? {} : { scene }),
          };
          this.#video = { msg, sentAt: this.#now() };
          out.push(msg);
        }
        this.#beat = null;
        if (cue.beats !== undefined) {
          const msg: SongBeat["msg"] = {
            type: "beat",
            song: cue.song,
            bpm: cue.beats.bpm,
            times_ms: cue.beats.times_ms,
            offset_ms: cue.offset_ms ?? 0,
          };
          this.#beat = { msg, sentAt: this.#now() };
          out.push(msg);
        }
        return out;
      }
      case "line":
        return [subtitle(`song:${cue.song}:${cue.index}`, cue.text.trim(), true)];
      case "ended": {
        const out: CoreMessage[] = [
          { type: "speaking", state: "stopped" },
          subtitle(`song:${cue.song}:end`, "", true),
        ];
        if (this.#video?.msg.song === cue.song) {
          this.#video = null;
          out.push({ type: "song_video", action: "stop", song: cue.song });
        }
        if (this.#beat?.msg.song === cue.song) {
          this.#beat = null;
          out.push({ type: "beat", song: cue.song, bpm: 0, times_ms: [], offset_ms: 0 });
        }
        return out;
      }
    }
  }
}

/** The overlay line while her speech is paused for a song being prepared. */
export const PREPARING_NOTICE = "準備歌曲中…";

function pauseNotice(payload: JsonValue): CoreMessage[] {
  const p = isJsonObject(payload) ? payload : {};
  if (typeof p.paused !== "boolean") return [];
  return [{ type: "notice", text: p.paused ? PREPARING_NOTICE : "" }];
}

function giftMessage(payload: JsonValue): CoreMessage[] {
  const p = isJsonObject(payload) ? payload : {};
  const name = typeof p.name === "string" ? p.name.trim() : "";
  const label = typeof p.label === "string" ? p.label.trim() : "";
  const item = typeof p.item === "string" ? p.item.trim() : "";
  const count = typeof p.count === "number" && Number.isFinite(p.count) ? Math.floor(p.count) : 1;
  if (name === "" || label === "" || item === "" || count < 1) return [];
  return [
    {
      type: "gift",
      name: name.slice(0, GIFT_NAME_MAX),
      item: item.slice(0, 32),
      count: Math.min(count, 99),
      label: label.slice(0, GIFT_LABEL_MAX),
    },
  ];
}

function touchMessage(payload: JsonValue): CoreMessage[] {
  const touch = parseTouch(payload);
  return touch === null ? [] : [{ type: "touch", ...touch }];
}

function screenMessage(payload: JsonValue): CoreMessage[] {
  const p = isJsonObject(payload) ? payload : {};
  const name = typeof p.name === "string" ? p.name.trim() : "";
  const text = typeof p.text === "string" ? p.text.trim() : "";
  const song = typeof p.song === "string" ? p.song.trim() : "";
  const kind = p.kind === "dedication" ? "dedication" : p.kind === "message" ? "message" : null;
  if (kind === null || name === "" || text === "") return [];
  if (kind === "dedication" && song === "") return [];
  return [
    {
      type: "screen",
      kind,
      name: name.slice(0, SCREEN_NAME_MAX),
      text: text.slice(0, SCREEN_TEXT_MAX),
      song: kind === "dedication" ? song.slice(0, SCREEN_SONG_MAX) : null,
    },
  ];
}

/** Takes lines shown early that will not play out of `e`'s subtitle. */
function dropEarly(e: TurnSubtitle, lines: { text: string; index: number }[]): void {
  const gone = new Set(lines.map((x) => x.index));
  e.segments = e.segments.filter((_, i) => !gone.has(i));
  // The later early lines moved up by the ones taken out before them.
  e.early = e.early
    .filter((x) => !gone.has(x.index))
    .map((x) => ({ ...x, index: x.index - [...gone].filter((g) => g < x.index).length }));
  e.spoken = joined(e.segments);
}

function subtitle(turn: TurnId, text: string, final: boolean): CoreMessage {
  return { type: "subtitle", turn, text, final };
}

const ASCII_ALNUM = /^[A-Za-z0-9]$/;

/** The segments as one subtitle line. */
function joined(segments: string[]): string {
  return segments.reduce((line, segment) => append(line, segment), "");
}

/** Appends a speech segment, with a space between two Latin words. */
function append(spoken: string, text: string): string {
  if (text === "") return spoken;
  const last = spoken.at(-1);
  const first = text[0] ?? "";
  const needsSpace =
    last !== undefined &&
    (ASCII_ALNUM.test(last) || last === "," || last === ".") &&
    ASCII_ALNUM.test(first);
  return needsSpace ? `${spoken} ${text}` : spoken + text;
}
