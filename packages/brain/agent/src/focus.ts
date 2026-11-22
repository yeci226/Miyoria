// Turn ownership (docs/design/v2-architecture.md §3.9): every turn knows whom it answers.
//
// `callKind` says how a line relates to her (it calls her, replies to her, is about her said to
// someone else, or only reacts); `oneCaller` gives several people calling her at once a run each.
//
// `TurnFocusBoard` keeps the focus of every turn in flight (or still speaking) per context:
// the agent provides it as `TurnFocusViewKey` so voice barge-in can ask, on its hot path, whom
// the turn is for, and every change is published as `agent.turn.focus`.

import {
  type AccountRef,
  accountRefString,
  type ContextKey,
  type Handle,
  type IncomingMessage,
  type MessageRef,
  matchPersonName,
  type PersonCandidate,
  safeName,
  sameAccount,
  shownNames,
  type TurnFocus,
  type TurnFocusView,
  type TurnId,
  type TurnPhase,
  type TurnReason,
  timestampMs,
} from "@miyoria/types";
import { type Aside, isQuestion, openingCall } from "./address.js";
import { contextId } from "./util.js";

/** How one message relates to her. */
export type CallKind =
  /** It calls her: a mention, her name, a DM, a question right after she spoke (voice). */
  | "address"
  /** It replies to one of her messages. */
  | "reply"
  /** It answers her line but is said to someone else, about her (attention's `Aside`). */
  | "about"
  /** It answers her line with only a reaction for the room. */
  | "reaction"
  | null;

/** The kinds that call for her: she is addressed or answered. */
export function callsHer(kind: CallKind): boolean {
  return kind === "address" || kind === "reply";
}

/** What is known about a voice context when classifying its utterances. */
export interface VoiceCallFacts {
  /** When she last spoke (clock ms), if ever. */
  lastSelfAt: number | null;
  /** A question this soon (ms) after she spoke addresses her. */
  questionWindowMs: number;
  /** People in the channel besides her (`null`: unknown). */
  others: number | null;
  /** Their display names: a question that opens with one of them is for that person. */
  roster?: readonly string[];
  /** Her names. */
  names?: readonly string[];
}

/**
 * How `msg` relates to her. `direct` is attention's `directReason` (mention, name, reply, DM);
 * in voice a question right after she spoke, or anything said one-on-one, also calls her, but not
 * a question that opens by calling someone else (`openingCall`). `aside`: attention's `asideOf`.
 */
export function callKind(
  msg: IncomingMessage,
  direct: string | null,
  voice: VoiceCallFacts | null,
  aside: Aside | null = null,
): CallKind {
  if (direct === "reply") return "reply";
  if (direct !== null) return "address";
  if (aside !== null) return aside.kind === "about_her" ? "about" : "reaction";
  if (voice === null) return null;
  if (voice.others === 1) return "address";
  const last = voice.lastSelfAt;
  const called = openingCall(msg.text, voice.roster ?? [], voice.names ?? []);
  if (last !== null && called === null && isQuestion(msg.text.toLowerCase())) {
    const gap = timestampMs(msg.ts) - last;
    if (gap >= -voice.questionWindowMs && gap <= voice.questionWindowMs) return "address";
  }
  return null;
}

/**
 * The input of one turn when several people call her at once: everything up to the next caller's
 * first call, and what the first caller says after it (`now`); the other callers' messages from
 * their first call on wait for their own turn (`later`), the first of them next. Lines of people
 * who do not call her stay with the first turn, as its background.
 */
export function oneCaller(
  inputs: readonly IncomingMessage[],
  classify: (msg: IncomingMessage) => CallKind,
): { now: IncomingMessage[]; later: IncomingMessage[] } {
  let first: AccountRef | null = null;
  const deferred = new Set<string>();
  const now: IncomingMessage[] = [];
  const later: IncomingMessage[] = [];
  for (const m of inputs) {
    const key = authorKey(m.author.account);
    if (first === null && callsHer(classify(m))) first = m.author.account;
    else if (
      first !== null &&
      !sameAccount(first, m.author.account) &&
      !deferred.has(key) &&
      callsHer(classify(m))
    ) {
      deferred.add(key);
    }
    (deferred.has(key) ? later : now).push(m);
  }
  return { now, later };
}

