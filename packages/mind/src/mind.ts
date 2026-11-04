// Her mind loop: when to think (triggers, the adaptive heartbeat, the caps), one thought (the
// snapshot, the `mind` LLM call, her reply), applying it to her inner state and handing her
// intents to the agent, and following what became of them for the journal.

import { ActuatorRegistryKey } from "@miyoria/actions";
import { errorMessage, type Logger, type ServiceLookup, sleep } from "@miyoria/kernel";
import {
  assistantMessage,
  type ChatMessage,
  LlmRouterKey,
  userMessage,
  withLlmTag,
} from "@miyoria/llm";
import { SocialKey } from "@miyoria/social";
import { ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  CHAT_DM,
  CHAT_START,
  type Clock,
  type ContextKey,
  contextKeyString,
  customEvent,
  EMOTION_LABELS,
  type EmotionName,
  type Envelope,
  type Event,
  type Intent,
  type IntentOutcome,
  IntentSinkKey,
  isJsonObject,
  type JsonValue,
  type KnowledgeChange,
  KnowledgeKey,
  type KnowledgeSubject,
  MIND_THOUGHT_TOPIC,
  type Mind,
  type MindStats,
  type MindSuggestion,
  newId,
  type PatchOp,
  PERSON_EMOTION_LABELS,
  type PersonEmotionName,
  Principals,
  type ProfileId,
  type RaisedTopic,
  SALIENT_TOPIC,
  type SalientEvent,
  type SelfState,
  SelfStateKey,
  type Thought,
  type ThoughtDecision,
  type ThoughtDigest,
  type ThoughtEffects,
  type ThoughtIntent,
  type ThoughtTrigger,
  type TurnId,
  toTimestamp,
  WorldStateKey,
} from "@miyoria/types";
import type { MindConfig } from "./config.js";
import type { Journal } from "./journal.js";
import { type BudgetState, CallLog, heartbeatMs, inQuietHours } from "./pace.js";
import { type MindInput, mindMessages, type PersonRef, type PlaceRef } from "./prompt.js";
import { clipReasoning, noEffects, thoughtInput } from "./record.js";
import { type DocDraft, type MindReply, MindReplyError, parseMindReply } from "./reply.js";
import {
  type Block,
  blockLifted,
  conditionOf,
  kindOf,
  type PlaceKind,
  placeKey,
  related,
  SelfStarts,
  type Situation,
} from "./selfstart.js";
import { capabilityInfo, gather, NOT_FOR_HER } from "./snapshot.js";

const MINUTE_MS = 60_000;
/** Her own turns make her reflect at most this often. */
const AFTER_TURN_GAP_MS = 5 * MINUTE_MS;
/** A voice lull counts after at least this many lines within `CONVERSATION_MS`. */
const CONVERSATION_LINES = 3;
const CONVERSATION_MS = 5 * MINUTE_MS;
/** At most one voice-lull thought per channel in this time. */
const VOICE_QUIET_GAP_MS = 3 * MINUTE_MS;
/** While she is in voice the loop checks for lulls this often. */
const VOICE_CHECK_MS = 5_000;
/** Pending triggers kept (older ones are merged away). */
const MAX_PENDING = 12;
const RECENT_THOUGHTS = 5;
/** Events of intent turns remembered until the intent's outcome names the turn. */
const MAX_TURN_EVENTS = 200;
/** Self-started turns remembered (their decisions arrive before they complete). */
const MAX_SELF_TURNS = 200;
/** Game adapters publish `game.<id>.<event>`; the director's own topics are not the game. */
const GAME_EVENT = /^game\.([a-z0-9_-]+)\.[^.]/;
/** Salient events below this score do not wake her while the budget is degraded. */
const DEGRADED_MIN_SCORE = 0.6;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export interface MindDeps {
  config: MindConfig;
  profile: ProfileId;
  name: string;
  /** Her persona prompt (the live one, if the agent runs). */
  persona: () => string;
  services: ServiceLookup;
  clock: Clock;
  publish: (event: Event) => void;
  log: Logger;
  journal: Journal;
}

