// Streaming one playback to the node.

import { errorMessage, getLogger } from "@miyoria/kernel";
import type { AudioChunk, AudioStream } from "@miyoria/speech";
import type { PlaybackState } from "@miyoria/types";
import { type CoreMessage, encodeAudio, TAG_LEVELS, TAG_PLAYBACK } from "../protocol.js";
import { deferred, Watch } from "../util.js";
import type { Conn } from "./conn.js";

const log = getLogger("voice.link.playback");

/** Something that is playing and can be cut short (used by barge-in). */
export interface Stoppable {
  stop(fadeMs: number): void;
}

/**
 * How a playback talks to its node beyond the audio: control messages, and whether the node
 * understands them (`play_duck` / `play_pause` are announced in the node's hello `capabilities`).
 */
export interface PlaybackControl {
  send(msg: CoreMessage): void;
  supports(capability: string): boolean;
}

/** Capability names of the node's `hello.capabilities`. */
export const CAP_DUCK = "play_duck";
export const CAP_PAUSE = "play_pause";

/** Handle of one playback started with `VoiceLink.play`. */
export class Playback implements Stoppable {
  readonly id: number;
  readonly #control: PlaybackControl | null;
  readonly #stop = deferred<void>();
  #stopped = false;
  #fadeMs = 0;
  /** When the node said it was audible, and when it stopped being (a stop asked for counts). */
  #startedAt: number | null = null;
  #endedAt: number | null = null;
  /** Barge-in held it: that time is nobody hearing anything. */
  #heldSince: number | null = null;
  #heldMs = 0;
  /** @internal Written by the pump. */
  readonly state$ = new Watch<PlaybackState | null>(null);

  /** @internal Created by `VoiceLink.play`. */
  constructor(id: number, control: PlaybackControl | null = null) {
    this.id = id;
    this.#control = control;
  }

  /**
   * Sets this playback's volume to `gain` (0..1, 1 = normal) over `fadeMs`. Returns whether the
   * node supports it (older nodes do not) and the playback is still running.
   */
  duck(gain: number, fadeMs: number): boolean {
    const c = this.#control;
    if (!c?.supports(CAP_DUCK) || this.#stopped || this.state$.value === "finished") {
      return false;
    }
    c.send({ type: "play_duck", play: this.id, gain, fade_ms: fadeMs });
    return true;
  }

