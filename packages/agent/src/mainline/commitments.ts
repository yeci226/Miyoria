// Commitments (docs/design/v3-architecture.md §10.2): what she said she would do, as objects, so a
// promise cannot just evaporate. They live in the log (a `decision` per change), so a restart keeps
// them. An overdue one comes back twice: in the prompt on every turn, and once as an observation
// that may ask for the mic. Then she does it or says so herself.

import {
  type Commitment,
  type CommitmentBody,
  type CommitmentDraft,
  type ContextKey,
  contextKeyEquals,
  type EventLog,
  isJsonObject,
  type JsonValue,
  type LogEvent,
  newId,
  type Observation,
  type Projection,
  type TurnId,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";

export const COMMITMENT_SOURCE = "mainline.commitment";
/** Overdue this long, a promise is closed as broken: it is no use to her prompt any more. */
const MAX_OVERDUE_MS = 30 * 60_000;

/** `game.start` and `game_start` name the same thing. */
function sameTool(a: string, b: string): boolean {
  return a.replaceAll(".", "_") === b.replaceAll(".", "_");
}

export class CommitmentBook implements Projection {
  readonly #log: () => Pick<EventLog, "append" | "observe"> | null;
  readonly #now: () => number;
  readonly #defaultDueSecs: number;
  readonly #open = new Map<string, Commitment>();

  constructor(
    log: () => Pick<EventLog, "append" | "observe"> | null,
    now: () => number,
    defaultDueSecs: number,
  ) {
    this.#log = log;
    this.#now = now;
    this.#defaultDueSecs = defaultDueSecs;
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

  add(
    draft: CommitmentDraft,
    context: ContextKey,
    turn: TurnId | null,
    cause: string | null,
  ): Commitment {
    const now = this.#now();
    const commitment: Commitment = {
      id: newId(),
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
    if (event.kind !== "decision" || event.source !== COMMITMENT_SOURCE) return;
    if (!isJsonObject(event.body) || !isJsonObject(event.body.commitment)) return;
    this.#take((event.body as unknown as CommitmentBody).commitment);
  }
}