interface VoiceRoom {
  context: ContextKey;
  people: number;
  /** When the people there said something (her own lines are not conversation). */
  lines: number[];
  /** Their last line. */
  last: number | null;
  /** Her own last line there. */
  herLast: number | null;
  lullAt: number | null;
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

const SALIENT_TEXT = (e: SalientEvent) => e.detail;

function localTime(now: number, offsetMinutes: number): string {
  const d = new Date(now + offsetMinutes * MINUTE_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}(星期${WEEKDAYS[d.getUTCDay()]})`
  );
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

/** The lowest talkativeness and initiative she sets for herself. */
export const MIN_SELF_TALK = 0.2;
/** How long a quiet spell (below 0.5) she chose herself lasts at most. */
export const MAX_QUIET_MINUTES = 45;

export class MindLoop implements Mind {
  readonly #d: MindDeps;
  readonly #calls: CallLog;
  #pending: ThoughtTrigger[] = [];
  #firstPendingAt: number | null = null;
  #suggestions: MindSuggestion[] = [];
  #salient: SalientEvent[] = [];
  #nextHeartbeat: number | null = null;
  #idleStreak = 0;
  /** Thoughts in a row (any trigger) that did nothing, and when the run began. */
  #idleRun = 0;
  #idleSince: number | null = null;
  #running = false;
  #thinking = false;
  #wake: (() => void) | null = null;
  #fallbackWarned = false;
  #tokens = 0;
  readonly #selfIds = new Set<string>();
  readonly #rooms = new Map<string, VoiceRoom>();
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
  /** The agenda item each pending intent is for (intent id → agenda id). */
  readonly #intentAgenda = new Map<string, string>();
  #gameSeenAt: number | null = null;

  constructor(deps: MindDeps) {
    this.#d = deps;
    this.#calls = new CallLog(deps.config);
    this.#starts = new SelfStarts(deps.config);
  }

  // ---- Mind ---------------------------------------------------------------------------------

  get accepting(): boolean {
    return this.#idleReason() === null;
  }

  suggest(suggestion: MindSuggestion): boolean {
    if (!this.accepting) return false;
    this.#suggestions = [...this.#suggestions, suggestion].slice(-MAX_PENDING);
    // A followup must not be lost if she does not act on it right away.
    if (suggestion.reason === "followup") this.#followupAgenda(suggestion);
    this.trigger({
      kind: "suggestion",
      detail: `${suggestion.reason}`,
      context: suggestion.context,
      at: toTimestamp(this.#now()),
    });
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

  // ---- triggers -----------------------------------------------------------------------------

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

  /** Something worth thinking about happened. */
  trigger(t: ThoughtTrigger): void {
    if (this.#pending.length === 0) this.#firstPendingAt = this.#now();
    this.#pending = [...this.#pending, t].slice(-MAX_PENDING);
    this.#wake?.();
  }

  #followupAgenda(s: MindSuggestion): void {
    const self = this.#d.services.get(SelfStateKey);
    if (!self) return;
    const person = s.about[0]
      ? (this.#d.services.get(SocialKey)?.personOf(s.about[0]) ?? null)
      : null;
    if (self.agenda().some((a) => a.text === s.hint)) return;
    self.addAgenda({
      text: s.hint,
      why: "之前說好要問的",
      person,
      context: s.context,
      expiresAt: toTimestamp(this.#now() + 2 * 24 * 60 * MINUTE_MS),
    });
  }

  /** Feeds one bus event (salience, her turns, voice activity, gate decisions). */
  observe(env: Envelope): void {
    const event = env.event;
    const now = this.#now();
    switch (event.type) {
      case "platform_ready":
        this.#selfIds.add(event.data.self_account.id);
        return;
      case "voice_joined":
      case "voice_participants": {
        const id = contextKeyString(event.data.context);
        const room = this.#rooms.get(id) ?? {
          context: event.data.context,
          people: 0,
          lines: [],
          last: null,
          herLast: null,
          lullAt: null,
        };
        room.people = event.data.participants.filter(
          (p) => !p.is_self && !this.#selfIds.has(p.account.id),
        ).length;
        if (event.type === "voice_joined") this.#rooms.set(id, room);
        else if (this.#rooms.has(id)) this.#rooms.set(id, room);
        this.#wake?.();
        return;
      }
      case "voice_left":
        this.#rooms.delete(contextKeyString(event.data.context));
        return;
      case "voice_utterance":
        if (event.data.speaker.is_bot || this.#selfIds.has(event.data.speaker.account.id)) return;
        this.#voiceLine(event.data.context, now);
        return;
      case "voice_playback": {
        // Her own speech: not conversation, but the channel is not quiet while she talks.
        const room = this.#rooms.get(contextKeyString(event.data.context));
        if (room && event.data.state === "started") room.herLast = now;
        return;
      }
      case "agent_turn_completed": {
        const { turn, context, text } = event.data;
        const own = this.#turnEvent(turn, { type: "completed", text });
        if (own || this.#selfTurns.has(turn)) {
          // A turn she started herself ending is not a reason to think again (no loop).
          if (text.trim() !== "") this.#startedTalking(turn, context, text, now);
          return;
        }
        const last = this.#calls.last();
        const quietEnough = last === null || now - last >= AFTER_TURN_GAP_MS;
        if (text.trim() !== "" && quietEnough && !this.#pending.some((p) => p.kind === "turn")) {
          this.trigger({ kind: "turn", detail: "", context, at: toTimestamp(now) });
        }
        return;
      }
      case "agent_decision": {
        const d = event.data;
        const skipped = d.reasons.find((r) => r.startsWith("skipped: "));
        if (!d.respond && skipped && d.reasons.some((r) => r.startsWith("intent:"))) {
          this.#turnEvent(d.turn, { type: "skipped", why: skipped.slice("skipped: ".length) });
        }
        // Her own turns (intents; initiative except the game commentary) vs. someone
        // addressing her there: a real exchange, which answers what she raised.
        const selfStarted = d.reasons.some(
          (r) =>
            r.startsWith("intent:") || (r.startsWith("initiative:") && r !== "initiative:game"),
        );
        if (selfStarted) {
          if (d.respond) this.#selfTurn(d.turn);
        } else if (d.reasons.some((r) => r.startsWith("direct: "))) {
          this.#starts.engaged(this.#placeOf(d.context), now);
        }
        return;
      }
      case "custom": {
        const { topic, payload } = event.data;
        if (topic === SALIENT_TOPIC) {
          const salient = parseSalient(payload);
          if (!salient) return;
          if (this.#budget() === "degraded" && salient.score < DEGRADED_MIN_SCORE) return;
          this.#salient = [...this.#salient, salient].slice(-MAX_PENDING);
          this.trigger({
            kind: "salient",
            detail: SALIENT_TEXT(salient),
            context: salient.context,
            at: toTimestamp(now),
          });
        } else if (topic === "gate.decision" && isJsonObject(payload)) {
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
        } else if (topic === "llm.budget") {
          this.#wake?.();
        } else {
          const game = GAME_EVENT.exec(topic)?.[1];
          if (game !== undefined && game !== "director") {
            // A game adapter is publishing: the game runs, what failed for its absence may work.
            const first = this.#gameSeenAt === null || now - this.#gameSeenAt > 5_000;
            this.#gameSeenAt = now;
            if (first) this.#liftBlocks(now);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  #voiceLine(context: ContextKey, now: number): void {
    const room = this.#rooms.get(contextKeyString(context));
    if (!room) return;
    room.lines = [...room.lines.filter((t) => now - t < CONVERSATION_MS), now];
    room.last = now;
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

  /** What her actions depend on right now (for holding and lifting blocks). */
  #situation(): Situation {
    const her = this.#d.services.get(WorldStateKey)?.snapshot().her ?? null;
    return {
      game: her?.game ?? null,
      gameSeenAt: this.#gameSeenAt,
      voice: her?.voice ? contextKeyString(her.voice) : null,
      live: `${her?.golive ?? ""}|${her?.streaming ?? false}`,
      scene: her?.scene ?? null,
    };
  }

  /** Puts `intent`'s capability (and the agenda items it served) on hold after it failed. */
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
    const changes = [`暫停 ${cap}(${why})`];
    const self = this.#d.services.get(SelfStateKey);
    if (self) {
      const linked = this.#intentAgenda.get(intent.id) ?? null;
      const about = `${intent.opening ?? ""} ${intent.why}`;
      for (const item of self.agenda()) {
        if (item.blocked) continue;
        if (item.id !== linked && !related(item.text, about)) continue;
        if (self.blockAgenda(item.id, { capability: cap, reason: why })) {
          changes.push(`議程「${item.text}」先擱著`);
        }
      }
    }
    this.#d.journal.update(thoughtId, (t) => {
      t.changes.push(...changes);
    });
  }

  /** Lifts holds whose situation changed (or that waited long enough), agenda items included. */
  #liftBlocks(now: number): void {
    const s = this.#situation();
    const retry = this.#d.config.blocked_retry_mins * MINUTE_MS;
    const lifted = new Set<string>();
    for (const [cap, b] of this.#blocks) {
      if (!blockLifted(b, s, now, retry)) continue;
      this.#blocks.delete(cap);
      lifted.add(cap);
    }
    const self = this.#d.services.get(SelfStateKey);
    if (!self) return;
    for (const item of self.agenda()) {
      const held = item.blocked;
      if (!held || this.#blocks.has(held.capability)) continue;
      const b: Block = {
        capability: held.capability,
        reason: held.reason,
        at: Date.parse(held.at) || now,
        // Held before a restart: what it depended on then is unknown, so only time or a game
        // coming up lifts it.
        condition: conditionOf(held.capability, s),
      };
      if (lifted.has(held.capability) || blockLifted(b, s, now, retry)) {
        self.unblockAgenda(item.id);
      } else {
        this.#blocks.set(held.capability, b);
      }
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
   * Voice channels she is in that went quiet after a conversation: nobody (her included) said
   * anything for `voice_quiet_secs` after at least a few lines of the others. Never while the
   * world still sees people talking there, nor while she may not start talking there anyway.
   */
  #checkVoice(now: number): void {
    const quietMs = this.#d.config.voice_quiet_secs * 1000;
    let channels: { channel: string; guild: string; secs: number | null }[] | null = null;
    for (const room of this.#rooms.values()) {
      if (room.people === 0 || room.last === null) continue;
      if (now - room.last < quietMs) continue;
      if (room.herLast !== null && now - room.herLast < quietMs) continue;
      const conversation = room.lines.filter(
        (t) => room.last !== null && room.last - t < CONVERSATION_MS,
      );
      if (conversation.length < CONVERSATION_LINES) continue;
      if (room.lullAt !== null && now - room.lullAt < VOICE_QUIET_GAP_MS) continue;
      channels ??= (this.#d.services.get(WorldStateKey)?.snapshot().voice_channels ?? []).map(
        (v) => ({ channel: v.channel, guild: v.guild, secs: v.activity?.secs_since_last ?? null }),
      );
      const seen = channels.find(
        (v) => v.channel === room.context.channel && v.guild === room.context.scope,
      );
      if (seen?.secs != null && seen.secs * 1000 < quietMs) continue;
      if (this.#starts.wait(this.#placeOf(room.context), "voice", now).ms > 0) continue;
      room.lullAt = now;
      room.lines = [];
      this.trigger({
        kind: "voice_quiet",
        detail: `大家 ${Math.round((now - room.last) / 1000)} 秒沒說話了(之前 5 分鐘 ${conversation.length} 句)`,
        context: room.context,
        at: toTimestamp(now),
      });
    }
  }

  // ---- loop ---------------------------------------------------------------------------------

  async run(signal: AbortSignal): Promise<void> {
    this.#running = true;
    try {
      while (!signal.aborted) {
        const now = this.#now();
        this.#checkVoice(now);
        const delay = this.#due(now);
        if (delay <= 0) {
          await this.#thinkPending(signal);
          continue;
        }
        const nap = Math.min(delay, this.#rooms.size > 0 ? VOICE_CHECK_MS : 60_000);
        // A trigger ends the nap early (and its timer with it).
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

  /** Ms until the next thought may happen (≤ 0: now). */
  #due(now: number): number {
    if (this.#idleReason() !== null) {
      // Nothing waits through a pause: what was going on is stale by then.
      this.#pending = [];
      this.#suggestions = [];
      this.#salient = [];
      this.#nextHeartbeat = null;
      return 30_000;
    }
    const rate = this.#calls.waitMs(now);
    if (this.#pending.length > 0) {
      const coalesced = (this.#firstPendingAt ?? now) + this.#d.config.coalesce_ms - now;
      return Math.max(coalesced, rate);
    }
    if (this.#nextHeartbeat === null) this.#scheduleHeartbeat(now);
    if (this.#nextHeartbeat === null) return 60_000;
    return Math.max(this.#nextHeartbeat - now, rate);
  }

  #scheduleHeartbeat(now: number): void {
    const self = this.#d.services.get(SelfStateKey);
    const ms = heartbeatMs(
      {
        lively: this.#lively(),
        inVoice: [...this.#rooms.values()].some((r) => r.people > 0),
        agendaDue: (self?.agenda() ?? []).some((a) => a.due === null || Date.parse(a.due) <= now),
        night: inQuietHours(now, this.#d.config),
        budget: this.#budget(),
        idleStreak: this.#idleStreak,
        boredom: self?.boredom() ?? 0,
      },
      this.#d.config,
    );
    this.#nextHeartbeat = ms === null ? null : now + ms;
  }

  /** A text channel or voice channel has a lively conversation going. */
  #lively(): boolean {
    const world = this.#d.services.get(WorldStateKey)?.snapshot() ?? null;
    return (
      (world?.channels.some((c) => c.lively) ?? false) ||
      (world?.voice_channels.some((v) => v.activity?.lively === true) ?? false)
    );
  }

  async #thinkPending(signal: AbortSignal): Promise<void> {
    const now = this.#now();
    const triggers =
      this.#pending.length > 0
        ? this.#pending
        : [{ kind: "heartbeat" as const, detail: "", context: null, at: toTimestamp(now) }];
    const suggestions = this.#suggestions;
    const salient = this.#salient;
    this.#pending = [];
    this.#suggestions = [];
    this.#salient = [];
    this.#firstPendingAt = null;
    const onlyHeartbeat = triggers.every((t) => t.kind === "heartbeat");
    const thought = await this.think(triggers, suggestions, salient, signal);
    const acted = (thought?.intents.length ?? 0) > 0;
    this.#idleStreak = onlyHeartbeat && !acted ? this.#idleStreak + 1 : 0;
    this.#scheduleHeartbeat(this.#now());
  }

  // ---- one thought --------------------------------------------------------------------------

  /** Thinks once about `triggers`; `null` when she cannot think right now. */
  async think(
    triggers: ThoughtTrigger[],
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
      if (!router.configures(cfg.purpose) && !this.#fallbackWarned) {
        this.#fallbackWarned = true;
        d.log.warn({ purpose: cfg.purpose }, "no model chain for the mind purpose; using chat");
      }
      this.#liftBlocks(started);
      const self = d.services.get(SelfStateKey);
      const registry = d.services.get(ActuatorRegistryKey);
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
      const night = inQuietHours(started, cfg);
      const input: MindInput = {
        name: d.name,
        persona: d.persona(),
        time: localTime(started, cfg.utc_offset_minutes),
        night,
        self: self?.snapshot() ?? null,
        capabilities: capabilityInfo(registry),
        threadsGame: d.services.get(ToolRegistryKey)?.get("game_threads_observe") !== undefined,
        maxIntents: cfg.max_intents,
        triggers,
        suggestions,
        world: snap.world,
        places: snap.places,
        people: snap.people,
        agenda: snap.agenda,
        recent: d.journal.recent(RECENT_THOUGHTS),
        memories: snap.memories,
        documents: snap.documents,
        lessons: snap.lessons,
        recap: snap.recap,
        digest: d.journal.digests(1)[0]?.summary ?? null,
        unanswered: this.#starts
          .unanswered(snap.focus === null ? null : this.#placeOf(snap.focus), started)
          .map((t) => t.text),
        blocked: [...this.#blocks.values()].map((b) => ({
          capability: b.capability,
          reason: b.reason,
        })),
        idle:
          this.#idleSince === null
            ? null
            : {
                thoughts: this.#idleRun,
                minutes: Math.round((started - this.#idleSince) / MINUTE_MS),
              },
      };
      this.#calls.record(started);
      const thought: Thought = {
        id: newId(),
        at: toTimestamp(started),
        triggers,
        thought: "",
        changes: [],
        intents: [],
        tokens: null,
        error: null,
        ms: 0,
        suggestions: suggestions.map((s) => structuredClone(s)),
        input: thoughtInput(input),
        reasoning: null,
        effects: null,
        calls: [],
        cost_usd: null,
        attempts: 0,
        idle: input.idle ?? null,
      };
      // Her LLM calls for this thought, for the call inspector's links both ways.
      const costs = new Map<string, number | null>();
      const onCall = (call: { id: string; cost_usd: number | null }) => {
        if (!costs.has(call.id)) thought.calls?.push(call.id);
        costs.set(call.id, call.cost_usd);
        const known = [...costs.values()].filter((c): c is number => c !== null);
        thought.cost_usd = known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
      };
      let reply: MindReply;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);
      try {
        // `json_mode` is a hint; the reply is extracted and validated either way, and one
        // unusable reply gets one repair try with the problem spelled out.
        let messages: ChatMessage[] = mindMessages(input);
        for (let attempt = 1; ; attempt++) {
          thought.attempts = attempt;
          const response = await withLlmTag(
            {
              module: "mind",
              thought: thought.id,
              label: "thought",
              repair: attempt > 1 ? attempt - 1 : null,
              onCall,
            },
            () =>
              router.complete(
                cfg.purpose,
                {
                  messages,
                  json_mode: true,
                  // No `thinking` here: `[llm.thinking] mind` decides (the example config has it on).
                  max_tokens: cfg.max_tokens,
                  session: `mind-${d.profile}`,
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
            reply = parseMindReply(response.text, cfg.max_intents);
            break;
          } catch (error) {
            if (!(error instanceof MindReplyError) || attempt >= 2) throw error;
            messages = [
              ...messages,
              assistantMessage(response.text.slice(0, 4000)),
              userMessage(
                `上面的回覆不能用:${error.message}。請只回傳一個符合格式的 JSON 物件,不要加其他文字。`,
              ),
            ];
          }
        }
      } catch (error) {
        if (signal?.aborted) return null;
        thought.error = controller.signal.aborted ? "timed out" : errorMessage(error);
        thought.ms = this.#now() - started;
        d.log.warn({ err: thought.error }, "her thought failed");
        await d.journal.add(thought);
        return thought;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      thought.thought = reply.thought;
      thought.ms = this.#now() - started;
      const onlyHeartbeat = triggers.every((t) => t.kind === "heartbeat");
      const effects = noEffects();
      thought.changes = await this.#apply(
        reply,
        snap.people,
        snap.places,
        snap.focus,
        self,
        effects,
      );
      thought.effects = effects;
      // A thought woken only by her own turn ending must not start a conversation where she
      // just spoke (it would feed itself: her turn, a thought, another turn).
      const justSpoke = triggers.every((t) => t.kind === "turn")
        ? triggers.flatMap((t) => (t.context === null ? [] : [this.#placeOf(t.context)]))
        : [];
      const intents = this.#intents(
        reply,
        snap.people,
        snap.places,
        snap.focus,
        night && onlyHeartbeat,
        justSpoke,
        snap.agenda,
      );
      thought.intents = intents.map(([, record]) => record);
      // Talking with people (or listening to a lively conversation) is not sitting idle;
      // neither is anything she set out to do, nor writing her notes.
      if (
        triggers.some((t) => t.kind === "turn") ||
        intents.some(([intent]) => intent !== null) ||
        thought.changes.some((c) => c.startsWith("資料 ")) ||
        this.#lively()
      ) {
        this.#idleRun = 0;
        this.#idleSince = null;
      } else {
        this.#idleRun += 1;
        this.#idleSince ??= started;
      }
      await d.journal.add(thought);
      // Acting can take a while (the scheduler's lanes, joining voice): the loop goes on.
      void this.#act(thought.id, intents, signal).catch((error: unknown) => {
        d.log.warn({ err: errorMessage(error) }, "acting on her intents failed");
      });
      return thought;
    } finally {
      this.#thinking = false;
    }
  }

  /** Applies feelings, drives, policy and agenda; returns what changed, in words. */
  async #apply(
    reply: MindReply,
    people: PersonRef[],
    places: PlaceRef[],
    focus: ContextKey | null,
    self: SelfState | undefined,
    effects: ThoughtEffects = noEffects(),
  ): Promise<string[]> {
    const changes: string[] = [];
    const now = this.#now();
    const person = (ref: string | null) =>
      ref === null ? undefined : people.find((p) => p.ref === ref);
    const place = (ref: string | null) =>
      ref === null ? undefined : places.find((p) => p.ref === ref);
    const social = this.#d.services.get(SocialKey);
    for (const f of reply.feelings) {
      const p = person(f.person);
      if (!p || p.person === null) continue;
      effects.feelings.push({
        person: p.person,
        name: p.name,
        note: f.note,
        hint: f.hint === "+" || f.hint === "-" ? f.hint : null,
      });
      if (f.note !== null && self) {
        try {
          await self.setFeeling(p.person, f.note, "self");
          changes.push(`對 ${p.name} 的感覺`);
        } catch (error) {
          this.#d.log.warn({ err: errorMessage(error) }, "cannot write her feelings");
        }
      }
      for (const [name, v] of Object.entries(f.emotions ?? {}) as [PersonEmotionName, number][]) {
        self?.feelToward?.(p.person, name, v, "我自己想了想");
        changes.push(
          `對 ${p.name} 的${PERSON_EMOTION_LABELS[name]} ${v > 0 ? "+" : ""}${v.toFixed(2)}`,
        );
      }
      if ((f.hint === "+" || f.hint === "-") && social) {
        // A hint, not a number: social's daily caps decide what it is worth.
        await social.applyEvents(
          p.person,
          [["mind", f.hint === "+" ? "warm" : "cold", 0.3]],
          null,
          null,
          now,
        );
        changes.push(`好感 ${p.name} ${f.hint}`);
      }
    }
    if (!self) return changes;
    const emotions = Object.entries(reply.emotions ?? {}) as [EmotionName, number][];
    if (emotions.length > 0 && self.feel) {
      effects.emotions = Object.fromEntries(emotions);
      for (const [name, v] of emotions) self.feel(name, v, "我自己想了想");
      changes.push(
        `情緒 ${emotions.map(([k, v]) => `${EMOTION_LABELS[k]} ${v > 0 ? "+" : ""}${v.toFixed(2)}`).join("、")}`,
      );
    }
    const drives = Object.entries(reply.drives);
    if (drives.length > 0) {
      effects.drives = Object.fromEntries(drives);
      self.adjust(reply.drives, "mind");
      changes.push(
        `慾望 ${drives.map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v.toFixed(2)}`).join("、")}`,
      );
    }
    for (const t of reply.talkativeness) {
      const scope = this.#scope(t.scope, place(t.scope)?.context ?? null, focus);
      if (scope === null) continue;
      // Going quiet on her own is a mood, not a vow: not near silence, and not for long.
      // (Someone asking her to be quiet goes through the agent's own tool, without these.)
      const level = Math.max(t.level, MIN_SELF_TALK);
      const minutes =
        level < t.level || level >= 0.5 ? t.minutes : Math.min(t.minutes, MAX_QUIET_MINUTES);
      self.setTalkativeness(scope, { level, forMs: minutes * MINUTE_MS, why: t.why });
      effects.talkativeness.push({ scope, level, minutes, why: t.why });
      changes.push(`多話程度 ${scope} ${level.toFixed(2)}(${minutes} 分鐘)`);
    }
    if (reply.initiative !== null) {
      const level = Math.max(reply.initiative.level, MIN_SELF_TALK);
      self.setInitiative(level, reply.initiative.why);
      effects.initiative = { level, why: reply.initiative.why };
      changes.push(`主動程度 ${level.toFixed(2)}`);
    }
    for (const a of reply.agendaAdd) {
      const item = self.addAgenda({
        text: a.text,
        why: a.why,
        person: person(a.person)?.person ?? null,
        context: place(a.place)?.context ?? null,
        due: a.dueInMin === null ? null : toTimestamp(now + a.dueInMin * MINUTE_MS),
        expiresAt: toTimestamp(now + a.expiresInMin * MINUTE_MS),
      });
      changes.push(`議程 +「${item.text}」`);
      effects.agenda_added.push({ text: item.text, why: a.why });
    }
    const open = self.agenda();
    const byRef = (ref: string) => {
      const n = /^g(\d+)$/.exec(ref.trim())?.[1];
      return n === undefined ? undefined : open[Number(n) - 1];
    };
    for (const ref of reply.agendaDone) {
      const item = byRef(ref);
      if (item && self.completeAgenda(item.id)) {
        changes.push(`完成議程「${item.text}」`);
        effects.agenda_done.push(item.text);
      }
    }
    for (const ref of reply.agendaDrop) {
      const item = byRef(ref);
      if (item && self.dropAgenda(item.id)) {
        changes.push(`放棄議程「${item.text}」`);
        effects.agenda_dropped.push(item.text);
      }
    }
    changes.push(...(await this.#documents(reply.documents, people, focus, effects)));
    return changes;
  }

  /** Her document changes (her own judgment, privileged), each all or nothing. */
  async #documents(
    drafts: readonly DocDraft[],
    people: PersonRef[],
    focus: ContextKey | null,
    effects: ThoughtEffects,
  ): Promise<string[]> {
    const kb = this.#d.services.get(KnowledgeKey);
    if (!kb || drafts.length === 0) return [];
    const out: string[] = [];
    const subjectOf = (ref: string | null): KnowledgeSubject | null => {
      const r = ref?.trim() ?? "";
      if (r === "self") return { type: "self" };
      if (r === "server") {
        return focus?.scope && focus.kind !== "dm"
          ? { type: "guild", platform: focus.platform, guild: focus.scope }
          : null;
      }
      if (r.startsWith("topic:") && r.length > 6) return { type: "topic", name: r.slice(6) };
      const person = people.find((p) => p.ref === r)?.person ?? null;
      return person === null ? null : { type: "person", person };
    };
    for (const d of drafts) {
      let change: KnowledgeChange | null = null;
      switch (d.type) {
        case "create": {
          const subject = subjectOf(d.subject);
          if (subject && d.kind && d.title) {
            change = {
              type: "create",
              subject,
              kind: d.kind,
              title: d.title,
              content: d.content,
              why: d.why,
            };
          }
          break;
        }
        case "patch":
          if (d.doc)
            change = { type: "patch", doc: d.doc, ops: d.ops as unknown as PatchOp[], why: d.why };
          break;
        case "retitle":
          if (d.doc)
            change = { type: "retitle", doc: d.doc, kind: d.kind, title: d.title, why: d.why };
          break;
        case "delete":
          if (d.doc) change = { type: "delete", doc: d.doc, why: d.why };
          break;
        case "merge":
          if (d.doc && d.into) {
            change = { type: "merge", doc: d.doc, into: d.into, path: d.path, why: d.why };
          }
          break;
      }
      if (change === null) {
        effects.documents.push({
          type: d.type,
          title: d.title ?? null,
          ok: false,
          error: "incomplete",
        });
        continue;
      }
      try {
        const result = await kb.apply(change, {
          kind: "self",
          account: null,
          person: null,
          name: null,
          context: focus,
        });
        if (result.ok) {
          out.push(result.doc ? `資料 ${d.type}「${result.doc.title}」` : `資料 ${d.type}`);
          effects.documents.push({
            type: d.type,
            title: result.doc?.title ?? d.title ?? null,
            ok: true,
            error: null,
          });
        } else {
          this.#d.log.debug({ err: result.error }, "her document change was refused");
          effects.documents.push({
            type: d.type,
            title: d.title ?? null,
            ok: false,
            error: String(result.error),
          });
        }
      } catch (error) {
        this.#d.log.warn({ err: errorMessage(error) }, "cannot change her documents");
        effects.documents.push({
          type: d.type,
          title: d.title ?? null,
          ok: false,
          error: errorMessage(error),
        });
      }
    }
    return out;
  }

  /** A talkativeness scope from her reply: a place ref, `here`, `server` or a kind. */
  #scope(raw: string, place: ContextKey | null, focus: ContextKey | null): string | null {
    if (place !== null) return contextKeyString(place);
    const v = raw.trim().toLowerCase();
    if (v === "*" || v === "voice" || v === "text") return v;
    if (v === "here") return focus === null ? null : contextKeyString(focus);
    if (v === "server") {
      return focus?.scope ? `${focus.platform}:${focus.scope}` : null;
    }
    return null;
  }

  /** Her intents resolved against the snapshot: `[intent, journal record]`. */
  #intents(
    reply: MindReply,
    people: PersonRef[],
    places: PlaceRef[],
    focus: ContextKey | null,
    quiet: boolean,
    justSpoke: readonly string[] = [],
    agenda: readonly { ref: string; item: { id: string } }[] = [],
  ): [Intent | null, ThoughtIntent][] {
    const registry = this.#d.services.get(ActuatorRegistryKey);
    const now = this.#now();
    return reply.intents.map((draft) => {
      const place = draft.place === null ? undefined : places.find((p) => p.ref === draft.place);
      const who = draft.person === null ? undefined : people.find((p) => p.ref === draft.person);
      let context: ContextKey | null = place?.context ?? focus;
      const args = { ...draft.args };
      let problem: string | null = null;
      const known = registry?.get(draft.action) !== undefined;
      if (!known || NOT_FOR_HER.includes(draft.action)) problem = "not something she can do";
      else if (quiet && (draft.action === CHAT_START || draft.action === CHAT_DM)) {
        problem = "quiet hours";
      }
      if (draft.action === CHAT_DM) {
        if (!who) problem ??= "nobody to DM";
        else args.to = who.account.id;
      }
      if (draft.action === "voice.join" && place?.context.kind === "voice") {
        args.channel = place.context.channel;
        if (place.context.scope !== null) args.guild = place.context.scope;
      }
      if (draft.action === "voice.join" && args.channel === undefined) {
        problem ??= "no voice channel to join";
      }
      if (draft.action === CHAT_START && context === null) problem ??= "no place to talk";
      if (context?.kind === "dm") context = null;
      if (draft.action === CHAT_START || draft.action === CHAT_DM) {
        const place =
          draft.action === CHAT_DM
            ? who
              ? `dm:${who.account.platform}:${who.account.id}`
              : null
            : context === null
              ? null
              : this.#placeOf(context);
        const kind: PlaceKind = draft.action === CHAT_DM ? "dm" : kindOf(context);
        if (place !== null && problem === null) {
          problem = this.#talkProblem(place, kind, draft.opening, draft.why, justSpoke, now);
        }
        // The owner's level of a text channel (the agent checks it again when it opens).
        if (draft.action === CHAT_START && context !== null && problem === null) {
          problem = this.#d.services.get(IntentSinkKey)?.ceiling?.(context)?.blocked ?? null;
        }
      } else {
        const held = this.#blocks.get(draft.action);
        if (held) problem ??= `on hold until things change: ${held.reason}`;
      }
      const about: AccountRef | null = who?.account ?? null;
      const intent: Intent = {
        id: newId(),
        capability: draft.action,
        args: JSON.parse(JSON.stringify(args)),
        why: draft.why,
        opening: draft.opening,
        context,
        about,
        created_at: toTimestamp(now),
        expires_at: toTimestamp(now + draft.expiresInS * 1000),
      };
      const record: ThoughtIntent = {
        id: intent.id,
        capability: intent.capability,
        args: intent.args,
        why: intent.why,
        opening: intent.opening,
        context,
        about,
        expires_at: intent.expires_at,
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
      const item = draft.agenda === null ? undefined : agenda.find((a) => a.ref === draft.agenda);
      if (item && problem === null) this.#intentAgenda.set(intent.id, item.item.id);
      return [problem === null ? intent : null, record];
    });
  }

  /**
   * Why she should not start talking at `place` now, or `null`: she just spoke there, the
   * backoff after ignored self-starts, or it is a topic she raised there that nobody picked up.
   */
  #talkProblem(
    place: string,
    kind: PlaceKind,
    opening: string | null,
    why: string,
    justSpoke: readonly string[],
    now: number,
  ): string | null {
    if (justSpoke.includes(place)) return "she just spoke there";
    const wait = this.#starts.wait(place, kind, now);
    if (wait.ms > 0) {
      const mins = Math.max(1, Math.ceil(wait.ms / MINUTE_MS));
      const ignored = wait.misses > 0 ? `, ${wait.misses} ignored in a row` : "";
      return `backoff: she started talking there recently${ignored}; next in ${mins} min`;
    }
    const again = this.#starts.repeats(place, `${opening ?? ""} ${why}`, now);
    if (again !== null) {
      return `already raised there and nobody picked it up: 「${[...again].slice(0, 40).join("")}」`;
    }
    return null;
  }

  /** Hands her intents to the agent one by one and follows their outcome. */
  async #act(
    thoughtId: string,
    intents: [Intent | null, ThoughtIntent][],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const [intent] of intents) {
      if (intent === null || signal?.aborted) {
        if (intent !== null) this.#intentAgenda.delete(intent.id);
        continue;
      }
      const outcome = await this.#submit(intent, signal);
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
      if (outcome.status === "failed" && !talkOnly) this.#block(thoughtId, intent, outcome.detail);
      this.#intentAgenda.delete(intent.id);
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
