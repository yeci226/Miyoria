// Proposals (docs/design/v3-architecture.md §10.5): the only door the background has. Her Plan,
// the memory followups and whatever else runs in the background write a `Proposal`; it cannot speak
// or act. Writing one also asks the Floor for a turn, because what she wants should not have to
// wait for someone to talk to her (§21 失去主動), but the main line decides what becomes of it, and
// it stays on the board, in her prompt, until it expires.
//
// A proposal to ask or tell someone something is a wish (`@miyoria/types` `wish.ts`): it joins
// the wish about that person and topic, is dropped before it reaches the Floor when that was
// answered or asked already (2026-11-10: memory, a commitment and her Plan raised the same
// question again and again), and leaves the board once she asked, whichever turn did it.

import type { ServiceLookup } from "@miyoria/kernel";
import {
  type ArbiterDecision,
  ArbiterKey,
  CHAT_DM,
  CHAT_START,
  type ContextKey,
  contextKeyEquals,
  DirectivesKey,
  type EventLog,
  type Impulse,
  type ImpulseSource,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type LogEvent,
  type NewProposal,
  newId,
  newImpulse,
  type Projection,
  type Proposal,
  type ProposalBoard,
  type ProposalBody,
  type ProposalOutcome,
  type ProposalResultBody,
  type ProposalState,
  type TurnId,
  timestampMs,
  WISH_SOURCE,
  type WishBody,
  WishesKey,
  wishHolder,
} from "@miyoria/types";

/** The capability of a proposal that means talking, whatever it says. */
export function isTalk(proposal: Pick<Proposal, "capability">): boolean {
  const c = proposal.capability;
  return c === undefined || c === CHAT_START || c === CHAT_DM;
}

/** What the board needs of the agent. */
export interface BoardDeps {
  log(): Pick<EventLog, "append"> | null;
  now(): number;
  services: ServiceLookup;
}

/** The claim of a proposal, under the proposal's own id. */
function claimOf(proposal: Proposal, now: number): Impulse {
  const talk = isTalk(proposal);
  const source = sourceOf(proposal);
  // Only what she wants herself counts as her starting something; a draft of the game director or
  // a followup is not her topic (`Impulse.source`).
  const own = source === "plan" || source === "agenda";
  const args: JsonObject = isJsonObject(proposal.args ?? null)
    ? { ...(proposal.args as JsonObject) }
    : {};
  const impulse = newImpulse(
    {
      source,
      kind: talk ? "speak" : "act",
      context: proposal.context,
      person: proposal.person,
      account: proposal.about,
      capability: proposal.capability ?? (own ? CHAT_START : null),
      args,
      ttlMs: Math.max(timestampMs(proposal.expires) - now, 0),
      why: proposal.why,
      hint: proposal.what,
      about: proposal.about === null ? [] : [proposal.about],
      goal: proposal.goal,
      reason: own ? "intent" : source === "game" ? "game" : "followup",
      claim: "wish",
      attention: proposal.attention ?? null,
    },
    now,
  );
  return { ...impulse, id: proposal.id, expires_at: proposal.expires };
}

/** Which kind of wish a writer's proposal is. */
function sourceOf(proposal: Proposal): ImpulseSource {
  if (proposal.source === "plan" || proposal.source === "agenda") return proposal.source;
  return proposal.source === "memory" ? "followup" : "game";
}

function stateOf(decision: ArbiterDecision): ProposalState {
  switch (decision.verdict) {
    case "accepted":
      return "taken";
    case "rejected":
      // A rule against it, or it was said already. What only has to wait stays until it expires.
      return decision.reason === "denied" || decision.reason === "repeat" ? "dropped" : "open";
    case "deferred":
    case "merged":
      return "open";
    default:
      return "dropped";
  }
}

export class Proposals implements ProposalBoard, Projection {
  readonly #d: BoardDeps;
  readonly #open = new Map<string, Proposal>();

  constructor(deps: BoardDeps) {
    this.#d = deps;
  }

