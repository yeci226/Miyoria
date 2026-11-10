// The sensors of phase 1: every V2 bus event worth knowing becomes a line of the log, without any
// V2 module knowing about it. Later phases have the modules write Observations themselves and this
// file shrinks away.
//
// Each topic gets an `attention_key`, a `revision` and a `salience` decided here by rules, never by
// a model (§6). Causes are stitched together from what V2 events share: message ids (a turn's
// focus), impulse ids, turn ids and task ids. `Envelope.causation` is hardly ever set in V2.
//
// Nothing here may touch the disk or wait: it runs on every event on the bus.

import type { ServiceLookup } from "@miyoria/kernel";
import {
  ACTION_SETTLED_TOPIC,
  ACTIVITY_CHANGED_TOPIC,
  ACTIVITY_DONE_TOPIC,
  ACTIVITY_FAILED_TOPIC,
  ACTIVITY_RESTORE_TOPIC,
  ACTIVITY_STARTED_TOPIC,
  type AccountRef,
  type ActionSettled,
  type ActivityRestore,
  type ActivitySnapshot,
  type ActivityTaskEvent,
  ARBITER_DECISION_TOPIC,
  ARBITER_IMPULSE_TOPIC,
  type ArbiterDecision,
  type Author,
  type BucketWrite,
  type ContextKey,
  contextKeyString,
  type DeliveryChannel,
  type DeliveryLedger,
  type Envelope,
  type EventData,
  type EventLog,
  envelopeTopic,
  GOAL_TOPIC,
  gameEventKey,
  gameGoalKey,
  type Handle,
  HandleDirectoryKey,
  holdsBack,
  type Impulse,
  type IncomingMessage,
  type InputSource,
  type InputVerdict,
  incomingText,
  inspectInput,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  MIND_THOUGHT_TOPIC,
  type MindThoughtBody,
  MUTED,
  NOTED_GAME_EVENTS,
  NOTICE_TOPIC,
  type Notice,
  parseSongCue,
  parseSongPrepare,
  parseTaskEvent,
  parseTaskTopic,
  type Salience,
  SONG_PREPARE_TOPIC,
  SONG_TOPIC,
  type SteerOutcomeBody,
  SYSTEM_SHUTDOWN_TOPIC,
  sameAccount,
  type TaskEvent,
  type Thought,
  TURN_FOCUS_TOPIC,
  TURN_OUTCOME_TOPIC,
  type TurnFocus,
  type TurnId,
  type TurnOutcomeRecord,
  timestampMs,
  topicKey,
  VOICE_BARGE_IN_TOPIC,
  type VoiceBargeIn,
  type VoiceParticipant,
  type VoiceUtterance,
} from "@miyoria/types";
import type { FactsConfig } from "./config.js";
import {
  GAME_SESSION_SOURCE,
  LIFECYCLE_SOURCE,
  parseContext,
  RESTORE_KEY_PREFIX,
  SHUTDOWN_KEY,
} from "./recovery.js";
import type { RevisionBook } from "./revisions.js";

// Topics declared by packages this one does not depend on.
const GOLIVE_TOPIC = "voice.golive";
const STAGE_STATUS_TOPIC = "stage.status";
const STAGE_ERROR_TOPIC = "stage.error";
const GAME_SESSION_TOPIC = "game.director.session";
const GAME_GOAL_TOPIC = "game.director.goal";
const GAME_DECISION_TOPIC = "game.director.decision";
const GATE_DECISION_TOPIC = "gate.decision";
const VOICE_LATENCY_TOPIC = "voice.latency";

/** What the scheduler answers for an action that never went out. */
const NEVER_SENT = new Set(["expired", "cancelled", "coalesced", MUTED]);
/** A death is always a new one, however soon after the last. */
const ALWAYS_NEW = new Set(["death"]);
const URGENT_GAME_EVENTS = new Set(["death", "low_health"]);
/** Events that end a task or a goal the same way every time: no state to compare. */
const NO_REPEAT = 0;
/** Correlations remembered (message ids, impulses, turns, tasks). */
const MEMORY = 2_000;

/** A small map that forgets its oldest keys. */
class Recent<V> {
  readonly #map = new Map<string, V>();

  get(key: string): V | undefined {
    return this.#map.get(key);
  }

  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > MEMORY) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#map.delete(key);
  }
}

interface Attention {
  key: string;
  revision: number;
}

/** What is known about a turn. */
interface TurnFacts {
  /** The newest decision of the turn: what its lines were caused by. */
  head: string | null;
  /** The last action the gate let through for it. */
  action: string | null;
  /** The narration key of the impulse that opened it. */
  attention: Attention | null;
  /** The key of the message it answers. */
  focus: Attention | null;
  addressed: Handle[];
  /** The message ids of the last focus logged. */
  focusIds: string | null;
}

