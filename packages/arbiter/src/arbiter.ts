// The Arbiter (docs/design/v2-architecture.md §3.3): the one place that decides whether she
// speaks or acts now. Every wish arrives as an `Impulse`; the Arbiter only
//
// * applies the floors: autonomy pause, LLM budget, consent, the owner's channel level, quiet
//   hours, and for her own starts (`plan` / `agenda` that make her talk) the daily caps, the
//   gaps and the unanswered backoff. Narration (`Impulse.attention`) is not said twice, and
//   everything that has her talking unasked stops at `max_unanswered` until a person speaks
//   (`unanswered.ts`). One rule set (`[modules.arbiter]`);
// * orders, merges and preempts: impulses with the same `coalesce_key` merge (the newest
//   wins); a place that is busy defers an impulse, retried most urgent first (addressed >
//   ongoing conversation > her own wishes); once something takes a place, her own wishes
//   waiting there are preempted, and so are they when someone addresses her there;
// * keeps the books in the `Ledger`: every decision that is not "go" is recorded with its
//   reason, her own starts and whether anyone picked them up (`affect.event` `topic_ignored`
//   when nobody did), and the limits she sees in her prompts ("你今天主動開了 5 次話題,最近 3
//   次沒人接;下次可主動在 21:40 之後").
//
// Rules that she can see in advance reject (with `retry_at`): she plans again with the ledger
// in view. Only facts of the moment (the place is busy, she just spoke) defer.
//
// Accepted impulses are run by the agent's `ImpulseHost` (speak, and her own act impulses
// that may end in a turn) or `ArbiterEnv.act` (other act impulses, through the gate).
//
// Under `pipeline = "v3"` (`ArbiterEnv.floor`) this class is the queue in front of the Floor: an
// impulse is only a claim on the mic, narration dedupe and `max_unanswered` are the Floor's and
// the DeliveryLedger's (floor.ts), and an accepted claim opens a turn of the main line, nothing
// else: there is no `act`, and no text of a claim is ever said as it stands.

import { errorMessage, getLogger } from "@miyoria/kernel";
import {
  type AccountRef,
  AFFECT_EVENT_TOPIC,
  ARBITER_DECISION_TOPIC,
  type Arbiter,
  type ArbiterDecision,
  type ArbiterReason,
  type ArbiterVerdict,
  type ContextKey,
  type ConversationFacts,
  claimOf,
  contextKeyString,
  type Event,
  type Impulse,
  type ImpulseHost,
  type ImpulseRun,
  impulseReason,
  isImpulseExpired,
  isSelfInitiated,
  isSelfTalk,
  LEDGER_TOPIC,
  type LedgerEntry,
  type LedgerLimits,
  type LedgerOutcome,
  type LedgerRecord,
  type LedgerView,
  PRIORITY_RANK,
  type TurnFocus,
  type TurnId,
  type TurnOutcomeRecord,
  toTimestamp,
  v2Event,
} from "@miyoria/types";
import { type ArbiterConfig, isContextDisabled } from "./config.js";
import type { FloorCore } from "./floor.js";
import { Ledger, type Place, placeOf } from "./ledger.js";
import { clockText, hasQuietHours, inQuietHours, nextDayStart, quietEndsAt } from "./time.js";
import { startsTalk } from "./unanswered.js";

const log = getLogger("arbiter");

const MINUTE_MS = 60_000;

export type BudgetState = "ok" | "degraded" | "exhausted";

/** What the Arbiter consults; every part is optional (absent: no such floor). */
export interface ArbiterEnv {
  now(): number;
  publish(event: Event): void;
  /** Autonomy paused by the owner. */
  paused?(): boolean;
  budget?(): BudgetState;
  /** She ignores this person (the social module): nothing is aimed at them. */
  blocked?(account: AccountRef): boolean;
  /** The agent's host (looked up per call). */
  host?(): ImpulseHost | null;
  /** Runs an `act` impulse that is not one of hers through the gate. */
  act?(impulse: Impulse, signal?: AbortSignal): Promise<ImpulseRun>;
  /** `pipeline = "v3"`: the Floor decides instead of the V2 narration and `max_unanswered` rules. */
  floor?: FloorCore;
}

/** A capability she may not use on her own until `until` (epoch ms). */
export interface HeldCapability {
  capability: string;
  reason: string;
  until: number;
}

/** A floor that says no (`defer`: try again at `retryAt`; else rejected). */
interface Floor {
  reason: ArbiterReason;
  detail: string;
  retryAt: number | null;
  defer: boolean;
  /**
   * Decided, but kept out of the ledger: narration asks every few seconds and would push
   * everything else out of it. `arbiter.decision` still says why she stayed silent.
   */
  quiet?: boolean;
}

