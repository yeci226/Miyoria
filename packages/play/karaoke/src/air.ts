// What her stream plays of a karaoke round (docs/design/karaoke.md 「做了什麼第五步」): the
// stream's karaoke scene (the overlay in OBS, whose audio Go Live carries) plays the backing and at
// most one singer's voice; her own voice connection carries none of it (she is not the one
// singing). This file is Core's side of the voice: whose it is, and a steady, gap-free stream of it
// on the room's one fixed delay.
//
// * Source: the µ-law 16 kHz chunks each singer's browser already streams for the live score
//   (`RoomDesk.audio`), placed on the backing's time by the singer's device latency (the same
//   `latency_ms` the score takes off). Only in memory, zeroed when dropped; never stored, never
//   logged.
// * One delay for the round (`stream_delay_ms`): the stream plays song time `t` at
//   `start_at + delay`. The mix of `t` is sent `AIR_LEAD_MS` before that, so a singer's audio for
//   `t` must reach Core by `start_at + t + delay − AIR_LEAD_MS`. What comes later is dropped (that
//   stretch is silence); the delay never grows, and a switch of singer never moves the backing.
// * Whose voice (`AirPicker`): a round's one singer who asked for it; with two or more, the
//   best-ranked singer who allows it, once they have led for `hold` (a brief swap changes nothing),
//   switched in a gap between lyric lines when one comes within `GAP_WINDOW_MS`, with a crossfade.
//   Before any score, the first singer (in joining order) who allows it.

import { KARAOKE_VOICE_RATE } from "@miyoria/contracts/stage-link";
import { toBase64 } from "./score/index.js";

/** The mix of song time `t` is sent this long before the stream plays it (bus, stage link, page). */
export const AIR_LEAD_MS = 500;
/** At most this much mixed audio in one piece. */
const MAX_PIECE_MS = 1_000;
/** A singer whose audio has not come for this long is not put on (or is taken off). */
export const AIR_QUIET_MS = 3_000;
/** A switch waits for a gap between lyric lines at most this long (song time). */
export const GAP_WINDOW_MS = 3_000;
/** Audio this far past the mix is not taken (a clock that is far off). */
const MAX_AHEAD_MS = 15_000;
/** Samples per buffer block (100 ms). */
const BLOCK = KARAOKE_VOICE_RATE / 10;
/** Delay samples kept per singer for the figure in the log. */
const DELAYS_KEPT = 40;

// ---- G.711 µ-law ------------------------------------------------------------------------------

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32_635;

/** The linear value of each µ-law byte (ITU-T G.711). */
export const MULAW_TABLE: Int16Array = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
    t[i] = sign ? -magnitude : magnitude;
  }
  return t;
})();

export function mulawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = MULAW_TABLE[bytes[i] as number] as number;
  return out;
}

