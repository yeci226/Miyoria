// Per-guild playback queue: one playback at a time, the rest wait their turn.
//
// This is a pure state machine. The thing that actually makes sound is behind {@link PlayerPort}
// (a real @discordjs/voice AudioPlayer in production, a fake in tests).
//
//   start() -> queued ──(head of queue)──> waiting ──(prebuffered / input ended)──> playing ──> done
//
// Events emitted per play id: started (once audible) and exactly one terminal state
// (finished | interrupted | failed).
import type { Logger } from "../log.js";
import { noopLogger } from "../log.js";
import type { PlaybackState } from "../protocol.js";
import type { PlaybackSource } from "./source.js";

export interface PlayerHooks {
  /** Audio is audible. Call at most once per play. */
  started(): void;
  /** Playback is over (for any reason, including a stop). `error` if it ended abnormally. */
  ended(error?: Error): void;
}

export interface PlayerPort {
  /** Start pulling frames from `source`. Must eventually call `hooks.ended`. */
  play(source: PlaybackSource, hooks: PlayerHooks): void;
  /** Stop immediately. Should lead to `hooks.ended` (if it does not, the queue still cleans up on `clear`). */
  stop(): void;
}

export interface PlaybackEvent {
  play: number;
  state: PlaybackState;
  error?: string;
}

export interface QueueOptions {
  port: PlayerPort;
  onEvent: (ev: PlaybackEvent) => void;
  /** Builds the source for a new play. */
  createSource: (sampleRate: number) => PlaybackSource;
  /** Max plays waiting behind the active one. */
  maxQueued?: number;
  log?: Logger;
}

type EntryState = "queued" | "waiting" | "playing" | "done";

interface Entry {
  play: number;
  source: PlaybackSource;
  state: EntryState;
  startedReported: boolean;
  stopRequested: boolean;
  failsafe?: ReturnType<typeof setTimeout>;
}

export type StartResult = { ok: true } | { ok: false; error: string };

/** Extra time past `fade_ms` we wait for the fade to complete before cutting the player. */
const FADE_GRACE_MS = 750;

export class PlaybackQueue {
  private readonly port: PlayerPort;
  private readonly onEvent: (ev: PlaybackEvent) => void;
  private readonly createSource: (sampleRate: number) => PlaybackSource;
  private readonly maxQueued: number;
  private readonly log: Logger;
  private readonly entries: Entry[] = []; // [0] is the active one (waiting | playing)

  constructor(opts: QueueOptions) {
    this.port = opts.port;
    this.onEvent = opts.onEvent;
    this.createSource = opts.createSource;
    this.maxQueued = opts.maxQueued ?? 16;
    this.log = opts.log ?? noopLogger;
  }

