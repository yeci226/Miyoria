// The karaoke scene as the round's player: the backing and the relayed singer's voice come out of
// this page, which OBS mixes into the stream (`reroute_audio`). Her own voice is not here: she
// talks in the voice channel, and the sound dips under her lines (`duck_gain`) so they stay clear
// for people who hear both.
//
// One Web Audio context per round. Song time `s` plays at `base + s` on its clock (karaoke-audio.ts);
// the base comes from the song clock and is set again, the backing restarted at its place, only
// when the two are more than 150 ms apart. While the context runs, the lyrics, the wipe and the
// video follow the audio clock (`songMs`), so they match what is heard. A context the browser
// holds back (no autoplay outside OBS) starts on the first click or key; until then the page runs
// on the song clock.

import {
  anchorBase,
  audioSongMs,
  base64Bytes,
  DUCK_ATTACK_S,
  DUCK_RELEASE_S,
  decodeMulaw,
  duckedGain,
  needsReanchor,
  pcm16le,
  placeSound,
  VOICE_AHEAD_S,
  VOICE_RATE,
} from "./karaoke-audio.js";
import type { KaraokeAir, KaraokeBacking, KaraokeVoice } from "./feed.js";

/** How fast a change of the owner's gains reaches the sound (s). */
const GAIN_CHANGE_S = 0.05;

interface Round {
  key: string;
  ctx: AudioContext;
  backingGain: GainNode;
  voiceGain: GainNode;
  /** Song time 0 on the context's clock, once known. */
  base: number | null;
  backing: AudioBuffer | null;
  backingUrl: string | null;
  backingSource: AudioBufferSourceNode | null;
  voices: Set<AudioBufferSourceNode>;
  loading: AbortController | null;
  unlock: (() => void) | null;
}

export class KaraokePlayer {
  #round: Round | null = null;
  #air: KaraokeAir | null = null;
  #speaking = false;

  /**
   * `clock`: the song time (ms) by the song clock, or `null` outside a round. `onHeld`: whether
   * the browser holds the sound back until someone clicks.
   */
  constructor(
    private readonly clock: () => number | null,
    private readonly onHeld: (held: boolean) => void = () => {},
  ) {}

