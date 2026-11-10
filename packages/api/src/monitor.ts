// Live state the API derives from the bus: the voice channels she is in (participants, who is
// speaking, recent latency) and whether her own speech is playing. Only events seen since the
// `api` module started count.

import type { Subscription } from "@miyoria/kernel";
import {
  type AccountRef,
  type ContextKey,
  contextKeyEquals,
  type Envelope,
  isJsonObject,
  type JsonValue,
  sameAccount,
  type Timestamp,
  type TurnId,
  timestampMs,
  type VoiceParticipant,
} from "@miyoria/types";
import type {
  E2eSegmentName,
  E2eStats,
  LatencyStats,
  VoiceE2eLatency,
  VoiceState,
} from "./types.js";

/** Topics the monitor follows. */
export const MONITOR_TOPICS: readonly string[] = ["voice.*", "agent.turn.started"];

/** Latency samples older than this are dropped. */
const WINDOW_MS = 15 * 60_000;
const MAX_SAMPLES = 512;
const U32_MAX = 4_294_967_295;

class Samples {
  readonly #items: Array<{ at: number; ms: number }> = [];

  push(at: number, ms: number): void {
    this.#items.push({ at, ms });
    while (this.#items.length > MAX_SAMPLES) this.#items.shift();
  }

  /** The sorted values still inside the window. */
  #window(now: number): number[] {
    const cutoff = now - WINDOW_MS;
    while (this.#items.length > 0 && (this.#items[0]?.at ?? 0) < cutoff) this.#items.shift();
    return this.#items.map((s) => s.ms).sort((a, b) => a - b);
  }

  /** p50 / p90, for the end-to-end series. */
  e2e(now: number): E2eStats {
    const values = this.#window(now);
    return {
      p50_ms: percentile(values, 0.5),
      p90_ms: percentile(values, 0.9),
      samples: values.length,
    };
  }

  stats(now: number): LatencyStats {
    const values = this.#window(now);
    return {
      p50_ms: percentile(values, 0.5),
      p95_ms: percentile(values, 0.95),
      samples: values.length,
    };
  }
}

/** Nearest-rank percentile of sorted values. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

const E2E_SEGMENTS: readonly E2eSegmentName[] = [
  "endpoint",
  "asr",
  "llm_first",
  "tts_queue",
  "tts_first",
  "playback",
];

/** `speech_end → first_audio_played` and its segments (`voice.latency`, stage `e2e`). */
class E2eSeries {
  readonly total = new Samples();
  readonly segments = new Map<E2eSegmentName, Samples>(E2E_SEGMENTS.map((s) => [s, new Samples()]));
  /** Every measurement in the window, with why it is incomplete (`null`: it is complete). */
  readonly #outcomes: Array<{ at: number; reason: string | null }> = [];

  push(at: number, complete: boolean, reason: string | null, total: number | null): void {
    this.#outcomes.push({ at, reason: complete ? null : (reason ?? "unknown") });
    while (this.#outcomes.length > MAX_SAMPLES) this.#outcomes.shift();
    if (complete && total !== null) this.total.push(at, total);
  }

  stats(now: number): VoiceE2eLatency {
    const cutoff = now - WINDOW_MS;
    while (this.#outcomes.length > 0 && (this.#outcomes[0]?.at ?? 0) < cutoff) {
      this.#outcomes.shift();
    }
    const byReason: Record<string, number> = {};
    let complete = 0;
    for (const o of this.#outcomes) {
      if (o.reason === null) complete += 1;
      else byReason[o.reason] = (byReason[o.reason] ?? 0) + 1;
    }
    const segments = {} as Record<E2eSegmentName, E2eStats>;
    for (const name of E2E_SEGMENTS) segments[name] = this.segments.get(name)?.e2e(now) as E2eStats;
    return {
      total: this.total.e2e(now),
      segments,
      complete,
      incomplete: this.#outcomes.length - complete,
      incomplete_by_reason: byReason,
    };
  }
}

interface Session {
  context: ContextKey;
  participants: VoiceParticipant[];
  speaking: AccountRef[];
  joinedAt: Timestamp;
  lastTurn: TurnId | null;
  asr: Samples;
  llm: Samples;
  tts: Samples;
  e2e: E2eSeries;
}

function newSession(context: ContextKey, joinedAt: Timestamp): Session {
  return {
    context,
    participants: [],
    speaking: [],
    joinedAt,
    lastTurn: null,
    asr: new Samples(),
    llm: new Samples(),
    tts: new Samples(),
    e2e: new E2eSeries(),
  };
}

function isContextKey(value: JsonValue | undefined): value is ContextKey & JsonValue {
  if (!isJsonObject(value)) return false;
  const { platform, scope, channel, kind } = value;
  return (
    typeof platform === "string" &&
    (scope === null || typeof scope === "string") &&
    typeof channel === "string" &&
    (kind === "channel" || kind === "thread" || kind === "dm" || kind === "voice")
  );
}

export class Monitor {
  #sessions: Session[] = [];
  /** Contexts where her playback is running. */
  #playing: ContextKey[] = [];
  /** Last expression triggered through the API. */
  #expression: string | null = null;

