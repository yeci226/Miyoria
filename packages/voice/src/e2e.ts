// End-to-end voice latency: from the moment a person stops talking to the first audio of her
// answer reaching Discord, split into six consecutive segments.
//
//   speech_end ─ endpoint ─ sent to ASR ─ asr ─ transcript ─ llm_first ─ first text ─ tts_queue ─
//   TTS starts ─ tts_first ─ first audio ─ playback ─ audible
//
// `tts_queue` ends when the worker starts synthesizing, so it holds the wait for the turn to be
// confirmed, for a TTS slot and for the worker's GPU lock; `tts_first` is synthesis alone. That
// split is what tells contention from a slow model (docs/design/v3-architecture.md §13.1).
//
// The listener registers a measurement per transcribed utterance (`heard`). The speaker marks
// the first text of the reply (`textReady`), then binds the utterance to the turn that speaks
// (`begin`) and feeds the TTS and playback timestamps into the returned `E2eMeasure`. Every
// call is a map lookup and a clock read: nothing here waits on I/O or adds a timer.
//
// One measurement per reply that answers human speech. A turn nobody spoke to (self-started,
// text-triggered) never matches a registered utterance and is not counted. A reply that does not
// reach the speakers is published once as incomplete, with its reason. Utterances that never get
// a reply are forgotten after `ttlMs` (or when more than `maxPending` wait), without a record.

import type { ContextKey, JsonObject, MessageRef, TurnId } from "@miyoria/types";

/** The six segments, in the order a listener experiences them. */
export const E2E_SEGMENTS = [
  "endpoint",
  "asr",
  "llm_first",
  "tts_queue",
  "tts_first",
  "playback",
] as const;

export type E2eSegment = (typeof E2E_SEGMENTS)[number];

/** Why a measurement is incomplete. */
export type E2eReason =
  /** Somebody talked over her before the first audio played. */
  | "barge_in"
  /** The playback was stopped before it started (not by barge-in). */
  | "interrupted"
  /** The speak call was cancelled (turn aborted, scheduler timeout, shutdown). */
  | "cancelled"
  /** A song or the GPU loan held the floor for too long. */
  | "floor"
  /** TTS (or its translation) failed before any audio arrived. */
  | "tts_failed"
  /** The audio was there but the voice node failed to play it. */
  | "playback_failed"
  /** The utterance was cut by the length cap: the speaker had not stopped talking. */
  | "speech_end_unknown"
  /** The reply began but never reached the speaker (turn dropped after the first text). */
  | "expired";

/** One published measurement (the payload of the `voice.latency` event, stage `e2e`). */
export interface E2eRecord {
  context: ContextKey;
  turn: TurnId | null;
  /** The `voice_utterance` id the reply answers. */
  utterance: string;
  complete: boolean;
  reason: E2eReason | null;
  /** `speech_end → first_audio_played`; `null` when incomplete. */
  total_ms: number | null;
  /** Each segment, `null` where one of its two boundaries was not reached or not known. */
  segments: Record<E2eSegment, number | null>;
  /**
   * `total_ms` minus the segments that are not `null`: `0` when all are known, the time of the
   * unmeasured segments otherwise. `null` when incomplete.
   */
  unattributed_ms: number | null;
  /** The first line came from a TTS prefetch. */
  prefetched: boolean;
  provider: string | null;
  /** How the turn was judged over, when a model judges it. */
  turn_end?: TurnEnd;
}

/** How a turn ended, with a model judging it. */
export interface TurnEnd {
  /** `turn`: the model said so; `timeout`: the longest silence; else the silence or length cap. */
  ended_by: string;
  /** The model's last answer; `null` when it did not give one. */
  probability: number | null;
}

/** TTS timestamps of one line (clock ms). */
export interface TtsTiming {
  /** The synthesis request went out (after translation and any wait for a TTS slot). */
  requestAt: number;
  /** The first non-empty audio chunk arrived. */
  firstAudioAt: number;
  /** What the worker reports having waited for its GPU lock. */
  queueMs?: number;
}

