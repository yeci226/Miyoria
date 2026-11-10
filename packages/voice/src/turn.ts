// End of turn: the client of the end-of-turn worker, and the gate her speech waits at.
//
// The segmenter asks `TurnJudge` once a speaker has been quiet for `turn_stop_ms`. Its answer is a
// suggestion with a deadline: no answer in time, and the silence decides as it always did. After
// a failure the worker is left alone for a while, so a dead worker costs nothing per utterance.
//
// `TurnGate` is docs/design/v3-architecture.md §13.4 "LLM first, TTS after the turn is confirmed":
// an utterance goes to ASR and the LLM as soon as the model says the speaker is done, but that
// can be wrong, and the GPU is the scarcest thing she has. So a reply only starts synthesizing
// when the people it answers are not talking and stayed quiet for `turn_confirm_ms`. It opens by
// itself after `turn_gate_max_ms`: her voice is never held up by the gate going wrong.

import { errorMessage, sleep } from "@miyoria/kernel";
import { type AccountRef, accountRefString } from "@miyoria/types";

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
  /** Worker root. */
  url: string;
  /** Longest wait for an answer. */
  timeoutMs: number;
  /** After a failure the worker is not asked for this long. Default 30 000. */
  retryMs?: number;
  now(): number;
  /** Told once per outage. */
  warn(message: string): void;
}

const DEFAULT_RETRY_MS = 30_000;

/** `POST {url}/turn` with the raw PCM. */
export class HttpTurnJudge implements TurnJudge {
  readonly #o: HttpTurnJudgeOptions;
  readonly #url: string;
  #downUntil = 0;
  #warned = false;

  constructor(options: HttpTurnJudgeOptions) {
    this.#o = options;
    this.#url = `${options.url.replace(/\/+$/, "")}/turn`;
  }

  async ask(
    samples: Int16Array,
    sampleRate: number,
    signal: AbortSignal,
  ): Promise<TurnAnswer | null> {
    if (this.#o.now() < this.#downUntil) return null;
    try {
      const response = await fetch(this.#url, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-sample-rate": String(sampleRate),
        },
        body: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#o.timeoutMs)]),
      });
      if (!response.ok) throw new Error(`end-of-turn worker answered ${response.status}`);
      const body = (await response.json()) as Partial<TurnAnswer>;
      if (typeof body.complete !== "boolean" || typeof body.probability !== "number") {
        throw new Error("end-of-turn worker sent a bad answer");
      }
      this.#warned = false;
      return { complete: body.complete, probability: body.probability };
    } catch (error) {
      if (signal.aborted) return null;
      this.#downUntil = this.#o.now() + (this.#o.retryMs ?? DEFAULT_RETRY_MS);
      if (!this.#warned) {
        this.#warned = true;
        this.#o.warn(`Smart Turn is not answering, using the silence: ${errorMessage(error)}`);
      }
      return null;
    }
  }
}

/** How often a waiting reply looks at the gate again. */
const GATE_POLL_MS = 25;

/** `Infinity`: talking or not decided yet; else quiet, and confirmed from then on. */
type Until = number;

export class TurnGate {
  readonly #now: () => number;
  readonly #guilds = new Map<string, Map<string, Until>>();

  constructor(now: () => number) {
    this.#now = now;
  }

  /** `speaker` is talking, or their turn is not over. */
  hold(guild: string, speaker: AccountRef): void {
    this.#guild(guild).set(accountRefString(speaker), Number.POSITIVE_INFINITY);
  }

  /** `speaker`'s turn looks over; it counts as confirmed in `afterMs` unless they talk again. */
  settle(guild: string, speaker: AccountRef, afterMs: number): void {
    this.#guild(guild).set(accountRefString(speaker), this.#now() + afterMs);
  }

  /** Whether one of `accounts` has a turn that is not confirmed. */
  held(guild: string, accounts: readonly AccountRef[]): boolean {
    const g = this.#guilds.get(guild);
    if (!g) return false;
    const now = this.#now();
    for (const account of accounts) {
      const key = accountRefString(account);
      const until = g.get(key);
      if (until === undefined) continue;
      if (until > now) return true;
      g.delete(key);
    }
    return false;
  }

  /** Waits until `accounts` are confirmed, at most `maxMs`. Rejects when `signal` aborts. */
  async wait(
    guild: string,
    accounts: readonly AccountRef[],
    maxMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = this.#now() + maxMs;
    while (this.held(guild, accounts) && this.#now() < deadline) {
      await sleep(GATE_POLL_MS, signal);
    }
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