interface Draft {
  source: string;
  key: string;
  revision: number;
  salience: Salience;
  summary: string;
  addressed?: boolean;
  from?: Handle | null;
  context?: ContextKey | null;
  buckets?: BucketWrite[];
  speech?: boolean;
  cause?: string | null;
}

export interface BusFactsOptions {
  log: EventLog;
  ledger: DeliveryLedger;
  revisions: RevisionBook;
  config: FactsConfig;
  /** Her names, for "said her name" (lower-cased here). */
  names?: readonly string[];
  /** For the handle directory (optional: without it `person` is the display name). */
  services?: ServiceLookup | null;
  /**
   * `pipeline = "v3"`: the main line opens and acks its own lines, so nothing here does. The
   * handlers below only serve the V2 path behind the switch, and go with it.
   */
  ownLines?: boolean;
}

/** The input defence's note, to go beside what it is about. */
function noted(verdict: InputVerdict | null): string {
  return verdict?.note ? `\n${verdict.note}` : "";
}

function joined(names: readonly string[]): string {
  return names.length === 0 ? "沒有人" : names.join("、");
}

export class BusFacts {
  readonly #log: EventLog;
  readonly #ledger: DeliveryLedger;
  readonly #revisions: RevisionBook;
  readonly #config: FactsConfig;
  readonly #names: readonly string[];
  readonly #services: ServiceLookup | null;
  readonly #ownLines: boolean;
  readonly #own: AccountRef[] = [];
  /** Who is in each voice channel, her accounts left out. */
  readonly #present = new Map<string, Handle[]>();
  /** Message or utterance id → its observation. */
  readonly #messages = new Recent<{ event: string; key: string }>();
  /** `attention_key` → its newest observation. */
  readonly #keys = new Recent<string>();
  readonly #impulses = new Recent<{ event: string; attention: Attention | null }>();
  readonly #turns = new Recent<TurnFacts>();
  /** Task id → its newest line. */
  readonly #tasks = new Recent<string>();
  /** Lines waiting for the end of their playback, oldest first. */
  readonly #playing = new Recent<string[]>();
  /** Speech that already got an end from voice (so the scheduler's failure is not a second). */
  readonly #ended = new Recent<true>();

  constructor(options: BusFactsOptions) {
    this.#log = options.log;
    this.#ledger = options.ledger;
    this.#revisions = options.revisions;
    this.#config = options.config;
    this.#names = (options.names ?? []).map((n) => n.toLowerCase()).filter((n) => n !== "");
    this.#services = options.services ?? null;
    this.#ownLines = options.ownLines ?? false;
  }

  // ---- shared helpers -----------------------------------------------------------------------