/** What the listener knows once a transcript is accepted. */
export interface Heard {
  context: ContextKey;
  /** The `voice_utterance` id. */
  utterance: string;
  /** When the person stopped talking; `null` when they may not have (length-capped). */
  speechEndAt: number | null;
  /** The utterance was closed and the ASR request left. */
  sentAt: number;
  /** The transcript came back. */
  transcriptAt: number;
  /** How the turn was judged over, when a model judges it. */
  turn?: TurnEnd;
}

export interface E2eOptions {
  now(): number;
  emit(record: E2eRecord): void;
  /** Utterances without a reply are forgotten after this long. */
  ttlMs?: number;
  /** At most this many utterances wait for a reply (the oldest is forgotten first). */
  maxPending?: number;
}

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_MAX_PENDING = 32;

/** Indexes into the timestamp chain. */
const T = {
  speechEnd: 0,
  sent: 1,
  transcript: 2,
  firstText: 3,
  ttsRequest: 4,
  ttsFirst: 5,
  audible: 6,
} as const;

type Chain = [
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
];

interface Pending {
  heard: Heard;
  firstTextAt: number | null;
}

export class E2eLatency {
  readonly #o: E2eOptions;
  readonly #pending = new Map<string, Pending>();

  constructor(options: E2eOptions) {
    this.#o = options;
  }

  /** Utterances waiting for a reply. */
  get size(): number {
    return this.#pending.size;
  }

  /** Registers a transcribed utterance that may be answered. */
  heard(heard: Heard): void {
    this.#sweep();
    this.#pending.set(heard.utterance, { heard, firstTextAt: null });
    while (this.#pending.size > (this.#o.maxPending ?? DEFAULT_MAX_PENDING)) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#forget(oldest);
    }
  }

  /**
   * The first text of a reply is available. `focus` is what the turn answers; the newest
   * registered utterance among it counts. Later calls for the same utterance change nothing.
   */
  textReady(focus: readonly MessageRef[]): void {
    this.#sweep();
    const hit = this.#find(focus);
    if (hit !== null && hit[1].firstTextAt === null) hit[1].firstTextAt = this.#o.now();
  }

  /**
   * A turn starts speaking. Returns the measurement when it answers a registered utterance
   * (which is then bound to it: only the turn's first line is measured), else `null`.
   */
  begin(context: ContextKey, turn: TurnId | null, focus: readonly MessageRef[]): E2eMeasure | null {
    this.#sweep();
    if (turn === null) return null;
    const hit = this.#find(focus);
    if (hit === null) return null;
    const [id, pending] = hit;
    this.#pending.delete(id);
    const chain: Chain = [
      pending.heard.speechEndAt,
      pending.heard.sentAt,
      pending.heard.transcriptAt,
      pending.firstTextAt ?? this.#o.now(),
      null,
      null,
      null,
    ];
    return new E2eMeasure(this.#o, context, turn, id, chain, pending.heard.turn);
  }

  /** Forgets everything (module stop). */
  clear(): void {
    this.#pending.clear();
  }

  #find(focus: readonly MessageRef[]): [string, Pending] | null {
    for (let i = focus.length - 1; i >= 0; i--) {
      const ref = focus[i];
      const pending = ref === undefined ? undefined : this.#pending.get(ref.id);
      if (ref !== undefined && pending !== undefined) return [ref.id, pending];
    }
    return null;
  }

  #sweep(): void {
    const cutoff = this.#o.now() - (this.#o.ttlMs ?? DEFAULT_TTL_MS);
    for (const [id, p] of this.#pending) {
      if (p.heard.transcriptAt >= cutoff) break; // Oldest first.
      this.#forget(id);
    }
  }

  /** Drops a waiting utterance. A reply that had begun is reported, one that never did is not. */
  #forget(id: string): void {
    const p = this.#pending.get(id);
    this.#pending.delete(id);
    if (p === undefined || p.firstTextAt === null) return;
    const chain: Chain = [
      p.heard.speechEndAt,
      p.heard.sentAt,
      p.heard.transcriptAt,
      p.firstTextAt,
      null,
      null,
      null,
    ];
    this.#o.emit(record(p.heard.context, null, id, chain, "expired", false, null, p.heard.turn));
  }
}

