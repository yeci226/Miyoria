// Her Deliberate loop (docs/design/v2-architecture.md §3.4, §3.7): what used to be one god
// prompt every few minutes is three small calls, each with its own short system.
//
// * Appraise (reasoning `appraise`): after an interaction segment ended (or an important event)
//   what it meant to her: at most 3 appraisals and small feeling edits, into `AffectState`.
// * Plan (reasoning `plan`, the first of the day `plan_daily`): woken by goal triggers (checked
//   by cheap code), an activity ending, a cared-about person coming online, her mood dropping,
//   salient changes and suggestions, and by an adaptive heartbeat. Sees the world, her affect,
//   her goals, the ledger with its limits and the ranked desire list; changes her goals and
//   produces 0–2 impulses for the Arbiter (or, until it runs, intents for the agent).
// * Reflect lives with her lessons in `@miyoria/learning` (the `reflect` module).
//
// Plan never writes emotions; nothing here writes drives or talkativeness any more. Everything
// that is kept (thoughts, goals, the day plan) goes through `repairHandleText`.

import { ActuatorRegistryKey } from "@miyoria/actions";
import { errorMessage, getLogger, type Logger, type ServiceLookup, sleep } from "@miyoria/kernel";
import {
  assistantMessage,
  type ChatMessage,
  type ChatResponse,
  LlmRouterKey,
  userMessage,
  withLlmTag,
} from "@miyoria/llm";
import { SocialKey } from "@miyoria/social";
import { MessageLogKey, type SettingsStore } from "@miyoria/store";
import {
  ACTIVITY_CHANGED_TOPIC,
  ACTIVITY_DONE_TOPIC,
  ACTIVITY_FAILED_TOPIC,
  type AccountRef,
  ActivityManagerKey,
  type ActivitySnapshot,
  AFFECT_CHANGED_TOPIC,
  type AffectSnapshot,
  AffectStateKey,
  type ArbiterDecision,
  ArbiterKey,
  accountRefString,
  CHAT_DM,
  CHAT_START,
  type Clock,
  type ContextKey,
  ConversationStatesKey,
  characterCore,
  contextKeyString,
  customEvent,
  type Desire,
  DIRECTIVE_CHANGED_TOPIC,
  type DirectiveChangedBody,
  DirectivesKey,
  type Envelope,
  type Event,
  type Goal,
  type Handle,
  HandleDirectoryKey,
  holdsBack,
  type Impulse,
  type Intent,
  type IntentOutcome,
  IntentSinkKey,
  incomingText,
  inspectInput,
  isJsonObject,
  isValidHandle,
  type JsonValue,
  type LedgerLimits,
  MIND_THOUGHT_TOPIC,
  type Mind,
  type MindStats,
  type MindSuggestion,
  newId,
  type PersonId,
  type PlanWake,
  Principals,
  type ProfileId,
  type ProposalBoard,
  ProposalBoardKey,
  type RaisedTopic,
  ReflectionKey,
  repairHandleText,
  runningActivity,
  SALIENT_TOPIC,
  type SalientEvent,
  SelfStateKey,
  type Thought,
  type ThoughtDecision,
  type ThoughtDigest,
  type ThoughtIntent,
  type ThoughtTrigger,
  type TriggerProbe,
  type TurnId,
  toTimestamp,
  WorldStateKey,
} from "@miyoria/types";
import {
  type AppraiseReply,
  AppraiseReplyError,
  applyAppraisal,
  appraiseMessages,
  parseAppraiseReply,
  type Segment,
  Segments,
} from "./appraise.js";
import type { MindConfig } from "./config.js";
import { rankDesires, type Whereabouts } from "./desire.js";
import { describeTrigger, type GoalBook, GoalError, goalKey, TriggerWatch } from "./goals.js";
import type { Journal } from "./journal.js";
import { fromLedger, type PlanLimits } from "./ledger.js";
import { type BudgetState, CallLog, heartbeatMs, localDay, urgeOf } from "./pace.js";
import { PresenceStats, renderHabit } from "./presence.js";
import { type PersonRef, type PlanInput, planMessages, type WakeReason } from "./prompt.js";
import { clipReasoning, noEffects, thoughtInput } from "./record.js";
import {
  type GoalDraft,
  type ImpulseDraft,
  isEmptyPlan,
  MindReplyError,
  type PlanReply,
  parsePlanReply,
  type TriggerDraft,
} from "./reply.js";
import {
  type Block,
  blockLifted,
  conditionOf,
  kindOf,
  type PlaceKind,
  placeKey,
  SelfStarts,
  type Situation,
} from "./selfstart.js";
import {
  capabilityInfo,
  type Gathered,
  gather,
  NOT_FOR_HER,
  personByRef,
  placeByRef,
} from "./snapshot.js";

const log = getLogger("mind.loop");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Pending wakes kept (older ones are merged away). */
const MAX_PENDING = 12;
/** Lines people said to her that Plan is shown, and for how long they count. */
const HEARD_LINES = 12;
const HEARD_WINDOW_MS = 20 * MINUTE_MS;
const RECENT_THOUGHTS = 5;
/** Events of intent turns remembered until the intent's outcome names the turn. */
const MAX_TURN_EVENTS = 200;
/** Self-started turns remembered (their decisions arrive before they complete). */
const MAX_SELF_TURNS = 200;
/** Salient events below this score do not wake her while the budget is degraded. */
const DEGRADED_MIN_SCORE = 0.6;
/** Salient events below this score wake her only when they are about someone she cares about. */
const SALIENT_MIN_SCORE = 0.5;
/** Settings key of her plan state (the day plan, her last daily plan, presence statistics). */
export const PLAN_STATE_KEY = "mind:plan:state";
/** Message-log lines read per context to seed the presence statistics. */
const SEED_LINES = 400;
const SEED_CONTEXTS = 8;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export interface MindDeps {
  config: MindConfig;
  profile: ProfileId;
  name: string;
  /** Her persona (`PersonaHandle.corePrompt()`); the 3–5 sentence core is taken from it. */
  persona: () => string;
  services: ServiceLookup;
  clock: Clock;
  publish: (event: Event) => void;
  log: Logger;
  journal: Journal;
  goals: GoalBook;
  /** Where her plan state is kept (`null`: memory only). */
  store?: SettingsStore | null;
}

/** A turn she started herself: what it was about, and whom (for a DM). */
interface SelfTurn {
  about: string;
  dm: AccountRef | null;
}

type TurnEvent =
  | { type: "decision"; decision: ThoughtDecision }
  | { type: "skipped"; why: string }
  | { type: "completed"; text: string };

/** One impulse of a Plan, resolved against the snapshot. */
interface Planned {
  impulse: Impulse;
  /** The same thing as an intent, for the agent while the Arbiter does not run. */
  intent: Intent;
  goal: Goal | null;
}

/** Her day plan as written by her first Plan of a day. */
interface DayPlan {
  day: string;
  text: string;
  at: string;
}