interface Queued {
  impulse: Impulse;
  signal: AbortSignal | undefined;
  retryAt: number;
  reason: ArbiterReason;
}

interface Tracked {
  entry: string;
  impulse: Impulse;
  talk: boolean;
}

interface Block {
  capability: string;
  reason: string;
  until: number;
  /** A hold: enforced on what she does on her own, not only shown to her. */
  hard?: boolean;
}

/** Sources the owner drives: only expiry applies. */
const OWNER = new Set(["command", "panel", "message"]);
/** Sources that are chatter: they also stop while the budget is degraded. */
const CHATTER = new Set(["plan", "agenda", "world"]);
/** Sources that wait a moment after she spoke (her own starts have it in their rules). */
const AFTER_SPEECH = new Set(["world"]);
/** Sources that the context opt-out list stops. */
const OPT_OUT = new Set(["plan", "agenda", "world", "followup"]);

const NO_FACTS: ConversationFacts = {
  mode: null,
  start_gap_ms: 0,
  present: true,
  last_spoke_at: null,
};

function rank(impulse: Impulse): number {
  return PRIORITY_RANK[impulse.priority] ?? PRIORITY_RANK.idle;
}

function sameContext(a: ContextKey | null, b: ContextKey | null): boolean {
  return a !== null && b !== null && contextKeyString(a) === contextKeyString(b);
}

function personKey(impulse: Impulse): string | null {
  const a = impulse.target.account;
  if (a !== null) return `acc:${a.platform}:${a.id}`;
  return impulse.target.person === null ? null : `h:${impulse.target.person}`;
}

function minutes(ms: number): number {
  return Math.max(Math.ceil(ms / MINUTE_MS), 1);
}

export class ArbiterCore implements Arbiter {
  readonly #cfg: ArbiterConfig;
  readonly #env: ArbiterEnv;
  readonly book: Ledger;
  #queue: Queued[] = [];
  /** Accepted impulses with a turn, by turn. */
  readonly #turns = new Map<TurnId, Tracked>();
  #blocks: Block[] = [];
  /** A hold changed since `holds()` was read. */
  holdsDirty = false;
  /** A DM channel's place (`dm:<account>`), learned from her DM turns. */
  readonly #dmPlaces = new Map<string, string>();
  #pumping = false;

  constructor(config: ArbiterConfig, env: ArbiterEnv) {
    this.#cfg = config;
    this.#env = env;
    this.book = new Ledger(config);
  }

  get config(): ArbiterConfig {
    return this.#cfg;
  }