  /**
   * Holds the playback (fading out over `fadeMs`) until `resume`; the audio already sent waits
   * in the node. Returns whether the node supports it.
   */
  pause(fadeMs: number): boolean {
    const c = this.#control;
    if (!c?.supports(CAP_PAUSE) || this.#stopped) return false;
    c.send({ type: "play_pause", play: this.id, fade_ms: fadeMs });
    this.#heldSince ??= Date.now();
    return true;
  }

  /** Continues a paused playback, fading in over `fadeMs`. */
  resume(fadeMs: number): boolean {
    const c = this.#control;
    if (!c?.supports(CAP_PAUSE) || this.#stopped) return false;
    c.send({ type: "play_resume", play: this.id, fade_ms: fadeMs });
    this.#release(Date.now());
    return true;
  }

  #release(now: number): void {
    if (this.#heldSince !== null) this.#heldMs += now - this.#heldSince;
    this.#heldSince = null;
  }

  /** How long it was audible, in ms: from the node's `started` to its end, holds left out. */
  heardMs(): number {
    if (this.#startedAt === null) return 0;
    const end = this.#endedAt ?? Date.now();
    const held = this.#heldMs + (this.#heldSince === null ? 0 : end - this.#heldSince);
    return Math.max(end - this.#startedAt - held, 0);
  }

  /** @internal The pump's report of where the playback is. */
  advance(state: PlaybackState): void {
    const now = Date.now();
    if (state === "started") this.#startedAt ??= now;
    else this.#endedAt ??= now;
    this.state$.set(state);
  }

  /**
   * Stops the playback, fading out over `fadeMs`. It then ends as `interrupted` (unless it
   * already ended).
   */
  stop(fadeMs: number): void {
    if (this.#stopped) return;
    this.#fadeMs = fadeMs;
    this.#stopped = true;
    this.#endedAt ??= Date.now();
    this.#stop.resolve();
  }

  /** @internal */
  get stopRequested(): boolean {
    return this.#stopped;
  }

  /** @internal */
  get stopping(): Promise<void> {
    return this.#stop.promise;
  }

  /** @internal */
  get fadeMs(): number {
    return this.#fadeMs;
  }

  /** The latest state: `null` until the node reports `started`. */
  state(): PlaybackState | null {
    return this.state$.value;
  }

  /** Waits until the playback finished, was interrupted or failed. */
  async wait(): Promise<PlaybackState> {
    const s = await this.state$.waitFor((s) => s !== null && s !== "started");
    return s ?? "failed";
  }
}

type Next = { ok: true; result: IteratorResult<AudioChunk> } | { ok: false; error: unknown };

/**
 * A chunk with an optional levels track of the same length (plays started with `levels`): sent
 * as `0x03` frames, each before the `0x02` frame it goes with.
 */
export type LeveledChunk = AudioChunk & { levels?: Int16Array };

/** Starts streaming `audio` to the node. `play_start` has already been sent. */
export function startPlayback(
  conn: Conn,
  id: number,
  sampleRate: number,
  audio: AudioStream | AsyncIterable<LeveledChunk>,
  node: Watch<PlaybackState | null>,
  control: PlaybackControl | null = null,
): Playback {
  const playback = new Playback(id, control);
  void pump(conn, playback, sampleRate, audio, node)
    .catch((error: unknown) => {
      log.warn({ play: id, err: errorMessage(error) }, "playback pump failed");
      return "failed" as const;
    })
    .then((end) => {
      conn.state.plays.delete(id);
      log.debug({ play: id, state: end }, "playback ended");
      playback.advance(end);
    });
  return playback;
}

async function pump(
  conn: Conn,
  playback: Playback,
  sampleRate: number,
  audio: AsyncIterable<LeveledChunk>,
  node: Watch<PlaybackState | null>,
): Promise<PlaybackState> {
  const id = playback.id;
  // 100 ms frames keep play_stop responsive without flooding the socket.
  const frameLen = Math.max(1, Math.floor(sampleRate / 10));
  const it = audio[Symbol.asyncIterator]();
  let sending = true;
  let pending: Promise<Next> | null = null;
  let settled: Next | null = null;
  let seen = node.version;
  const stopPlay = (fadeMs: number) =>
    conn.sendJson({ type: "play_stop", play: id, fade_ms: fadeMs }).catch(() => undefined);
  try {
    for (;;) {
      if (sending && pending === null) {
        settled = null;
        pending = it.next().then(
          (result): Next => {
            settled = { ok: true, result };
            return settled;
          },
          (error: unknown): Next => {
            settled = { ok: false, error };
            return settled;
          },
        );
      }
      const ready =
        playback.stopRequested || conn.isClosed || node.version !== seen || settled !== null;
      if (!ready) {
        await Promise.race([
          playback.stopping,
          conn.closing,
          node.changed(),
          ...(pending !== null ? [pending] : []),
        ]);
      }
      // Same priority as the legacy `biased` select.
      if (playback.stopRequested) {
        await stopPlay(playback.fadeMs);
        return "interrupted";
      }
      if (conn.isClosed) return "failed";
      if (node.version !== seen) {
        seen = node.version;
        const state = node.value;
        if (state === "started") playback.advance("started");
        else if (state !== null) return state;
        continue;
      }
      const next = settled as Next | null;
      if (next === null) continue;
      pending = null;
      settled = null;
      if (!next.ok) {
        log.warn({ play: id, err: errorMessage(next.error) }, "audio stream failed");
        await stopPlay(0);
        return "failed";
      }
      if (next.result.done) {
        sending = false;
        try {
          await conn.sendJson({ type: "play_end", play: id });
        } catch {
          return "failed";
        }
        continue;
      }
      const chunk: LeveledChunk = next.result.value;
      if (chunk.sampleRate !== sampleRate) {
        log.warn(
          { play: id, expected: sampleRate, got: chunk.sampleRate },
          "audio chunk has a different sample rate",
        );
        await stopPlay(0);
        return "failed";
      }
      for (let at = 0; at < chunk.samples.length; at += frameLen) {
        const frame = chunk.samples.subarray(at, at + frameLen);
        try {
          if (chunk.levels) {
            await conn.send(encodeAudio(TAG_LEVELS, id, chunk.levels.subarray(at, at + frameLen)));
          }
          await conn.send(encodeAudio(TAG_PLAYBACK, id, frame));
        } catch {
          return "failed";
        }
      }
    }
  } finally {
    // Releases the TTS stream (e.g. cancels the HTTP response) without waiting for it.
    Promise.resolve(it.return?.()).catch(() => undefined);
  }
}
