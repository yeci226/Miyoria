// The live feed: bus events in, a small public picture of her out.
//
// The overlay's own machinery does the folding: the Stage's `Forwarder` turns speech, subtitles
// and emotion markers into lines and faces exactly as the stream shows them, and its
// `ActivityTracker` says when she is thinking or preparing a song. This file decides what they are
// fed (privacy.ts, rule 1), screens what comes out (rule 2) and tells every watcher what changed.

import { ActivityTracker, EMOTION_TOPIC, Forwarder, SUBTITLE_TOPIC } from "@miyoria/stage";
import {
  type ActivitySnapshot,
  AFFECT_CHANGED_TOPIC,
  type ContextKey,
  type Event,
  type LiveActivity,
  type LiveEmotion,
  type LiveEvent,
  type LiveLine,
  type LivePart,
  type LivePats,
  type LivePlace,
  type LivePresence,
  type LiveSnapshot,
  type LiveSpot,
  type LiveVideo,
  SONG_PREPARE_TOPIC,
  SONG_TOPIC,
  SPEECH_SYNTH_TOPIC,
  VOICE_UPCOMING_TOPIC,
} from "@miyoria/types";
import { isPublicPlace, mayShow, payloadContext, payloadTurn, type Screen } from "./privacy.js";

/** Topics the feed follows. */
export const LIVE_TOPICS: readonly string[] = [
  "agent.turn.started",
  "agent.turn.completed",
  "voice.playback",
  EMOTION_TOPIC,
  SUBTITLE_TOPIC,
  VOICE_UPCOMING_TOPIC,
  SPEECH_SYNTH_TOPIC,
  AFFECT_CHANGED_TOPIC,
  SONG_TOPIC,
  SONG_PREPARE_TOPIC,
];

/** Longest line shown, in code points; a longer one shows its end. */
export const MAX_LINE_CHARS = 280;
/** Turns remembered (their place, their line). */
const MAX_TURNS = 64;
/** Emotion names the page may be told: what an avatar's `[emotion]` keys look like. */
const EMOTION_NAME = /^[a-z][a-z0-9_-]{0,23}$/;
/** Smallest change of intensity worth telling. */
const INTENSITY_STEP = 0.05;
const NEUTRAL: LiveEmotion = { name: "neutral", intensity: 0 };

interface Turn {
  public: boolean;
  via: LiveLine["via"];
}

interface LineEntry {
  line: LiveLine;
  /** Shown with words at least once. */
  shown: boolean;
  /** Taken back for good: it named someone, or moderation stopped it. */
  withheld: boolean;
}

export interface LiveStateOptions {
  channels: readonly string[];
  screen: Screen;
  maxViewers: number;
  pats: LivePats;
  video?: LiveVideo;
}

/** Where she is, as the public status says it (`publicStatus` in the api package). */
export function placeOf(snapshot: ActivitySnapshot | null, singing: boolean): LivePresence {
  if (snapshot === null) return { place: singing ? "singing" : "offline", game: null };
  const activity = snapshot.activity;
  const playing =
    activity.type === "game" && (activity.phase === "starting" || activity.phase === "running");
  let place: LivePlace = "idle";
  if (singing) place = "singing";
  else if (playing) place = "playing";
  else if (snapshot.broadcast.type === "live") place = "live";
  else if (snapshot.presence.type === "in") place = "in_voice";
  const target = activity.type === "game" ? activity.target : null;
  const game = playing && target !== null && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(target);
  return { place, game: game ? target : null };
}

/** The end of `text`, at most `MAX_LINE_CHARS` code points. */
function capped(text: string): string {
  const chars = [...text];
  return chars.length <= MAX_LINE_CHARS ? text : `…${chars.slice(-MAX_LINE_CHARS + 1).join("")}`;
}

export class LiveState {
  readonly #channels: ReadonlySet<string>;
  readonly #screen: Screen;
  readonly #maxViewers: number;
  readonly #forwarder: Forwarder;
  readonly #tracker = new ActivityTracker({ textTurns: true });
  readonly #turns = new Map<string, Turn>();
  readonly #lines = new Map<string, LineEntry>();
  readonly #listeners = new Set<(event: LiveEvent) => void>();
  #nextLine = 1;
  #presence: LivePresence = { place: "offline", game: null };
  #activity: LiveActivity | null = null;
  #speaking = false;
  #emotion: LiveEmotion = NEUTRAL;
  #line: LiveLine | null = null;
  #pats: LivePats;
  #video: LiveVideo;
  #snapshot: ActivitySnapshot | null = null;