function authorKey(account: AccountRef): string {
  return `${account.platform}:${account.id}`;
}

/** The argument naming whom a tool call is for, when several people called her at once. */
export const FOR_ARG = "for_whom";

/** The schema of `FOR_ARG`, offered to tools that act for someone (`Tool.actsFor`) then. */
export const FOR_PROPERTY = {
  type: "string",
  description:
    "這件事是幫誰做的:要回的訊息(<reply_to>)裡那個人的編號(例如 1)或名字(對話紀錄每行開頭那個,或他現在的顯示名,要寫完整)。",
} as const;

/** What a tool call acts for: the message of the person it is for, or why it cannot tell. */
export type CallFor =
  | { ok: true; message: IncomingMessage | undefined }
  | { ok: false; error: string };

/**
 * Whom a tool call acts for (2026-11-11: 阿鰻 offered rice with an @-mention, ミルクねこ replied to
 * her about something else two seconds later, both landed in one turn and the latest speaker paid).
 *
 * One person in the focus: theirs (`fallback`), whatever `pick` says. Several: `pick` (the call's
 * `for_whom`) names one, by the number of the focus block (`targets`, as numbered there) or by name
 * (`matchPersonName`: their handle when `names` knows it, the name they go by, her call name),
 * and the call is for that person's latest message that asks her (`asks`), else their latest. A
 * tool that acts for someone (`actsFor`) and does not say whom, or names nobody in the focus, is
 * refused with the choices, so she can call again; any other tool goes on with `fallback`.
 */
export function callFor(
  focus: readonly IncomingMessage[],
  targets: readonly { id: string | null; account: AccountRef }[],
  pick: unknown,
  actsFor: boolean,
  asks: (m: IncomingMessage) => boolean,
  fallback: () => IncomingMessage | undefined,
  names: FocusNames | null = null,
): CallFor {
  const people: IncomingMessage["author"][] = [];
  for (const m of focus) {
    if (!people.some((p) => sameAccount(p.account, m.author.account))) people.push(m.author);
  }
  if (people.length <= 1) return { ok: true, message: fallback() };
  const said = typeof pick === "number" ? String(pick) : typeof pick === "string" ? pick : "";
  const who = said.trim() === "" ? null : pickPerson(people, targets, said, names);
  if (who === null) {
    if (!actsFor && said.trim() === "") return { ok: true, message: fallback() };
    const choices = people.map((p) => {
      const n = targets.findIndex((t) => sameAccount(t.account, p.account));
      const handle = names?.(p.account)?.handle ?? null;
      const shown = handle === null ? [] : shownNames(handle, [p.display_name]);
      const name = `${safeName(handle ?? p.display_name)}${shown.length > 0 ? `(${shown[0]})` : ""}`;
      return `${n < 0 ? "" : `[${n + 1}] `}${name}`;
    });
    const why = said.trim() === "" ? "好幾個人同時叫你" : `${FOR_ARG} 「${safeName(said)}」 對不上`;
    return {
      ok: false,
      error: `${why},沒辦法知道這件事是幫誰做的,所以沒有做。再呼叫一次,用 ${FOR_ARG} 填要回的訊息(<reply_to>)裡的編號或名字:${choices.join("、")}`,
    };
  }
  const theirs = focus.filter((m) => sameAccount(m.author.account, who));
  return { ok: true, message: theirs.findLast(asks) ?? theirs.at(-1) };
}

/** Her handle for an account and what she calls them, when known (`null`: neither). */
export type FocusNames = (account: AccountRef) => { handle: string; call: string | null } | null;