export function mulawEncodeSample(sample: number): number {
  let s = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  s = Math.min(s, MULAW_CLIP) + MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// ---- one singer's voice on song time ----------------------------------------------------------

/** A singer's decoded voice by song sample (16 kHz), in 100 ms blocks; nothing before the mix. */
export class VoiceBuffer {
  readonly #blocks = new Map<number, Int16Array>();
  /** Wall time the last audio came, or `null`. */
  heardAt: number | null = null;
  /** Samples that came after their place was mixed (dropped as late). */
  late = 0;
  /** Recent path delays (ms): how long after its sung moment the audio was here. */
  readonly delays: number[] = [];

  /**
   * Puts `pcm` with its first sample at song sample `at`, where the mix is at `cursor`: what is
   * before the cursor is late and dropped, what is absurdly far ahead is not taken.
   */
  put(at: number, pcm: Int16Array, cursor: number, now: number, delayMs: number): void {
    this.heardAt = now;
    this.delays.push(delayMs);
    if (this.delays.length > DELAYS_KEPT) this.delays.shift();
    const limit = cursor + (MAX_AHEAD_MS * KARAOKE_VOICE_RATE) / 1000;
    for (let i = 0; i < pcm.length; i++) {
      const s = at + i;
      if (s < cursor) {
        this.late++;
        continue;
      }
      if (s < 0 || s >= limit) continue;
      const b = Math.floor(s / BLOCK);
      let block = this.#blocks.get(b);
      if (block === undefined) {
        block = new Int16Array(BLOCK);
        this.#blocks.set(b, block);
      }
      block[s - b * BLOCK] = pcm[i] as number;
    }
    pcm.fill(0);
  }

  /** The sample at song sample `s` (0 where nothing came). */
  at(s: number): number {
    const b = Math.floor(s / BLOCK);
    return this.#blocks.get(b)?.[s - b * BLOCK] ?? 0;
  }

  /** Forgets (and zeroes) everything before song sample `s`. */
  dropBefore(s: number): void {
    const keep = Math.floor(s / BLOCK);
    for (const [b, block] of this.#blocks) {
      if (b < keep) {
        block.fill(0);
        this.#blocks.delete(b);
      }
    }
  }

  clear(): void {
    for (const block of this.#blocks.values()) block.fill(0);
    this.#blocks.clear();
  }

  /** The 90th percentile of the recent path delays (ms), or `null`. */
  delay(): number | null {
    if (this.delays.length === 0) return null;
    const sorted = [...this.delays].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? null;
  }
}

// ---- whose voice ------------------------------------------------------------------------------

/** One singer as the picker sees them. */
export interface AirSinger {
  key: string;
  /** Allows their voice out now (asked for it alone, or did not opt out of the leader's) and is heard. */
  eligible: boolean;
  total: number;
  /** Joining order (the pick before any score). */
  order: number;
}

/** What the picker wants: the voice to have on, and whether to wait for a gap between lines. */
export interface AirWish {
  target: string | null;
  /** Switch at the next gap between lyric lines (else at once). */
  gap: boolean;
}

/**
 * Picks the voice. Solo: the singer while they allow it. Two or more: before any score the first
 * who allows it; then the best total among those who allow it, once they have been best for
 * `holdMs` without a break; on a tie the voice on now stays. A voice that is no longer allowed (or
 * heard) goes at once, to the best allowed one.
 */
export class AirPicker {
  readonly #holdMs: number;
  readonly #solo: boolean;
  #candidate: { key: string; since: number } | null = null;

  constructor(holdMs: number, solo: boolean) {
    this.#holdMs = holdMs;
    this.#solo = solo;
  }

  pick(now: number, current: string | null, singers: readonly AirSinger[]): AirWish {
    const allowed = singers.filter((s) => s.eligible);
    if (this.#solo) return { target: allowed[0]?.key ?? null, gap: false };
    const scored = singers.some((s) => s.total > 0);
    const byOrder = [...allowed].sort((a, b) => a.order - b.order);
    const best = [...allowed].sort((a, b) => b.total - a.total || a.order - b.order)[0];
    const on = allowed.find((s) => s.key === current);
    if (on === undefined) {
      // Nobody on, or the voice on may not be any more: the best allowed now (no hold).
      this.#candidate = null;
      const next = scored ? best : byOrder[0];
      return { target: next?.key ?? null, gap: false };
    }
    if (!scored || best === undefined || best.key === on.key || best.total <= on.total) {
      this.#candidate = null;
      return { target: on.key, gap: false };
    }
    if (this.#candidate?.key !== best.key) this.#candidate = { key: best.key, since: now };
    if (now - this.#candidate.since >= this.#holdMs) return { target: best.key, gap: true };
    return { target: on.key, gap: false };
  }
}

// ---- the round's stream -----------------------------------------------------------------------

export interface AirPiece {
  at_ms: number;
  audio: string;
}

export interface RoomAirOptions {
  /** The singers' start on Core's clock (ms). */
  startAt: number;
  /** The round's fixed delay (`stream_delay_ms`). */
  delayMs: number;
  holdMs: number;
  fadeMs: number;
  /** The round has one singer. */
  solo: boolean;
  /** The song's length (ms): nothing is mixed after it. */
  durationMs: number;
  /** Song times (ms) where a switch sounds least abrupt: gaps between lyric lines. */
  gaps: readonly number[];
  send: (piece: AirPiece) => void;
}

/** One change of voice: from `from` to `to`, fading over `[at, at + fade)` (song samples). */
interface Switch {
  from: string | null;
  to: string | null;
  at: number;
}

export class RoomAir {
  readonly #o: RoomAirOptions;
  readonly #picker: AirPicker;
  readonly #buffers = new Map<string, VoiceBuffer>();
  /** The next song sample to mix. */
  #cursor = 0;
  /** The voice on (before any pending switch). */
  #on: string | null = null;
  #switch: Switch | null = null;
  #closed = false;

  constructor(options: RoomAirOptions) {
    this.#o = options;
    this.#picker = new AirPicker(options.holdMs, options.solo);
  }

  /** The song sample the stream's mix has reached. */
  get cursor(): number {
    return this.#cursor;
  }

  #buffer(key: string): VoiceBuffer {
    let b = this.#buffers.get(key);
    if (b === undefined) {
      b = new VoiceBuffer();
      this.#buffers.set(key, b);
    }
    return b;
  }

  /**
   * A chunk of `key`'s microphone: µ-law, its first sample at song time `songMs` on their audio
   * clock; `latencyMs` (their device's) places it on the backing's time. `bytes` are not kept.
   */
  put(key: string, songMs: number, latencyMs: number, bytes: Uint8Array, now: number): void {
    if (this.#closed || !Number.isFinite(songMs)) return;
    const placedMs = songMs - latencyMs;
    const at = Math.round((placedMs * KARAOKE_VOICE_RATE) / 1000);
    const endMs = placedMs + (bytes.length * 1000) / KARAOKE_VOICE_RATE;
    const delay = now - (this.#o.startAt + endMs);
    this.#buffer(key).put(at, mulawDecode(bytes), this.#cursor, now, delay);
  }

  /** Whether `key`'s audio came lately (they are heard). */
  heard(key: string, now: number): boolean {
    const at = this.#buffers.get(key)?.heardAt ?? null;
    return at !== null && now - at < AIR_QUIET_MS;
  }

  /** The voice the stream plays now (at the mix; a crossfade counts as its new voice). */
  onAir(): string | null {
    const sw = this.#switch;
    return sw !== null && this.#cursor >= sw.at ? sw.to : this.#on;
  }

  /** One pass (every room tick while sung): the voice wanted, then the mix up to the lead. */
  tick(now: number, singers: readonly AirSinger[]): void {
    if (this.#closed) return;
    const fade = Math.max(1, Math.round((this.#o.fadeMs * KARAOKE_VOICE_RATE) / 1000));
    // The voice the mix ends up with once the switch in hand is done.
    const settled = this.#switch === null ? this.#on : this.#switch.to;
    const wish = this.#picker.pick(now, settled, singers);
    if (wish.target !== settled) {
      if (this.#switch !== null && this.#cursor < this.#switch.at) {
        // Not begun yet: aim it at the new wish (or call it off).
        if (wish.target === this.#on) this.#switch = null;
        else this.#switch = { ...this.#switch, to: wish.target };
      } else if (this.#switch === null) {
        this.#switch = {
          from: this.#on,
          to: wish.target,
          at: wish.gap ? this.#gapAfter(this.#cursor) : this.#cursor,
        };
      }
    }
    this.#mix(now, fade);
  }

  /** The first gap between lines at or after `cursor` within the window, else `cursor`. */
  #gapAfter(cursor: number): number {
    const fromMs = (cursor * 1000) / KARAOKE_VOICE_RATE;
    const gap = this.#o.gaps.find((g) => g >= fromMs && g - fromMs <= GAP_WINDOW_MS);
    return gap === undefined ? cursor : Math.round((gap * KARAOKE_VOICE_RATE) / 1000);
  }

  #mix(now: number, fade: number): void {
    const rate = KARAOKE_VOICE_RATE;
    const songNowMs = now - this.#o.startAt - this.#o.delayMs + AIR_LEAD_MS;
    const end = Math.round((Math.min(songNowMs, this.#o.durationMs) * rate) / 1000);
    if (end <= this.#cursor) return;
    if (this.#cursor < 0) this.#cursor = 0;
    const n = Math.min(end - this.#cursor, Math.round((MAX_PIECE_MS * rate) / 1000));
    if (n <= 0) return;
    const from = this.#cursor;
    const sound = this.#on !== null || this.#switch !== null;
    const out = sound ? new Uint8Array(n) : null;
    for (let i = 0; i < n; i++) {
      const s = from + i;
      const sw = this.#switch;
      let v = 0;
      if (sw === null || s < sw.at) {
        if (this.#on !== null) v = this.#buffer(this.#on).at(s);
      } else {
        const k = Math.min(1, (s - sw.at) / fade);
        if (sw.from !== null) v += (1 - k) * this.#buffer(sw.from).at(s);
        if (sw.to !== null) v += k * this.#buffer(sw.to).at(s);
        if (k >= 1) {
          this.#on = sw.to;
          this.#switch = null;
        }
      }
      if (out !== null) out[i] = mulawEncodeSample(v);
    }
    this.#cursor = from + n;
    for (const b of this.#buffers.values()) b.dropBefore(this.#cursor);
    if (out !== null) {
      this.#o.send({ at_ms: Math.round((from * 1000) / rate), audio: toBase64(out) });
      out.fill(0);
    }
  }

  /** Per singer: the 90th percentile path delay (ms) and how much of their audio came too late. */
  stats(): { key: string; delay_ms: number | null; late_ms: number }[] {
    return [...this.#buffers].map(([key, b]) => ({
      key,
      delay_ms: b.delay(),
      late_ms: Math.round((b.late * 1000) / KARAOKE_VOICE_RATE),
    }));
  }

  /** The round is over: every buffer is zeroed and forgotten. */
  close(): void {
    this.#closed = true;
    for (const b of this.#buffers.values()) b.clear();
    this.#buffers.clear();
    this.#on = null;
    this.#switch = null;
  }
}

/**
 * Where a switch of voice sounds least abrupt: in each rest between two lyric lines of at least
 * `minGapS`, a little after the line ends (song ms, sorted).
 */
export function lyricGaps(
  lines: readonly { start: number; end: number | null }[],
  minGapS = 0.3,
): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i] as { start: number; end: number | null };
    const b = lines[i + 1] as { start: number; end: number | null };
    const end = a.end ?? a.start;
    const gap = b.start - end;
    if (gap >= minGapS) out.push(Math.round((end + Math.min(gap / 2, 0.3)) * 1000));
  }
  return out;
}
