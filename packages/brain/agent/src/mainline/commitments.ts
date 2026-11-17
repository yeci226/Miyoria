// Commitments (docs/design/v3-architecture.md §10.2): what she said she would do, as objects, so a
// promise cannot just evaporate. They live in the log (a `decision` per change), so a restart keeps
// them. An overdue one comes back twice: in the prompt on every turn, and once as an observation
// that may ask for the mic. Then she does it or says so herself.
//
// A promise to ask someone something is a wish (`@miyoria/types` `wish.ts`): it is held under the
// same key as the proposal or goal it came from, and it is kept once she asked, wherever and
// however she did. 2026-11-10: "after 11:02 ask S about X" had no capability, so the DM she sent
// at 11:07 kept nothing; the promise stayed overdue in her prompt, the DM's own result turn asked
// again five seconds later, and at 11:37 it was closed as broken although she had asked.

import {
  type Commitment,
  type CommitmentBody,
  type CommitmentDraft,
  type ContextKey,
  contextKeyEquals,
  type EventLog,
  type Handle,
  isJsonObject,
  type JsonValue,
  type LogEvent,
  newId,
  type Observation,
  type Projection,
  type TurnId,
  timestampMs,
  toTimestamp,
  WISH_SOURCE,
  type WishBody,
  type Wishes,
  wishHolder,
} from "@miyoria/types";

export const COMMITMENT_SOURCE = "mainline.commitment";
/** Overdue this long, a promise is closed as broken: it is no use to her prompt any more. */
const MAX_OVERDUE_MS = 30 * 60_000;

/** Words of a promise that is kept by saying something to someone. */
const TALK_WHAT = /問|聊聊|告訴|跟.{0,12}說|提醒|關心|私訊|回覆|\bask\b|\btell\b|\bdm\b/i;

/** Whether `what` is a promise to say something (it needs no tool). */
export function isTalkPromise(what: string): boolean {
  return TALK_WHAT.test(what);
}

/** `game.start` and `game_start` name the same thing. */
function sameTool(a: string, b: string): boolean {
  return a.replaceAll(".", "_") === b.replaceAll(".", "_");
}

export class CommitmentBook implements Projection {
  readonly #log: () => Pick<EventLog, "append" | "observe"> | null;
  readonly #now: () => number;
  readonly #defaultDueSecs: number;
  readonly #open = new Map<string, Commitment>();
  readonly #wishes: () => Wishes | null;

  constructor(
    log: () => Pick<EventLog, "append" | "observe"> | null,
    now: () => number,
    defaultDueSecs: number,
    wishes: () => Wishes | null = () => null,
  ) {
    this.#log = log;
    this.#now = now;
    this.#defaultDueSecs = defaultDueSecs;
    this.#wishes = wishes;
  }

  #write(commitment: Commitment, cause: string | null): void {
    const body: CommitmentBody = { commitment };
    const log = this.#log();
    if (log === null) {
      this.#take(commitment);
      return;
    }
    log.append({
      kind: "decision",
      source: COMMITMENT_SOURCE,
      cause,
      context: commitment.context,
      body: body as unknown as JsonValue,
    });
  }

  #take(commitment: Commitment): void {
    if (commitment.status === "open") this.#open.set(commitment.id, commitment);
    else this.#open.delete(commitment.id);
  }

  /**
   * A new promise. `person`: whom it is about, when it is one to ask or tell someone something:
   * it joins that wish, and a wish they answered or asked her to stop takes no new promise
   * (`null`: not made).
   */
  add(
    draft: CommitmentDraft,
    context: ContextKey,
    turn: TurnId | null,
    cause: string | null,
    person: Handle | null = null,
  ): Commitment | null {
    const now = this.#now();
    const id = newId();
    const wish = this.#wishes()?.hold(person, draft.what, wishHolder("commitment", id)) ?? null;
    if (wish?.state === "closed") return null;
    const commitment: Commitment = {
      id,
      what: draft.what,
      capability: draft.capability,
      due: toTimestamp(now + (draft.due_secs ?? this.#defaultDueSecs) * 1000),
      status: "open",
      context,
      turn,
      made_at: toTimestamp(now),
      reminded: false,
    };
    this.#write(commitment, cause);
    return commitment;
  }

  /** What she still owes, oldest first (`context`: there). */
  open(context?: ContextKey): Commitment[] {
    const all = [...this.#open.values()];
    const here =
      context === undefined ? all : all.filter((c) => contextKeyEquals(c.context, context));
    return here.sort((a, b) => timestampMs(a.made_at) - timestampMs(b.made_at));
  }

  overdue(context?: ContextKey): Commitment[] {
    const now = this.#now();
    return this.open(context).filter((c) => timestampMs(c.due) <= now);
  }

  /** `tool` finished: what it was promised for is kept. */
  kept(tool: string, cause: string | null): void {
    for (const c of this.open()) {
      if (c.capability !== null && sameTool(c.capability, tool)) {
        this.#write({ ...c, status: "kept" }, cause);
      }
    }
  }

  /** She said what `commitment` promised to say: a promise to talk is kept by talking. */
  said(commitment: Commitment, cause: string | null): void {
    const open = this.#open.get(commitment.id);
    if (open) this.#write({ ...open, status: "kept" }, cause);
  }

  /** She said on stage that she will not do `commitments`: they are closed, and honestly so. */
  admitted(commitments: readonly Commitment[], cause: string | null): void {
    for (const c of commitments) this.#write({ ...c, status: "broken" }, cause);
  }

  /** Overdue commitments she was not reminded of yet ask for the mic. */
  remind(): void {
    const log = this.#log();
    if (log === null) return;
    const now = this.#now();
    for (const c of this.overdue()) {
      if (now - timestampMs(c.due) > MAX_OVERDUE_MS) {
        this.#write({ ...c, status: "broken" }, null);
        continue;
      }
      if (c.reminded) continue;
      this.#write({ ...c, reminded: true }, null);
      const observation: Observation = {
        source: COMMITMENT_SOURCE,
        silent: false,
        salience: "notable",
        attention_key: `commitment:${c.id}`,
        revision: 1,
        summary: `你剛說要「${c.what}」,還沒做`,
        addressed_to_her: false,
        from: null,
        context: c.context,
      };
      log.observe(observation);
    }
  }

  apply(event: LogEvent): void {
    if (event.kind === "decision" && event.source === WISH_SOURCE) {
      this.#wished(event);
      return;
    }
    if (event.kind !== "decision" || event.source !== COMMITMENT_SOURCE) return;
    if (!isJsonObject(event.body) || !isJsonObject(event.body.commitment)) return;
    this.#take((event.body as unknown as CommitmentBody).commitment);
  }

  /** She asked what a promise of hers was about, or it was answered: the promise is kept. */
  #wished(event: LogEvent): void {
    if (!isJsonObject(event.body)) return;
    const { wish } = event.body as unknown as Partial<WishBody>;
    if (!wish || wish.state === "open" || wish.end === "expired") return;
    const kept = (wish.holders ?? []).flatMap((h) => {
      if (!h.startsWith("commitment:")) return [];
      const c = this.#open.get(h.slice("commitment:".length));
      return c === undefined ? [] : [c];
    });
    if (kept.length === 0) return;
    // Not in the middle of this event's delivery: the others must see it first.
    queueMicrotask(() => {
      for (const c of kept) {
        const open = this.#open.get(c.id);
        if (open) this.#write({ ...open, status: "kept" }, event.id);
      }
    });
  }
}
