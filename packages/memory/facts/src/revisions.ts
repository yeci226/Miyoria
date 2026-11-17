// `revision` (docs/design/v3-architecture.md §6): goes up only when the thing really changed.
//
// Two kinds of things have keys. State (who is in voice, the stage) changes when its fingerprint
// does, and an unchanged state is no event at all. An event (crafted a stone pickaxe, took damage
// from a zombie) has no state to compare: as in V2's `Impulse.attention`, happening again after
// `repeat_after_ms` is what makes it new.

import { type LogEvent, type Projection, timestampMs } from "@miyoria/types";
import { observationBody } from "./context.js";

/** Keys remembered; the oldest are forgotten (a forgotten key starts over, nothing worse). */
const MAX_KEYS = 20_000;

interface Entry {
  revision: number;
  /** When this revision began. */
  since: number;
  /** `null` for events, and for state read back from the log. */
  fingerprint: string | null;
}

export interface Revision {
  revision: number;
  /** This is a new revision: the first of the key, or a real change. */
  fresh: boolean;
  /** The very first revision of the key. */
  first: boolean;
}

export class RevisionBook implements Projection {
  readonly #keys = new Map<string, Entry>();

  /** The revision of a state that now looks like `fingerprint`. */
  state(key: string, fingerprint: string, at: number): Revision {
    const entry = this.#keys.get(key);
    if (!entry) return this.#start(key, at, fingerprint, 1, true);
    if (entry.fingerprint === fingerprint) {
      return { revision: entry.revision, fresh: false, first: false };
    }
    return this.#start(key, at, fingerprint, entry.revision + 1, false);
  }

  /** The revision of an event that happened at `at`. `0`: every occurrence is a new one. */
  event(key: string, at: number, repeatAfterMs: number): Revision {
    const entry = this.#keys.get(key);
    if (!entry) return this.#start(key, at, null, 1, true);
    if (at - entry.since < repeatAfterMs) {
      return { revision: entry.revision, fresh: false, first: false };
    }
    return this.#start(key, at, null, entry.revision + 1, false);
  }

  /** The current revision of `key`, `null` when it is not known. */
  current(key: string): number | null {
    return this.#keys.get(key)?.revision ?? null;
  }

  #start(
    key: string,
    since: number,
    fingerprint: string | null,
    revision: number,
    first: boolean,
  ): Revision {
    this.#keys.delete(key);
    this.#keys.set(key, { revision, since, fingerprint });
    while (this.#keys.size > MAX_KEYS) {
      const oldest = this.#keys.keys().next().value;
      if (oldest === undefined) break;
      this.#keys.delete(oldest);
    }
    return { revision, fresh: true, first };
  }

  /** Reads revisions back from the log; what is logged by this book changes nothing. */
  apply(event: LogEvent): void {
    const o = observationBody(event)?.observation;
    if (!o) return;
    const entry = this.#keys.get(o.attention_key);
    if (entry && entry.revision >= o.revision) return;
    this.#keys.delete(o.attention_key);
    this.#keys.set(o.attention_key, {
      revision: o.revision,
      since: timestampMs(event.at),
      fingerprint: null,
    });
  }
}
