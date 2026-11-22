// End of turn: the client of the end-of-turn worker, and the gate her speech waits at.
//
// The segmenter asks `TurnJudge` once a speaker has been quiet for `turn_stop_ms`. Its answer is a
// suggestion with a deadline: no answer in time, and the silence decides as it always did. After
// a failure the worker is left alone for a while, so a dead worker costs nothing per utterance.
// The worker is the `turn` endpoint of Core's registry, found at each question; with none, the
// silence decides too.
//
// `TurnGate` is docs/design/v3-architecture.md §13.4 "LLM first, TTS after the turn is confirmed":
// an utterance goes to ASR and the LLM as soon as the model says the speaker is done, but that
// can be wrong, and the GPU is the scarcest thing she has. So a reply only starts synthesizing
// when the people it answers are not talking and stayed quiet for `turn_confirm_ms`. It opens by
// itself after `turn_gate_max_ms`: her voice is never held up by the gate going wrong.

import { WORKERS_SAMPLE_RATE_HEADER, WorkersTurnReplySchema } from "@miyoria/contracts/workers";
import { errorMessage, sleep } from "@miyoria/runtime/kernel";
import { type AccountRef, accountRefString } from "@miyoria/types";
import { type EndpointSource, firstEndpoint } from "../../speech/src/index.js";
import { deferred } from "./util.js";

/** What the model says about the end of a turn. */
export interface TurnAnswer {
  complete: boolean;
  probability: number;
}

export interface TurnJudge {
  /** The model's answer; `null` when it has none (in time). Never rejects. */
  ask(samples: Int16Array, sampleRate: number, signal: AbortSignal): Promise<TurnAnswer | null>;
}

export interface HttpTurnJudgeOptions {
  /** Core's endpoint registry: the worker is its direct `turn` endpoint. */
  endpoints: EndpointSource | null;
  /** Longest wait for an answer. */
  timeoutMs: number;
  /** After a failure the worker is not asked for this long. Default 30 000. */
  retryMs?: number;
  now(): number;
  /** Told once per outage. */
  warn(message: string): void;
}

const DEFAULT_RETRY_MS = 30_000;

/** `POST {worker}/turn` with the raw PCM. */
export class HttpTurnJudge implements TurnJudge {
  readonly #o: HttpTurnJudgeOptions;
  #downUntil = 0;
  #warned = false;

  constructor(options: HttpTurnJudgeOptions) {
    this.#o = options;
  }

  async ask(
    samples: Int16Array,
    sampleRate: number,
    signal: AbortSignal,
  ): Promise<TurnAnswer | null> {
    if (this.#o.now() < this.#downUntil) return null;
    const source = this.#o.endpoints;
    const endpoint = firstEndpoint(source, "turn", { direct: true });
    if (source === null || endpoint === null) {
      this.#warnOnce("no end-of-turn worker is known, using the silence");
      return null;
    }
    let sent = false;
    try {
      const response = await source.request(endpoint, "/turn", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          [WORKERS_SAMPLE_RATE_HEADER]: String(sampleRate),
        },
        body: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#o.timeoutMs)]),
      });
      sent = true;
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`end-of-turn worker answered ${response.status}`);
      }
      const body = WorkersTurnReplySchema.safeParse(await response.json());
      if (!body.success) throw new Error("end-of-turn worker sent a bad answer");
      this.#warned = false;
      return { complete: body.data.complete, probability: body.data.probability };
    } catch (error) {
      if (signal.aborted) return null;
      // No answer at all: the registry passes over this worker for a while too.
      if (!sent) source.failed(endpoint, error);
      this.#downUntil = this.#o.now() + (this.#o.retryMs ?? DEFAULT_RETRY_MS);
      this.#warnOnce(`Smart Turn is not answering, using the silence: ${errorMessage(error)}`);
      return null;
    }
  }

  /** Once per outage: an answer clears it. */
  #warnOnce(message: string): void {
    if (this.#warned) return;
    this.#warned = true;
    this.#o.warn(message);
  }
}

/** `Infinity`: talking or not decided yet; else quiet, and confirmed from then on. */
type Until = number;

export class TurnGate {
  readonly #now: () => number;
  readonly #guilds = new Map<string, Map<string, Until>>();
  /** Settles on the next `hold` / `settle`: what a waiting reply waits for besides the clock. */
  #changed = deferred<void>();

  constructor(now: () => number) {
    this.#now = now;
  }

  /** `speaker` is talking, or their turn is not over. */
  hold(guild: string, speaker: AccountRef): void {
    this.#guild(guild).set(accountRefString(speaker), Number.POSITIVE_INFINITY);
    this.#notify();
  }

  /** `speaker`'s turn looks over; it counts as confirmed in `afterMs` unless they talk again. */
  settle(guild: string, speaker: AccountRef, afterMs: number): void {
    this.#guild(guild).set(accountRefString(speaker), this.#now() + afterMs);
    this.#notify();
  }

  /** Whether one of `accounts` has a turn that is not confirmed. */
  held(guild: string, accounts: readonly AccountRef[]): boolean {
    return this.#heldUntil(guild, accounts) !== null;
  }

  /**
   * Waits until `accounts` are confirmed, at most `maxMs`. Rejects when `signal` aborts. Wakes
   * when the last of their turns is confirmed, or when a turn is held or settled again.
   */
  async wait(
    guild: string,
    accounts: readonly AccountRef[],
    maxMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = this.#now() + maxMs;
    for (;;) {
      signal.throwIfAborted();
      const until = this.#heldUntil(guild, accounts);
      const now = this.#now();
      if (until === null || now >= deadline) return;
      const stop = new AbortController();
      try {
        await Promise.race([
          this.#changed.promise,
          // Rejects once `signal` aborts (checked above) or the race is over; nobody needs that.
          sleep(Math.min(until, deadline) - now, AbortSignal.any([signal, stop.signal])).catch(
            () => undefined,
          ),
        ]);
      } finally {
        stop.abort();
      }
    }
  }

  /** When the last unconfirmed turn of `accounts` is confirmed (`Infinity`: not known); `null`: none is. */
  #heldUntil(guild: string, accounts: readonly AccountRef[]): Until | null {
    const g = this.#guilds.get(guild);
    if (!g) return null;
    const now = this.#now();
    let last: Until | null = null;
    for (const account of accounts) {
      const key = accountRefString(account);
      const until = g.get(key);
      if (until === undefined) continue;
      if (until > now) last = Math.max(last ?? until, until);
      else g.delete(key);
    }
    return last;
  }

  #notify(): void {
    const changed = this.#changed;
    this.#changed = deferred<void>();
    changed.resolve();
  }

  #guild(guild: string): Map<string, Until> {
    let g = this.#guilds.get(guild);
    if (!g) {
      g = new Map();
      this.#guilds.set(guild, g);
    }
    return g;
  }
}