function localTime(now: number, offsetMinutes: number): string {
  const d = new Date(now + offsetMinutes * MINUTE_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}(星期${WEEKDAYS[d.getUTCDay()]})`
  );
}

function hhmm(at: number, offsetMinutes: number): string {
  return localTime(at, offsetMinutes).slice(11, 16);
}

function short(text: string, max: number): string {
  const c = [...text.replace(/\s+/g, " ").trim()];
  return c.length > max ? `${c.slice(0, max).join("")}…` : c.join("");
}

/** Persisted text: no per-call codes (empty when nothing is left). */
function clean(text: string): string {
  return repairHandleText(text) ?? "";
}

function parseContext(value: JsonValue | undefined): ContextKey | null {
  if (!isJsonObject(value)) return null;
  const { platform, scope, channel, kind } = value;
  if (typeof platform !== "string" || typeof channel !== "string") return null;
  if (kind !== "channel" && kind !== "thread" && kind !== "dm" && kind !== "voice") return null;
  return { platform, scope: typeof scope === "string" ? scope : null, channel, kind };
}

function parseSalient(payload: JsonValue): SalientEvent | null {
  if (!isJsonObject(payload) || typeof payload.detail !== "string") return null;
  const account = isJsonObject(payload.account) ? payload.account : null;
  return {
    kind: (typeof payload.kind === "string" ? payload.kind : "came_online") as SalientEvent["kind"],
    key: typeof payload.key === "string" ? payload.key : "",
    account:
      account && typeof account.platform === "string" && typeof account.id === "string"
        ? { platform: account.platform, id: account.id }
        : null,
    person: typeof payload.person === "string" ? payload.person : null,
    display_name: typeof payload.display_name === "string" ? payload.display_name : null,
    context: parseContext(payload.context),
    detail: payload.detail,
    score: typeof payload.score === "number" ? payload.score : 0.5,
    count: typeof payload.count === "number" ? payload.count : 1,
    first_at: typeof payload.first_at === "string" ? payload.first_at : "",
    at: typeof payload.at === "string" ? payload.at : "",
  };
}

/** The activity running in a snapshot payload (`game:minecraft`), or `null`. */
function runningOf(payload: JsonValue): { type: string; target: string | null } | null {
  if (!isJsonObject(payload) || !isJsonObject(payload.activity)) return null;
  try {
    return runningActivity(payload as unknown as ActivitySnapshot);
  } catch {
    return null;
  }
}

/** Names an ended activity goes by in `after_activity` triggers. */
function endedNames(a: { type: string; target: string | null }): string[] {
  return a.target === null ? [a.type] : [a.type, `${a.type}:${a.target}`];
}

/** The wake as the journal records it (its trigger kinds predate Plan's wakes). */
function triggerOf(w: WakeReason, at: number): ThoughtTrigger {
  const kind: ThoughtTrigger["kind"] =
    w.kind === "heartbeat" || w.kind === "daily"
      ? "heartbeat"
      : w.kind === "manual"
        ? "manual"
        : "salient";
  const prefix =
    w.kind === "daily" ? "今天的第一次計畫" : w.kind === "goal_trigger" ? "目標觸發" : "";
  const detail = [prefix, w.detail].filter((s) => s !== "").join(":");
  return { kind, detail, context: w.context, at: toTimestamp(at) };
}

/** The status of an impulse after the Arbiter's decision, as her journal keeps it. */
export function outcomeOf(decision: ArbiterDecision): IntentOutcome {
  switch (decision.verdict) {
    case "accepted":
      return { status: "started", detail: decision.detail, turn: decision.turn };
    case "deferred":
      return {
        status: "pending",
        detail: `${decision.detail}${decision.retry_at ? `(${decision.retry_at} 後再試)` : ""}`,
        turn: null,
      };
    case "rejected":
      return { status: "denied", detail: decision.detail, turn: null };
    case "merged":
      return { status: "dropped", detail: `merged: ${decision.detail}`, turn: decision.turn };
    case "preempted":
    case "expired":
      return { status: "dropped", detail: decision.detail, turn: null };
  }
}

/** A trigger she wrote as a goal trigger (`at` resolved to an absolute time). */
export function resolveTrigger(
  draft: TriggerDraft,
  now: number,
  offsetMinutes: number,
): Goal["trigger"] {
  switch (draft.kind) {
    case "at": {
      if (draft.inMin !== null)
        return { kind: "at", time: toTimestamp(now + draft.inMin * MINUTE_MS) };
      const t = draft.time ?? "";
      const hm = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
      if (hm) {
        const local = new Date(now + offsetMinutes * MINUTE_MS);
        const at =
          Date.UTC(
            local.getUTCFullYear(),
            local.getUTCMonth(),
            local.getUTCDate(),
            Number(hm[1]),
            Number(hm[2]),
          ) -
          offsetMinutes * MINUTE_MS;
        return { kind: "at", time: toTimestamp(at > now ? at : at + DAY_MS) };
      }
      const abs = Date.parse(t);
      return Number.isNaN(abs) ? { kind: "whenever" } : { kind: "at", time: toTimestamp(abs) };
    }
    case "when_online":
      return { kind: "when_online", person: draft.person };
    case "after_activity":
      return { kind: "after_activity", activity: draft.activity };
    case "whenever":
      return { kind: "whenever" };
  }
}

export class MindLoop implements Mind {
  readonly #d: MindDeps;
  readonly #calls: CallLog;
  readonly #appraiseCalls: CallLog;
  readonly #segments = new Segments();
  /** What people said to her lately, oldest first, for Plan. */
  #heard: { at: number; who: string; text: string }[] = [];
  readonly #watch = new TriggerWatch();
  readonly #presence: PresenceStats;
  #wakes: WakeReason[] = [];
  #firstWakeAt: number | null = null;
  #suggestions: MindSuggestion[] = [];
  #salient: SalientEvent[] = [];
  /** Goals whose trigger fired since the last Plan. */
  readonly #fired = new Set<string>();
  /** Activities that ended since the last trigger check. */
  #ended: string[] = [];
  #activity: { type: string; target: string | null } | null = null;
  #nextHeartbeat: number | null = null;
  /** Plan runs in a row that changed nothing and did nothing. */
  #emptyStreak = 0;
  /** What things looked like after her last Plan (a heartbeat skips the call while same). */
  #lastPrint: string | null = null;
  #planned = 0;
  #emptyPlans = 0;
  /** Her valence at her last Plan (a drop wakes her). */
  #valence: number | null = null;
  #moodWoke = false;
  #lastDaily: string | null = null;
  #dayPlan: DayPlan | null = null;
  #yesterdayPlan: DayPlan | null = null;
  #seededDay: string | null = null;
  #started = false;
  #running = false;
  #thinking = false;
  #wake: (() => void) | null = null;
  #fallbackWarned = false;
  #tokens = 0;
  readonly #selfIds = new Set<string>();
  readonly #labels = new Map<string, string>();
  /** Turns of her intents (and events seen for turns not yet known to be hers). */
  readonly #turnEvents = new Map<TurnId, TurnEvent[]>();
  readonly #ownTurns = new Set<TurnId>();
  /** What she started herself, the backoff and her raised topics. */
  readonly #starts: SelfStarts;
  /** Turns she started herself (intents, initiative), by turn id. */
  readonly #selfTurns = new Map<TurnId, SelfTurn | null>();
  /** What her intent turns were about (known once the intent was submitted). */
  readonly #intentTurns = new Map<TurnId, SelfTurn>();
  /** A DM channel's place key (`dm:<account>`), learned from her DM turns. */
  readonly #dmPlaces = new Map<string, string>();
  /** Capabilities on hold after they failed. */
  readonly #blocks = new Map<string, Block>();
  #gameSeenAt: number | null = null;

  constructor(deps: MindDeps) {
    this.#d = deps;
    this.#calls = CallLog.of(deps.config);
    this.#appraiseCalls = new CallLog(deps.config.appraise_max_per_hour, 30_000);
    this.#starts = new SelfStarts(deps.config);
    this.#presence = new PresenceStats(deps.config.utc_offset_minutes);
  }

  // ---- Mind ---------------------------------------------------------------------------------

  get accepting(): boolean {
    return this.#idleReason() === null;
  }

  suggest(suggestion: MindSuggestion): boolean {
    if (!this.accepting) return false;
    this.#suggestions = [...this.#suggestions, suggestion].slice(-MAX_PENDING);
    // A followup must not be lost if she does not act on it right away: it becomes a goal.
    if (suggestion.reason === "followup") this.#followupGoal(suggestion);
    this.wakeUp({ kind: "salient", detail: suggestion.reason, context: suggestion.context });
    return true;
  }

  thoughts(limit = 50): Thought[] {
    return this.#d.journal.list(limit);
  }

  thought(id: string): Thought | null {
    return this.#d.journal.get(id);
  }

  digests(limit = 20): ThoughtDigest[] {
    return this.#d.journal.digests(limit);
  }

  unanswered(context: ContextKey | null): RaisedTopic[] {
    const key = context === null ? null : this.#placeOf(context);
    return this.#starts.unanswered(key, this.#now());
  }

  stats(): MindStats {
    const now = this.#now();
    const last = this.#calls.last();
    return {
      calls_last_hour: this.#calls.lastHour(now),
      max_calls_per_hour: this.#d.config.max_calls_per_hour,
      calls_total: this.#calls.total,
      tokens_total: this.#tokens,
      last_at: last === null ? null : toTimestamp(last),
      next_heartbeat_at: this.#nextHeartbeat === null ? null : toTimestamp(this.#nextHeartbeat),
      idle_reason: this.#idleReason(),
    };
  }

  /** Plan runs so far and how many of them changed nothing and did nothing. */
  planStats(): { runs: number; empty: number; empty_streak: number } {
    return { runs: this.#planned, empty: this.#emptyPlans, empty_streak: this.#emptyStreak };
  }

  /** Today's day plan (her words), if she wrote one. */
  dayPlan(): string | null {
    const today = localDay(this.#now(), this.#d.config.utc_offset_minutes).day;
    return this.#dayPlan?.day === today ? this.#dayPlan.text : null;
  }

  // ---- wakes --------------------------------------------------------------------------------

  #now(): number {
    return this.#d.clock.now();
  }

  #budget(): BudgetState {
    return this.#d.services.get(LlmRouterKey)?.budgetState() ?? "ok";
  }

  #idleReason(): string | null {
    if (!this.#running) return "not running";
    if (this.#d.services.get(ActuatorRegistryKey)?.paused) return "paused";
    if (this.#budget() === "exhausted") return "budget exhausted";
    if (this.#d.config.max_calls_per_hour === 0) return "max_calls_per_hour is 0";
    return null;
  }

  /** Something worth planning about happened. */
  wakeUp(w: WakeReason): void {
    if (this.#wakes.length === 0) this.#firstWakeAt = this.#now();
    this.#wakes = [...this.#wakes, w].slice(-MAX_PENDING);
    this.#wake?.();
  }

  /** The old trigger API (tests, the panel): a thought trigger as a Plan wake. */
  trigger(t: ThoughtTrigger): void {
    const kind: PlanWake =
      t.kind === "heartbeat" ? "heartbeat" : t.kind === "manual" ? "manual" : "salient";
    this.wakeUp({ kind, detail: t.detail, context: t.context });
  }

  #hear(who: string, text: string, now: number): void {
    if (text.trim() === "") return;
    this.#heard.push({ at: now, who, text: text.trim() });
    if (this.#heard.length > HEARD_LINES) this.#heard.shift();
  }

  #heardLately(now: number): string[] {
    return this.#heard
      .filter((h) => now - h.at <= HEARD_WINDOW_MS)
      .map((h) => `${h.who}: ${short(h.text, 120)}`);
  }

  #handleOfAccount(account: AccountRef, name: string | null): Handle | null {
    const handles = this.#d.services.get(HandleDirectoryKey);
    if (!handles) return name;
    const person = this.#d.services.get(SocialKey)?.personOf(account) ?? null;
    return handles.ofAccount(account, name ?? account.id, person);
  }

  #personOfHandle(handle: Handle): PersonId | null {
    return (
      this.#d.services.get(HandleDirectoryKey)?.resolve(handle)?.person ??
      this.#d.services.get(AffectStateKey)?.cardByHandle(handle)?.person ??
      null
    );
  }

  #followupGoal(s: MindSuggestion): void {
    const account = s.about[0];
    const person = account ? (this.#d.services.get(SocialKey)?.personOf(account) ?? null) : null;
    const handle =
      person === null ? null : (this.#d.services.get(HandleDirectoryKey)?.ofPerson(person) ?? null);
    const goals = this.#d.goals;
    const what = clean(s.hint);
    if (what === "" || goals.goals().some((g) => g.what === what)) return;
    try {
      goals.add({
        what,
        why: "之前說好要問的",
        trigger: handle === null ? { kind: "whenever" } : { kind: "when_online", person: handle },
        expires: toTimestamp(this.#now() + 2 * DAY_MS),
        person: handle,
        context: s.context,
        source: "plan",
      });
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "followup goal refused");
    }
  }

  /** The attachment of the person behind `account` (0 when unknown). */
  #attachment(account: AccountRef | null, person: PersonId | null): number {
    const affect = this.#d.services.get(AffectStateKey);
    if (!affect) return 0;
    const p =
      person ?? (account ? (this.#d.services.get(SocialKey)?.personOf(account) ?? null) : null);
    return p === null ? 0 : (affect.card(p)?.attachment ?? 0);
  }

  /** Feeds one bus event (salience, her turns, voice, activity, affect, gate decisions). */
  observe(env: Envelope): void {
    const event = env.event;
    const now = this.#now();
    switch (event.type) {
      case "platform_ready":
        this.#selfIds.add(event.data.self_account.id);
        return;
      case "platform_message_created": {
        const m = event.data;
        if (m.author.is_bot || this.#selfIds.has(m.author.account.id)) return;
        const verdict = inspectInput(this.#d.services, {
          id: m.id.id,
          text: incomingText(m),
          source: "chat",
          author: m.author.account,
          context: m.id.context,
        });
        if (verdict?.action === "ignore") return;
        const handle = this.#handleOfAccount(m.author.account, m.author.display_name);
        if (handle !== null) this.#presence.seen(handle, now);
        const called = m.mentions_self || m.reply_to_self || m.id.context.kind === "dm";
        if (called && !holdsBack(verdict)) {
          this.#hear(handle ?? m.author.display_name, m.text, now);
        }
        this.#segments.line(m.id.context, {
          at: now,
          who: handle ?? m.author.display_name,
          account: m.author.account,
          text: m.text,
          addressed: m.mentions_self || m.reply_to_self || m.id.context.kind === "dm",
        });
        return;
      }
      case "voice_joined":
      case "voice_participants":
        this.#wake?.();
        return;
      case "voice_utterance": {
        const u = event.data;
        if (u.speaker.is_bot || this.#selfIds.has(u.speaker.account.id)) return;
        const verdict = inspectInput(this.#d.services, {
          id: u.id,
          text: u.text.trim(),
          source: "voice",
          author: u.speaker.account,
          context: u.context,
        });
        if (verdict?.action === "ignore") return;
        const handle = this.#handleOfAccount(u.speaker.account, u.speaker.display_name);
        if (handle !== null) this.#presence.seen(handle, now);
        if (!holdsBack(verdict)) this.#hear(handle ?? u.speaker.display_name, u.text, now);
        this.#segments.line(u.context, {
          at: now,
          who: handle ?? u.speaker.display_name,
          account: u.speaker.account,
          text: u.text,
          // In voice everyone in the room talks with her.
          addressed: false,
        });
        return;
      }
      case "agent_turn_completed": {
        const { turn, context, text } = event.data;
        if (text.trim() !== "") {
          this.#segments.line(context, {
            at: now,
            who: null,
            account: null,
            text,
            addressed: false,
          });
        }
        const own = this.#turnEvent(turn, { type: "completed", text });
        if ((own || this.#selfTurns.has(turn)) && text.trim() !== "") {
          this.#startedTalking(turn, context, text, now);
        }
        return;
      }
      case "agent_decision": {
        const d = event.data;
        const skipped = d.reasons.find((r) => r.startsWith("skipped: "));
        if (!d.respond && skipped && d.reasons.some((r) => r.startsWith("intent:"))) {
          this.#turnEvent(d.turn, { type: "skipped", why: skipped.slice("skipped: ".length) });
        }
        // Her own turns (her intents; never an announcement, commentary, greeting or result:
        // those are no topics she raised, v2 §5 item 12) vs. someone addressing her there: a
        // real exchange, which answers what she raised.
        const selfStarted = d.reasons.some((r) => r.startsWith("intent:"));
        if (selfStarted) {
          if (d.respond) this.#selfTurn(d.turn);
        } else if (d.reasons.some((r) => r.startsWith("direct: "))) {
          this.#starts.engaged(this.#placeOf(d.context), now);
        }
        return;
      }
      case "custom":
        this.#custom(event.data.topic, event.data.payload, now);
        return;
      default:
        return;
    }
  }

  /** §9: what a new rule forbids is off her agenda at once, not when she next looks at it. */
  #ruleChanged(payload: JsonValue): void {
    const { op, directive } = payload as unknown as DirectiveChangedBody;
    const rules = this.#d.services.get(DirectivesKey);
    if (op !== "add" || directive?.effect !== "deny" || !rules) return;
    for (const goal of this.#d.goals.goals()) {
      const rule = rules.forbids(goal);
      if (rule !== null) this.#d.goals.setStatus(goal.id, "dropped", `規則:${rule.text}`);
    }
  }

  #custom(topic: string, payload: JsonValue, now: number): void {
    switch (topic) {
      case DIRECTIVE_CHANGED_TOPIC:
        this.#ruleChanged(payload);
        return;
      case SALIENT_TOPIC: {
        const salient = parseSalient(payload);
        if (!salient) return;
        const arrival = salient.kind === "came_online" || salient.kind === "joined_voice";
        if (arrival && salient.account) {
          const handle = this.#handleOfAccount(salient.account, salient.display_name);
          if (handle !== null) this.#presence.seen(handle, now);
        }
        const cared =
          arrival &&
          this.#attachment(salient.account, salient.person) >= this.#d.config.cared_attachment;
        if (this.#budget() === "degraded" && salient.score < DEGRADED_MIN_SCORE && !cared) return;
        // Someone coming online may fire a `when_online` goal: check right away.
        if (arrival) this.#wake?.();
        // The one cold-channel detector is world's `channel_quiet` (v2 §3.3); the voice channel
        // she is in going quiet after a conversation wakes her Plan whatever its score.
        const voiceLull = salient.kind === "channel_quiet" && salient.context?.kind === "voice";
        if (voiceLull && salient.context && !this.#mayStartIn(salient.context, now)) return;
        if (salient.score < SALIENT_MIN_SCORE && !cared && !voiceLull) return;
        this.#salient = [...this.#salient, salient].slice(-MAX_PENDING);
        this.wakeUp({ kind: "salient", detail: salient.detail, context: salient.context });
        return;
      }
      case "gate.decision": {
        if (!isJsonObject(payload)) return;
        const turn = typeof payload.turn === "string" ? payload.turn : null;
        if (turn === null) return;
        this.#turnEvent(turn, {
          type: "decision",
          decision: {
            at: typeof payload.at === "string" ? payload.at : toTimestamp(now),
            capability: String(payload.capability ?? ""),
            allowed: payload.allowed === true,
            stage: String(payload.stage ?? ""),
            reason: String(payload.reason ?? ""),
          },
        });
        return;
      }
      case "llm.budget":
        this.#wake?.();
        return;
      case ACTIVITY_CHANGED_TOPIC: {
        const running = runningOf(payload);
        const prev = this.#activity;
        this.#activity = running;
        if (running?.type === "game") {
          const first = this.#gameSeenAt === null || prev?.type !== "game";
          this.#gameSeenAt = now;
          if (first) this.#liftBlocks(now);
        }
        if (
          prev !== null &&
          (running === null || running.type !== prev.type || running.target !== prev.target)
        ) {
          this.#activityEnded(prev, null, now);
        }
        return;
      }
      case ACTIVITY_DONE_TOPIC:
      case ACTIVITY_FAILED_TOPIC: {
        if (!isJsonObject(payload) || payload.resource !== "activity") return;
        const request = isJsonObject(payload.request) ? payload.request : null;
        const failed = topic === ACTIVITY_FAILED_TOPIC;
        const detail = typeof payload.detail === "string" ? payload.detail : "";
        // A stop that finished, or an activity that failed while it ran (it ended early).
        const prev = this.#activity;
        if (failed && prev !== null) {
          this.#activity = null;
          this.#activityEnded(prev, detail === "" ? "失敗了" : detail, now);
        } else if (!failed && request?.type === "stop" && prev !== null) {
          this.#activity = null;
          this.#activityEnded(prev, null, now);
        }
        return;
      }
      case AFFECT_CHANGED_TOPIC: {
        if (!isJsonObject(payload) || !isJsonObject(payload.mood)) return;
        const valence = payload.mood.valence;
        if (typeof valence !== "number" || this.#valence === null || this.#moodWoke) return;
        if (this.#valence - valence >= this.#d.config.mood_drop) {
          this.#moodWoke = true;
          this.wakeUp({ kind: "affect", detail: "心情變差了", context: null });
        }
        return;
      }
      default:
        return;
    }
  }

  #activityEnded(
    a: { type: string; target: string | null },
    failure: string | null,
    now: number,
  ): void {
    this.#ended.push(...endedNames(a));
    const name = a.target === null ? a.type : `${a.type}(${a.target})`;
    const detail = failure === null ? `${name} 結束了` : `${name} 提早結束了:${failure}`;
    const her = this.#herVoice();
    if (her !== null) this.#segments.event(her, detail, now);
    this.wakeUp({ kind: "activity_ended", detail, context: null });
  }

  /** The place key of `context` (a DM channel maps to its partner once known). */
  #placeOf(context: ContextKey): string {
    const key = placeKey(context);
    return this.#dmPlaces.get(key) ?? key;
  }

  #selfTurn(turn: TurnId): void {
    if (!this.#selfTurns.has(turn)) this.#selfTurns.set(turn, null);
    if (this.#selfTurns.size > MAX_SELF_TURNS) {
      const oldest = this.#selfTurns.keys().next().value;
      if (oldest !== undefined) this.#selfTurns.delete(oldest);
    }
  }

  /** She said `text` in a turn she started herself: the backoff and her raised topics. */
  #startedTalking(turn: TurnId, context: ContextKey, text: string, now: number): void {
    const info = this.#intentTurns.get(turn) ?? this.#selfTurns.get(turn) ?? null;
    let key = placeKey(context);
    if (info?.dm) {
      const dm = `dm:${info.dm.platform}:${info.dm.id}`;
      this.#dmPlaces.set(key, dm);
      key = dm;
    }
    this.#starts.started(key, kindOf(context), context, now, text, info?.about ?? "");
  }

  /** Her voice channel, from the activity snapshot (else the world). */
  #herVoice(): ContextKey | null {
    const snap = this.#d.services.get(ActivityManagerKey)?.snapshot();
    if (snap) return snap.presence.type === "in" ? snap.presence.channel : null;
    return this.#d.services.get(WorldStateKey)?.snapshot().her.voice ?? null;
  }

  /** What she is doing (`game`, `singing`, ...), from the activity snapshot (else the world). */
  #doing(): { type: string; target: string | null } | null {
    const manager = this.#d.services.get(ActivityManagerKey);
    if (manager) return runningActivity(manager.snapshot());
    const game = this.#d.services.get(WorldStateKey)?.snapshot().her.game ?? null;
    return game === null ? null : { type: "game", target: game };
  }

  /** What her actions depend on right now (for holding and lifting blocks). */
  #situation(): Situation {
    const world = this.#d.services.get(WorldStateKey)?.snapshot() ?? null;
    const her = world?.her ?? null;
    const doing = this.#doing();
    const voice = this.#herVoice();
    const room = world?.voice_channels.find(
      (c) => c.guild === voice?.scope && c.channel === voice.channel,
    );
    return {
      game: doing?.type === "game" ? (doing.target ?? "game") : null,
      gameSeenAt: this.#gameSeenAt,
      voice: voice ? contextKeyString(voice) : null,
      live: `${her?.golive ?? ""}|${her?.streaming ?? false}`,
      scene: her?.scene ?? null,
      streamers: (room?.members ?? [])
        .filter((m) => m.streaming && !m.is_self)
        .map((m) => accountRefString(m.account))
        .sort()
        .join(","),
    };
  }

  /** Puts `intent`'s capability on hold after it failed. */
  #block(thoughtId: string, intent: Intent, reason: string): void {
    const now = this.#now();
    const cap = intent.capability;
    const why = [...reason.replace(/\s+/g, " ").trim()].slice(0, 160).join("");
    this.#blocks.set(cap, {
      capability: cap,
      reason: why,
      at: now,
      condition: conditionOf(cap, this.#situation()),
    });
    this.#d.journal.update(thoughtId, (t) => {
      t.changes.push(`暫停 ${cap}(${clean(why)})`);
    });
  }

  /** Lifts holds whose situation changed (or that waited long enough). */
  #liftBlocks(now: number): void {
    const s = this.#situation();
    const retry = this.#d.config.blocked_retry_mins * MINUTE_MS;
    for (const [cap, b] of this.#blocks) {
      if (blockLifted(b, s, now, retry)) this.#blocks.delete(cap);
    }
  }

  /**
   * Records an event of an intent turn. Returns whether the turn is (or may become) one of hers;
   * unknown turns are remembered until an intent outcome claims them.
   */
  #turnEvent(turn: TurnId, e: TurnEvent): boolean {
    const list = this.#turnEvents.get(turn) ?? [];
    list.push(e);
    this.#turnEvents.set(turn, list);
    if (this.#turnEvents.size > MAX_TURN_EVENTS) {
      const oldest = this.#turnEvents.keys().next().value;
      if (oldest !== undefined) this.#turnEvents.delete(oldest);
    }
    if (!this.#ownTurns.has(turn)) return false;
    const at = toTimestamp(this.#now());
    this.#d.journal.updateByTurn(turn, (_t, intent) => applyTurnEvent(intent, e, at));
    return true;
  }

  #own(turn: TurnId): void {
    this.#ownTurns.add(turn);
    if (this.#ownTurns.size > MAX_TURN_EVENTS) {
      const oldest = this.#ownTurns.values().next().value;
      if (oldest !== undefined) this.#ownTurns.delete(oldest);
    }
  }

  /**
   * Without the Arbiter, mind's own floor: no lull wake while she may not start talking there
   * anyway (her self-start gap). With the Arbiter its ledger is what she plans with.
   */
  #mayStartIn(context: ContextKey, now: number): boolean {
    if (this.#d.services.get(ArbiterKey)) return true;
    return this.#starts.wait(this.#placeOf(context), "voice", now).ms <= 0;
  }

  // ---- goal triggers ------------------------------------------------------------------------

  /** Where `handle` is: in voice, online or offline (as far as she can see). */
  where(handle: Handle): Whereabouts {
    const world = this.#d.services.get(WorldStateKey);
    if (!world) return "offline";
    const entry = this.#d.services.get(HandleDirectoryKey)?.resolve(handle) ?? null;
    const snap = world.snapshot();
    const account =
      entry?.account ??
      snap.people.find((p) => p.display_name === handle)?.account ??
      snap.voice_channels.flatMap((v) => v.members).find((m) => m.display_name === handle)
        ?.account ??
      null;
    if (account === null) return "offline";
    const inVoice = snap.voice_channels.some((v) =>
      v.members.some(
        (m) => !m.is_self && m.account.platform === account.platform && m.account.id === account.id,
      ),
    );
    const presence = world.person(account);
    if (inVoice || presence?.voice) return "voice";
    if (presence?.status != null && presence.status !== "offline") return "online";
    return "offline";
  }

  #probe(now: number): TriggerProbe {
    return { now, online: (h) => this.where(h) !== "offline", ended: this.#ended };
  }

  /** Drops expired goals and wakes Plan for goals whose trigger started firing. */
  #checkGoals(now: number): void {
    const goals = this.#d.goals;
    for (const g of goals.sweep()) log.debug({ goal: g.id }, "goal expired");
    const fired = this.#watch.check(
      goals.goals(),
      this.#probe(now),
      this.#d.config.goal_refire_mins * MINUTE_MS,
    );
    this.#ended = [];
    for (const g of fired) {
      if (g.status === "pending") goals.setStatus(g.id, "active");
      this.#fired.add(g.id);
      this.wakeUp({
        kind: "goal_trigger",
        detail: `${goalKey(g)}「${g.what}」(${describeTrigger(g.trigger, this.#d.config.utc_offset_minutes)})`,
        context: g.context,
      });
    }
  }

  // ---- loop ---------------------------------------------------------------------------------

  async run(signal: AbortSignal): Promise<void> {
    this.#running = true;
    try {
      if (!this.#started) {
        this.#started = true;
        await this.#startUp();
      }
      while (!signal.aborted) {
        const now = this.#now();
        this.#checkGoals(now);
        const segments = this.#segments.ready(
          now,
          this.#d.config.appraise_quiet_secs * 1000,
          this.#d.config.appraise_min_lines,
        );
        if (segments.length > 0) {
          if (this.#idleReason() === null && this.#budget() === "ok") {
            await this.appraise(segments, signal);
          }
          continue;
        }
        const delay = this.#due(now);
        if (delay <= 0) {
          await this.#planPending(signal);
          continue;
        }
        let nap = Math.min(delay, 60_000);
        const seg = this.#segments.nextMs(now, this.#d.config.appraise_quiet_secs * 1000);
        if (seg !== null) nap = Math.min(nap, Math.max(seg, 1000));
        const at = TriggerWatch.nextAt(this.#d.goals.goals(), now);
        if (at !== null) nap = Math.min(nap, Math.max(at - now, 1000));
        // A wake ends the nap early (and its timer with it).
        const napping = new AbortController();
        const stop = () => napping.abort();
        signal.addEventListener("abort", stop, { once: true });
        this.#wake = stop;
        await sleep(nap, napping.signal).catch(() => undefined);
        signal.removeEventListener("abort", stop);
        this.#wake = null;
      }
    } finally {
      this.#running = false;
    }
  }

  /** Loads her plan state and migrates her old free-text agenda into goals (once). */
  async #startUp(): Promise<void> {
    const store = this.#d.store;
    if (store) {
      try {
        const state = await store.get(this.#d.profile, PLAN_STATE_KEY);
        if (isJsonObject(state)) {
          this.#lastDaily = typeof state.last_daily === "string" ? state.last_daily : null;
          const plan = (v: JsonValue | undefined): DayPlan | null =>
            isJsonObject(v) && typeof v.day === "string" && typeof v.text === "string"
              ? { day: v.day, text: v.text, at: typeof v.at === "string" ? v.at : "" }
              : null;
          this.#dayPlan = plan(state.day_plan);
          this.#yesterdayPlan = plan(state.yesterday_plan);
          this.#presence.load(state.presence);
        }
      } catch (error) {
        this.#d.log.warn({ err: errorMessage(error) }, "cannot load her plan state");
      }
    }
    const self = this.#d.services.get(SelfStateKey);
    if (self) {
      const handles = this.#d.services.get(HandleDirectoryKey);
      const open = self.agenda();
      const added = this.#d.goals.migrate(open, (p) => handles?.ofPerson(p) ?? null);
      if (added > 0) this.#d.log.info({ goals: added }, "her agenda became goals");
      // One agenda: what became a goal is closed in the old free-text one (`self:state`).
      let closed = 0;
      for (const item of open) {
        if (this.#d.goals.migrated(item.id) && self.dropAgenda(item.id) !== null) closed++;
      }
      if (closed > 0) this.#d.log.info({ items: closed }, "closed her migrated agenda items");
    }
  }

  #saveState(): void {
    const store = this.#d.store;
    if (!store) return;
    const value: JsonValue = {
      last_daily: this.#lastDaily,
      day_plan: this.#dayPlan === null ? null : { ...this.#dayPlan },
      yesterday_plan: this.#yesterdayPlan === null ? null : { ...this.#yesterdayPlan },
      presence: this.#presence.toJSON(),
    };
    void store.set(this.#d.profile, PLAN_STATE_KEY, value).catch((error: unknown) => {
      this.#d.log.warn({ err: errorMessage(error) }, "cannot persist her plan state");
    });
  }

  /** Ms until the next Plan may happen (≤ 0: now). */
  #due(now: number): number {
    if (this.#idleReason() !== null) {
      // Nothing waits through a pause: what was going on is stale by then.
      this.#wakes = [];
      this.#suggestions = [];
      this.#salient = [];
      this.#nextHeartbeat = null;
      return 30_000;
    }
    const { day, hour } = localDay(now, this.#d.config.utc_offset_minutes);
    if (this.#lastDaily !== day && hour >= this.#d.config.daily_hour) {
      if (!this.#wakes.some((w) => w.kind === "daily")) {
        this.wakeUp({ kind: "daily", detail: "", context: null });
      }
    }
    const rate = this.#calls.waitMs(now);
    if (this.#wakes.length > 0) {
      const coalesced = (this.#firstWakeAt ?? now) + this.#d.config.coalesce_ms - now;
      return Math.max(coalesced, rate);
    }
    if (this.#nextHeartbeat === null) this.#scheduleHeartbeat(now);
    if (this.#nextHeartbeat === null) return 60_000;
    return Math.max(this.#nextHeartbeat - now, rate);
  }

  #scheduleHeartbeat(now: number): void {
    const affect = this.#d.services.get(AffectStateKey)?.snapshot() ?? null;
    const self = affect ? null : this.#d.services.get(SelfStateKey);
    const urge = affect
      ? urgeOf(affect.boredom, affect.drives)
      : self
        ? urgeOf(self.boredom(), self.drives())
        : 0;
    const quiet =
      this.#d.services.get(ArbiterKey)?.ledger(null).limits.quiet_hours?.active ?? false;
    const ms = heartbeatMs(
      {
        urge,
        emptyStreak: this.#emptyStreak,
        quiet,
        budget: this.#budget(),
        initiative: affect?.biases.initiative ?? 0,
      },
      this.#d.config,
    );
    this.#nextHeartbeat = ms === null ? null : now + ms;
  }

  async #planPending(signal: AbortSignal): Promise<void> {
    const now = this.#now();
    const wakes: WakeReason[] =
      this.#wakes.length > 0 ? this.#wakes : [{ kind: "heartbeat", detail: "", context: null }];
    const suggestions = this.#suggestions;
    const salient = this.#salient;
    this.#wakes = [];
    this.#suggestions = [];
    this.#salient = [];
    this.#firstWakeAt = null;
    const onlyHeartbeat = wakes.every((w) => w.kind === "heartbeat");
    // Nothing changed since her last plan: thinking again would only spin (cheap check).
    if (onlyHeartbeat && this.#lastPrint !== null && this.#lastPrint === this.#fingerprint()) {
      this.#emptyStreak += 1;
      this.#scheduleHeartbeat(now);
      return;
    }
    await this.plan(wakes, suggestions, salient, signal);
    this.#scheduleHeartbeat(this.#now());
  }

  /** What Plan would see, coarsely: a heartbeat with the same print would change nothing. */
  #fingerprint(): string {
    const affect = this.#d.services.get(AffectStateKey)?.snapshot() ?? null;
    const goals = this.#d.goals.goals();
    const desires = this.#desires(affect, goals, new Set());
    const bucket = (w: number) => Math.round(w * 5);
    const cared = (this.#d.services.get(AffectStateKey)?.cards() ?? [])
      .filter((c) => c.attachment >= this.#d.config.cared_attachment)
      .map((c) => `${c.handle}:${this.where(c.handle)}`)
      .sort();
    const doing = this.#doing();
    return JSON.stringify([
      desires.slice(0, 3).map((d) => `${d.want}:${d.person ?? ""}:${bucket(d.weight)}`),
      goals.map((g) => g.id),
      cared,
      doing === null ? null : `${doing.type}:${doing.target ?? ""}`,
      this.#herVoice() === null ? null : "voice",
    ]);
  }

  #capabilities(): Set<string> {
    const registry = this.#d.services.get(ActuatorRegistryKey);
    const names = (registry?.names() ?? []).filter((n) => !NOT_FOR_HER.includes(n));
    return new Set([...names, CHAT_START, CHAT_DM]);
  }

  #desires(affect: AffectSnapshot | null, goals: Goal[], fired: ReadonlySet<string>): Desire[] {
    const cards = this.#d.services.get(AffectStateKey)?.cards() ?? [];
    return rankDesires({
      affect,
      cards,
      where: (h) => this.where(h),
      goals,
      fired,
      capabilities: this.#capabilities(),
      activity: this.#doing()?.type ?? null,
      inVoice: this.#herVoice() !== null,
      cared: this.#d.config.cared_attachment,
    });
  }

  /** The limits she plans with: the Arbiter's ledger, else her own fallback floor. */
  #limits(focus: ContextKey | null, now: number): PlanLimits {
    const arbiter = this.#d.services.get(ArbiterKey);
    if (arbiter) {
      try {
        return fromLedger(arbiter.ledger(focus));
      } catch (error) {
        this.#d.log.debug({ err: errorMessage(error) }, "cannot read the ledger");
      }
    }
    const retry = this.#d.config.blocked_retry_mins * MINUTE_MS;
    const { day } = localDay(now, this.#d.config.utc_offset_minutes);
    const dayStart =
      Date.parse(`${day}T00:00:00.000Z`) - this.#d.config.utc_offset_minutes * MINUTE_MS;
    const focusKey = focus === null ? null : this.#placeOf(focus);
    const focusWait =
      focus === null || focusKey === null ? 0 : this.#starts.wait(focusKey, kindOf(focus), now).ms;
    const limits: LedgerLimits = {
      initiatives_today: this.#starts.startsSince(dayStart),
      initiative_cap: null,
      unanswered_streak: this.#starts.maxMisses(now),
      next_initiative_at: focusWait > 0 ? toTimestamp(now + focusWait) : null,
      quiet_hours: null,
      paused: this.#d.services.get(ActuatorRegistryKey)?.paused ?? false,
      blocked: [...this.#blocks.values()].map((b) => ({
        capability: b.capability,
        reason: b.reason,
        until: toTimestamp(b.at + retry),
      })),
    };
    return {
      source: "mind",
      limits,
      entries: [],
      unanswered: this.#starts.unanswered(focusKey, now),
      waits: this.#starts
        .waits(now)
        .slice(0, 4)
        .map((w) => ({ place: w.key, ms: w.ms, misses: w.misses })),
    };
  }

  // ---- LLM ----------------------------------------------------------------------------------

  /** One structured call with one repair try; tokens and calls go on `thought`. */
  async #call<T>(
    label: string,
    thought: Thought,
    messages: ChatMessage[],
    reasoning: "appraise" | "plan" | "plan_daily",
    maxTokens: number,
    parse: (text: string) => T,
    signal: AbortSignal | undefined,
  ): Promise<{ value: T; response: ChatResponse }> {
    const d = this.#d;
    const router = d.services.get(LlmRouterKey);
    if (!router) throw new Error("no llm router");
    const cfg = d.config;
    if (!router.configures(cfg.purpose) && !this.#fallbackWarned) {
      this.#fallbackWarned = true;
      d.log.warn({ purpose: cfg.purpose }, "no model chain for the mind purpose; using chat");
    }
    const costs = new Map<string, number | null>();
    const onCall = (call: { id: string; cost_usd: number | null }) => {
      if (!costs.has(call.id)) thought.calls?.push(call.id);
      costs.set(call.id, call.cost_usd);
      const known = [...costs.values()].filter((c): c is number => c !== null);
      thought.cost_usd = known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
    };
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);
    try {
      let current = messages;
      for (let attempt = 1; ; attempt++) {
        thought.attempts = attempt;
        const response = await withLlmTag(
          {
            module: "mind",
            thought: thought.id,
            label,
            repair: attempt > 1 ? attempt - 1 : null,
            onCall,
          },
          () =>
            router.complete(
              cfg.purpose,
              {
                messages: current,
                json_mode: true,
                reasoning_purpose: reasoning,
                max_tokens: maxTokens,
                session: `mind-${d.profile}-${label}`,
              },
              controller.signal,
            ),
        );
        thought.reasoning = clipReasoning(response.reasoning);
        const usage = response.usage;
        if (usage) {
          const used = usage.prompt_tokens + usage.completion_tokens;
          thought.tokens = (thought.tokens ?? 0) + used;
          this.#tokens += used;
        }
        try {
          return { value: parse(response.text), response };
        } catch (error) {
          const fixable = error instanceof MindReplyError || error instanceof AppraiseReplyError;
          if (!fixable || attempt >= 2) throw error;
          current = [
            ...current,
            assistantMessage([...response.text].slice(0, 4000).join("")),
            userMessage(
              `上面的回覆不能用:${(error as Error).message}。請只回傳一個符合格式的 JSON 物件,不要加其他文字。`,
            ),
          ];
        }
      }
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw new Error("timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #core(): string {
    return characterCore(this.#d.persona());
  }

  #blankThought(at: number, triggers: ThoughtTrigger[]): Thought {
    return {
      id: newId(),
      at: toTimestamp(at),
      triggers,
      thought: "",
      changes: [],
      intents: [],
      tokens: null,
      error: null,
      ms: 0,
      suggestions: [],
      input: null,
      reasoning: null,
      effects: null,
      calls: [],
      cost_usd: null,
      attempts: 0,
      idle: null,
    };
  }

  // ---- Appraise -----------------------------------------------------------------------------

  /** Appraises interaction segments that ended; `null` when she cannot right now. */
  async appraise(segments: Segment[], signal?: AbortSignal): Promise<Thought | null> {
    const d = this.#d;
    const affect = d.services.get(AffectStateKey);
    const router = d.services.get(LlmRouterKey);
    if (!affect || !router || this.#thinking || segments.length === 0) return null;
    const started = this.#now();
    if (this.#appraiseCalls.waitMs(started) > 0) {
      d.log.debug({ segments: segments.length }, "appraise capped; segments dropped");
      return null;
    }
    this.#thinking = true;
    try {
      const cards = new Map<Handle, NonNullable<ReturnType<typeof affect.cardByHandle>>>();
      for (const s of segments) {
        for (const l of s.lines) {
          if (l.who === null || cards.has(l.who)) continue;
          const card = affect.cardByHandle(l.who);
          if (card) cards.set(l.who, card);
        }
      }
      const context = segments.at(-1)?.context ?? null;
      const who = [
        ...new Set(segments.flatMap((s) => s.lines.flatMap((l) => (l.who ? [l.who] : [])))),
      ];
      const thought = this.#blankThought(started, [
        {
          kind: "turn",
          detail: `一段互動結束了${who.length > 0 ? `(${who.slice(0, 4).join("、")})` : ""}`,
          context,
          at: toTimestamp(started),
        },
      ]);
      this.#appraiseCalls.record(started);
      let reply: AppraiseReply;
      try {
        const out = await this.#call(
          "appraise",
          thought,
          appraiseMessages({
            name: d.name,
            core: this.#core(),
            time: localTime(started, d.config.utc_offset_minutes),
            segments,
            cards,
          }),
          "appraise",
          d.config.appraise_max_tokens,
          parseAppraiseReply,
          signal,
        );
        reply = out.value;
      } catch (error) {
        if (signal?.aborted) return null;
        thought.error = errorMessage(error);
        thought.ms = this.#now() - started;
        d.log.warn({ err: thought.error }, "her appraisal failed");
        await d.journal.add(thought);
        return thought;
      }
      const result = await applyAppraisal(reply, affect, context, this.#now(), (h) =>
        this.#personOfHandle(h),
      );
      const effects = noEffects();
      for (const b of result.bonds) {
        effects.feelings.push({
          person: b.person,
          name: b.handle,
          note: b.feeling ? (affect.card(b.person)?.feeling ?? null) : null,
          hint: b.affinity > 0 ? "+" : b.affinity < 0 ? "-" : null,
        });
      }
      thought.effects = effects;
      thought.changes = result.changes.map(clean).filter((c) => c !== "");
      thought.thought =
        thought.changes.length === 0
          ? "(感受)沒什麼特別的。"
          : `(感受)${thought.changes.join(";")}`;
      thought.ms = this.#now() - started;
      await d.journal.add(thought);
      return thought;
    } finally {
      this.#thinking = false;
    }
  }

  // ---- Plan ---------------------------------------------------------------------------------

  /** Plans once about `wakes`; `null` when she cannot right now. */
  async plan(
    wakes: WakeReason[],
    suggestions: MindSuggestion[] = [],
    salient: SalientEvent[] = [],
    signal?: AbortSignal,
  ): Promise<Thought | null> {
    const d = this.#d;
    const router = d.services.get(LlmRouterKey);
    if (!router || this.#thinking) return null;
    this.#thinking = true;
    const started = this.#now();
    try {
      const cfg = d.config;
      this.#liftBlocks(started);
      d.goals.sweep();
      const daily = wakes.some((w) => w.kind === "daily");
      const triggers = wakes.map((w) => triggerOf(w, started));
      const snap = await gather({
        services: d.services,
        profile: d.profile,
        now: started,
        triggers,
        suggestions,
        salient,
        contributors: cfg.contributors,
        labels: this.#labels,
        ...(signal ? { signal } : {}),
      });
      const affect = d.services.get(AffectStateKey)?.snapshot() ?? null;
      const self = affect ? null : (d.services.get(SelfStateKey)?.snapshot() ?? null);
      const limits = this.#limits(snap.focus, started);
      const fired = new Set(this.#fired);
      this.#fired.clear();
      const goals = d.goals.goals();
      const desires = this.#desires(affect, goals, fired);
      const today = localDay(started, cfg.utc_offset_minutes).day;
      if (daily) await this.#seedPresence(today);
      const input: PlanInput = {
        name: d.name,
        core: this.#core(),
        time: localTime(started, cfg.utc_offset_minutes),
        daily,
        wakes,
        affect,
        self,
        capabilities: capabilityInfo(d.services.get(ActuatorRegistryKey)),
        maxImpulses: cfg.max_intents,
        limits,
        now: started,
        utcOffsetMinutes: cfg.utc_offset_minutes,
        world: snap.world,
        places: snap.places,
        people: snap.people,
        goals,
        fired,
        desires,
        suggestions,
        recent: d.journal.recent(RECENT_THOUGHTS),
        heard: this.#heardLately(started),
        dayPlan: this.#dayPlan?.day === today ? this.#dayPlan.text : null,
        ...(daily
          ? {
              habits: this.#habits(started),
              yesterday: this.#yesterday(started),
              reactions: this.#reactions(),
            }
          : {}),
        memories: snap.memories,
        watch: snap.watch,
        documents: snap.documents,
        lessons: snap.lessons,
        recap: snap.recap,
        digest: d.journal.digests(1)[0]?.summary ?? null,
        unanswered: limits.unanswered.map((t) => t.text),
      };
      this.#calls.record(started);
      this.#planned += 1;
      if (daily) {
        this.#lastDaily = today;
        this.#saveState();
      }
      if (affect) {
        this.#valence = affect.mood.valence;
        this.#moodWoke = false;
      }
      const thought = this.#blankThought(started, triggers);
      thought.suggestions = suggestions.map((s) => structuredClone(s));
      thought.input = thoughtInput(input);
      let reply: PlanReply;
      try {
        const out = await this.#call(
          daily ? "plan_daily" : "plan",
          thought,
          planMessages(input),
          daily ? "plan_daily" : "plan",
          cfg.max_tokens,
          (text) => parsePlanReply(text, cfg.max_intents),
          signal,
        );
        reply = out.value;
      } catch (error) {
        if (signal?.aborted) return null;
        thought.error = errorMessage(error);
        thought.ms = this.#now() - started;
        d.log.warn({ err: thought.error }, "her plan failed");
        await d.journal.add(thought);
        return thought;
      }
      thought.thought = clean(reply.thought);
      thought.ms = this.#now() - started;
      const effects = noEffects();
      const changes = this.#applyGoals(reply, snap, started, effects, daily);
      if (reply.dayPlan !== null) {
        const text = clean(reply.dayPlan);
        if (text !== "") {
          if (this.#dayPlan && this.#dayPlan.day !== today) this.#yesterdayPlan = this.#dayPlan;
          this.#dayPlan = { day: today, text, at: toTimestamp(started) };
          changes.push(daily ? "寫了今天的計畫" : "改了今天的計畫");
          this.#saveState();
        }
      }
      thought.changes = changes.map(clean).filter((c) => c !== "");
      thought.effects = effects;
      const planned = this.#impulses(reply.impulses, snap, fired, started);
      thought.intents = planned.map(([, record]) => record);
      const acted = planned.filter(([p]) => p !== null).length;
      const empty = thought.changes.length === 0 && acted === 0;
      if (empty || isEmptyPlan(reply)) {
        this.#emptyStreak += 1;
        this.#emptyPlans += 1;
      } else {
        this.#emptyStreak = 0;
      }
      this.#lastPrint = this.#fingerprint();
      await d.journal.add(thought);
      // Acting can take a while (the Arbiter, the scheduler's lanes): the loop goes on.
      void this.#act(thought.id, planned, signal).catch((error: unknown) => {
        d.log.warn({ err: errorMessage(error) }, "acting on her impulses failed");
      });
      return thought;
    } finally {
      this.#thinking = false;
    }
  }

  /** Her goal changes, applied; returns what changed, in words. */
  #applyGoals(
    reply: PlanReply,
    snap: Gathered,
    now: number,
    effects: ReturnType<typeof noEffects>,
    daily: boolean,
  ): string[] {
    const goals = this.#d.goals;
    const offset = this.#d.config.utc_offset_minutes;
    const changes: string[] = [];
    // Someone in the snapshot, someone the handle table or the world knows, else the name she
    // wrote when it can be a handle (a `when_online` goal waits for them to show up).
    const personHandle = (ref: string | null): Handle | null => {
      if (ref === null) return null;
      const p = personByRef(snap.people, ref) ?? this.#personOutside(ref);
      if (p) return p.ref;
      const r = ref.trim();
      return isValidHandle(r) ? r : null;
    };
    const triggerOf = (draft: TriggerDraft): Goal["trigger"] => {
      const t = resolveTrigger(draft, now, offset);
      if (t.kind !== "when_online") return t;
      const handle = personHandle(t.person);
      return handle === null ? { kind: "whenever" } : { kind: "when_online", person: handle };
    };
    const expires = (h: number | null) => (h === null ? undefined : toTimestamp(now + h * HOUR_MS));
    for (const a of reply.add as GoalDraft[]) {
      const what = clean(a.what);
      if (what === "" || goals.goals().some((g) => g.what === what)) continue;
      try {
        const place = a.place === null ? undefined : placeByRef(snap.places, a.place);
        const goal = goals.add({
          what,
          why: a.why,
          trigger: triggerOf(a.trigger),
          steps: a.steps,
          expires:
            expires(a.expiresInHours) ??
            toTimestamp(now + this.#d.config.goal_default_days * DAY_MS),
          person: personHandle(a.person),
          context: place?.context ?? null,
          source: daily ? "plan_daily" : "plan",
        });
        changes.push(`目標 +「${goal.what}」(${describeTrigger(goal.trigger, offset)})`);
        effects.agenda_added.push({ text: goal.what, why: goal.why });
      } catch (error) {
        if (!(error instanceof GoalError)) throw error;
      }
    }
    for (const e of reply.edit) {
      const goal = goals.byKey(e.goal);
      if (!goal) continue;
      const exp = expires(e.expiresInHours);
      const edited = goals.edit(goal.id, {
        ...(e.what === null ? {} : { what: e.what }),
        ...(e.why === null ? {} : { why: e.why }),
        ...(e.trigger === null ? {} : { trigger: triggerOf(e.trigger) }),
        ...(e.steps === null ? {} : { steps: e.steps }),
        ...(exp === undefined ? {} : { expires: exp }),
      });
      if (edited)
        changes.push(`目標改了「${edited.what}」(${describeTrigger(edited.trigger, offset)})`);
    }
    for (const key of reply.done) {
      const goal = goals.byKey(key);
      if (goal && goals.setStatus(goal.id, "done", "完成了")) {
        changes.push(`完成目標「${goal.what}」`);
        effects.agenda_done.push(goal.what);
      }
    }
    for (const drop of reply.drop) {
      const goal = goals.byKey(drop.goal);
      if (goal && goals.setStatus(goal.id, "dropped", drop.why === "" ? "改變主意了" : drop.why)) {
        changes.push(`放棄目標「${goal.what}」`);
        effects.agenda_dropped.push(goal.what);
      }
    }
    return changes;
  }

  /** Her impulses resolved against the snapshot: `[planned, journal record]`. */
  #impulses(
    drafts: readonly ImpulseDraft[],
    snap: Gathered,
    fired: ReadonlySet<string>,
    now: number,
  ): [Planned | null, ThoughtIntent][] {
    const registry = this.#d.services.get(ActuatorRegistryKey);
    const arbiter = this.#d.services.get(ArbiterKey);
    const world = this.#d.services.get(WorldStateKey)?.snapshot() ?? null;
    return drafts.map((draft) => {
      const place = draft.place === null ? undefined : placeByRef(snap.places, draft.place);
      const goal = draft.goal === null ? null : this.#d.goals.byKey(draft.goal);
      let who = draft.person === null ? undefined : personByRef(snap.people, draft.person);
      if (!who && draft.person !== null) who = this.#personOutside(draft.person);
      if (!who && goal?.person)
        who = personByRef(snap.people, goal.person) ?? this.#personOutside(goal.person);
      let capability: string;
      if (draft.kind === "speak") {
        capability =
          draft.capability === CHAT_DM || (draft.capability !== CHAT_START && !place && who)
            ? CHAT_DM
            : CHAT_START;
      } else {
        capability = draft.capability ?? "";
      }
      const args = { ...draft.args };
      let problem: string | null = null;
      if (draft.kind === "act") {
        if (capability === "") problem = "no capability";
        else if (registry?.get(capability) === undefined || NOT_FOR_HER.includes(capability)) {
          problem = "not something she can do";
        }
      }
      let context: ContextKey | null = place?.context ?? goal?.context ?? snap.focus;
      if (capability === CHAT_DM) {
        if (!who) problem ??= "nobody to DM";
        else args.to = who.account.id;
      }
      if (capability === "voice.join") {
        const spot =
          place?.context.kind === "voice"
            ? place.context
            : who
              ? (() => {
                  const v = world?.voice_channels.find((c) =>
                    c.members.some((m) => m.account.id === who?.account.id),
                  );
                  return v
                    ? ({
                        platform: v.platform,
                        scope: v.guild,
                        channel: v.channel,
                        kind: "voice",
                      } as ContextKey)
                    : null;
                })()
              : null;
        if (spot) {
          args.channel = spot.channel;
          if (spot.scope !== null) args.guild = spot.scope;
          context = spot;
        }
        if (args.channel === undefined) problem ??= "no voice channel to join";
      }
      if (capability === "voice.leave") {
        // Where she is, whatever she wrote: she knows refs (`p1`), not server ids.
        const voice = this.#herVoice();
        args.guild = voice?.scope ?? null;
        if (voice === null) problem ??= "she is not in voice";
        else context = voice;
      }
      if (capability === "watch.start" && who && args.user == null) args.user = who.account.id;
      if (capability === CHAT_START && context === null) problem ??= "no place to talk";
      if (context?.kind === "dm") context = null;
      const why = clean(draft.why);
      const hint = draft.hint === null ? null : clean(draft.hint) || null;
      // Without the Arbiter her own floor applies (the backoff, topics nobody picked up, the
      // channel's level, actions on hold); with it, the Arbiter decides and records why.
      if (!arbiter && problem === null)
        problem = this.#floor(capability, context, who, hint, why, now);
      const expiresAt = toTimestamp(now + draft.expiresInMin * MINUTE_MS);
      const target = {
        context,
        person: who?.ref ?? goal?.person ?? null,
        account: who?.account ?? null,
      };
      const impulse: Impulse = {
        id: newId(),
        source: goal !== null && fired.has(goal.id) ? "agenda" : "plan",
        kind: draft.kind,
        target,
        capability,
        args: JSON.parse(JSON.stringify(args)),
        priority: "initiative",
        expires_at: expiresAt,
        why,
        hint,
        about: who ? [who.account] : [],
        coalesce_key: `${capability}:${context ? contextKeyString(context) : (target.person ?? "")}`,
        goal: goal?.id ?? null,
        created_at: toTimestamp(now),
      };
      const intent: Intent = {
        id: impulse.id,
        capability,
        args: impulse.args,
        why,
        opening: hint,
        context,
        about: who?.account ?? null,
        created_at: impulse.created_at,
        expires_at: expiresAt,
      };
      const record: ThoughtIntent = {
        id: impulse.id,
        capability,
        args: impulse.args,
        why,
        opening: hint,
        context,
        about: intent.about,
        expires_at: expiresAt,
        status: problem === null ? "pending" : "dropped",
        detail: problem,
        turn: null,
        decisions: [],
        said: null,
        history: [
          {
            at: toTimestamp(now),
            status: problem === null ? "pending" : "dropped",
            detail: problem,
          },
        ],
      };
      return [problem === null ? { impulse, intent, goal } : null, record];
    });
  }

  /** Someone she named who is not in the snapshot (the handle table or the world knows them). */
  #personOutside(handle: string): PersonRef | undefined {
    const h = handle.trim();
    const entry = this.#d.services.get(HandleDirectoryKey)?.resolve(h) ?? null;
    const seen = entry?.account
      ? null
      : (this.#d.services
          .get(WorldStateKey)
          ?.snapshot()
          .people.find((p) => p.display_name === h) ?? null);
    const account = entry?.account ?? seen?.account ?? null;
    if (account === null) return undefined;
    return {
      ref: entry?.handle ?? h,
      account,
      person: entry?.person ?? seen?.person ?? null,
      name: entry?.display_name ?? seen?.display_name ?? h,
      relation: null,
      feeling: null,
      doing: null,
    };
  }

  /** Her own floor while the Arbiter does not run; `null` when nothing stops her. */
  #floor(
    capability: string,
    context: ContextKey | null,
    who: PersonRef | undefined,
    hint: string | null,
    why: string,
    now: number,
  ): string | null {
    if (capability === CHAT_START || capability === CHAT_DM) {
      const place =
        capability === CHAT_DM
          ? who
            ? `dm:${who.account.platform}:${who.account.id}`
            : null
          : context === null
            ? null
            : this.#placeOf(context);
      const kind: PlaceKind = capability === CHAT_DM ? "dm" : kindOf(context);
      if (place !== null) {
        const wait = this.#starts.wait(place, kind, now);
        if (wait.ms > 0) {
          const mins = Math.max(1, Math.ceil(wait.ms / MINUTE_MS));
          const ignored = wait.misses > 0 ? `, ${wait.misses} ignored in a row` : "";
          return `backoff: she started talking there recently${ignored}; next in ${mins} min`;
        }
        const again = this.#starts.repeats(place, `${hint ?? ""} ${why}`, now);
        if (again !== null) {
          return `already raised there and nobody picked it up: 「${[...again].slice(0, 40).join("")}」`;
        }
      }
      if (capability === CHAT_START && context !== null) {
        return this.#d.services.get(IntentSinkKey)?.ceiling?.(context)?.blocked ?? null;
      }
      return null;
    }
    const held = this.#blocks.get(capability);
    return held ? `on hold until things change: ${held.reason}` : null;
  }

  /** Submits her impulses one by one (the Arbiter, else the agent) and follows their outcome. */
  async #act(
    thoughtId: string,
    planned: [Planned | null, ThoughtIntent][],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const [p] of planned) {
      if (p === null || signal?.aborted) continue;
      const arbiter = this.#d.services.get(ArbiterKey);
      const board = this.#d.services.get(ProposalBoardKey);
      let outcome: IntentOutcome;
      if (board) {
        outcome = await this.#propose(board, p, signal);
      } else if (arbiter) {
        try {
          outcome = outcomeOf(await arbiter.submit(p.impulse, signal));
        } catch (error) {
          outcome = { status: "failed", detail: errorMessage(error), turn: null };
        }
      } else {
        outcome = await this.#submit(p.intent, signal);
      }
      const intent = p.intent;
      if (outcome.turn !== null) {
        this.#own(outcome.turn);
        this.#intentTurns.set(outcome.turn, {
          about: `${intent.opening ?? ""} ${intent.why}`.trim(),
          dm: intent.capability === CHAT_DM ? intent.about : null,
        });
        if (this.#intentTurns.size > MAX_TURN_EVENTS) {
          const oldest = this.#intentTurns.keys().next().value;
          if (oldest !== undefined) this.#intentTurns.delete(oldest);
        }
      }
      const talkOnly = intent.capability === CHAT_START || intent.capability === CHAT_DM;
      if (!arbiter && outcome.status === "failed" && !talkOnly) {
        this.#block(thoughtId, intent, outcome.detail);
      }
      // A goal without steps is done once its impulse went through.
      if (
        p.goal &&
        p.goal.steps.length === 0 &&
        (outcome.status === "started" || outcome.status === "done")
      ) {
        if (this.#d.goals.setStatus(p.goal.id, "done", "做了")) {
          this.#d.journal.update(thoughtId, (t) => {
            t.changes.push(`完成目標「${p.goal?.what ?? ""}」`);
          });
        }
      }
      this.#d.journal.update(thoughtId, (t) => {
        const record = t.intents.find((i) => i.id === intent.id);
        if (!record) return;
        record.status = outcome.status;
        record.detail = outcome.detail;
        record.turn = outcome.turn;
        noteStatus(record, toTimestamp(this.#now()));
        // Events of the turn that arrived before its outcome.
        for (const e of outcome.turn === null ? [] : (this.#turnEvents.get(outcome.turn) ?? [])) {
          applyTurnEvent(record, e, toTimestamp(this.#now()));
        }
      });
    }
  }

  /**
   * V3 (docs/design/v3-architecture.md §10.5): she still decides what she wants, here. Whether and
   * how it happens is the main line's: this writes a `Proposal`, and that is all it can do.
   */
  async #propose(
    board: ProposalBoard,
    planned: Planned,
    signal: AbortSignal | undefined,
  ): Promise<IntentOutcome> {
    const { impulse, intent } = planned;
    try {
      const outcome = await board.propose(
        {
          id: impulse.id,
          what: impulse.hint ?? impulse.why,
          why: impulse.why,
          capability: intent.capability,
          args: intent.args,
          expires: intent.expires_at,
          source: impulse.source,
          context: intent.context,
          about: intent.about,
          person: impulse.target.person,
          goal: impulse.goal,
        },
        signal,
      );
      const status =
        outcome.state === "taken" ? "started" : outcome.state === "open" ? "pending" : "dropped";
      return { status, detail: outcome.detail, turn: outcome.turn };
    } catch (error) {
      return { status: "failed", detail: errorMessage(error), turn: null };
    }
  }

  async #submit(intent: Intent, signal: AbortSignal | undefined): Promise<IntentOutcome> {
    const sink = this.#d.services.get(IntentSinkKey);
    try {
      if (sink) return await sink.submit(intent, signal);
      // Without the agent she can still act, just not talk.
      const registry = this.#d.services.get(ActuatorRegistryKey);
      if (!registry) return { status: "dropped", detail: "no actuator registry", turn: null };
      const turn = newId();
      const outcome = await registry.invoke(
        {
          principal: Principals.self(intent.context, null),
          capability: intent.capability,
          args: intent.args,
          why: intent.why === "" ? null : intent.why,
          turn,
          about: intent.about,
        },
        signal ? { signal } : {},
      );
      if (outcome.status === "done") return { status: "done", detail: outcome.result.text, turn };
      if (outcome.status === "denied") {
        return { status: "denied", detail: outcome.decision.reason, turn };
      }
      return { status: "failed", detail: outcome.error, turn };
    } catch (error) {
      return { status: "failed", detail: errorMessage(error), turn: null };
    }
  }

  // ---- the day plan's material --------------------------------------------------------------

  /** Seeds the presence statistics from the message log, once a day. */
  async #seedPresence(day: string): Promise<void> {
    if (this.#seededDay === day) return;
    this.#seededDay = day;
    const log = this.#d.services.get(MessageLogKey);
    if (!log) return;
    const contexts = new Map<string, ContextKey>();
    for (const c of this.#d.services.get(ConversationStatesKey)?.list() ?? []) {
      if (c.context.kind !== "dm") contexts.set(contextKeyString(c.context), c.context);
    }
    for (const c of this.#d.services.get(WorldStateKey)?.snapshot().channels ?? []) {
      contexts.set(contextKeyString(c.context), c.context);
    }
    for (const context of [...contexts.values()].slice(0, SEED_CONTEXTS)) {
      try {
        for (const e of await log.recent(this.#d.profile, context, SEED_LINES)) {
          if (e.is_self) continue;
          const handle = this.#handleOfAccount(e.author, e.author_name);
          const at = Date.parse(e.ts);
          if (handle !== null && !Number.isNaN(at)) this.#presence.seen(handle, at);
        }
      } catch (error) {
        this.#d.log.debug({ err: errorMessage(error) }, "cannot read the message log");
      }
    }
    this.#saveState();
  }

  /** When the people she cares about usually show up. */
  #habits(now: number): string[] {
    const cards = this.#d.services.get(AffectStateKey)?.cards() ?? [];
    const cared = new Set(
      cards.filter((c) => c.attachment >= this.#d.config.cared_attachment).map((c) => c.handle),
    );
    const habits = this.#presence.habits(now);
    const picked = [
      ...habits.filter((h) => cared.has(h.handle)),
      ...habits.filter((h) => !cared.has(h.handle)),
    ].slice(0, 6);
    return picked.map((h) => `- ${renderHabit(h)}`);
  }

  /** What she did yesterday (her journal, the ledger, her activities, yesterday's plan). */
  #yesterday(now: number): string[] {
    const offset = this.#d.config.utc_offset_minutes;
    const yesterday = localDay(now - DAY_MS, offset).day;
    const out: string[] = [];
    const plan = this.#dayPlan?.day === yesterday ? this.#dayPlan : this.#yesterdayPlan;
    if (plan?.day === yesterday) out.push(`- 昨天的計畫:${short(plan.text, 200)}`);
    for (const t of this.#d.journal.list(200)) {
      if (localDay(Date.parse(t.at), offset).day !== yesterday) continue;
      for (const i of t.intents) {
        if (i.status !== "done" && i.status !== "started") continue;
        out.push(
          `- ${hhmm(Date.parse(t.at), offset)} ${i.capability}${i.why ? `:${short(i.why, 60)}` : ""}`,
        );
      }
    }
    for (const task of this.#d.services.get(ActivityManagerKey)?.tasks(50) ?? []) {
      if (localDay(Date.parse(task.created_at), offset).day !== yesterday) continue;
      if (task.request.type !== "start") continue;
      const what = `${task.request.activity}${task.request.target ? `(${task.request.target})` : ""}`;
      out.push(`- ${hhmm(Date.parse(task.created_at), offset)} ${what}:${task.status}`);
    }
    return out.slice(-10);
  }

  /** How people reacted lately (the reflect module's feedback tallies). */
  #reactions(): string[] {
    const handles = this.#d.services.get(HandleDirectoryKey);
    return (this.#d.services.get(ReflectionKey)?.feedback(1) ?? []).slice(0, 6).map((t) => {
      const who = t.subject.startsWith("person:")
        ? (handles?.ofPerson(t.subject.slice("person:".length)) ?? t.label)
        : t.label;
      const parts: string[] = [];
      if (t.reactions_pos + t.reactions_neg > 0)
        parts.push(`反應 +${t.reactions_pos}/-${t.reactions_neg}`);
      if (t.replies > 0) parts.push(`回覆你 ${t.replies} 次`);
      if (t.started > 0)
        parts.push(`你主動 ${t.started} 次(有人接 ${t.answered}、沒人理 ${t.ignored})`);
      if (t.positive + t.negative > 0) parts.push(`稱讚 ${t.positive}、嫌你 ${t.negative}`);
      return `- ${who}:${parts.join("、") || "沒有特別的反應"}`;
    });
  }

  /** Publishes a journal entry (`mind.thought`). */
  static publish(publish: (event: Event) => void, thought: Thought): void {
    publish(customEvent(MIND_THOUGHT_TOPIC, JSON.parse(JSON.stringify(thought)) as JsonValue));
  }
}

