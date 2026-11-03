// The lyrics card: one message while she sings (where she last typed on that server, else the
// voice channel's text chat; only for songs with synced lyrics). It shows the
// song, the current lyrics line and the progress, and is edited in place: at most once every
// MIN_EDIT_MS (Discord allows about 5 edits per 5 s per channel), only the newest state, one
// request at a time. When the song ends it is edited a last time and left as a record.

import type { Logger } from "@miyoria/kernel";
import type { Clock, ContextKey, MessageRef, PlatformSink, SongCue } from "@miyoria/types";
import type { SongMeta } from "./client.js";

/** Shortest gap between two writes (send or edit) of one card. */
export const MIN_EDIT_MS = 1500;
/** How often the progress is refreshed when no new line comes. */
export const PROGRESS_MS = 10_000;
/** Longest piece of untrusted text (title, artist, line) on the card, in characters. */
const MAX_TEXT = 200;

export interface CardView {
  title: string;
  artist: string | null;
  /** The current line; `null` between lines (instrumental) or without lyrics. */
  line: string | null;
  lyrics: "synced" | "none";
  elapsedMs: number;
  durationMs: number | null;
  ended: "finished" | "stopped" | null;
}

/** One line, at most MAX_TEXT characters, with Discord markdown and mentions made literal. */
function plain(text: string): string {
  const flat = [...text.replace(/\s+/g, " ").trim()].slice(0, MAX_TEXT).join("");
  return flat.replace(/[\\`*_~|>#\-[\]<]/g, "\\$&");
}

function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function renderCard(view: CardView): string {
  const artist = view.artist === null ? "" : plain(view.artist);
  const head = `**${plain(view.title) || "?"}**${artist === "" ? "" : ` — ${artist}`}`;
  if (view.ended === "finished") return `✅ 唱完了:${head}`;
  if (view.ended === "stopped") return `⏹️ 沒唱完:${head}`;
  const line = view.line === null ? "" : plain(view.line);
  const shown = line !== "" ? line : view.lyrics === "none" ? "(沒找到歌詞)" : "🎶";
  const progress =
    view.durationMs === null
      ? clockText(view.elapsedMs)
      : `${clockText(view.elapsedMs)} / ${clockText(view.durationMs)}`;
  return `🎵 ${head}\n## ${shown}\n\`${progress}\``;
}

export interface LyricsCardDeps {
  sink: Pick<PlatformSink, "send" | "edit">;
  context: ContextKey;
  song: SongMeta;
  clock: Clock;
  log: Logger;
}

/**
 * The card of one song. Feed it the song's cues; it sends on `started`, edits on lines, the
 * progress and `ended`, and gives up for good (one warning) when a write fails.
 */
export class LyricsCard {
  readonly #d: LyricsCardDeps;
  #started = false;
  #startedAt = 0;
  #offsetMs = 0;
  #durationMs: number | null;
  #line: string | null = null;
  #ended: CardView["ended"] = null;
  #ref: MessageRef | null = null;
  #lastWriteAt = Number.NEGATIVE_INFINITY;
  #dirty = false;
  #inFlight = false;
  #dead = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #progress: ReturnType<typeof setTimeout> | null = null;

  constructor(d: LyricsCardDeps) {
    this.#d = d;
    this.#durationMs = d.song.duration_s === null ? null : d.song.duration_s * 1000;
  }

  /** Never throws and never waits: writes happen on their own schedule. */
  onCue(cue: SongCue): void {
    if (this.#dead || this.#ended !== null) return;
    switch (cue.state) {
      case "started":
        if (this.#started) return;
        this.#started = true;
        this.#startedAt = this.#d.clock.now();
        this.#offsetMs = cue.offset_ms ?? 0;
        if (cue.duration_ms !== undefined) this.#durationMs = cue.duration_ms;
        this.#send();
        return;
      case "line":
        if (!this.#started) return;
        this.#line = cue.text;
        this.#schedule();
        return;
      case "ended":
        if (!this.#started) return;
        this.#ended = cue.outcome === "finished" ? "finished" : "stopped";
        this.#clearProgress();
        this.#schedule();
        return;
    }
  }

  #view(): CardView {
    const lyrics = this.#d.song.lyrics;
    return {
      title: this.#d.song.title,
      artist: this.#d.song.artist,
      line: this.#line,
      lyrics: lyrics?.synced && lyrics.lines.length > 0 ? "synced" : "none",
      elapsedMs: this.#d.clock.now() - this.#startedAt + this.#offsetMs,
      durationMs: this.#durationMs,
      ended: this.#ended,
    };
  }

  #send(): void {
    this.#inFlight = true;
    this.#lastWriteAt = this.#d.clock.now();
    const text = renderCard(this.#view());
    this.#d.sink.send(this.#d.context, { text, reply_to: null }).then(
      (ref) => {
        this.#inFlight = false;
        if (this.#dead) return;
        this.#ref = ref;
        this.#afterWrite();
      },
      (error: unknown) => this.#fail("sending the lyrics card", error),
    );
  }

  /** Marks the card out of date and writes it as soon as the pacing allows. */
  #schedule(): void {
    this.#dirty = true;
    if (this.#dead || this.#ref === null || this.#inFlight || this.#timer !== null) return;
    const wait = this.#lastWriteAt + MIN_EDIT_MS - this.#d.clock.now();
    if (wait <= 0) {
      this.#edit();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#edit();
    }, wait);
  }

  #edit(): void {
    const edit = this.#d.sink.edit;
    if (this.#dead || this.#ref === null || !this.#dirty) return;
    if (!edit) {
      this.#fail("editing the lyrics card", new Error("this platform cannot edit messages"));
      return;
    }
    this.#dirty = false;
    this.#inFlight = true;
    this.#lastWriteAt = this.#d.clock.now();
    const text = renderCard(this.#view());
    edit.call(this.#d.sink, this.#ref, text).then(
      () => {
        this.#inFlight = false;
        this.#afterWrite();
      },
      (error: unknown) => this.#fail("editing the lyrics card", error),
    );
  }

  /** After a write: the last one retires the card; otherwise keep the progress ticking. */
  #afterWrite(): void {
    if (this.#dead) return;
    if (this.#ended !== null && !this.#dirty) {
      this.#retire();
      return;
    }
    if (this.#dirty) this.#schedule();
    if (this.#ended === null) {
      this.#clearProgress();
      this.#progress = setTimeout(() => {
        this.#progress = null;
        this.#schedule();
      }, PROGRESS_MS);
    }
  }

  #fail(what: string, error: unknown): void {
    this.#inFlight = false;
    if (this.#dead) return;
    this.#retire();
    this.#d.log.warn({ err: error }, `${what} failed; no lyrics card for this song`);
  }

  #retire(): void {
    this.#dead = true;
    this.#clearProgress();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #clearProgress(): void {
    if (this.#progress !== null) clearTimeout(this.#progress);
    this.#progress = null;
  }
}