  /** The round to play (`<room>-<round>`), or `null`: nothing plays (the round is over, or none). */
  play(key: string | null): void {
    if (key === this.#round?.key) return;
    this.close();
    if (key === null || typeof AudioContext !== "function") return;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ latencyHint: "playback" });
    } catch {
      return;
    }
    const backingGain = ctx.createGain();
    const voiceGain = ctx.createGain();
    backingGain.connect(ctx.destination);
    voiceGain.connect(ctx.destination);
    const round: Round = {
      key,
      ctx,
      backingGain,
      voiceGain,
      base: null,
      backing: null,
      backingUrl: null,
      backingSource: null,
      voices: new Set(),
      loading: null,
      unlock: null,
    };
    this.#round = round;
    this.#applyGains(0);
    ctx.addEventListener("statechange", () => {
      if (this.#round !== round) return;
      this.onHeld(ctx.state === "suspended");
      // The clock stood still while it was held: start over from the song clock.
      if (ctx.state === "running") this.#anchor(round);
    });
    if (ctx.state === "suspended") {
      this.onHeld(true);
      const unlock = (): void => {
        void ctx.resume().catch(() => undefined);
      };
      round.unlock = unlock;
      window.addEventListener("pointerdown", unlock);
      window.addEventListener("keydown", unlock);
    }
    this.sync();
  }

  /** The owner's gains and what plays (`air` of the scene). */
  air(air: KaraokeAir): void {
    this.#air = air;
    this.#applyGains(GAIN_CHANGE_S);
  }

  /** She started or stopped speaking: the sound dips under her lines. */
  speaking(on: boolean): void {
    if (on === this.#speaking) return;
    this.#speaking = on;
    this.#applyGains(on ? DUCK_ATTACK_S : DUCK_RELEASE_S);
  }

  /** The round's backing (fetched and decoded once per URL); `null`: none. */
  backing(backing: KaraokeBacking | null): void {
    const round = this.#round;
    if (round === null || (backing?.url ?? null) === round.backingUrl) return;
    round.loading?.abort();
    round.backingSource?.stop();
    round.backingSource = null;
    round.backing = null;
    round.backingUrl = backing?.url ?? null;
    if (backing === null) return;
    const loading = new AbortController();
    round.loading = loading;
    void load(round.ctx, backing, loading.signal).then(
      (buffer) => {
        if (this.#round !== round || loading.signal.aborted) return;
        round.backing = buffer;
        this.#startBacking(round);
      },
      () => {
        // Not playable here: the round goes on with the voice alone.
      },
    );
  }

  /** A piece of the relayed voice; dropped unless it is this round's and has time left. */
  voice(piece: KaraokeVoice): void {
    const round = this.#round;
    if (round === null || `${piece.room}-${piece.round}` !== round.key) return;
    if (round.base === null) this.sync();
    if (round.base === null || round.ctx.state !== "running") return;
    let samples: Float32Array<ArrayBuffer>;
    try {
      samples = decodeMulaw(base64Bytes(piece.audio));
    } catch {
      return;
    }
    if (samples.length === 0) return;
    const place = placeSound({
      base: round.base,
      startS: piece.atMs / 1000,
      duration: samples.length / VOICE_RATE,
      now: round.ctx.currentTime,
      maxAheadS: VOICE_AHEAD_S,
    });
    if (place === null) return;
    const buffer = round.ctx.createBuffer(1, samples.length, VOICE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = round.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(round.voiceGain);
    source.addEventListener("ended", () => round.voices.delete(source));
    round.voices.add(source);
    source.start(place.when, place.offset);
  }

  /**
   * Checks the audio clock against the song clock (on every scene frame): set when unknown, set
   * again and the sound restarted when they are too far apart; small differences leave it alone.
   */
  sync(): void {
    const round = this.#round;
    if (round === null || round.ctx.state !== "running") return;
    const clockMs = this.clock();
    if (clockMs === null) return;
    if (round.base !== null && !needsReanchor(audioSongMs(round.ctx.currentTime, round.base), clockMs)) {
      return;
    }
    this.#anchor(round);
  }

  /** The song time (ms) by the audio clock while the round's sound runs; else `null`. */
  songMs(): number | null {
    const round = this.#round;
    if (round === null || round.base === null || round.ctx.state !== "running") return null;
    return audioSongMs(round.ctx.currentTime, round.base);
  }

  /** Stops every sound and lets the context go. */
  close(): void {
    const round = this.#round;
    this.#round = null;
    if (round === null) return;
    round.loading?.abort();
    if (round.unlock !== null) {
      window.removeEventListener("pointerdown", round.unlock);
      window.removeEventListener("keydown", round.unlock);
    }
    for (const source of [round.backingSource, ...round.voices]) {
      try {
        source?.stop();
      } catch {
        // Never started.
      }
    }
    round.voices.clear();
    void round.ctx.close().catch(() => undefined);
    this.onHeld(false);
  }

  /** Song time on the audio clock from the song clock now; the backing starts over at its place. */
  #anchor(round: Round): void {
    const clockMs = this.clock();
    if (clockMs === null || round.ctx.state !== "running") return;
    round.base = anchorBase(round.ctx.currentTime, clockMs);
    // Voice pieces already placed belong to the old time: the next ones come within a second.
    for (const source of round.voices) {
      try {
        source.stop();
      } catch {
        // Never started.
      }
    }
    round.voices.clear();
    this.#startBacking(round);
  }

  #startBacking(round: Round): void {
    if (round.backingSource !== null) {
      try {
        round.backingSource.stop();
      } catch {
        // Never started.
      }
      round.backingSource = null;
    }
    if (round.backing === null || round.base === null || round.ctx.state !== "running") return;
    const place = placeSound({
      base: round.base,
      startS: 0,
      duration: round.backing.duration,
      now: round.ctx.currentTime,
    });
    if (place === null) return;
    const source = round.ctx.createBufferSource();
    source.buffer = round.backing;
    source.connect(round.backingGain);
    source.start(place.when, place.offset);
    round.backingSource = source;
  }

  /** Sets both gains (ducked while she speaks), reaching them over `seconds`. */
  #applyGains(seconds: number): void {
    const round = this.#round;
    if (round === null) return;
    const air = this.#air;
    const duck = air?.duckGain ?? 1;
    const backing = air?.backing ? duckedGain(air.backingGain, duck, this.#speaking) : 0;
    const voice = air ? duckedGain(air.voiceGain, duck, this.#speaking) : 0;
    const now = round.ctx.currentTime;
    for (const [param, value] of [
      [round.backingGain.gain, backing],
      [round.voiceGain.gain, voice],
    ] as const) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      if (seconds <= 0) param.setValueAtTime(value, now);
      else param.linearRampToValueAtTime(value, now + seconds);
    }
  }
}

/** Fetches and decodes a backing: raw s16le into a buffer as it is, AAC through the browser. */
async function load(ctx: AudioContext, backing: KaraokeBacking, signal: AbortSignal): Promise<AudioBuffer> {
  const res = await fetch(backing.url, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`backing: ${res.status}`);
  const data = await res.arrayBuffer();
  if (backing.format === "m4a") return ctx.decodeAudioData(data);
  const samples = pcm16le(data);
  const buffer = ctx.createBuffer(1, Math.max(samples.length, 1), backing.rate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}