  async propose(input: NewProposal, signal?: AbortSignal): Promise<ProposalOutcome> {
    const proposal: Proposal = { ...input, id: input.id ?? newId() };
    const body: ProposalBody = { proposal };
    const log = this.#d.log();
    if (log === null) this.#open.set(proposal.id, proposal);
    else {
      log.append({
        kind: "proposal",
        source: proposal.source,
        context: proposal.context,
        person: proposal.person,
        body: body as unknown as JsonValue,
      });
    }
    // Background cannot get around a rule (§9): what breaks one goes no further than this.
    const verdict = this.#d.services.get(DirectivesKey)?.screen(proposal);
    if (verdict !== undefined && verdict.outcome !== "allow") {
      this.settle(proposal.id, "dropped", verdict.reason, null);
      return { id: proposal.id, state: "dropped", detail: verdict.reason, turn: null };
    }
    const wishes = this.#d.services.get(WishesKey);
    if (wishes && proposal.person !== null) {
      const holder = wishHolder("proposal", proposal.id);
      wishes.hold(proposal.person, proposal.what, holder);
      const wished = await wishes.screen(
        { person: proposal.person, text: proposal.what, holder },
        signal,
      );
      if (!wished.raise) {
        this.settle(proposal.id, "dropped", wished.why, null);
        return { id: proposal.id, state: "dropped", detail: wished.why, turn: null };
      }
    }
    const arbiter = this.#d.services.get(ArbiterKey);
    if (!arbiter) {
      return { id: proposal.id, state: "open", detail: "等主線下次開口", turn: null };
    }
    const decision = await arbiter.submit(claimOf(proposal, this.#d.now()), signal);
    const state = stateOf(decision);
    if (state === "dropped") this.settle(proposal.id, "dropped", decision.detail, null);
    return { id: proposal.id, state, detail: decision.detail, turn: decision.turn };
  }

  /** What became of `id`, from the main line. */
  settle(
    id: string,
    state: Exclude<ProposalState, "open">,
    detail: string,
    turn: TurnId | null,
  ): void {
    const proposal = this.#open.get(id);
    if (!proposal) return;
    const body: ProposalResultBody = { proposal: id, state, detail, turn };
    const log = this.#d.log();
    if (log === null) this.#open.delete(id);
    else {
      log.append({
        kind: "result",
        source: "mainline",
        context: proposal.context,
        body: body as unknown as JsonValue,
      });
    }
  }

  #sweep(): void {
    const now = this.#d.now();
    for (const p of [...this.#open.values()]) {
      if (timestampMs(p.expires) <= now) this.settle(p.id, "expired", "過期了", null);
    }
  }

  open(context?: ContextKey | null): Proposal[] {
    this.#sweep();
    const all = [...this.#open.values()];
    if (context === undefined || context === null) return all;
    return all.filter((p) => p.context === null || contextKeyEquals(p.context, context));
  }

  /** The proposal behind `id`, if it is still open. */
  get(id: string): Proposal | null {
    return this.#open.get(id) ?? null;
  }

  apply(event: LogEvent): void {
    if (event.kind === "decision" && event.source === WISH_SOURCE) {
      this.#wished(event);
      return;
    }
    if (event.kind === "proposal" && isJsonObject(event.body)) {
      const { proposal } = event.body as unknown as Partial<ProposalBody>;
      if (isJsonObject(proposal ?? null) && typeof proposal?.id === "string") {
        this.#open.set(proposal.id, proposal);
      }
      return;
    }
    if (event.kind === "result" && isJsonObject(event.body)) {
      const { proposal, state } = event.body as unknown as Partial<ProposalResultBody>;
      if (typeof proposal === "string" && typeof state === "string") this.#open.delete(proposal);
    }
  }

  /** She asked what a proposal wanted asked, or it was answered: it leaves the board. */
  #wished(event: LogEvent): void {
    if (!isJsonObject(event.body)) return;
    const { wish } = event.body as unknown as Partial<WishBody>;
    if (!wish || wish.state === "open" || wish.end === "expired") return;
    const ids = (wish.holders ?? []).flatMap((h) =>
      h.startsWith("proposal:") ? [h.slice("proposal:".length)] : [],
    );
    if (!ids.some((id) => this.#open.has(id))) return;
    const asked = wish.end === null || wish.end === "asked";
    const detail = asked
      ? "問過了"
      : wish.end === "answered"
        ? "對方已經回答了"
        : "對方說問過了,不要再問";
    // Not in the middle of this event's delivery: the others must see it first.
    queueMicrotask(() => {
      for (const id of ids) this.settle(id, asked ? "taken" : "dropped", detail, null);
    });
  }
}
