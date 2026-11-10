// Her intents (from the mind loop / her Plan) as turns she starts herself, and the agent's side
// of the Arbiter (`ImpulseHost`).
//
// * `chat.start` / `chat.dm`: she only wants to talk. The gate decides (consent, approach and
//   DM opt-outs, strangers); its executor hands the intent to the context's coordinator, which
//   opens her turn (principal `self`, with tools) once the context is free.
// * Any other capability (join voice, go live, switch scene, ...): the action runs through the
//   gate first (principal `self`); if it succeeds and she has something to say, her turn opens
//   where she now is: the voice channel she joined (once she is in it) or the intent's context.
//
// While the Arbiter runs (`ArbiterKey`) it is the one gate: an intent becomes an impulse of
// source `plan`, the Arbiter applies its rules (quiet hours, her daily caps, the gaps and the
// unanswered backoff, the channel level) and, once it accepts, hands it back here
// (`ImpulseHost.open`) to run as above. Impulses that are not hers (songs, game commentary,
// followups, notices, greetings) open an initiative turn in their context.
//
// Under `pipeline = "v3"` nothing here acts. An accepted claim opens a turn of the main line, and
// an accepted proposal with a capability is one too: the turn sees what she wanted and decides,
// and only its hands call the capability. Only `chat.*`, which runs no action of its own, still
// goes through the gate here: consent is the gate's.

import type { ActuatorRegistry } from "@miyoria/actions";
import { errorMessage } from "@miyoria/kernel";
import {
  type ArbiterDecision,
  ArbiterKey,
  CHAT_DM,
  CHAT_START,
  type ContextKey,
  type ConversationFacts,
  claimOf,
  type Impulse,
  type ImpulseHost,
  type ImpulseRun,
  type Intent,
  type IntentOutcome,
  type IntentSink,
  impulseReason,
  isJsonObject,
  isSelfInitiated,
  type JsonValue,
  newId,
  newImpulse,
  Principals,
  type TalkCeiling,
  type TurnId,
  toTimestamp,
} from "@miyoria/types";
import { modeLabel } from "./levels.js";
import { ACTING_ALONE } from "./mainline/main.js";
import type { Agent, IntentTurn } from "./runtime.js";

/** An intent handed to the Arbiter, waiting to be run (and what running it gave). */
interface Submitted {
  intent: Intent;
  outcome: IntentOutcome | null;
}

export class AgentIntents implements IntentSink, ImpulseHost {
  /** Intent turns waiting for their `chat.*` capability to run, by turn id. */
  readonly #waiting = new Map<TurnId, IntentTurn>();
  /** Intents submitted to the Arbiter, by impulse id. */
  readonly #submitted = new Map<string, Submitted>();

  constructor(
    private readonly agent: Agent,
    private readonly registry: () => ActuatorRegistry,
  ) {}

  /** The intent turn a `chat.*` executor runs for `turn`, if it came through `submit`. */
  take(turn: TurnId | null): IntentTurn | null {
    if (turn === null) return null;
    const input = this.#waiting.get(turn) ?? null;
    this.#waiting.delete(turn);
    return input;
  }

  /** The level of a text channel and whether it lets her start talking there now. */
  ceiling(context: ContextKey): TalkCeiling | null {
    if (context.kind === "voice" || context.kind === "dm") return null;
    const mode = this.agent.handle.channelMode(context);
    return { mode, label: modeLabel(mode), blocked: this.agent.startBlocked(context) };
  }

  async submit(intent: Intent, signal?: AbortSignal): Promise<IntentOutcome> {
    const now = this.agent.ctx.clock.now();
    if (now >= Date.parse(intent.expires_at)) {
      return { status: "dropped", detail: "expired", turn: null };
    }
    const arbiter = this.agent.ctx.services.get(ArbiterKey);
    if (!arbiter) return this.#run(intent, signal, false);
    const impulse = impulseOfIntent(intent, now);
    const slot: Submitted = { intent, outcome: null };
    this.#submitted.set(impulse.id, slot);
    try {
      const decision = await arbiter.submit(impulse, signal);
      return slot.outcome ?? outcomeOf(decision);
    } catch (error) {
      return { status: "failed", detail: errorMessage(error), turn: null };
    } finally {
      this.#submitted.delete(impulse.id);
    }
  }

  // ---- ImpulseHost --------------------------------------------------------------------------

  facts(context: ContextKey): ConversationFacts {
    return this.agent.facts(context);
  }