  has(play: number): boolean {
    return this.find(play) !== undefined;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Id of the play that is currently active (waiting for prebuffer or playing). */
  get activeId(): number | undefined {
    return this.entries[0]?.play;
  }

  /** `levels`: the play comes with a levels track ({@link pushLevels}) for lip sync. */
  start(play: number, sampleRate: number, levels = false): StartResult {
    if (this.find(play)) return { ok: false, error: `play ${play} already exists` };
    if (this.entries.length > this.maxQueued) return { ok: false, error: "playback queue is full" };
    const source = this.createSource(sampleRate);
    if (levels) source.enableLevels();
    this.entries.push({ play, source, state: "queued", startedReported: false, stopRequested: false });
    this.pump();
    return { ok: true };
  }

  /** Appends PCM for a play. Unknown / finished plays are ignored (returns false). */
  push(play: number, pcm: Uint8Array): boolean {
    const e = this.find(play);
    if (!e) return false;
    const r = e.source.write(pcm);
    if (r === "overflow" && e.state !== "playing") {
      // Overflow before the playback even began: fail now instead of waiting for a pull.
      this.finishEntry(e, "failed", "audio buffer limit exceeded");
      return false;
    }
    if (e.state === "waiting") this.tryBegin(e);
    return r === "ok";
  }

  /** Appends to a play's levels track. Unknown plays are ignored. */
  pushLevels(play: number, pcm: Uint8Array): void {
    this.find(play)?.source.writeLevels(pcm);
  }

  /** Core has no more audio for this play. */
  end(play: number): void {
    const e = this.find(play);
    if (!e) return;
    e.source.end();
    if (e.state === "waiting") this.tryBegin(e);
  }

  /** Barge-in. `fadeMs` > 0 fades the active playback out; queued ones are just dropped. */
  stop(play: number, fadeMs: number): void {
    const e = this.find(play);
    if (!e) return;
    e.stopRequested = true;
    if (e.state === "queued" || e.state === "waiting") {
      e.source.abort();
      this.finishEntry(e, "interrupted");
      return;
    }
    if (fadeMs > 0) e.source.fadeOut(fadeMs);
    else {
      e.source.abort();
      this.port.stop();
    }
    // Safety net: the stop / fade normally completes by itself as the player pulls frames and
    // reports `ended`. This only matters for a player that stopped pulling (e.g. paused because
    // the voice connection dropped).
    e.failsafe = setTimeout(() => {
      e.failsafe = undefined;
      if (e.state !== "done") {
        this.log.warn(`play ${play}: stop did not complete, cutting`);
        e.source.abort();
        this.port.stop();
        this.finishEntry(e, "interrupted");
      }
    }, fadeMs + FADE_GRACE_MS);
    e.failsafe.unref?.();
  }

  /** Ducking: sets the volume of a play (0..1) with a ramp. Unknown plays are ignored. */
  duck(play: number, gain: number, fadeMs: number): void {
    const e = this.find(play);
    if (e && !e.stopRequested) e.source.setGain(gain, fadeMs);
  }

  /**
   * Holds a play (fading out first). A paused play that never resumes ends by itself, see
   * {@link SourceOptions.maxPauseMs}.
   */
  pause(play: number, fadeMs: number): void {
    const e = this.find(play);
    if (e && !e.stopRequested) e.source.pause(fadeMs);
  }

  resume(play: number, fadeMs: number): void {
    const e = this.find(play);
    if (e && !e.stopRequested) e.source.resume(fadeMs);
  }

  /** Drops everything (leaving the channel, connection lost). Active + queued all report `interrupted` (or `failed` with `error`). */
  clear(error?: string): void {
    const all = this.entries.slice();
    const hadActivePlayer = all[0]?.state === "playing";
    for (const e of all) {
      e.source.abort();
      this.finishEntry(e, error ? "failed" : "interrupted", error, /* pump */ false);
    }
    if (hadActivePlayer) this.port.stop();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private find(play: number): Entry | undefined {
    return this.entries.find((e) => e.play === play);
  }

  private pump(): void {
    const head = this.entries[0];
    if (head?.state !== "queued") return;
    head.state = "waiting";
    this.tryBegin(head);
  }

  private tryBegin(e: Entry): void {
    if (e.state !== "waiting" || !e.source.canStart()) return;
    e.state = "playing";
    const hooks: PlayerHooks = {
      started: () => {
        if (e.state === "done" || e.startedReported) return;
        e.startedReported = true;
        this.onEvent({ play: e.play, state: "started" });
      },
      ended: (error) => this.onPlayerEnded(e, error),
    };
    try {
      this.port.play(e.source, hooks);
    } catch (err) {
      this.finishEntry(e, "failed", err instanceof Error ? err.message : String(err));
    }
  }

  private onPlayerEnded(e: Entry, error?: Error): void {
    if (e.state === "done") return;
    if (error) {
      this.finishEntry(e, "failed", error.message);
      return;
    }
    switch (e.source.endReason) {
      case "drained":
        this.finishEntry(e, "finished");
        break;
      case "starved":
        this.finishEntry(e, "failed", "timed out waiting for audio from Core");
        break;
      case "overflow":
        this.finishEntry(e, "failed", "audio buffer limit exceeded");
        break;
      default:
        // Also covers the player going idle without the source ending (connection lost, etc.).
        this.finishEntry(e, "interrupted");
    }
  }

  private finishEntry(e: Entry, state: PlaybackState, error?: string, pump = true): void {
    if (e.state === "done") return;
    const wasHead = this.entries[0] === e;
    e.state = "done";
    if (e.failsafe) clearTimeout(e.failsafe);
    const idx = this.entries.indexOf(e);
    if (idx >= 0) this.entries.splice(idx, 1);
    // A play that finished normally must have been reported as started first.
    if (state === "finished" && !e.startedReported) {
      e.startedReported = true;
      this.onEvent({ play: e.play, state: "started" });
    }
    const ev: PlaybackEvent = { play: e.play, state };
    if (error !== undefined) ev.error = error;
    this.onEvent(ev);
    if (pump && wasHead) this.pump();
  }
}