  #handle(account: AccountRef, name: string): Handle {
    return this.#services?.get(HandleDirectoryKey)?.ofAccount(account, name) ?? name;
  }

  #isOwn(account: AccountRef): boolean {
    return this.#own.some((a) => sameAccount(a, account));
  }

  #saidHerName(text: string): boolean {
    const lower = text.toLowerCase();
    return this.#names.some((n) => lower.includes(n));
  }

  #turn(turn: TurnId): TurnFacts {
    let facts = this.#turns.get(turn);
    if (!facts) {
      facts = {
        head: null,
        action: null,
        attention: null,
        focus: null,
        addressed: [],
        focusIds: null,
      };
      this.#turns.set(turn, facts);
    }
    return facts;
  }

  #head(turn: TurnId | null): string | null {
    return turn === null ? null : (this.#turns.get(turn)?.head ?? null);
  }

  #observe(env: Envelope, draft: Draft): string {
    const addressed = draft.addressed ?? false;
    const event = this.#log.observe(
      {
        source: draft.source,
        silent: draft.salience === "ambient" && !addressed,
        salience: draft.salience,
        attention_key: draft.key,
        revision: draft.revision,
        summary: draft.summary,
        addressed_to_her: addressed,
        from: draft.from ?? null,
        context: draft.context ?? null,
      },
      {
        id: env.id,
        at: env.ts,
        cause: draft.cause ?? env.causation ?? null,
        buckets: draft.buckets ?? [],
        speech: draft.speech ?? false,
        origin: {
          module: env.source,
          topic: envelopeTopic(env),
          event: env.event as unknown as JsonValue,
          turn: env.correlation,
        },
      },
    );
    this.#keys.set(draft.key, event.id);
    return event.id;
  }

  /** A state that may not have changed: nothing is logged when it did not. */
  #state(env: Envelope, fingerprint: string, draft: Omit<Draft, "revision">): void {
    const { revision, fresh } = this.#revisions.state(draft.key, fingerprint, timestampMs(env.ts));
    if (fresh) this.#observe(env, { ...draft, revision });
  }

  // ---- the bus ------------------------------------------------------------------------------

  /** Takes one bus event in. */
  handle(env: Envelope): void {
    const event = env.event;
    switch (event.type) {
      case "platform_ready":
        if (!this.#isOwn(event.data.self_account)) this.#own.push(event.data.self_account);
        break;
      case "platform_message_created":
        this.#message(env, event.data);
        break;
      case "voice_utterance":
        this.#utterance(env, event.data);
        break;
      case "voice_joined":
      case "voice_participants":
        this.#participants(env, event.data.context, event.data.participants);
        break;
      case "voice_left":
        this.#voiceLeft(env, event.data.context, event.data.reason);
        break;
      case "voice_playback":
        if (!this.#ownLines) this.#playback(event.data);
        break;
      case "agent_decision":
        this.#agentDecision(env, event.data);
        break;
      case "agent_initiative":
        this.#initiative(env, event.data);
        break;
      case "module_state_changed":
        this.#moduleState(env, event.data);
        break;
      case "custom":
        this.#custom(env, event.data.topic, event.data.payload);
        break;
      default:
        break;
    }
  }

  #custom(env: Envelope, topic: string, payload: JsonValue): void {
    const data = isJsonObject(payload) ? payload : {};
    switch (topic) {
      case SYSTEM_SHUTDOWN_TOPIC:
        this.#observe(env, {
          source: LIFECYCLE_SOURCE,
          key: SHUTDOWN_KEY,
          revision: 1,
          salience: "ambient",
          summary: "核心要關閉了",
        });
        return;
      case ACTIVITY_RESTORE_TOPIC:
        this.#restore(env, data as unknown as ActivityRestore);
        return;
      case ACTION_SETTLED_TOPIC:
        if (!this.#ownLines) this.#settled(data as unknown as ActionSettled);
        return;
      case ACTIVITY_CHANGED_TOPIC:
        this.#activity(env, data as unknown as ActivitySnapshot);
        return;
      case ACTIVITY_STARTED_TOPIC:
      case ACTIVITY_DONE_TOPIC:
      case ACTIVITY_FAILED_TOPIC:
        this.#activityTask(env, data as unknown as ActivityTaskEvent);
        return;
      case NOTICE_TOPIC:
        this.#notice(env, data as unknown as Notice);
        return;
      case ARBITER_IMPULSE_TOPIC:
        this.#impulse(data as unknown as Impulse);
        return;
      case ARBITER_DECISION_TOPIC:
        this.#arbiterDecision(data as unknown as ArbiterDecision);
        return;
      case TURN_FOCUS_TOPIC:
        this.#focus(data as unknown as TurnFocus);
        return;
      case TURN_OUTCOME_TOPIC:
        this.#outcome(data as unknown as TurnOutcomeRecord);
        return;
      case GATE_DECISION_TOPIC:
        this.#gate(data);
        return;
      case VOICE_LATENCY_TOPIC:
        this.#latency(data);
        return;
      case MIND_THOUGHT_TOPIC:
        this.#thought(data as unknown as Thought);
        return;
      case GOAL_TOPIC:
        this.#log.append({ kind: "proposal", source: "plan", body: data });
        return;
      case GOLIVE_TOPIC:
        this.#golive(env, data);
        return;
      case STAGE_STATUS_TOPIC:
        this.#stage(env, data);
        return;
      case STAGE_ERROR_TOPIC:
        this.#observe(env, {
          source: "stage",
          key: "stage:error",
          revision: this.#revisions.event("stage:error", timestampMs(env.ts), NO_REPEAT).revision,
          salience: "notable",
          summary: `直播機出錯:${typeof data.message === "string" ? data.message : "不明"}`,
        });
        return;
      case SONG_TOPIC:
        this.#song(env, payload);
        return;
      case SONG_PREPARE_TOPIC:
        this.#songPrepare(env, payload);
        return;
      case VOICE_BARGE_IN_TOPIC:
        this.#bargeIn(env, data as unknown as VoiceBargeIn);
        return;
      case GAME_SESSION_TOPIC:
        this.#gameSession(env, data);
        return;
      case GAME_GOAL_TOPIC:
        this.#gameGoal(env, data);
        return;
      case GAME_DECISION_TOPIC:
        this.#log.append({ kind: "thought", source: "game.director", body: data });
        return;
      default:
        break;
    }
    const task = parseTaskTopic(topic);
    if (task !== null) {
      const parsed = parseTaskEvent(payload);
      if (parsed !== null) this.#task(env, task.owner, parsed);
      return;
    }
    const game = /^game\.([^.]+)\.(.+)$/.exec(topic);
    if (game !== null && game[1] !== "director" && game[1] !== "chat") {
      this.#gameEvent(env, game[1] as string, game[2] as string, data);
    }
  }

  // ---- what people say ----------------------------------------------------------------------

  #message(env: Envelope, message: IncomingMessage): void {
    const { author, id } = message;
    // Her own messages are not something she perceives: the ledger has them.
    if (this.#isOwn(author.account)) return;
    const text = incomingText(message);
    const addressed =
      message.mentions_self ||
      message.reply_to_self ||
      id.context.kind === "dm" ||
      this.#saidHerName(text);
    this.#said(env, `platform.${id.context.platform}`, "platform.text", {
      id: id.id,
      key: `msg:${id.context.platform}:${id.id}`,
      author,
      context: id.context,
      text,
      addressed,
      verdict: this.#inspect(id.id, text, "chat", author.account, id.context),
    });
  }

  /** What the input defence says of something people wrote (the same verdict wherever asked). */
  #inspect(
    id: string | null,
    text: string,
    source: InputSource,
    author: AccountRef | null,
    context: ContextKey | null,
  ): InputVerdict | null {
    if (this.#services === null) return null;
    return inspectInput(this.#services, { id, text, source, author, context });
  }

  #utterance(env: Envelope, u: VoiceUtterance): void {
    if (this.#isOwn(u.speaker.account) || u.text.trim() === "") return;
    this.#said(env, "voice.asr", "voice.asr", {
      id: u.id,
      key: `voice:utterance:${u.id}`,
      author: u.speaker,
      context: u.context,
      text: u.text,
      addressed: this.#saidHerName(u.text),
      verdict: this.#inspect(u.id, u.text.trim(), "voice", u.speaker.account, u.context),
    });
  }

  #said(
    env: Envelope,
    source: string,
    writer: string,
    said: {
      id: string;
      key: string;
      author: Author;
      context: ContextKey;
      text: string;
      addressed: boolean;
      verdict: InputVerdict | null;
    },
  ): void {
    const { author, context, text, key, verdict } = said;
    const from = this.#handle(author.account, author.display_name);
    if (verdict?.action === "ignore") {
      // It happened, and that is all: nothing of it reaches what she knows.
      this.#observe(env, {
        source,
        key,
        revision: 1,
        salience: "ambient",
        summary: `${author.display_name}:(略過)`,
        from,
        context,
      });
      return;
    }
    // Written by someone who is held back: there, but it asks for nothing and answers nothing.
    const held = holdsBack(verdict);
    const addressed = said.addressed && !held;
    const event = this.#observe(env, {
      source,
      key,
      revision: 1,
      salience: addressed ? "notable" : "ambient",
      summary: `${author.display_name}:${text}${noted(verdict)}`,
      addressed,
      from,
      context,
      speech: !author.is_bot && !held,
      buckets: [{ op: "append-self", writer, owner: env.source, untrusted: true }],
    });
    this.#messages.set(said.id, { event, key });
  }

  // ---- voice --------------------------------------------------------------------------------

  #participants(env: Envelope, context: ContextKey, participants: VoiceParticipant[]): void {
    const names: Handle[] = [];
    for (const p of participants) {
      if (!p.is_self) names.push(this.#handle(p.account, p.display_name));
    }
    names.sort();
    const place = contextKeyString(context);
    this.#present.set(place, names);
    this.#state(env, names.join("\n"), {
      source: "voice.presence",
      key: `voice:members:${place}`,
      salience: "ambient",
      summary: `語音頻道裡有:${joined(names)}`,
      context,
      buckets: [
        { op: "replace-self", writer: "voice.members", owner: env.source, untrusted: true },
      ],
    });
  }

  #voiceLeft(env: Envelope, context: ContextKey, reason: string | null): void {
    const place = contextKeyString(context);
    this.#present.delete(place);
    const key = `voice:members:${place}`;
    this.#observe(env, {
      source: "voice.presence",
      key,
      revision: this.#revisions.state(key, "left", timestampMs(env.ts)).revision,
      salience: "ambient",
      summary: reason === null ? "她離開了語音頻道" : `她離開了語音頻道(${reason})`,
      context,
      buckets: [{ op: "leave", writer: "voice.members" }],
    });
  }

  #bargeIn(env: Envelope, barge: VoiceBargeIn): void {
    this.#observe(env, {
      source: "voice.barge",
      key: `voice:barge:${barge.turn ?? "none"}`,
      revision: 1,
      salience: "ambient",
      summary: `她的話被打斷(${barge.action}:${barge.reason})`,
      context: barge.context,
      cause: this.#head(barge.turn),
    });
  }

  // ---- delivery -----------------------------------------------------------------------------

  /** Which key a line goes under: the narration's, the message it answers, or its own words. */
  #lineKey(turn: TurnId | null, text: string): Attention {
    const facts = turn === null ? undefined : this.#turns.get(turn);
    return facts?.attention ?? facts?.focus ?? { key: topicKey(text), revision: 1 };
  }

  #openLine(
    channel: DeliveryChannel,
    context: ContextKey,
    turn: TurnId | null,
    text: string,
  ): string {
    const { key, revision } = this.#lineKey(turn, text);
    const facts = turn === null ? undefined : this.#turns.get(turn);
    const audience =
      channel === "voice"
        ? (this.#present.get(contextKeyString(context)) ?? [])
        : (facts?.addressed ?? []);
    return this.#ledger.open({
      attention_key: key,
      revision,
      channel,
      context,
      said: text,
      audience,
      turn,
      cause: this.#head(turn),
      source: `delivery.${channel}`,
    });
  }

  #playback(data: EventData<"voice_playback">): void {
    const { context, turn, state, text } = data;
    const id = `${contextKeyString(context)}\n${turn}\n${text}`;
    const waiting = this.#playing.get(id) ?? [];
    if (state === "started") {
      this.#playing.set(id, [...waiting, this.#openLine("voice", context, turn, text)]);
      return;
    }
    const line = waiting[0] ?? this.#openLine("voice", context, turn, text);
    if (waiting.length > 1) this.#playing.set(id, waiting.slice(1));
    else this.#playing.delete(id);
    if (state === "finished" && (data.blocked ?? null) !== null) {
      this.#ledger.undelivered(line, "blocked", data.blocked);
    } else if (state === "finished") {
      this.#ledger.ack(line);
    } else {
      this.#ended.set(id, true);
      this.#ledger.undelivered(line, state);
    }
  }

  #settled(settled: ActionSettled): void {
    const { type, context, turn, text, ok, error } = settled;
    if (type === "speak") {
      // Voice reported how it went, unless the line never got that far.
      const id = `${contextKeyString(context)}\n${turn}\n${text}`;
      if (ok || this.#ended.get(id)) {
        this.#ended.delete(id);
        return;
      }
      const state = NEVER_SENT.has(error ?? "") ? "cancelled" : "failed";
      const waiting = this.#playing.get(id) ?? [];
      const line = waiting[0] ?? this.#openLine("voice", context, turn, text);
      if (waiting.length > 1) this.#playing.set(id, waiting.slice(1));
      else this.#playing.delete(id);
      this.#ledger.undelivered(line, state, error);
      return;
    }
    const line = this.#openLine("text", context, turn, text);
    if (ok && (settled.blocked ?? null) !== null) {
      this.#ledger.undelivered(line, "blocked", settled.blocked);
    } else if (ok) this.#ledger.ack(line);
    else {
      const state = NEVER_SENT.has(error ?? "") ? "cancelled" : "failed";
      this.#ledger.undelivered(line, state, error);
    }
  }

  // ---- turns and decisions ------------------------------------------------------------------

  #focus(focus: TurnFocus): void {
    const facts = this.#turn(focus.turn);
    facts.addressed = focus.addressed_by;
    const ids = focus.focus.map((m) => m.id).join(",");
    // Most focus events are phase changes of the same turn.
    if (facts.focusIds === ids) return;
    facts.focusIds = ids;
    const first = focus.focus[0];
    const answers = first ? this.#messages.get(first.id) : undefined;
    if (answers) facts.focus = { key: answers.key, revision: 1 };
    const event = this.#log.append({
      kind: "decision",
      source: "agent.focus",
      cause: answers?.event ?? facts.head,
      context: focus.context,
      person: focus.addressed_by[0] ?? null,
      body: {
        turn: focus.turn,
        reason: focus.reason,
        addressed_by: focus.addressed_by,
        focus: focus.focus.map((m) => m.id),
        background: focus.background.map((m) => m.id),
      },
    });
    facts.head = event.id;
  }

  #agentDecision(env: Envelope, trace: EventData<"agent_decision">): void {
    const facts = this.#turn(trace.turn);
    const event = this.#log.append({
      kind: "decision",
      source: "agent",
      cause: facts.head ?? env.causation,
      context: trace.context,
      body: trace as unknown as JsonValue,
    });
    facts.head = event.id;
  }

  #outcome(record: TurnOutcomeRecord): void {
    this.#log.append({
      kind: "result",
      source: "agent",
      cause: this.#head(record.turn),
      context: record.context,
      person: record.addressed_by[0] ?? null,
      body: { turn_outcome: record as unknown as JsonValue },
    });
  }

  #initiative(env: Envelope, data: EventData<"agent_initiative">): void {
    this.#log.append({
      kind: "proposal",
      source: "agent.initiative",
      cause: env.causation,
      context: data.context,
      body: { reason: data.reason, hint: data.hint },
    });
  }

  #impulse(impulse: Impulse): void {
    const key = impulse.attention?.key ?? null;
    const event = this.#log.append({
      kind: "proposal",
      source: `arbiter.${impulse.source}`,
      cause: key === null ? null : (this.#keys.get(key) ?? null),
      context: impulse.target.context,
      person: impulse.target.person,
      body: {
        impulse: impulse.id,
        kind: impulse.kind,
        capability: impulse.capability,
        priority: impulse.priority,
        why: impulse.why,
        hint: impulse.hint,
        attention_key: key,
      },
    });
    const attention = key === null ? null : { key, revision: this.#revisions.current(key) ?? 1 };
    this.#impulses.set(impulse.id, { event: event.id, attention });
  }

  #arbiterDecision(decision: ArbiterDecision): void {
    const impulse = this.#impulses.get(decision.impulse);
    const event = this.#log.append({
      kind: "decision",
      source: "arbiter",
      cause: impulse?.event ?? null,
      body: decision as unknown as JsonValue,
    });
    if (decision.verdict !== "accepted" || decision.turn === null) return;
    const facts = this.#turn(decision.turn);
    facts.head = event.id;
    if (impulse?.attention) facts.attention = impulse.attention;
  }

  #gate(decision: JsonObject): void {
    const turn = typeof decision.turn === "string" ? decision.turn : null;
    const allowed = decision.allowed === true;
    const event = this.#log.append({
      kind: allowed ? "action" : "result",
      source: "gate",
      cause: this.#head(turn),
      body: {
        capability: decision.capability ?? null,
        allowed,
        stage: decision.stage ?? null,
        reason: decision.reason ?? null,
        why: decision.why ?? null,
        turn,
      },
    });
    if (allowed && turn !== null) this.#turn(turn).action = event.id;
  }

  /**
   * The six-segment measurement of one reply (`voice.latency`, stage `e2e`), so a past turn can
   * show it. Only that stage: the per-line `llm` one and every other measurement stay off the log.
   */
  #latency(data: JsonObject): void {
    if (data.stage !== "e2e" || typeof data.turn !== "string") return;
    const { stage: _stage, ...measurement } = data;
    this.#log.append({
      kind: "result",
      source: VOICE_LATENCY_TOPIC,
      cause: this.#head(data.turn),
      context: isJsonObject(data.context) ? (data.context as unknown as ContextKey) : null,
      body: { turn: data.turn, e2e: measurement },
    });
  }

  #thought(thought: Thought): void {
    this.#log.append({
      kind: "thought",
      source: "mind",
      body: {
        thought: thought.thought,
        changes: thought.changes,
        intents: thought.intents,
        error: thought.error,
      } satisfies MindThoughtBody as unknown as JsonValue,
    });
  }

  // ---- activity and tasks -------------------------------------------------------------------

  #activity(env: Envelope, snapshot: ActivitySnapshot): void {
    const { presence, broadcast, activity } = snapshot;
    const doing =
      activity.type === "idle"
        ? "閒著"
        : `${activity.type}${activity.target === null ? "" : `(${activity.target})`} ${activity.phase}`;
    const summary = `語音:${presence.type};直播:${broadcast.type};活動:${doing}`;
    this.#state(env, summary, {
      source: "activity",
      key: "activity:state",
      salience: "ambient",
      summary,
      buckets: [{ op: "replace-self", writer: "activity", owner: env.source, untrusted: false }],
    });
  }

  #activityTask(env: Envelope, task: ActivityTaskEvent): void {
    const key = `task:${task.task}`;
    const at = timestampMs(env.ts);
    const facts = task.turn === null ? undefined : this.#turns.get(task.turn);
    const failed = task.type === "failed";
    const waited = task.type === "done" && task.turn !== null;
    const text = task.type === "started" ? "開始" : failed ? `失敗(${task.code})` : "完成";
    const detail = task.type === "started" ? "" : `:${task.detail}`;
    const event = this.#observe(env, {
      source: "activity",
      key,
      revision: this.#revisions.state(key, task.type, at).revision,
      salience: failed || waited ? "notable" : "ambient",
      summary: `${task.request.type} ${text}${detail}`,
      cause: this.#tasks.get(task.task) ?? facts?.action ?? facts?.head ?? null,
      buckets: [
        { op: "append-self", writer: "activity.tasks", owner: env.source, untrusted: true },
      ],
    });
    this.#tasks.set(task.task, event);
  }

  /**
   * How a steer went (v3 §10.6): a `steer` line under the request's id (the request is written by
   * the activity manager under the steer's id), and an Observation so she hears about a refusal
   * or a steer that came too late. It is not a task state: the task goes on (or ended on its own).
   */
  #steered(env: Envelope, owner: string, task: Extract<TaskEvent, { type: "steered" }>): void {
    const label =
      task.outcome === "applied" ? "已套用" : task.outcome === "rejected" ? "被拒絕" : "來不及";
    const detail = task.detail === "" ? "" : `:${task.detail}`;
    const line = this.#log.append({
      kind: "steer",
      source: owner,
      at: env.ts,
      cause: task.steer,
      body: {
        phase: "outcome",
        task: task.task,
        steer: task.steer,
        outcome: task.outcome,
        detail: task.detail,
      } satisfies SteerOutcomeBody,
    });
    const key = `steer:${task.steer}`;
    this.#observe(env, {
      source: owner,
      key,
      revision: this.#revisions.event(key, timestampMs(env.ts), NO_REPEAT).revision,
      salience: task.outcome === "applied" ? "ambient" : "notable",
      summary: `任務調整${label}${detail}`,
      cause: line.id,
      buckets: [
        { op: "append-self", writer: "steers", owner: env.source, untrusted: true, max_entries: 5 },
      ],
    });
  }

  #task(env: Envelope, owner: string, task: TaskEvent): void {
    if (task.type === "steered") {
      this.#steered(env, owner, task);
      return;
    }
    const key = `task:${task.task}`;
    const at = timestampMs(env.ts);
    const writer = `${owner}.task`;
    const failed = task.type === "failed";
    const summary =
      task.type === "started"
        ? `任務開始:${task.goal}`
        : task.type === "progress"
          ? task.detail
          : failed
            ? `任務失敗(${task.code}):${task.detail}`
            : `任務完成:${task.detail}`;
    const event = this.#observe(env, {
      source: owner,
      key,
      revision: this.#revisions.state(key, task.type, at).revision,
      salience: failed ? "notable" : "ambient",
      summary,
      cause: this.#tasks.get(task.task) ?? null,
      buckets:
        task.type === "done" || failed
          ? [{ op: "leave", writer }]
          : [{ op: "replace-self", writer, owner: env.source, untrusted: true }],
    });
    this.#tasks.set(task.task, event);
  }

  #notice(env: Envelope, notice: Notice): void {
    const key = `notice:${notice.task ?? notice.id}`;
    this.#observe(env, {
      source: `notice.${notice.source}`,
      key,
      revision: this.#revisions.event(key, timestampMs(env.ts), NO_REPEAT).revision,
      salience: "notable",
      summary: notice.text,
      context: notice.context,
      cause:
        (notice.task === null ? null : this.#tasks.get(notice.task)) ?? this.#head(notice.turn),
      buckets: [{ op: "append-self", writer: "notices", owner: env.source, untrusted: true }],
    });
  }

  #moduleState(env: Envelope, data: EventData<"module_state_changed">): void {
    const { module, state, reason } = data;
    const left = state === "stopped" || state === "failed" || state === "disabled";
    if (!left && state !== "running") return;
    this.#state(env, state, {
      source: "system",
      key: `system:module:${module}`,
      salience: "ambient",
      summary: reason === null ? `模組 ${module}:${state}` : `模組 ${module}:${state}(${reason})`,
      buckets: left ? [{ op: "leave-owner", owner: module }] : [],
    });
  }

  #restore(env: Envelope, restore: ActivityRestore): void {
    this.#observe(env, {
      source: LIFECYCLE_SOURCE,
      key: `${RESTORE_KEY_PREFIX}${restore.game}`,
      revision: 1,
      salience: "ambient",
      summary: `上次沒關的 ${restore.game}:${restore.outcome}`,
    });
  }

  // ---- stage and songs ----------------------------------------------------------------------

  #golive(env: Envelope, data: JsonObject): void {
    const state = typeof data.state === "string" ? data.state : "unknown";
    const guild = typeof data.guild === "string" ? data.guild : "";
    const ended = state === "stopped" || state === "failed";
    this.#state(env, state, {
      source: "stream",
      key: `stream:golive:${guild}`,
      salience: state === "failed" ? "notable" : "ambient",
      summary: `Go Live:${state}`,
      buckets: ended
        ? [{ op: "leave", writer: "stream" }]
        : [{ op: "replace-self", writer: "stream", owner: env.source, untrusted: false }],
    });
  }

  #stage(env: Envelope, data: JsonObject): void {
    const connected = data.connected === true;
    const scene = typeof data.scene === "string" ? data.scene : null;
    const fingerprint = JSON.stringify([connected, data.obs, data.streaming, scene]);
    const summary = connected
      ? `直播機連著;場景 ${scene ?? "不明"};${data.streaming === true ? "正在直播" : "沒有直播"}`
      : "直播機沒有連上";
    this.#state(env, fingerprint, {
      source: "stage",
      key: "stage:status",
      salience: "ambient",
      summary,
      buckets: connected
        ? [{ op: "replace-self", writer: "stage", owner: env.source, untrusted: true }]
        : [{ op: "leave", writer: "stage" }],
    });
  }

  #song(env: Envelope, payload: JsonValue): void {
    const cue = parseSongCue(payload);
    // A lyrics line is not news: `line` cues are left out.
    if (cue === null || cue.state === "line") return;
    const key = `song:${cue.song}`;
    const started = cue.state === "started";
    const name = cue.state === "started" ? cue.title || cue.song : cue.song;
    this.#observe(env, {
      source: "sing",
      key,
      revision: this.#revisions.state(key, cue.state, timestampMs(env.ts)).revision,
      salience: "ambient",
      summary: started ? `正在唱:${name}` : `唱完了:${name}`,
      buckets: started
        ? [{ op: "replace-self", writer: "song", owner: env.source, untrusted: true }]
        : [{ op: "leave", writer: "song" }],
    });
  }

  #songPrepare(env: Envelope, payload: JsonValue): void {
    const prepare = parseSongPrepare(payload);
    if (prepare === null) return;
    const idle = prepare.no === null;
    // Progress moves all the time; only a new stage of a new song is a change.
    this.#state(env, `${prepare.no}:${prepare.stage}:${prepare.exclusive}`, {
      source: "sing",
      key: "song:prepare",
      salience: "ambient",
      summary: idle ? "沒有在準備歌" : `準備歌曲 ${prepare.title}:${prepare.stage}`,
      buckets: idle
        ? [{ op: "leave", writer: "song.prepare" }]
        : [{ op: "replace-self", writer: "song.prepare", owner: env.source, untrusted: true }],
    });
  }

  // ---- games --------------------------------------------------------------------------------

  #gameSession(env: Envelope, data: JsonObject): void {
    const game = typeof data.game === "string" ? data.game : null;
    if (game === null) return;
    const name = typeof data.game_name === "string" ? data.game_name : game;
    const key = `game:session:${game}`;
    const started = data.state === "started";
    const failed = typeof data.code === "string";
    this.#observe(env, {
      source: GAME_SESSION_SOURCE,
      key,
      revision: this.#revisions.state(key, String(data.state), timestampMs(env.ts)).revision,
      salience: started || failed ? "notable" : "ambient",
      summary: started ? `正在玩 ${name}` : `不玩 ${name} 了`,
      context: parseContext(data.context),
      buckets: started
        ? [{ op: "replace-self", writer: "game.session", owner: env.source, untrusted: true }]
        : [
            { op: "leave", writer: "game.session" },
            { op: "leave", writer: `game.${game}` },
            { op: "leave", writer: `game.${game}.task` },
          ],
    });
  }

  #gameGoal(env: Envelope, data: JsonObject): void {
    const goal = typeof data.goal === "string" ? data.goal : "";
    const reached = data.status === "done";
    const key =
      typeof data.attention_key === "string" ? data.attention_key : gameGoalKey(goal, null);
    const at = timestampMs(env.ts);
    this.#observe(env, {
      source: "game.director",
      key,
      revision: this.#revisions.event(key, at, this.#config.event_repeat_mins * 60_000).revision,
      salience: reached ? "notable" : "ambient",
      summary: reached ? `完成目標:${goal}` : `目標沒做成:${goal}`,
      cause: typeof data.task === "string" ? (this.#tasks.get(data.task) ?? null) : null,
      buckets: [
        {
          op: "append-self",
          writer: `game.${typeof data.game === "string" ? data.game : "unknown"}`,
          owner: env.source,
          untrusted: true,
        },
      ],
    });
  }

  /** §6: decided here, by rules. First time, a big drop in health, death: never each tick. */
  #gameSalience(
    kind: string,
    data: JsonObject | null,
    important: boolean,
    fresh: boolean,
  ): Salience {
    if (URGENT_GAME_EVENTS.has(kind)) return "urgent";
    if (!fresh) return "ambient";
    if (kind === "damage") {
      return typeof data?.amount === "number" && data.amount >= this.#config.big_damage
        ? "notable"
        : "ambient";
    }
    if (kind === "advancement" || important || NOTED_GAME_EVENTS.includes(kind)) return "notable";
    return "ambient";
  }

  #gameEvent(env: Envelope, game: string, topicKind: string, payload: JsonObject): void {
    const kind = typeof payload.type === "string" ? payload.type : topicKind;
    const data = isJsonObject(payload.data) ? payload.data : null;
    const key = gameEventKey(kind, data);
    const { hazard_events: hazards, hazard_repeat_secs: hazardSecs } = this.#config;
    const repeat = ALWAYS_NEW.has(kind)
      ? NO_REPEAT
      : hazards.includes(kind)
        ? hazardSecs * 1000
        : this.#config.event_repeat_mins * 60_000;
    const { revision, fresh } = this.#revisions.event(key, timestampMs(env.ts), repeat);
    const salience = this.#gameSalience(kind, data, payload.important === true, fresh);
    const text = typeof data?.text === "string" ? data.text : null;
    const verdict = text === null ? null : this.#inspect(null, text, "game_chat", null, null);
    this.#observe(env, {
      source: `game.${game}`,
      key,
      revision,
      salience,
      summary: text === null ? kind : `${text}${noted(verdict)}`,
      buckets:
        salience === "ambient"
          ? []
          : [{ op: "append-self", writer: `game.${game}`, owner: env.source, untrusted: true }],
    });
  }
}