  constructor(options: LiveStateOptions, now: () => number = Date.now) {
    this.#channels = new Set(options.channels);
    this.#screen = options.screen;
    this.#maxViewers = options.maxViewers;
    this.#pats = options.pats;
    this.#video = options.video ?? { on: false, src: null };
    this.#forwarder = new Forwarder(true, { now });
  }

  snapshot(): LiveSnapshot {
    return {
      presence: { ...this.#presence },
      activity: this.#activity === null ? null : { ...this.#activity },
      speaking: this.#speaking,
      emotion: { ...this.#emotion },
      line: this.#line === null ? null : { ...this.#line },
      pats: { ...this.#pats },
      video: { ...this.#video },
    };
  }

  follow(listener: (event: LiveEvent) => void): (() => void) | null {
    if (this.#listeners.size >= this.#maxViewers) return null;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  viewers(): number {
    return this.#listeners.size;
  }

  #emit(event: LiveEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // One broken page must not stop the others.
        this.#listeners.delete(listener);
      }
    }
  }

  // ---- what she is doing -----------------------------------------------------------------

  /** Her body state changed (or the clock moved on). */
  setPresence(snapshot: ActivitySnapshot | null): void {
    this.#snapshot = snapshot;
    this.#updatePresence();
  }

  #updatePresence(): void {
    const next = placeOf(this.#snapshot, this.#activity?.kind === "singing");
    if (next.place === this.#presence.place && next.game === this.#presence.game) return;
    this.#presence = next;
    this.#emit({ type: "presence", presence: { ...next } });
  }

  setPats(pats: LivePats, patted: boolean, touch?: { spot: LiveSpot; part: LivePart }): void {
    const same = pats.recent === this.#pats.recent && pats.open === this.#pats.open;
    this.#pats = { ...pats };
    if (!patted && same) return;
    this.#emit(
      patted && touch
        ? { type: "pat", pats: { ...pats }, spot: { ...touch.spot }, part: touch.part }
        : { type: "pat", pats: { ...pats } },
    );
  }

  /** OBS started or stopped publishing. */
  setVideo(video: LiveVideo): void {
    if (video.on === this.#video.on && video.src === this.#video.src) return;
    this.#video = { ...video };
    this.#emit({ type: "video", video: { ...video } });
  }

  /** Lets time-based state move on: thinking shows after a moment, turns expire. */
  tick(now: number): void {
    const message = this.#tracker.next(now);
    if (message?.type !== "activity") return;
    const kind = message.kind;
    const next: LiveActivity | null =
      kind === null
        ? null
        : {
            kind,
            label: message.label,
            detail:
              message.detail !== null && this.#screen.moderate(message.detail) === true
                ? message.detail
                : null,
            progress: message.progress,
          };
    const before = this.#activity;
    const same =
      before === next ||
      (before !== null &&
        next !== null &&
        before.kind === next.kind &&
        before.label === next.label &&
        before.detail === next.detail &&
        before.progress === next.progress);
    if (same) return;
    this.#activity = next;
    this.#emit({ type: "activity", activity: next === null ? null : { ...next } });
    this.#updatePresence();
  }

  // ---- the bus ---------------------------------------------------------------------------

  /** One bus event. `now` is the clock of the activity line. */
  onEvent(event: Event, now: number): void {
    const verdict = this.#admit(event);
    if (verdict === "drop") return;
    this.#tracker.onEvent(event, now);
    if (verdict === "track") {
      this.tick(now);
      return;
    }
    for (const message of this.#forwarder.onEvent(event)) {
      switch (message.type) {
        case "subtitle":
          this.#onLine(message.turn, message.text, message.final);
          break;
        case "speaking":
          this.#setSpeaking(message.state === "started");
          break;
        case "emotion":
          this.#setEmotion(message.name, message.intensity);
          break;
        default:
          break;
      }
    }
    this.tick(now);
  }

  #remember(turn: string, entry: Turn): void {
    this.#turns.delete(turn);
    this.#turns.set(turn, entry);
    while (this.#turns.size > MAX_TURNS) {
      const oldest = this.#turns.keys().next().value;
      if (oldest === undefined) break;
      this.#turns.delete(oldest);
    }
  }

  #place(context: ContextKey | null, turn: string | null): boolean {
    if (context !== null) return isPublicPlace(context, this.#channels);
    return turn !== null && this.#turns.get(turn)?.public === true;
  }

  /**
   * Rule 1: `pass` goes to the overlay machinery, `track` only to the activity line (songs),
   * `drop` nowhere.
   */
  #admit(event: Event): "pass" | "track" | "drop" {
    switch (event.type) {
      case "agent_turn_started": {
        const { turn, context } = event.data;
        const open = isPublicPlace(context, this.#channels);
        this.#remember(turn, { public: open, via: context.kind === "voice" ? "voice" : "text" });
        return open ? "pass" : "drop";
      }
      case "agent_turn_completed":
        return isPublicPlace(event.data.context, this.#channels) ? "pass" : "drop";
      case "voice_playback": {
        const { context, turn } = event.data;
        if (!isPublicPlace(context, this.#channels)) return "drop";
        if (turn !== null && !this.#turns.has(turn)) {
          this.#remember(turn, { public: true, via: "voice" });
        }
        // Moderation replaced what she meant: those are not her words reaching anyone.
        return event.data.blocked ? "drop" : "pass";
      }
      case "custom": {
        const { topic, payload } = event.data;
        if (topic === AFFECT_CHANGED_TOPIC) return "pass";
        if (topic === SONG_TOPIC || topic === SONG_PREPARE_TOPIC) return "track";
        if (
          topic === EMOTION_TOPIC ||
          topic === SUBTITLE_TOPIC ||
          topic === VOICE_UPCOMING_TOPIC ||
          topic === SPEECH_SYNTH_TOPIC
        ) {
          return this.#place(payloadContext(payload), payloadTurn(payload)) ? "pass" : "drop";
        }
        return "drop";
      }
      default:
        return "drop";
    }
  }

  // ---- what comes out ----------------------------------------------------------------------

  #setSpeaking(speaking: boolean): void {
    if (speaking === this.#speaking) return;
    this.#speaking = speaking;
    this.#emit({ type: "speaking", speaking });
  }

  #setEmotion(raw: string, rawIntensity: number): void {
    const name = raw.trim().toLowerCase();
    if (!EMOTION_NAME.test(name)) return;
    const intensity = Number.isFinite(rawIntensity) ? Math.min(Math.max(rawIntensity, 0), 1) : 1;
    const last = this.#emotion;
    if (last.name === name && Math.abs(last.intensity - intensity) < INTENSITY_STEP) return;
    this.#emotion = { name, intensity };
    this.#emit({ type: "emotion", emotion: { name, intensity } });
  }

  /** Rule 2, on a line as the overlay would show it. */
  #onLine(turn: string, rawText: string, final: boolean): void {
    // A line without a turn is one playback: its text is all there is to tell it by.
    const key = turn === "" ? `free:${rawText}` : turn;
    let entry = this.#lines.get(key);
    if (!entry) {
      const via = this.#turns.get(turn)?.via ?? "voice";
      entry = {
        line: { id: this.#nextLine++, text: "", final: false, via },
        shown: false,
        withheld: false,
      };
      this.#lines.set(key, entry);
      while (this.#lines.size > MAX_TURNS) {
        const oldest = this.#lines.keys().next().value;
        if (oldest === undefined) break;
        this.#lines.delete(oldest);
      }
    }
    if (entry.withheld) return;
    const text = capped(rawText.trim());
    if (!mayShow(this.#screen, text)) {
      entry.withheld = true;
      if (!entry.shown) return;
      // It was on the page already: take it back.
      this.#publishLine({ ...entry.line, text: "", final: true });
      return;
    }
    if (text === "" && !entry.shown) return;
    entry.shown = entry.shown || text !== "";
    entry.line = { ...entry.line, text, final };
    this.#publishLine(entry.line);
  }

  #publishLine(line: LiveLine): void {
    this.#line = { ...line };
    this.#emit({ type: "line", line: { ...line } });
  }
}
