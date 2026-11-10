// What a replay says about "順不順" (v2 §4): per-turn outcomes, whether she answered who called
// her (and only them), how often she spoke when called in voice, what the Arbiter blocked and
// why, and what the ActivityManager was left holding.

import {
  type AccountRef,
  ARBITER_DECISION_TOPIC,
  type ArbiterDecision,
  type ContextKey,
  type Event,
  type IncomingMessage,
  isJsonObject,
  isSelfInitiated,
  type MessageRef,
  sameAccount,
  TURN_FOCUS_TOPIC,
  TURN_OUTCOME_TOPIC,
  type TurnOutcomeRecord,
  type VoiceUtterance,
  v2Payload,
} from "@miyoria/types";
import type { ReplayRun } from "./runner.js";

/** An input that called her: a mention, a reply to her, a DM or her name. */
export interface Address {
  id: string;
  context: ContextKey;
  voice: boolean;
  author: AccountRef;
  who: string;
  text: string;
  /** A turn whose focus held it ended `sent`. */
  answered: boolean;
}

export interface TurnLine {
  turn: string;
  context: string;
  reason: string;
  /** `sent` / `silence` / `cancelled` / `error`. */
  outcome: string;
  /** `cancelled`: the cause and who caused it. */
  cause: string | null;
  by: string | null;
  addressed_by: string[];
  focus: string[];
  /** A sent turn that answered someone who called her: only them, them first. `null`: n/a. */
  focus_correct: boolean | null;
}

export interface Rate {
  num: number;
  den: number;
  /** `null` when there was nothing to count. */
  rate: number | null;
}

export interface ReplayReport {
  name: string;
  duration_ms: number;
  inputs: number;
  turns: TurnLine[];
  outcomes: Record<string, number>;
  /** Cancelled turns by cause. */
  cancelled_by: Record<string, number>;
  addresses: Address[];
  /** Voice inputs that called her and got spoken to (v2 §4 stage 0: > 70%). */
  voice_direct_speak_rate: Rate;
  /** Text inputs that called her and got a reply. */
  text_direct_reply_rate: Rate;
  /** Sent turns that answered the right people (focus correct). */
  focus_correct_rate: Rate;
  arbiter: {
    decisions: number;
    by_verdict: Record<string, number>;
    /** Blocked (rejected / deferred / dropped) by reason. */
    blocked_by_reason: Record<string, number>;
    /** Her own (plan / agenda) impulses that were blocked (v2 §4 stage 2: < 20%). */
    self_initiated_block_rate: Rate;
    /** Topics she raised herself that nobody picked up (`affect.event` `topic_ignored`). */
    topics_ignored: number;
    /** Her own impulses that were blocked: when, why (what she was told). */
    self_initiated_blocked: { at: string; source: string; reason: string; detail: string }[];
  };
  activity: {
    snapshot: string;
    /** Tasks still queued or running at the end. */
    open_tasks: number;
    /** A resource left mid-transition or failed. */
    residual: string[];
  };
  /** Model calls by reasoning purpose. */
  llm_calls: Record<string, number>;
}

const rate = (num: number, den: number): Rate => ({
  num,
  den,
  rate: den === 0 ? null : Math.round((num / den) * 1000) / 1000,
});

