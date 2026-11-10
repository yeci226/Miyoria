// Outcomes she should know about, in the Ledger-ready form (v2 §1.4: "她不知道自己做了什麼").
//
// Medium- and high-risk runs used to end as a log line (high risk: `REVIEW_PENDING`, then the
// result went to the log only) or as a string in one tool result. Now every such outcome is a
// `LedgerRecord`: written to the Ledger when the Arbiter runs (`ArbiterKey.record`), otherwise
// published on `ACTION_OUTCOME_TOPIC` for whoever keeps one. A late result (a high-risk tool that
// answered "pending" and nobody waits for any more) is also a `Notice` for her conversation.

import type { ServiceLookup } from "@miyoria/kernel";
import {
  ArbiterKey,
  customEvent,
  type Event,
  type ImpulseSource,
  type JsonValue,
  type LedgerOutcome,
  type LedgerRecord,
  NOTICE_TOPIC,
  type Notice,
  newId,
  type Principal,
  type TaskFailureCode,
  toTimestamp,
  v2Event,
} from "@miyoria/types";
import type { ActionOutcome, ActionRequest, Capability } from "./capability.js";
import { deniedText } from "./capability.js";

/** Payload: `ActionOutcomeRecord`; published when no Arbiter keeps the Ledger. */
export const ACTION_OUTCOME_TOPIC = "actions.outcome";

/** How long a late result stays worth telling her (ms). */
export const NOTICE_TTL_MS = 30 * 60_000;

const MAX_TEXT = 300;

/** `ACTION_OUTCOME_TOPIC` payload: the ledger record plus what ran. */
export interface ActionOutcomeRecord extends LedgerRecord {
  capability: string;
  status: ActionOutcome["status"];
  at: string;
}

/** The ledger source of a principal (who started it). */
export function ledgerSource(principal: Principal, turn: string | null): ImpulseSource {
  switch (principal.kind) {
    case "command":
      return "command";
    case "panel":
      return "panel";
    case "director":
      return "game";
    case "user":
      return "message";
    case "self":
      // In a conversation she acts for whoever she talks to; without a turn it was her plan.
      return turn === null ? "plan" : "message";
  }
}

function clip(text: string): string {
  const chars = [...text.trim()];
  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT).join("")}…` : chars.join("");
}

function ledgerOutcome(outcome: ActionOutcome): LedgerOutcome {
  return outcome.status === "done" ? "ok" : outcome.status === "denied" ? "denied" : "failed";
}

function detailOf(outcome: ActionOutcome): string {
  switch (outcome.status) {
    case "done":
      return clip(outcome.result.text);
    case "denied":
      return clip(`${deniedText(outcome.decision.stage)}(${outcome.decision.reason})`);
    case "failed":
      return clip(outcome.error);
  }
}

function codeOf(outcome: ActionOutcome): TaskFailureCode | null {
  return outcome.status === "done" ? null : outcome.status === "denied" ? "denied" : "internal";
}

/** The notice for a late outcome (she asked in `request`'s context). */
export function outcomeNotice(
  capability: Capability,
  request: ActionRequest,
  outcome: ActionOutcome,
  now: number,
): Notice {
  const ok = outcome.status === "done";
  const head = ok ? `${capability.summary}:做好了` : `${capability.summary}:沒有做成`;
  return {
    id: newId(),
    at: toTimestamp(now),
    source: "actions",
    task: null,
    turn: request.turn,
    context: request.principal.context,
    ok,
    code: codeOf(outcome),
    text: clip(`${head}(${detailOf(outcome)})`),
    expires_at: toTimestamp(now + NOTICE_TTL_MS),
  };
}

export interface OutcomeSink {
  services: ServiceLookup;
  publish: (event: Event) => void;
  now: number;
}

/** Records `outcome` in the Ledger (or publishes it on `ACTION_OUTCOME_TOPIC`). */
export function recordOutcome(
  sink: OutcomeSink,
  capability: Capability,
  request: ActionRequest,
  outcome: ActionOutcome,
): void {
  const record: LedgerRecord = {
    kind: "task",
    source: ledgerSource(request.principal, request.turn),
    context: request.principal.context,
    person: null,
    summary: capability.summary,
    outcome: ledgerOutcome(outcome),
    detail: detailOf(outcome),
    impulse: null,
    turn: request.turn,
    task: null,
  };
  const arbiter = sink.services.get(ArbiterKey);
  if (arbiter) {
    arbiter.record(record);
  } else {
    const payload: ActionOutcomeRecord = {
      ...record,
      capability: capability.name,
      status: outcome.status,
      at: toTimestamp(sink.now),
    };
    sink.publish(customEvent(ACTION_OUTCOME_TOPIC, payload as unknown as JsonValue));
  }
}

/** Tells her a late outcome (`agent.notice`). */
export function publishNotice(
  sink: OutcomeSink,
  capability: Capability,
  request: ActionRequest,
  outcome: ActionOutcome,
): void {
  sink.publish(v2Event(NOTICE_TOPIC, outcomeNotice(capability, request, outcome, sink.now)));
}
