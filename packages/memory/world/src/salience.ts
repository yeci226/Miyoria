// Coalescing and rate limiting of salient changes before they wake anything up.
//
// A candidate waits `coalesce_ms`; repeats with the same key meanwhile are merged into it
// (`count`). Once published, the same key is muted for `cooldown_secs` (someone flapping
// online / offline is one event, not twenty). At most `max_salient_per_minute` events leave per
// minute, highest score first; anything still waiting a minute after it was due is dropped.

import {
  type AccountRef,
  type ContextKey,
  type PersonId,
  type SalienceKind,
  type SalientEvent,
  toTimestamp,
} from "@miyoria/types";

/** A raw salient change, before coalescing. */
export interface Candidate {
  kind: SalienceKind;
  key: string;
  account: AccountRef | null;
  person: PersonId | null;
  display_name: string | null;
  context: ContextKey | null;
  detail: string;
  score: number;
}

export interface SalienceOptions {
  coalesce_ms: number;
  cooldown_secs: number;
  max_salient_per_minute: number;
}

const MINUTE_MS = 60_000;
/** Pending events this long past due are dropped instead of sent late. */
const STALE_MS = MINUTE_MS;

interface Pending {
  event: SalientEvent;
  due: number;
}

export class Salience {
  readonly #pending = new Map<string, Pending>();
  readonly #lastSent = new Map<string, number>();
  #sent: number[] = [];
  #suppressed = 0;
  #dropped = 0;

  constructor(private readonly options: SalienceOptions) {}

  /** Repeats muted by the cooldown, and events dropped by the rate limit, so far. */
  stats(): { suppressed: number; dropped: number; pending: number } {
    return { suppressed: this.#suppressed, dropped: this.#dropped, pending: this.#pending.size };
  }

  offer(candidate: Candidate, now: number): void {
    const last = this.#lastSent.get(candidate.key);
    if (last !== undefined && now - last < this.options.cooldown_secs * 1000) {
      this.#suppressed++;
      return;
    }
    const pending = this.#pending.get(candidate.key);
    if (pending) {
      const e = pending.event;
      e.count++;
      e.at = toTimestamp(now);
      e.detail = candidate.detail;
      e.score = Math.max(e.score, candidate.score);
      e.person = candidate.person ?? e.person;
      return;
    }
    this.#pending.set(candidate.key, {
      event: {
        ...candidate,
        score: Math.min(Math.max(candidate.score, 0), 1),
        count: 1,
        first_at: toTimestamp(now),
        at: toTimestamp(now),
      },
      due: now + this.options.coalesce_ms,
    });
  }

  /** Events ready to publish at `now`, highest score first. */
  due(now: number): SalientEvent[] {
    this.#sent = this.#sent.filter((t) => now - t < MINUTE_MS);
    const ready = [...this.#pending.values()]
      .filter((p) => p.due <= now)
      .sort((a, b) => b.event.score - a.event.score || a.due - b.due);
    const out: SalientEvent[] = [];
    for (const p of ready) {
      if (this.#sent.length >= this.options.max_salient_per_minute) {
        if (now - p.due > STALE_MS) {
          this.#pending.delete(p.event.key);
          this.#dropped++;
        }
        continue;
      }
      this.#pending.delete(p.event.key);
      this.#sent.push(now);
      this.#lastSent.set(p.event.key, now);
      out.push(p.event);
    }
    const cooldown = this.options.cooldown_secs * 1000;
    for (const [key, at] of this.#lastSent) {
      if (now - at >= cooldown) this.#lastSent.delete(key);
    }
    return out;
  }
}