function count<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of items) {
    const k = key(t);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function contextId(c: ContextKey): string {
  return `${c.platform}:${c.scope ?? "-"}:${c.kind}:${c.channel}`;
}

/** Her names as she is called by (lower case). */
function calledBy(text: string, names: readonly string[]): boolean {
  const t = text.toLowerCase();
  return names.some((n) => n.trim() !== "" && t.includes(n.toLowerCase()));
}

function addressOf(event: Event, names: readonly string[]): Omit<Address, "answered"> | null {
  if (event.type === "platform_message_created") {
    const m: IncomingMessage = event.data;
    const direct =
      m.mentions_self || m.reply_to_self || m.id.context.kind === "dm" || calledBy(m.text, names);
    if (!direct) return null;
    return {
      id: m.id.id,
      context: m.id.context,
      voice: m.id.context.kind === "voice",
      author: m.author.account,
      who: m.author.display_name,
      text: m.text,
    };
  }
  if (event.type === "voice_utterance") {
    const u: VoiceUtterance = event.data;
    if (!calledBy(u.text, names)) return null;
    return {
      id: u.id,
      context: u.context,
      voice: true,
      author: u.speaker.account,
      who: u.speaker.display_name,
      text: u.text,
    };
  }
  return null;
}

/** Who wrote each input message / utterance, by id. */
function authorsOf(run: ReplayRun): Map<string, AccountRef> {
  const out = new Map<string, AccountRef>();
  for (const entry of run.inputs) {
    const e = entry.event;
    if (e.type === "platform_message_created") out.set(e.data.id.id, e.data.author.account);
    else if (e.type === "voice_utterance") out.set(e.data.id, e.data.speaker.account);
  }
  return out;
}

/**
 * A sent turn that had a call in its input answered the right people: its focus holds the
 * input that called her (not left in the background),
 * and every focus message is by someone who called her in it (nobody's interjection got the
 * answer meant for the caller). A text reply that quotes a message quotes one that called her.
 */
function focusCorrect(
  record: TurnOutcomeRecord,
  addresses: ReadonlyMap<string, Omit<Address, "answered">>,
  authors: ReadonlyMap<string, AccountRef>,
  quoted: readonly MessageRef[],
): boolean {
  const focus = record.focus.map((r) => r.id);
  const calls = focus.filter((id) => addresses.has(id));
  if (calls.length === 0) return false;
  const callers = calls.flatMap((id) => {
    const a = addresses.get(id);
    return a ? [a.author] : [];
  });
  const onlyCallers = focus.every((id) => {
    const author = authors.get(id);
    return author !== undefined && callers.some((c) => sameAccount(c, author));
  });
  const quotesCaller = quoted.every((ref) => addresses.has(ref.id));
  return onlyCallers && quotesCaller;
}

/** The report of a replay. */
export function buildReport(run: ReplayRun): ReplayReport {
  const records = run.events.flatMap((env) => {
    const r = v2Payload(env.event, TURN_OUTCOME_TOPIC);
    return r ? [r] : [];
  });
  const decisions = run.events.flatMap((env) => {
    const d = v2Payload(env.event, ARBITER_DECISION_TOPIC);
    return d ? [d as ArbiterDecision] : [];
  });

  const addressList = run.inputs.flatMap((e) => {
    const a = addressOf(e.event, run.names);
    return a ? [a] : [];
  });
  const addressById = new Map(addressList.map((a) => [a.id, a] as const));
  const authors = authorsOf(run);
  const answered = new Set<string>();
  for (const r of records) {
    if (r.outcome.type === "sent") for (const f of r.focus) answered.add(f.id);
  }
  const addresses: Address[] = addressList.map((a) => ({ ...a, answered: answered.has(a.id) }));

  // Each turn's background input (the last `agent.turn.focus` of the turn).
  const background = new Map<string, MessageRef[]>();
  for (const env of run.events) {
    const f = v2Payload(env.event, TURN_FOCUS_TOPIC);
    if (f) background.set(f.turn, f.background);
  }

  // The messages each turn's text replies quoted.
  const quotes = new Map<string, MessageRef[]>();
  for (const { action } of run.sink.messages()) {
    const p = action.payload;
    if (p.type !== "send_message" || action.turn === null || p.message.reply_to === null) continue;
    quotes.set(action.turn, [...(quotes.get(action.turn) ?? []), p.message.reply_to]);
  }

  const turns: TurnLine[] = records.map((r) => {
    const o = r.outcome;
    // Judged: a sent turn that had a call (name, mention, reply, DM) among its input.
    const input = [...r.focus, ...(background.get(r.turn) ?? [])];
    const answering = o.type === "sent" && input.some((m) => addressById.has(m.id));
    return {
      turn: r.turn,
      context: contextId(r.context),
      reason: r.reason,
      outcome: o.type,
      cause: o.type === "cancelled" ? o.cause : null,
      by: o.type === "cancelled" ? o.by : null,
      addressed_by: r.addressed_by,
      focus: r.focus.map((f) => f.id),
      focus_correct: answering
        ? focusCorrect(r, addressById, authors, quotes.get(r.turn) ?? [])
        : null,
    };
  });

  const voiceCalls = addresses.filter((a) => a.voice);
  const textCalls = addresses.filter((a) => !a.voice);
  const judged = turns.filter((t) => t.focus_correct !== null);
  const blocked = decisions.filter((d) => d.verdict !== "accepted" && d.verdict !== "merged");
  // An impulse may be decided more than once (deferred, then accepted): its last word counts.
  const last = new Map<string, ArbiterDecision>();
  for (const d of decisions) last.set(d.impulse, d);
  const own = [...last.values()].filter((d) => isSelfInitiated(d.source));
  const ownBlocked = own.filter((d) => d.verdict !== "accepted" && d.verdict !== "merged");

  const residual: string[] = [];
  const snap = run.activity?.snapshot ?? null;
  if (snap !== null) {
    if (snap.presence.type === "joining" || snap.presence.type === "leaving") {
      residual.push(`presence ${snap.presence.type}`);
    }
    if (snap.broadcast.type === "starting" || snap.broadcast.type === "stopping") {
      residual.push(`broadcast ${snap.broadcast.type}`);
    }
    const a = snap.activity;
    if (a.type !== "idle" && a.phase !== "running") residual.push(`${a.type} ${a.phase}`);
  }
  const openTasks = (run.activity?.tasks ?? []).filter(
    (t) => t.status === "queued" || t.status === "running",
  );
  for (const t of openTasks) residual.push(`task ${t.request.type} ${t.status}`);

  return {
    name: run.name,
    duration_ms: run.durationMs,
    inputs: run.inputs.length,
    turns,
    outcomes: count(turns, (t) => t.outcome),
    cancelled_by: count(
      turns.filter((t) => t.outcome === "cancelled"),
      (t) => t.cause ?? "?",
    ),
    addresses,
    voice_direct_speak_rate: rate(voiceCalls.filter((a) => a.answered).length, voiceCalls.length),
    text_direct_reply_rate: rate(textCalls.filter((a) => a.answered).length, textCalls.length),
    focus_correct_rate: rate(judged.filter((t) => t.focus_correct).length, judged.length),
    arbiter: {
      decisions: decisions.length,
      by_verdict: count(decisions, (d) => d.verdict),
      blocked_by_reason: count(blocked, (d) => d.reason ?? d.verdict),
      self_initiated_block_rate: rate(ownBlocked.length, own.length),
      topics_ignored: run.events.filter((env) => {
        const e = env.event;
        return (
          e.type === "custom" &&
          e.data.topic === "affect.event" &&
          isJsonObject(e.data.payload) &&
          e.data.payload.kind === "topic_ignored"
        );
      }).length,
      self_initiated_blocked: ownBlocked.map((d) => ({
        at: d.at,
        source: d.source,
        reason: d.reason ?? d.verdict,
        detail: d.detail,
      })),
    },
    activity: {
      snapshot:
        snap === null
          ? "(no ActivityManager)"
          : `presence ${snap.presence.type}, broadcast ${snap.broadcast.type}, activity ${
              snap.activity.type === "idle"
                ? "idle"
                : `${snap.activity.type}(${snap.activity.target ?? ""}) ${snap.activity.phase}`
            }`,
      open_tasks: openTasks.length,
      residual,
    },
    llm_calls: count(run.llm.requests, (r) => r.reasoning_purpose ?? "?"),
  };
}

function pct(r: Rate): string {
  return r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(1)}% (${r.num}/${r.den})`;
}

/** A short plain-text rendering of the report. */
export function formatReport(report: ReplayReport): string {
  const lines = [
    `replay: ${report.name}`,
    `  ${report.inputs} inputs over ${Math.round(report.duration_ms / 1000)} s, ${report.turns.length} turns`,
    `  outcomes: ${JSON.stringify(report.outcomes)}  cancelled by: ${JSON.stringify(report.cancelled_by)}`,
    `  voice direct-address speak rate: ${pct(report.voice_direct_speak_rate)}`,
    `  text direct-address reply rate: ${pct(report.text_direct_reply_rate)}`,
    `  focus correct: ${pct(report.focus_correct_rate)}`,
    `  arbiter: ${report.arbiter.decisions} decisions ${JSON.stringify(report.arbiter.by_verdict)}, blocked by ${JSON.stringify(report.arbiter.blocked_by_reason)}`,
    `  self-initiated block rate: ${pct(report.arbiter.self_initiated_block_rate)}; her topics nobody picked up: ${report.arbiter.topics_ignored}`,
    `  activity: ${report.activity.snapshot}; open tasks ${report.activity.open_tasks}; residual ${
      report.activity.residual.length === 0 ? "none" : report.activity.residual.join(", ")
    }`,
    `  llm calls: ${JSON.stringify(report.llm_calls)}`,
  ];
  for (const a of report.addresses.filter((x) => !x.answered)) {
    lines.push(`  unanswered: ${a.who}「${a.text}」(${a.voice ? "voice" : "text"})`);
  }
  for (const b of report.arbiter.self_initiated_blocked) {
    lines.push(`  blocked (${b.source}) at ${b.at}: ${b.reason}: ${b.detail}`);
  }
  for (const t of report.turns.filter((x) => x.focus_correct === false)) {
    lines.push(`  wrong focus: turn ${t.turn} answered ${t.focus.join(", ")}`);
  }
  return lines.join("\n");
}