/** Most status changes kept per intent. */
const MAX_HISTORY = 12;

/** Appends the intent's current status to its history when it changed. */
export function noteStatus(intent: ThoughtIntent, at: string): void {
  intent.history ??= [];
  const history = intent.history;
  const last = history[history.length - 1];
  if (last && last.status === intent.status && last.detail === intent.detail) return;
  history.push({ at, status: intent.status, detail: intent.detail });
  if (history.length > MAX_HISTORY) history.splice(1, history.length - MAX_HISTORY);
}

/** Folds an event of her intent's turn into its journal record. */
export function applyTurnEvent(
  intent: ThoughtIntent,
  e: TurnEvent,
  at: string = new Date().toISOString(),
): void {
  switch (e.type) {
    case "decision":
      if (intent.decisions.length < 10) intent.decisions.push(e.decision);
      return;
    case "skipped":
      intent.status = "dropped";
      intent.detail = e.why;
      noteStatus(intent, at);
      return;
    case "completed":
      if (e.text.trim() !== "") {
        intent.said = e.text;
        if (intent.status === "started") intent.status = "done";
      } else if (intent.status === "started") {
        intent.status = "dropped";
        intent.detail = "she stayed quiet or was interrupted";
      }
      noteStatus(intent, at);
      return;
  }
}