  async open(impulse: Impulse, signal?: AbortSignal): Promise<ImpulseRun> {
    const talkOnly = impulse.capability === CHAT_START || impulse.capability === CHAT_DM;
    const main = this.agent.mainline;
    const attention = impulse.attention ?? null;
    if (main !== null && attention !== null) {
      // A retry of something a turn is already on (the context answered too late for the first
      // try, 2026-11-10 11:07) is that turn, not a second one.
      const live = main.liveTurn(attention);
      if (live !== null) return { status: "started", turn: live, task: null, detail: "已經在處理" };
      const promise = /^commitment:(.+)$/.exec(attention.key)?.[1];
      if (promise !== undefined && !main.commitments.open().some((c) => c.id === promise)) {
        return { status: "refused", reason: "repeat", detail: "這個承諾已經結束了" };
      }
    }
    if (main !== null && impulse.target.context !== null) {
      this.agent.yieldTo(impulse.target.context, claimOf(impulse));
    }
    if (isSelfInitiated(impulse.source) || talkOnly || impulse.kind === "act") {
      const slot = this.#submitted.get(impulse.id);
      const intent = slot?.intent ?? intentOfImpulse(impulse, this.agent.ctx.clock.now());
      if (main !== null && !talkOnly) return this.#propose(intent);
      const outcome = await this.#run(intent, signal, true);
      if (slot) slot.outcome = outcome;
      return runOf(outcome);
    }
    const context = impulse.target.context;
    if (context === null) {
      return { status: "refused", reason: "denied", detail: "沒有地方可以說" };
    }
    return this.agent.openInitiative(context, {
      reason: impulseReason(impulse),
      hint: impulse.hint ?? "",
      about: [...impulse.about],
      ...(main === null
        ? {}
        : {
            attention: impulse.attention ?? null,
            claim: claimOf(impulse),
            chain: main.takeChain(impulse.id),
            proposal:
              main.proposals.get(impulse.id) === null ? null : { id: impulse.id, tool: null },
          }),
    });
  }

  /**
   * V3: what her Plan wants done goes to a turn of the main line, which may do it. She can want
   * something with nobody around (join a channel, start a game): that turn acts without talking.
   */
  #propose(intent: Intent): ImpulseRun {
    const agent = this.agent;
    const capability = this.registry().get(intent.capability);
    const tool = capability?.tool?.name ?? intent.capability.replaceAll(".", "_");
    const context = intent.context === null ? null : agent.ownLinesContext(intent.context);
    const place = context !== null && (context.kind !== "voice" || agent.inVoice(context));
    const where = place ? context : ACTING_ALONE;
    const refused = agent.mainline?.floor()?.refuses("wish", where, intent.why) ?? null;
    const input: IntentTurn = {
      intent,
      turn: newId(),
      done: null,
      summary: capability?.summary ?? null,
      gated: true,
      tool,
      muted: !place || refused !== null,
    };
    const why = agent.deliverIntent(where, input);
    if (why !== null) return { status: "refused", reason: "denied", detail: why };
    // What she wanted to say once she is in there waits for her to arrive.
    const opening = intent.opening?.trim() ?? "";
    if (intent.capability === "voice.join" && opening !== "") {
      const room = joinedContext(intent, intent.args);
      if (room !== null) {
        const talk: Intent = { ...intent, id: newId(), capability: CHAT_START };
        agent.deliverOnArrival(room, {
          ...input,
          intent: talk,
          turn: newId(),
          tool: null,
          muted: false,
        });
      }
    }
    return { status: "started", turn: input.turn, task: null, detail: "交給主線決定" };
  }

  // ---- running an intent ----------------------------------------------------------------------

  /** Runs `intent` (gate first, then her turn); `gated`: the Arbiter already let it through. */
  async #run(
    intent: Intent,
    signal: AbortSignal | undefined,
    gated: boolean,
  ): Promise<IntentOutcome> {
    const registry = this.registry();
    const turn = newId();
    const capability = registry.get(intent.capability);
    const input: IntentTurn = {
      intent,
      turn,
      done: null,
      summary: capability?.summary ?? null,
      gated,
    };
    const request = {
      principal: Principals.self(intent.context, null),
      capability: intent.capability,
      args: intent.args,
      why: intent.why === "" ? null : intent.why,
      turn,
      about: intent.about,
    };
    const talkOnly = intent.capability === CHAT_START || intent.capability === CHAT_DM;
    if (talkOnly) this.#waiting.set(turn, input);
    let outcome: Awaited<ReturnType<ActuatorRegistry["invoke"]>>;
    try {
      outcome = await registry.invoke(
        request,
        talkOnly ? { signal } : { signal, priority: "initiative" },
      );
    } catch (error) {
      return { status: "failed", detail: errorMessage(error), turn };
    } finally {
      this.#waiting.delete(turn);
    }
    switch (outcome.status) {
      case "denied":
        return { status: "denied", detail: outcome.decision.reason, turn };
      case "failed":
        return { status: "failed", detail: outcome.error, turn };
      case "done":
        break;
    }
    const result = outcome.result;
    if (talkOnly) return { status: "started", detail: result.text, turn };
    const opening = intent.opening?.trim() ?? "";
    if (opening === "") return { status: "done", detail: result.text, turn };
    const talk: IntentTurn = { ...input, done: result.text };
    const joined = intent.capability === "voice.join" ? joinedContext(intent, result.data) : null;
    if (joined !== null) {
      this.agent.deliverOnArrival(joined, talk);
      return { status: "started", detail: result.text, turn };
    }
    if (intent.context === null) return { status: "done", detail: result.text, turn };
    const where = this.agent.ownLinesContext(intent.context);
    // She may still act on her own; only talking about it to nobody waits.
    if (this.agent.waitingForResponse(where)) {
      return { status: "done", detail: `${result.text} (not talking: nobody answered)`, turn };
    }
    const why = this.agent.deliverIntent(where, talk);
    return why === null
      ? { status: "started", detail: result.text, turn }
      : { status: "done", detail: `${result.text} (not talking: ${why})`, turn };
  }
}