  #now(): number {
    return this.#env.now();
  }

  /** Impulses waiting (most urgent first). */
  queued(): Impulse[] {
    return this.#sorted(this.#queue).map((q) => q.impulse);
  }

  // ---- Arbiter --------------------------------------------------------------------------------

  async submit(impulse: Impulse, signal?: AbortSignal): Promise<ArbiterDecision> {
    // A repeat is about to be turned down: it must not take the place of something new waiting.
    const repeat = this.#repeat(impulse);
    if (impulse.coalesce_key !== null && !repeat) {
      for (const q of [...this.#queue]) {
        if (q.impulse.coalesce_key !== impulse.coalesce_key || q.impulse.id === impulse.id)
          continue;
        this.#queue = this.#queue.filter((x) => x !== q);
        this.#decision(q.impulse, "merged", null, "合併進較新的同一件事", null, impulse.id);
      }
    }
    return this.#decide(impulse, signal, null);
  }

  /** Whether what `impulse` is about was said already. */
  #repeat(impulse: Impulse): boolean {
    const attention = impulse.attention ?? null;
    if (attention === null) return false;
    const floor = this.#env.floor;
    if (floor) return floor.repeated(attention);
    return this.book.saidUntil(attention.key, this.#now()) !== null;
  }

  ledger(context: ContextKey | null = null): LedgerView {
    const now = this.#now();
    const place = context === null ? null : this.#placeOfContext(context);
    return {
      at: toTimestamp(now),
      entries: this.book.entries(context),
      limits: this.limits(context, now),
      unanswered: this.book.unanswered(place?.key ?? null, now),
    };
  }

  record(entry: LedgerRecord): string {
    const e = this.book.add(entry, isSelfInitiated(entry.source), this.#now());
    this.#publishEntry(e);
    if (entry.kind === "task" && entry.outcome === "failed" && entry.detail !== null) {
      this.#block(entry.summary, entry.detail);
    }
    return e.id;
  }

  resolve(id: string, outcome: LedgerOutcome, detail: string | null): boolean {
    const e = this.book.resolve(id, outcome, detail, this.#now());
    if (!e) return false;
    this.#publishEntry(e);
    return true;
  }

  // ---- the limits she sees ----------------------------------------------------------------------

  limits(context: ContextKey | null, now = this.#now()): LedgerLimits {
    const cfg = this.#cfg;
    const place = context === null ? null : this.#placeOfContext(context);
    const facts = context === null ? NO_FACTS : this.#factsFor(context);
    const blocked: LedgerLimits["blocked"] = this.#blocks
      .filter((b) => b.until > now)
      .map((b) => ({ capability: b.capability, reason: b.reason, until: toTimestamp(b.until) }));
    if (facts.mode === "off" || facts.mode === "mention-only") {
      // Until the owner changes the level.
      blocked.unshift({
        capability: "chat.start",
        reason: `這個頻道的等級是「${facts.mode === "off" ? "關閉" : "只回提及"}」`,
        until: null,
      });
    }
    const waiting = place !== null && this.#waitingForResponse(place);
    if (waiting) {
      // Until someone speaks there.
      blocked.unshift({
        capability: "chat.start",
        reason: `你在這裡連續 ${cfg.max_unanswered} 次開口都沒人回應,等有人說話再開口`,
        until: null,
      });
    }
    return {
      initiatives_today: this.book.startsToday(now),
      initiative_cap: cfg.max_per_day > 0 ? cfg.max_per_day : null,
      unanswered_streak: this.book.streak,
      next_initiative_at: this.#nextAllowed(place, facts, now),
      quiet_hours: hasQuietHours(cfg)
        ? {
            start_hour: cfg.quiet_start_hour,
            end_hour: cfg.quiet_end_hour,
            active: inQuietHours(now, cfg),
          }
        : null,
      paused: this.#env.paused?.() ?? false,
      blocked,
      waiting_for_response: waiting,
    };
  }

  /** `max_unanswered` turns went out at `place` and no person spoke there since. */
  #waitingForResponse(place: Place): boolean {
    const floor = this.#env.floor;
    if (floor) return place.context !== null && floor.waitingForResponse(place.context);
    const max = this.#cfg.max_unanswered;
    return max > 0 && this.book.turnsUnanswered(place.key) >= max;
  }

  /** When she may start talking on her own (at `place`) again; `null`: now. */
  #nextAllowed(place: Place | null, facts: ConversationFacts, now: number): string | null {
    let at = now;
    for (let i = 0; i < 8; i++) {
      const floor = this.#timeRules(place, null, facts, at);
      if (floor === null) break;
      if (floor.retryAt === null || floor.retryAt <= at) return null;
      at = floor.retryAt;
    }
    return at > now ? toTimestamp(at) : null;
  }

  // ---- deciding ---------------------------------------------------------------------------------

  async #decide(
    impulse: Impulse,
    signal: AbortSignal | undefined,
    queued: Queued | null,
  ): Promise<ArbiterDecision> {
    const now = this.#now();
    if (signal?.aborted) return this.#final(impulse, "expired", "expired", "取消了", null);
    if (isImpulseExpired(impulse, now)) {
      return this.#final(impulse, "expired", "expired", "過期了,沒有做", null);
    }
    const facts =
      impulse.target.context === null ? NO_FACTS : this.#factsFor(impulse.target.context);
    const floor = this.#floor(impulse, facts, now);
    if (floor !== null) {
      if (floor.defer && floor.retryAt !== null) return this.#defer(impulse, signal, floor, queued);
      if (floor.quiet) {
        return this.#decision(impulse, "rejected", floor.reason, floor.detail, floor.retryAt);
      }
      return this.#final(impulse, "rejected", floor.reason, floor.detail, floor.retryAt);
    }
    const talk = isSelfTalk(impulse);
    const place = this.#placeOf(impulse);
    // Booked before it runs: an impulse decided meanwhile sees it.
    if (talk) this.book.book(impulse.id, place, personKey(impulse), now);
    const claimed = this.#claimed(impulse);
    let run: ImpulseRun;
    try {
      run = await this.#run(claimed, signal);
    } catch (error) {
      run = { status: "refused", reason: "denied", detail: errorMessage(error) };
    }
    const after = this.#now();
    if (run.status !== "started" && claimed.attention) {
      this.#env.floor?.unreserve(claimed.attention);
    }
    switch (run.status) {
      case "busy":
        if (talk) this.book.unbook(impulse.id);
        return this.#defer(
          impulse,
          signal,
          { reason: "busy", detail: run.detail, retryAt: after + this.#cfg.retry_ms, defer: true },
          queued,
        );
      case "refused":
        if (talk) this.book.unbook(impulse.id);
        if (impulse.kind === "act" && impulse.capability !== null && run.reason === "denied") {
          this.#block(impulse.capability, run.detail);
        }
        return this.#final(impulse, "rejected", run.reason, run.detail, null);
      case "started":
        return this.#accepted(claimed, run, talk, place, after);
    }
  }

  /** V3: the claim with the revision it stands for, reserved so nothing claims it meanwhile. */
  #claimed(impulse: Impulse): Impulse {
    const floor = this.#env.floor;
    const attention = impulse.attention ?? null;
    if (!floor || attention === null) return impulse;
    const revised = { ...attention, revision: floor.revisionOf(attention) };
    floor.reserve(revised, null);
    return { ...impulse, attention: revised };
  }

  #accepted(
    impulse: Impulse,
    run: Extract<ImpulseRun, { status: "started" }>,
    talk: boolean,
    place: Place | null,
    now: number,
  ): ArbiterDecision {
    const waiting = talk || run.turn !== null;
    // Before the turn ends: an impulse decided meanwhile sees it. A turn that does not go out
    // takes it back (`turnOutcome`).
    const attention = impulse.attention ?? null;
    if (attention !== null) {
      this.book.markSaid(attention.key, now + attention.repeat_after_ms, now);
      this.#env.floor?.reserve(attention, run.turn);
    }
    const entry = this.book.add(
      {
        kind: run.task !== null ? "task" : run.turn !== null ? "turn" : "impulse",
        source: impulse.source,
        context: impulse.target.context,
        person: impulse.target.person,
        summary: this.#summary(impulse),
        outcome: waiting ? "pending" : "ok",
        detail: run.detail === "" ? null : run.detail,
        impulse: impulse.id,
        turn: run.turn,
        task: run.task,
      },
      isSelfInitiated(impulse.source),
      now,
    );
    if (talk) {
      this.book.raise(entry.id, place, impulse.target.person, impulse.hint ?? impulse.why, now);
      this.book.setTurn(entry.id, run.turn, run.task);
    }
    if (run.turn !== null) {
      this.#turns.set(run.turn, { entry: entry.id, impulse, talk });
      while (this.#turns.size > 500) {
        const oldest = this.#turns.keys().next().value;
        if (oldest === undefined) break;
        this.#turns.delete(oldest);
      }
    }
    this.#publishEntry(entry);
    // Something took the place: her own wishes waiting there are moot now.
    this.#preempt(impulse.target.context, rank(impulse), impulse.id);
    const decision = this.#decision(impulse, "accepted", null, run.detail, null, null, run);
    log.debug(
      {
        impulse: impulse.id,
        source: impulse.source,
        turn: run.turn,
        reason: impulseReason(impulse),
      },
      "impulse accepted",
    );
    return decision;
  }

  /** Waits for a better moment (or gives up when it would expire before). */
  #defer(
    impulse: Impulse,
    signal: AbortSignal | undefined,
    floor: Floor,
    queued: Queued | null,
  ): ArbiterDecision {
    const retryAt = floor.retryAt ?? this.#now() + this.#cfg.retry_ms;
    if (retryAt >= Date.parse(impulse.expires_at)) {
      return this.#final(impulse, "expired", floor.reason, `${floor.detail}(等不到就過期了)`, null);
    }
    const same = queued !== null && queued.reason === floor.reason;
    const q: Queued = { impulse, signal, retryAt, reason: floor.reason };
    this.#queue.push(q);
    this.#trimQueue();
    const decision: ArbiterDecision = {
      impulse: impulse.id,
      source: impulse.source,
      verdict: "deferred",
      reason: floor.reason,
      detail: floor.detail,
      retry_at: toTimestamp(retryAt),
      merged_into: null,
      turn: null,
      task: null,
      at: toTimestamp(this.#now()),
    };
    // A retry that is held back for the same reason again is not news.
    if (!same) this.#env.publish(v2Event(ARBITER_DECISION_TOPIC, decision));
    return decision;
  }

  #trimQueue(): void {
    const max = Math.max(this.#cfg.max_queued, 1);
    while (this.#queue.length > max) {
      const worst = this.#sorted(this.#queue).at(-1);
      if (!worst) break;
      this.#queue = this.#queue.filter((q) => q !== worst);
      this.#final(worst.impulse, "preempted", "superseded", "排隊的事太多,先放掉", null);
    }
  }

  #sorted(list: readonly Queued[]): Queued[] {
    return [...list].sort(
      (a, b) =>
        rank(a.impulse) - rank(b.impulse) ||
        Date.parse(a.impulse.created_at) - Date.parse(b.impulse.created_at),
    );
  }

  /** Drops her own wishes waiting in `context` (less urgent than `than`). */
  #preempt(context: ContextKey | null, than: number, by: string | null): void {
    if (context === null) return;
    for (const q of [...this.#queue]) {
      if (!sameContext(q.impulse.target.context, context)) continue;
      if (!isSelfInitiated(q.impulse.source) || rank(q.impulse) < than) continue;
      this.#queue = this.#queue.filter((x) => x !== q);
      this.#final(q.impulse, "preempted", "superseded", "那裡已經有別的事在進行", null, by);
    }
  }

  /** A final "no": recorded in the ledger with its reason and published. */
  #final(
    impulse: Impulse,
    verdict: Exclude<ArbiterVerdict, "accepted" | "deferred" | "merged">,
    reason: ArbiterReason,
    detail: string,
    retryAt: number | null,
    by: string | null = null,
  ): ArbiterDecision {
    const entry = this.book.add(
      {
        kind: "impulse",
        source: impulse.source,
        context: impulse.target.context,
        person: impulse.target.person,
        summary: this.#summary(impulse),
        outcome: "denied",
        detail: `${reason}: ${detail}`,
        impulse: impulse.id,
        turn: null,
        task: null,
      },
      isSelfInitiated(impulse.source),
      this.#now(),
    );
    this.#publishEntry(entry);
    log.debug(
      { impulse: impulse.id, source: impulse.source, verdict, reason, detail },
      "impulse not taken",
    );
    return this.#decision(impulse, verdict, reason, detail, retryAt, by);
  }

  #decision(
    impulse: Impulse,
    verdict: ArbiterVerdict,
    reason: ArbiterReason | null,
    detail: string,
    retryAt: number | null,
    mergedInto: string | null = null,
    run: Extract<ImpulseRun, { status: "started" }> | null = null,
  ): ArbiterDecision {
    const decision: ArbiterDecision = {
      impulse: impulse.id,
      source: impulse.source,
      verdict,
      reason,
      detail,
      retry_at: retryAt === null ? null : toTimestamp(retryAt),
      merged_into: verdict === "merged" ? mergedInto : null,
      turn: run?.turn ?? null,
      task: run?.task ?? null,
      at: toTimestamp(this.#now()),
    };
    this.#env.publish(v2Event(ARBITER_DECISION_TOPIC, decision));
    return decision;
  }

  #summary(impulse: Impulse): string {
    const what = (impulse.hint ?? "").trim() || impulse.why.trim();
    const head =
      impulse.kind === "act" && impulse.capability !== null
        ? impulse.capability
        : impulseReason(impulse);
    return what === "" ? head : `${head}:${what}`;
  }

  // ---- floors -----------------------------------------------------------------------------------

  #floor(impulse: Impulse, facts: ConversationFacts, now: number): Floor | null {
    const source = impulse.source;
    if (OWNER.has(source)) return null;
    const no = (reason: ArbiterReason, detail: string, retryAt: number | null = null): Floor => ({
      reason,
      detail,
      retryAt,
      defer: false,
    });
    if (this.#env.paused?.()) return no("paused", "主人暫停了你的自主行動");
    if (impulse.kind === "act" && impulse.capability !== null && isSelfInitiated(impulse.source)) {
      const hold = this.held(impulse.capability);
      if (hold !== null) return no("denied", hold);
    }
    const budget = this.#env.budget?.() ?? "ok";
    if (budget === "exhausted") return no("budget", "今天的能量(LLM 預算)用完了");
    if (budget === "degraded" && CHATTER.has(source)) {
      return no("budget", "今天的能量(LLM 預算)快用完了,先不主動");
    }
    const account = impulse.target.account;
    if (account !== null && this.#env.blocked?.(account)) return no("consent", "對方不想被打擾");
    const context = impulse.target.context;
    if (context !== null && OPT_OUT.has(source) && isContextDisabled(this.#cfg, context)) {
      return no("ceiling", "這裡設定成不主動說話");
    }
    if (facts.mode === "off" || facts.mode === "mention-only") {
      const label = facts.mode === "off" ? "關閉" : "只回提及";
      return no("ceiling", `這個頻道的等級是「${label}」,不能自己開口`);
    }
    // Only speaking needs her there: `voice.join` is how she gets in.
    if (!facts.present && impulse.kind === "speak") return no("denied", "你不在那個語音頻道");
    if (this.#env.floor) {
      const refused = this.#floorClaim(impulse, this.#env.floor);
      if (refused !== null) return refused;
    } else if (impulse.kind === "speak" && startsTalk(impulse)) {
      const quiet = !isSelfInitiated(source);
      const attention = impulse.attention ?? null;
      const until = attention === null ? null : this.book.saidUntil(attention.key, now);
      if (until !== null) {
        const detail = "這件事你剛說過了,沒有新進展就不用再提";
        return { reason: "repeat", detail, retryAt: until, defer: false, quiet };
      }
      const place = this.#placeOf(impulse);
      if (place !== null && this.#waitingForResponse(place)) {
        const n = this.#cfg.max_unanswered;
        const detail = `你在這裡連續 ${n} 次開口都沒人回應,等有人說話再開口`;
        return { reason: "unanswered", detail, retryAt: null, defer: false, quiet };
      }
    }
    const self = isSelfInitiated(source);
    if (self) {
      const rules = this.#timeRules(
        this.#placeOf(impulse),
        personKey(impulse),
        facts,
        now,
        isSelfTalk(impulse),
      );
      if (rules !== null) return rules;
    }
    if (impulse.kind === "speak" && AFTER_SPEECH.has(source)) {
      const until = this.#afterSpeech(context, facts);
      if (until !== null && now < until) {
        return { reason: "cooldown", detail: "你剛講完話", retryAt: until, defer: true };
      }
    }
    return null;
  }

  /** V3: narration dedupe through the ledger, then the claim order and her budget. */
  #floorClaim(impulse: Impulse, floor: FloorCore): Floor | null {
    if (impulse.kind !== "speak") return null;
    const quiet = !isSelfInitiated(impulse.source);
    const attention = impulse.attention ?? null;
    if (attention !== null && floor.repeated(attention)) {
      const detail = "這件事你剛說過了,沒有新進展就不用再提";
      return { reason: "repeat", detail, retryAt: null, defer: false, quiet };
    }
    const context = impulse.target.context;
    if (context === null) return null;
    const refused = floor.check(claimOf(impulse), context, impulse.hint);
    return refused === null ? null : { ...refused, defer: false, quiet };
  }

  /** Until when she just spoke in `context` (`null`: she has not spoken there). */
  #afterSpeech(context: ContextKey | null, facts: ConversationFacts): number | null {
    if (facts.last_spoke_at === null) return null;
    const secs =
      context?.kind === "voice"
        ? this.#cfg.after_speech_voice_secs
        : this.#cfg.after_speech_text_secs;
    return facts.last_spoke_at + secs * 1000;
  }

  /**
   * The rules on her own starts that only depend on time and what she already did: quiet
   * hours, the daily caps, the gaps and the unanswered backoff (`talk`: she starts talking; her
   * act impulses only respect quiet hours).
   */
  #timeRules(
    place: Place | null,
    person: string | null,
    facts: ConversationFacts,
    now: number,
    talk = true,
  ): Floor | null {
    const cfg = this.#cfg;
    const no = (reason: ArbiterReason, detail: string, retryAt: number | null): Floor => ({
      reason,
      detail,
      retryAt,
      defer: false,
    });
    const quietEnd = quietEndsAt(now, cfg);
    if (quietEnd !== null) {
      return no(
        "quiet_hours",
        `現在是安靜時段,${clockText(quietEnd, cfg)} 之後才能自己開口`,
        quietEnd,
      );
    }
    if (!talk) return null;
    const tomorrow = nextDayStart(now, cfg);
    const today = this.book.startsToday(now);
    if (cfg.max_per_day > 0 && today >= cfg.max_per_day) {
      return no(
        "rate",
        `今天主動開了 ${today} 次話題(上限 ${cfg.max_per_day}),明天 ${clockText(tomorrow, cfg)} 之後`,
        tomorrow,
      );
    }
    if (place !== null && cfg.max_per_context_per_day > 0) {
      const here = this.book.startsToday(now, { place: place.key });
      if (here >= cfg.max_per_context_per_day) {
        return no(
          "rate",
          `今天在這裡主動開了 ${here} 次(上限 ${cfg.max_per_context_per_day}),明天再說`,
          tomorrow,
        );
      }
    }
    if (person !== null && cfg.max_per_person_per_day > 0) {
      const theirs = this.book.startsToday(now, { person });
      if (theirs >= cfg.max_per_person_per_day) {
        return no(
          "rate",
          `今天已經主動找對方 ${theirs} 次(上限 ${cfg.max_per_person_per_day}),明天再說`,
          tomorrow,
        );
      }
    }
    const last = this.book.lastStart();
    if (last !== null && now < last + cfg.min_gap_secs * 1000) {
      const at = last + cfg.min_gap_secs * 1000;
      return no("cooldown", `剛主動開過話題,${clockText(at, cfg)} 之後`, at);
    }
    if (place === null) return null;
    const spoke = this.#afterSpeech(place.context, facts);
    if (spoke !== null && now < spoke) {
      return no("cooldown", "你剛在這裡講完話,等一下再自己開話題", spoke);
    }
    const lastHere = this.book.lastStart(place.key);
    if (lastHere !== null) {
      const gap = this.book.gapMs(place, now);
      if (now < lastHere + gap) {
        const at = lastHere + gap;
        const misses = this.book.misses(place.key, now);
        if (misses > 0 && now >= lastHere + this.book.baseGapMs(place.kind)) {
          return no(
            "unanswered",
            `你在這裡主動開的話題最近連續 ${misses} 次沒人接,下次可主動在 ${clockText(at, cfg)} 之後`,
            at,
          );
        }
        return no(
          "cooldown",
          `你 ${minutes(now - lastHere)} 分鐘前才在這裡主動開過話題,下次可主動在 ${clockText(at, cfg)} 之後`,
          at,
        );
      }
      if (facts.start_gap_ms > 0 && now < lastHere + facts.start_gap_ms) {
        const at = lastHere + facts.start_gap_ms;
        return no("ceiling", `這個頻道的等級限制:${clockText(at, cfg)} 之後才能再自己開話題`, at);
      }
    }
    return null;
  }

  // ---- running ----------------------------------------------------------------------------------

  async #run(impulse: Impulse, signal: AbortSignal | undefined): Promise<ImpulseRun> {
    const viaHost = impulse.kind === "speak" || isSelfInitiated(impulse.source);
    if (viaHost) {
      const host = this.#env.host?.() ?? null;
      if (host === null)
        return { status: "refused", reason: "denied", detail: "沒有人能開回合(agent 沒在跑)" };
      return host.open(impulse, signal);
    }
    if (!this.#env.act) return { status: "refused", reason: "denied", detail: "沒有動作的執行者" };
    return this.#env.act(impulse, signal);
  }

  #factsFor(context: ContextKey): ConversationFacts {
    const host = this.#env.host?.() ?? null;
    if (host === null) return NO_FACTS;
    try {
      return host.facts(context);
    } catch (error) {
      log.debug({ error: errorMessage(error) }, "conversation facts failed");
      return NO_FACTS;
    }
  }

  #placeOf(impulse: Impulse): Place | null {
    const context = impulse.target.context;
    if (context !== null && context.kind === "dm") {
      const known = this.#dmPlaces.get(contextKeyString(context));
      if (known) return { key: known, kind: "dm", context };
    }
    return placeOf(context, impulse.target.account);
  }

  #placeOfContext(context: ContextKey): Place | null {
    if (context.kind === "dm") {
      const known = this.#dmPlaces.get(contextKeyString(context));
      if (known) return { key: known, kind: "dm", context };
    }
    return placeOf(context, null);
  }

  /** She may not do `capability` on her own for `ms` (someone asking her still can). */
  hold(capability: string, reason: string, ms: number): void {
    if (ms <= 0) return;
    const until = this.#now() + ms;
    this.#blocks = [
      ...this.#blocks.filter((b) => b.capability !== capability),
      { capability, reason, until, hard: true },
    ];
    this.holdsDirty = true;
  }

  /** Why she may not do `capability` on her own now (`null`: she may). */
  held(capability: string): string | null {
    const now = this.#now();
    return (
      this.#blocks.find((b) => b.hard && b.capability === capability && b.until > now)?.reason ??
      null
    );
  }

  /** The holds to persist. */
  holds(): HeldCapability[] {
    this.holdsDirty = false;
    return this.#blocks
      .filter((b) => b.hard)
      .map(({ capability, reason, until }) => ({ capability, reason, until }));
  }

  restoreHolds(holds: readonly HeldCapability[], now: number): void {
    for (const h of holds) {
      if (h.until > now) this.#blocks.push({ ...h, hard: true });
    }
  }

  /** Her game ended and she did not end it for a reason of her own: she leaves it closed. */
  gameClosed(): void {
    this.hold(
      "game.start",
      "遊戲剛被關掉了(多半是有人不想你玩),先不要自己重開,有人明確叫你開才開",
      this.#cfg.game_hold_mins * MINUTE_MS,
    );
  }

  #block(capability: string, reason: string): void {
    const until = this.#now() + this.#cfg.blocked_mins * MINUTE_MS;
    // A hold outlives what a refusal would say.
    if (this.held(capability) !== null) return;
    this.#blocks = [
      ...this.#blocks.filter((b) => b.capability !== capability),
      { capability, reason, until },
    ];
  }

  #publishEntry(entry: LedgerEntry): void {
    this.#env.publish(v2Event(LEDGER_TOPIC, { ...entry }));
  }

  // ---- what happens around her ------------------------------------------------------------------

  /** Retries what waited (most urgent first) and drops what expired. */
  async pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      const now = this.#now();
      for (const q of [...this.#queue]) {
        if (!isImpulseExpired(q.impulse, now) && !q.signal?.aborted) continue;
        this.#queue = this.#queue.filter((x) => x !== q);
        this.#final(q.impulse, "expired", "expired", `等不到(${q.reason}),過期了`, null);
      }
      for (const q of this.#sorted(this.#queue.filter((x) => x.retryAt <= now))) {
        if (!this.#queue.includes(q)) continue;
        this.#queue = this.#queue.filter((x) => x !== q);
        await this.#decide(q.impulse, q.signal, q);
      }
    } finally {
      this.#pumping = false;
    }
  }

  /** When the next queued impulse may be retried (epoch ms), or `null`. */
  nextRetry(): number | null {
    let next: number | null = null;
    for (const q of this.#queue) if (next === null || q.retryAt < next) next = q.retryAt;
    return next;
  }

  /** Her turn finished with `text` (empty: she said nothing). */
  turnCompleted(turn: TurnId, context: ContextKey, text: string): void {
    const tracked = this.#turns.get(turn);
    if (!tracked?.talk) return;
    const topic = this.book.spoke(turn, text, this.#now(), context);
    if (topic && context.kind === "dm" && topic.place.startsWith("dm:")) {
      this.#dmPlaces.set(contextKeyString(context), topic.place);
    }
  }

  /** A turn's outcome: hers settle their entry; someone else's may answer what she raised. */
  turnOutcome(record: TurnOutcomeRecord): void {
    const now = this.#now();
    const tracked = this.#turns.get(record.turn);
    if (tracked) {
      this.#turns.delete(record.turn);
      const o = record.outcome;
      if (o.type !== "sent" && tracked.impulse.attention) {
        this.book.forgetSaid(tracked.impulse.attention.key);
        this.#env.floor?.unreserve(tracked.impulse.attention);
      }
      if (o.type === "sent") {
        if (startsTalk(tracked.impulse)) {
          const place =
            record.context.kind === "dm"
              ? this.#placeOf(tracked.impulse)
              : this.#placeOfContext(record.context);
          if (place !== null) this.book.startedTalking(place, now);
        }
        // Her own topic waits for a reaction; anything else is done.
        if (!tracked.talk) this.resolve(tracked.entry, "ok", null);
        else this.resolve(tracked.entry, "pending", "說了,等大家的反應");
        return;
      }
      if (tracked.talk) this.book.dropTopic(record.turn);
      if (o.type === "silence") {
        this.resolve(tracked.entry, tracked.talk ? "failed" : "ok", "最後沒有開口");
      } else if (o.type === "cancelled") {
        this.resolve(tracked.entry, "failed", `被取消了(${o.cause})`);
      } else {
        this.resolve(tracked.entry, "failed", o.error);
      }
      return;
    }
    if (record.reason === "addressed" || record.reason === "reply_to_her") {
      this.engaged(record.context, null, now);
    }
  }

  /** Someone addressed or answered her in `context` (`account`: who, for DMs). */
  engaged(context: ContextKey, account: AccountRef | null, now = this.#now()): void {
    this.heard(context, account);
    const place =
      context.kind === "dm" && account !== null
        ? (placeOf(context, account) as Place)
        : this.#placeOfContext(context);
    if (place === null) return;
    for (const entry of this.book.engaged(place.key, now)) {
      this.resolve(entry, "ok", "有人接話了");
    }
  }

  /**
   * A person spoke in `context` (`humanResponse`; `account`: who, for DMs), or a stay in voice
   * began or ended there (`null`): she may start talking there again.
   */
  heard(context: ContextKey, account: AccountRef | null): void {
    const place =
      context.kind === "dm" && account !== null
        ? (placeOf(context, account) as Place)
        : this.#placeOfContext(context);
    if (place !== null) this.book.heard(place.key);
    // The text chat of a voice channel is the same room (same channel id, kind `channel`).
    if (context.kind === "channel") {
      this.book.heard(contextKeyString({ ...context, kind: "voice" }));
    }
  }

  /** A turn's focus changed: someone addressing her there preempts her own waiting wishes. */
  turnFocus(focus: TurnFocus): void {
    if (this.#turns.has(focus.turn)) return;
    if (focus.reason !== "addressed" && focus.reason !== "reply_to_her") return;
    this.#preempt(focus.context, PRIORITY_RANK.system, null);
  }

  /** Settles unanswered topics (`topic_ignored`), drops stale holds and retries the queue. */
  async tick(): Promise<void> {
    const now = this.#now();
    for (const t of this.book.settle(now)) {
      if (t.entry !== "") this.resolve(t.entry, "ignored", "沒人接話");
      this.#env.publish(
        v2Event(AFFECT_EVENT_TOPIC, {
          kind: "topic_ignored",
          person: null,
          handle: t.person,
          context: t.context === null ? null : { ...t.context },
          detail: t.said === "" ? "主動開的話題沒人接" : `主動提的「${t.said}」沒人接`,
          key: `topic_ignored:${t.place}`,
          at: toTimestamp(now),
        }),
      );
      log.debug({ place: t.place, streak: this.book.streak }, "her topic went unanswered");
    }
    this.#blocks = this.#blocks.filter((b) => b.until > now);
    await this.pump();
  }
}