/** One reply being measured. Every method is idempotent after the first result. */
export class E2eMeasure {
  readonly #o: E2eOptions;
  readonly #context: ContextKey;
  readonly #turn: TurnId;
  readonly #utterance: string;
  readonly #chain: Chain;
  readonly #turnEnd: TurnEnd | undefined;
  #prefetched = false;
  #provider: string | null = null;
  #done = false;

  /** @internal Created by `E2eLatency.begin`. */
  constructor(
    options: E2eOptions,
    context: ContextKey,
    turn: TurnId,
    utterance: string,
    chain: Chain,
    turnEnd?: TurnEnd,
  ) {
    this.#o = options;
    this.#context = context;
    this.#turn = turn;
    this.#utterance = utterance;
    this.#chain = chain;
    this.#turnEnd = turnEnd;
  }

  /** The line's first audio is there. `timing` is `null` when the producer did not report it. */
  tts(timing: TtsTiming | null, prefetched: boolean, provider: string): void {
    if (this.#done) return;
    this.#prefetched = prefetched;
    this.#provider = provider;
    this.#chain[T.ttsRequest] = timing ? timing.requestAt + (timing.queueMs ?? 0) : null;
    this.#chain[T.ttsFirst] = timing?.firstAudioAt ?? null;
  }

  /** The node reports the first audio audible. */
  played(): void {
    this.#finish(null, this.#o.now());
  }

  /** The reply will not reach the speakers. */
  fail(reason: E2eReason): void {
    this.#finish(reason, null);
  }

  #finish(reason: E2eReason | null, audibleAt: number | null): void {
    if (this.#done) return;
    this.#done = true;
    this.#chain[T.audible] = audibleAt;
    this.#o.emit(
      record(
        this.#context,
        this.#turn,
        this.#utterance,
        this.#chain,
        reason,
        this.#prefetched,
        this.#provider,
        this.#turnEnd,
      ),
    );
  }
}

/**
 * Builds a record from a chain. Known timestamps are made non-decreasing (a prefetched line can
 * have started before the turn's first text was seen), so segments are never negative and, for
 * a complete chain, add up to the total exactly.
 */
export function record(
  context: ContextKey,
  turn: TurnId | null,
  utterance: string,
  chain: Chain,
  reason: E2eReason | null,
  prefetched: boolean,
  provider: string | null,
  turnEnd?: TurnEnd,
): E2eRecord {
  const t: Chain = [...chain];
  let floor = -Infinity;
  for (let i = 0; i < t.length; i++) {
    const v = t[i];
    if (v === null || v === undefined) continue;
    floor = Math.max(floor, v);
    t[i] = floor;
  }
  const segments = {} as Record<E2eSegment, number | null>;
  E2E_SEGMENTS.forEach((name, i) => {
    const a = t[i];
    const b = t[i + 1];
    segments[name] = a === null || a === undefined || b === null || b === undefined ? null : b - a;
  });
  const first = t[T.speechEnd];
  const last = t[T.audible];
  const total =
    first === null || first === undefined || last === null || last === undefined
      ? null
      : last - first;
  // Played without a known speech end: the segments stand, the total does not.
  const complete = reason === null && total !== null;
  const known = Object.values(segments).reduce<number>((sum, v) => sum + (v ?? 0), 0);
  return {
    context: { ...context },
    turn,
    utterance,
    complete,
    reason: reason ?? (complete ? null : "speech_end_unknown"),
    total_ms: complete ? total : null,
    segments,
    unattributed_ms: complete && total !== null ? total - known : null,
    prefetched,
    provider,
    ...(turnEnd ? { turn_end: turnEnd } : {}),
  };
}

/** The `voice.latency` payload fields of a record (the caller adds `stage: "e2e"`). */
export function e2eJson(r: E2eRecord): JsonObject {
  return {
    context: { ...r.context },
    turn: r.turn,
    utterance: r.utterance,
    complete: r.complete,
    reason: r.reason,
    total_ms: r.total_ms,
    segments: { ...r.segments },
    unattributed_ms: r.unattributed_ms,
    prefetched: r.prefetched,
    provider: r.provider,
    ...(r.turn_end ? { turn_end: { ...r.turn_end } } : {}),
  };
}