/** Her intent as an impulse for the Arbiter (source `plan`). */
export function impulseOfIntent(intent: Intent, now: number): Impulse {
  const talkOnly = intent.capability === CHAT_START || intent.capability === CHAT_DM;
  const impulse = newImpulse(
    {
      source: "plan",
      kind: talkOnly ? "speak" : "act",
      context: intent.context,
      account: intent.about,
      capability: intent.capability,
      args: intent.args,
      ttlMs: Math.max(Date.parse(intent.expires_at) - now, 0),
      why: intent.why,
      hint: intent.opening,
      about: intent.about === null ? [] : [intent.about],
      reason: "intent",
    },
    now,
  );
  return { ...impulse, expires_at: intent.expires_at };
}

/** An impulse of hers that did not come through `submit` (her Plan used the Arbiter directly). */
export function intentOfImpulse(impulse: Impulse, now: number): Intent {
  const capability =
    impulse.capability ??
    (impulse.target.context === null && impulse.target.account !== null ? CHAT_DM : CHAT_START);
  const args = { ...impulse.args };
  delete args.reason;
  if (capability === CHAT_DM && typeof args.to !== "string" && impulse.target.account !== null) {
    args.to = impulse.target.account.id;
  }
  return {
    id: impulse.id,
    capability,
    args,
    why: impulse.why,
    opening: impulse.hint,
    context: impulse.target.context?.kind === "dm" ? null : impulse.target.context,
    about: impulse.target.account,
    created_at: toTimestamp(now),
    expires_at: impulse.expires_at,
  };
}

/** What running an intent means for the Arbiter. */
function runOf(outcome: IntentOutcome): ImpulseRun {
  switch (outcome.status) {
    case "started":
    case "done":
      return { status: "started", turn: outcome.turn, task: null, detail: outcome.detail };
    case "denied":
      return { status: "refused", reason: "denied", detail: outcome.detail };
    default:
      return {
        status: "refused",
        reason: "denied",
        detail: `${outcome.status}: ${outcome.detail}`,
      };
  }
}

/** The Arbiter said no (or not yet) before her intent ran. */
function outcomeOf(decision: ArbiterDecision): IntentOutcome {
  const detail = `${decision.reason ?? decision.verdict}: ${decision.detail}`;
  switch (decision.verdict) {
    case "accepted":
      return { status: "started", detail: decision.detail, turn: decision.turn };
    case "rejected":
      return { status: "denied", detail, turn: null };
    case "deferred":
      return { status: "pending", detail, turn: null };
    default:
      return { status: "dropped", detail, turn: null };
  }
}

/** The voice context `voice.join` put her in (its result carries the channel id). */
function joinedContext(intent: Intent, data: JsonValue): ContextKey | null {
  const channel = isJsonObject(data) ? data.channel : null;
  if (typeof channel !== "string" || channel === "") return null;
  const guild =
    typeof intent.args.guild === "string" && intent.args.guild !== ""
      ? intent.args.guild
      : (intent.context?.scope ?? null);
  if (guild === null) return null;
  return {
    platform: intent.context?.platform ?? "discord",
    scope: guild,
    channel,
    kind: "voice",
  };
}