  /** Applies bus events until the subscription closes. */
  async run(sub: Subscription): Promise<void> {
    for await (const env of sub) this.handle(env);
  }

  #session(context: ContextKey): Session | undefined {
    return this.#sessions.find((s) => contextKeyEquals(s.context, context));
  }

  handle(env: Envelope): void {
    const at = env.ts;
    const event = env.event;
    switch (event.type) {
      case "voice_joined": {
        const { context, participants } = event.data;
        this.#sessions = this.#sessions.filter((s) => !contextKeyEquals(s.context, context));
        const session = newSession(context, at);
        session.participants = [...participants];
        this.#sessions.push(session);
        break;
      }
      case "voice_left": {
        const { context } = event.data;
        this.#sessions = this.#sessions.filter((s) => !contextKeyEquals(s.context, context));
        this.#playing = this.#playing.filter((c) => !contextKeyEquals(c, context));
        break;
      }
      case "voice_participants": {
        const { context, participants } = event.data;
        let session = this.#session(context);
        if (!session) {
          session = newSession(context, at);
          this.#sessions.push(session);
        }
        session.participants = [...participants];
        session.speaking = session.speaking.filter((a) =>
          participants.some((p) => sameAccount(p.account, a)),
        );
        break;
      }
      case "voice_speaking": {
        const { context, account, speaking } = event.data;
        const session = this.#session(context);
        if (session) {
          session.speaking = session.speaking.filter((a) => !sameAccount(a, account));
          if (speaking) session.speaking.push(account);
        }
        break;
      }
      case "voice_playback": {
        const { context, turn, state } = event.data;
        this.#playing = this.#playing.filter((c) => !contextKeyEquals(c, context));
        if (state === "started") this.#playing.push(context);
        const session = this.#session(context);
        if (turn !== null && session) session.lastTurn = turn;
        break;
      }
      case "agent_turn_started": {
        const { turn, context } = event.data;
        if (context.kind !== "voice") break;
        const session = this.#session(context);
        if (session) session.lastTurn = turn;
        break;
      }
      case "custom": {
        if (event.data.topic !== "voice.latency") break;
        this.#latency(event.data.payload, at);
        break;
      }
      default:
        break;
    }
  }

  #latency(payload: JsonValue, at: Timestamp): void {
    if (!isJsonObject(payload)) return;
    const context = payload.context;
    if (!isContextKey(context)) return;
    const ms = (key: string): number | null => {
      const v = payload[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
      return Math.trunc(Math.min(v, U32_MAX));
    };
    const session = this.#session(context);
    if (!session) return;
    const atMs = timestampMs(at);
    switch (payload.stage) {
      case "asr": {
        const v = ms("asr_ms");
        if (v !== null) session.asr.push(atMs, v);
        break;
      }
      case "tts": {
        const v = ms("first_audio_ms");
        if (v !== null) session.tts.push(atMs, v);
        break;
      }
      case "llm": {
        const v = ms("first_token_ms");
        if (v !== null) session.llm.push(atMs, v);
        break;
      }
      case "e2e": {
        const segments = payload.segments;
        const complete = payload.complete === true;
        const reason = typeof payload.reason === "string" ? payload.reason : null;
        session.e2e.push(atMs, complete, reason, ms("total_ms"));
        // Only a complete measurement feeds the percentiles: a failed one is a count, not a time.
        if (complete && isJsonObject(segments)) {
          for (const name of E2E_SEGMENTS) {
            const v = segments[name];
            if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
              session.e2e.segments.get(name)?.push(atMs, Math.trunc(Math.min(v, U32_MAX)));
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  /** Voice channels she is in, oldest join first. */
  voice(now: number): VoiceState {
    return {
      sessions: this.#sessions.map((s) => ({
        context: s.context,
        label: null,
        participants: [...s.participants],
        speaking: [...s.speaking],
        joined_at: s.joinedAt,
        latency: {
          asr: s.asr.stats(now),
          llm_first_token: s.llm.stats(now),
          tts_first_audio: s.tts.stats(now),
          e2e: s.e2e.stats(now),
        },
        last_turn: s.lastTurn,
      })),
    };
  }

  /** The voice channel to speak in: the one joined first. */
  voiceContext(): ContextKey | null {
    return this.#sessions[0]?.context ?? null;
  }

  /** Her speech is playing somewhere. */
  speaking(): boolean {
    return this.#playing.length > 0;
  }

  expression(): string | null {
    return this.#expression;
  }

  setExpression(expression: string): void {
    this.#expression = expression;
  }
}