/** The person `said` names: a number of the focus block (`2`, `[2]`) or a name (`@` optional). */
function pickPerson(
  people: readonly IncomingMessage["author"][],
  targets: readonly { id: string | null; account: AccountRef }[],
  said: string,
  names: FocusNames | null,
): AccountRef | null {
  const n = /^\s*[[［(（]?\s*(\d{1,2})\s*[\]］)）]?\s*$/.exec(said)?.[1];
  if (n !== undefined) {
    const account = targets[Number(n) - 1]?.account;
    return account !== undefined && people.some((p) => sameAccount(p.account, account))
      ? account
      : null;
  }
  const candidates: PersonCandidate[] = people.map((p) => {
    const known = names?.(p.account) ?? null;
    return {
      key: accountRefString(p.account),
      handle: known?.handle ?? p.display_name,
      person: null,
      account: p.account,
      shown: [p.display_name],
      first: null,
      call: known?.call ?? null,
    };
  });
  const match = matchPersonName(said, candidates);
  return match.kind === "one" ? match.candidate.account : null;
}

export interface TurnFocusInit {
  turn: TurnId;
  context: ContextKey;
  reason: TurnReason;
  addressed_by: Handle[];
  addressed_accounts: AccountRef[];
  focus: MessageRef[];
  background: MessageRef[];
  restarts: number;
}

/**
 * The focus of every turn in flight, per context (`TurnFocusView`). A finished voice turn whose
 * speech is still queued stays (phase `speaking`) until its speech is over, it is replaced by a
 * newer turn, or `speakingHoldMs` passed.
 */
export class TurnFocusBoard implements TurnFocusView {
  readonly #turns = new Map<string, TurnFocus>();
  /** Clock ms after which a `speaking` entry is dropped. */
  readonly #holds = new Map<TurnId, number>();

  constructor(
    readonly now: () => number,
    readonly publish: (focus: TurnFocus) => void,
  ) {}

  current(context: ContextKey): TurnFocus | null {
    const id = contextId(context);
    const focus = this.#turns.get(id) ?? null;
    if (focus === null) return null;
    const hold = this.#holds.get(focus.turn);
    if (hold !== undefined && this.now() >= hold) {
      this.#turns.delete(id);
      this.#holds.delete(focus.turn);
      return null;
    }
    return structuredClone(focus);
  }

  all(): TurnFocus[] {
    const out: TurnFocus[] = [];
    for (const focus of [...this.#turns.values()]) {
      const current = this.current(focus.context);
      if (current !== null) out.push(current);
    }
    return out;
  }

  /** A new turn in its context (replacing whatever was there). */
  start(init: TurnFocusInit, phase: TurnPhase = "generating"): TurnFocus {
    const at = new Date(this.now()).toISOString();
    const focus: TurnFocus = { ...init, phase, started_at: at, updated_at: at };
    const id = contextId(init.context);
    const before = this.#turns.get(id);
    if (before) this.#holds.delete(before.turn);
    this.#turns.set(id, focus);
    this.publish(structuredClone(focus));
    return focus;
  }

  /** The focus of `turn`, if it is still on the board. */
  get(turn: TurnId): TurnFocus | null {
    for (const focus of this.#turns.values()) if (focus.turn === turn) return focus;
    return null;
  }

  /** Moves `turn` to `phase` (`holdMs`: for `speaking`, how long it may stay at most). */
  phase(turn: TurnId, phase: TurnPhase, holdMs: number | null = null): void {
    const focus = this.get(turn);
    if (focus === null) return;
    if (holdMs !== null) this.#holds.set(turn, this.now() + holdMs);
    if (focus.phase === phase) return;
    focus.phase = phase;
    focus.updated_at = new Date(this.now()).toISOString();
    if (phase === "done") {
      this.#turns.delete(contextId(focus.context));
      this.#holds.delete(turn);
    }
    this.publish(structuredClone(focus));
  }

  /** `turn` is over (no-op when a newer turn replaced it). */
  end(turn: TurnId): void {
    this.phase(turn, "done");
  }
}
