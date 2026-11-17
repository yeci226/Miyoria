// Her promises as the segment pass sees them: what she said she would do in a conversation
// ("我等等幫你查", "明天提醒你"), recorded in the agent's commitment book (`PromiseBook`), which
// her `commitment` opportunity reads (an overdue one wakes her), and closed there when a later
// conversation shows she did it.

import {
  type Commitment,
  type ContextKey,
  type PersonId,
  type PromiseBook,
  type Timestamp,
  timestampMs,
} from "@miyoria/types";

/** A promise still open, as the pass shows it. */
export interface OpenPromise {
  id: string;
  what: string;
  due: Timestamp;
  made_at: Timestamp;
}

/** A promise the pass found in a segment. */
export interface NewPromise {
  what: string;
  /** Whom it was made to; `null`: nobody in particular. */
  to: PersonId | null;
  /** When she said it would be done; `null`: not said (the book's default). */
  due: Timestamp | null;
  context: ContextKey;
}

/** Where the pass reads, records and closes her promises. */
export interface PromiseLedger {
  /** Open promises made in `context`, oldest first. */
  open(context: ContextKey): OpenPromise[];
  /** Records a promise; the id, `null`: not made (no book, or one about a closed wish). */
  make(promise: NewPromise): string | null;
  /** `id` is kept; whether it was open. */
  keep(id: string): boolean;
}

export interface CommitmentLedgerOptions {
  /** The book's own clock: a due time is given to it as seconds from now. */
  now: () => number;
  /** Her name for a person (a handle), so a promise to ask them joins the wish about it. */
  handleOf?: (person: PersonId) => string | null;
}

const asOpen = (c: Commitment): OpenPromise => ({
  id: c.id,
  what: c.what,
  due: c.due,
  made_at: c.made_at,
});

/** A `PromiseLedger` over the agent's book, looked up on each use (it may start later). */
export function commitmentLedger(
  book: () => PromiseBook | null,
  options: CommitmentLedgerOptions,
): PromiseLedger {
  return {
    open(context) {
      return (book()?.open(context) ?? []).map(asOpen);
    },
    make(promise) {
      const b = book();
      if (b === null) return null;
      const dueSecs =
        promise.due === null
          ? null
          : Math.max(0, Math.round((timestampMs(promise.due) - options.now()) / 1000));
      const handle = promise.to === null ? null : (options.handleOf?.(promise.to) ?? null);
      return (
        b.add(
          { what: promise.what, capability: null, due_secs: dueSecs },
          promise.context,
          null,
          null,
          handle,
        )?.id ?? null
      );
    },
    keep(id) {
      const b = book();
      const open = b?.open().find((c) => c.id === id);
      if (b === null || open === undefined) return false;
      b.said(open, null);
      return true;
    },
  };
}
