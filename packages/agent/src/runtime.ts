// The agent's event loop: turns bus events into session updates and coordinator input, and
// keeps the state shared by the per-context coordinators and their turns: the focus of every
// turn in flight (`TurnFocusBoard`, provided as `TurnFocusViewKey`), turn outcomes
// (`agent.turn.outcome`), saved prompts, notices waiting to be told and the subtitles of
// lines she spoke before writing them.
//
// It also keeps her rhythm in text channels (`Rhythm`, levels.ts: looks, reactions, pacing) and
// provides `MessageActionsKey` for the context menus: "要她回這則" opens an addressed turn on that
// message, "不要記住這個" hides it from her prompts and tells the rest of her memory
// (`agent.message.excluded`).

import { errorMessage, type Logger, type ModuleContext, type Subscription } from "@miyoria/kernel";
import type { Tool, ToolContext, ToolRegistry } from "@miyoria/tools";
import {
  ACTION_SETTLED_TOPIC,
  ACTIVITY_DONE_TOPIC,
  ACTIVITY_FAILED_TOPIC,
  type AccountRef,
  type ActionId,
  ActuatorExecutorKey,
  ARBITER_IMPULSE_TOPIC,
  ArbiterKey,
  type Attitude,
  type ContextKey,
  type ConversationFacts,
  customEvent,
  type Envelope,
  type EventData,
  type FloorClaimKind,
  type Handle,
  HandleDirectoryKey,
  holdsBack,
  type Impulse,
  type ImpulseAttention,
  type ImpulseRun,
  type ImpulseSource,
  type IncomingMessage,
  type InputVerdict,
  type Intent,
  type InterruptLevel,
  impulseReason,
  incomingText,
  inspectInput,
  isJsonObject,
  type JsonValue,
  MESSAGE_EXCLUDED_TOPIC,
  type MessageActionOutcome,
  type MessageActionRequest,
  type MessageActions,
  MessageActionsKey,
  type MessageExcluded,
  type MessageRef,
  type Mood,
  MoodSignalsKey,
  NOTICE_TOPIC,
  type Notice,
  newId,
  newImpulse,
  type PlatformId,
  type PlaybackState,
  pipelineOf,
  type SavedPrompt,
  SelfStateKey,
  type SocialSignals,
  SocialSignalsKey,
  safeName,
  sameAccount,
  TURN_FOCUS_TOPIC,
  TURN_OUTCOME_TOPIC,
  type TurnId,
  type TurnOutcomeRecord,
  toTimestamp,
  type VoiceParticipant,
  type VoiceUtterance,
  v2Event,
  v2Payload,
} from "@miyoria/types";
import type { RandomSource, TalkLevel } from "./attention.js";
import type { AgentCommands } from "./commands.js";
import { PROMPT_TOPIC, SavedPrompts } from "./compiler.js";
import type { AgentConfig } from "./config.js";
import { Coordinator } from "./coordinator.js";
import { TurnFocusBoard } from "./focus.js";
import type { AgentHandle } from "./handle.js";
import { startBackfill } from "./history.js";
import {
  type Ceiling,
  ceilingFor,
  Rhythm,
  RhythmSectionSchema,
  UNCAPPED_INITIATIVES,
} from "./levels.js";
import { type Chain, heardPart, heardShare, MainLine } from "./mainline/main.js";
import { agentTurns } from "./metrics.js";
import type { PersonaHandle } from "./persona.js";
import { type HistoryEntry, Session } from "./session.js";
import { BUDGET_TOPIC, parseBudgetState } from "./signals.js";
import { ReactTool } from "./tools.js";
import { accountId, contextId } from "./util.js";
import { type FetchLike, ImageLoader } from "./vision.js";

/** Module whose restart means the agent commands must be registered again. */
const COMMANDS_MODULE = "commands";
const MINUTE_MS = 60_000;
/** Without the Arbiter, an initiative waits this long after she spoke (text / voice). */
const LEGACY_AFTER_SPEECH_TEXT_MS = 5_000;
const LEGACY_AFTER_SPEECH_VOICE_MS = 20_000;
/** How long the Arbiter waits for a coordinator to take (or refuse) an impulse's turn. */
const OPEN_TIMEOUT_MS = 5_000;
/** Topic of the voice module's barge-in reports (`packages/voice/src/topics.ts`, W2). */
export const BARGE_IN_TOPIC = "voice.barge_in";
/** Topic of the subtitle of a line she spoke before writing it (payload: see `noteSubtitle`). */
export const SUBTITLE_TOPIC = "agent.subtitle";
/** Notices kept per context while nobody reads them. */
const MAX_NOTICES = 10;
/** Barge-ins and subtitles remembered (by turn). */
const MAX_REMEMBERED = 64;

/** An `agent.initiative` request. */
export interface Initiative {
  reason: string;
  hint: string;
  about: AccountRef[];
  /** Main line: what the claim is about, its row of §7.1 and what it continues. */
  attention?: ImpulseAttention | null;
  claim?: FloorClaimKind;
  chain?: Chain | null;
  proposal?: { id: string; tool: string | null } | null;
}

/**
 * The Arbiter's source for an `agent.initiative` reason (publishers that were not converted to
 * impulses yet, extensions): game commentary, a song, a result or notice, else a reaction to
 * the world. None of them is her own initiative.
 */
export function initiativeSource(reason: string): ImpulseSource {
  if (reason === "game") return "game";
  if (reason === "notice") return "notice";
  if (reason === "action_result" || reason === "followup") return "followup";
  if (reason.startsWith("song_")) return "song";
  return "world";
}

/** Whether an `agent.initiative` is about her own doings, not a reaction to someone there. */
function aboutHerself(reason: string): boolean {
  if (reason === "action_result") return true;
  const source = initiativeSource(reason);
  return source === "game" || source === "notice" || source === "song";
}

/** How long a converted `agent.initiative` stays worth saying while the place is busy. */
const INITIATIVE_TTL_MS = 2 * MINUTE_MS;
/** Results someone waits for stay longer (the old follow-up retry window). */
const RESULT_TTL_MS = 10 * MINUTE_MS;

/** One of her intents (from her mind loop), to be opened as a turn she starts herself. */
export interface IntentTurn {
  intent: Intent;
  /** The turn's id (chosen up front so gate decisions and outcomes can be linked to it). */
  turn: TurnId;
  /** What the action she already took returned (`null`: she only wants to talk). */
  done: string | null;
  /** Summary of the capability she used, for the prompt. */
  summary: string | null;
  /**
   * The Arbiter already decided on it: no level gap or budget check here (it booked her start
   * itself, so checking again would see that start).
   */
  gated?: boolean;
  /** Main line: the tool that would carry the proposal out. */
  tool?: string | null;
  /** Main line: she may act on it but not talk (nobody is there, or her budget is spent). */
  muted?: boolean;
}

export type Input =
  /** A platform message or a voice utterance (as a message). */
  | { type: "message"; message: IncomingMessage }
  | { type: "typing" }
  /** Someone in the voice channel started or stopped speaking. */
  | { type: "speaking" }
  /** Playback of her speech for `turn` changed. */
  | { type: "playback"; turn: TurnId; state: PlaybackState }
  /**
   * Start a turn on her own (no new input), if the context is quiet. `reply`: the Arbiter's
   * impulse (it decided the rules; the coordinator only says whether the place is free).
   */
  | { type: "initiative"; initiative: Initiative; reply?: (run: ImpulseRun) => void }
  /** Start a turn she decided on (principal `self`, with tools) once the context is free. */
  | { type: "intent"; intent: IntentTurn }
  /** Main line: a claim cuts into her speech here, this hard (§7.3). */
  | { type: "yield"; level: InterruptLevel }
  /** The emergency stop: the turn in flight and everything waiting here ends. */
  | { type: "halt" };

/** Unbounded queue from the event loop to one coordinator (Rust `mpsc` channel). */
export class Inbox {
  readonly #items: Input[] = [];
  #waiter: (() => void) | null = null;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  get isEmpty(): boolean {
    return this.#items.length === 0;
  }

  /** `false` once closed (the coordinator is gone). */
  push(item: Input): boolean {
    if (this.#closed) return false;
    this.#items.push(item);
    this.#wake();
    return true;
  }

  shift(): Input | undefined {
    return this.#items.shift();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  /** Resolves once there is an item or the inbox is closed. */
  ready(): Promise<void> {
    if (this.#items.length > 0 || this.#closed) return Promise.resolve();
    return new Promise((resolve) => {
      const previous = this.#waiter;
      this.#waiter = () => {
        previous?.();
        resolve();
      };
    });
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }
}

interface ContextHandle {
  session: Session;
  inbox: Inbox;
}

/** State shared by the event loop, the per-context coordinators and turns. */
export class Agent {
  readonly #selfAccounts = new Map<string, AccountRef>();
  readonly #contexts = new Map<string, ContextHandle>();
  /** Her submitted messages awaiting `action.completed`. */
  readonly #pendingActions = new Map<ActionId, Session>();
  /** When she last said she is out of energy (budget exhausted), per context (clock ms). */
  readonly #budgetNotices = new Map<string, number>();
  /** Downloads the images she looks at (cached by attachment id). */
  readonly images: ImageLoader;
  /** Intents waiting for her to arrive in a voice channel (after `voice.join`), by context. */
  readonly #arrivals = new Map<string, IntentTurn>();
  /**
   * When she last started a conversation herself in a text channel (clock ms), by context: the
   * level's gap between starts. In memory only.
   */
  readonly #starts = new Map<string, number>();
  /** The focus of every turn in flight (`TurnFocusViewKey`). */
  readonly focusBoard: TurnFocusBoard;
  /** Compressed prompts of recent turns (`SavedPromptsKey`). */
  readonly prompts: SavedPrompts;
  /** Turns seen so far, for `[modules.agent.prompt] save_every`. */
  #promptCount = 0;
  /** Notices not shown to her yet, by context id (`""`: wherever she talks next). */
  readonly #notices = new Map<string, Notice[]>();
  /** Who barged in on her speech, by turn (`voice.barge_in` with `stop`). */
  readonly #barges = new Map<TurnId, Handle | null>();
  /** Written sentences of lines she spoke first, by turn: spoken line → subtitle. */
  readonly #subtitles = new Map<TurnId, Map<string, string>>();
  /** `pipeline = "v3"`: the one foreground decider. `null`: the V2 paths. */
  readonly mainline: MainLine | null;
  /** Her rhythm in text channels: looks, reactions, pacing (`[modules.agent.rhythm]`). */
  readonly rhythm: Rhythm;
  /** Messages people asked her not to remember, by context id (bounded). */
  readonly #excluded = new Map<string, Set<string>>();
  /** The context menus' requests (`MessageActionsKey`). */
  readonly messageActions: MessageActions = {
    replyTo: (request) => Promise.resolve(this.#replyTo(request)),
    dontRemember: (request) => Promise.resolve(this.#dontRemember(request)),
  };

  constructor(
    readonly ctx: ModuleContext,
    readonly config: AgentConfig,
    readonly persona: PersonaHandle,
    readonly random: RandomSource,
    readonly handle: AgentHandle,
    readonly tools: ToolRegistry,
    readonly commands: AgentCommands,
    fetchImage?: FetchLike,
  ) {
    this.images = new ImageLoader(fetchImage, (key, error) =>
      this.log.debug({ image: key, error }, "could not download image"),
    );
    this.focusBoard = new TurnFocusBoard(
      () => ctx.clock.now(),
      (focus) => ctx.publish(v2Event(TURN_FOCUS_TOPIC, focus), { turn: focus.turn }),
    );
    this.prompts = new SavedPrompts(config.prompt.saved);
    this.mainline = pipelineOf(ctx.services) === "v3" ? new MainLine(this) : null;
    this.rhythm = new Rhythm(ctx.config(RhythmSectionSchema).rhythm, () => ctx.clock.now());
    // An emoji is the cheapest rung of joining in (v4 §7.2). It is no line, so neither the Floor's
    // budget nor her share counts it: it has a limit of its own per channel.
    const react = tools.get(ReactTool.NAME);
    if (react !== undefined) tools.register(new LimitedReact(react, this.rhythm));
    ctx.provide(MessageActionsKey, this.messageActions);
  }

  get log(): Logger {
    return this.ctx.log;
  }

  /** The emergency stop is on: she remembers what she hears and answers nothing. */
  get muted(): boolean {
    return this.ctx.services.get(ActuatorExecutorKey)?.paused === true;
  }

  /** `TurnSilencer`. */
  silence(why: string): void {
    const floor = this.mainline?.floor();
    for (const handle of this.#contexts.values()) {
      handle.inbox.push({ type: "halt" });
      floor?.releaseContext(handle.session.context, why);
    }
    this.#arrivals.clear();
    this.mainline?.silence();
  }

  static topics(mainline = false): string[] {
    return [
      ...(mainline
        ? [ACTION_SETTLED_TOPIC, ACTIVITY_DONE_TOPIC, ACTIVITY_FAILED_TOPIC, "game.*", "sing.*"]
        : []),
      "platform.ready",
      "platform.message.created",
      "platform.typing",
      "voice.*",
      "action.completed",
      "system.module.state",
      "agent.initiative",
      NOTICE_TOPIC,
      BUDGET_TOPIC,
      ARBITER_IMPULSE_TOPIC,
    ];
  }

  async run(sub: Subscription): Promise<void> {
    for await (const env of sub) {
      try {
        this.#handle(env);
      } catch (error) {
        this.log.warn({ error: errorMessage(error) }, "could not handle event");
      }
    }
  }

  #handle(env: Envelope): void {
    const event = env.event;
    switch (event.type) {
      case "platform_ready": {
        const account = event.data.self_account;
        this.log.debug({ platform: account.platform, id: account.id }, "self account ready");
        this.#selfAccounts.set(accountId(account), account);
        break;
      }
      case "platform_message_created":
        this.mainline?.noteCause(event.data.id.id, env.id);
        this.#onMessage(event.data);
        break;
      case "platform_typing":
        if (!this.isSelf(event.data.account)) {
          this.#contexts.get(contextId(event.data.context))?.inbox.push({ type: "typing" });
        }
        break;
      case "voice_joined":
      case "voice_participants":
        if (this.#isVoice(event.data.context)) {
          this.#onVoiceMembers(event.data.context, event.data.participants);
        }
        break;
      case "voice_left": {
        const { context, reason } = event.data;
        if (!this.#isVoice(context)) break;
        this.log.debug({ context: contextId(context), reason }, "left voice, session dropped");
        this.handle.setVoiceRoom(context, false);
        this.mainline?.lines.dropContext(context, "she left the voice channel");
        this.mainline?.floor()?.releaseContext(context, "she left the voice channel");
        // Closing the inbox stops the coordinator (and its turn).
        const id = contextId(context);
        this.#contexts.get(id)?.inbox.close();
        this.#contexts.delete(id);
        break;
      }
      case "voice_speaking": {
        const { context, account, speaking } = event.data;
        if (!this.#isVoice(context) || this.isSelf(account)) break;
        const h = this.#contexts.get(contextId(context));
        if (h) {
          h.session.setSpeaking(account, speaking);
          h.inbox.push({ type: "speaking" });
        }
        break;
      }
      case "voice_utterance":
        this.mainline?.noteCause(event.data.id, env.id);
        if (this.#isVoice(event.data.context)) this.#onUtterance(event.data);
        break;
      case "voice_playback":
        if (this.#isVoice(event.data.context)) this.#onPlayback(event.data);
        break;
      case "action_completed": {
        const { action, ok } = event.data;
        const session = this.#pendingActions.get(action);
        this.#pendingActions.delete(action);
        if (session && !ok) session.forgetAction(action);
        break;
      }
      case "module_state_changed":
        if (event.data.state === "running" && event.data.module === COMMANDS_MODULE) {
          this.commands.install(this.ctx.services, this.handle, this.persona);
        }
        break;
      case "agent_initiative": {
        const { context, reason, hint, about } = event.data;
        this.#onInitiative(context, { reason, hint, about: [...about] });
        break;
      }
      case "custom":
        if (this.mainline?.custom(event.data.topic, event.data.payload)) break;
        if (event.data.topic === BUDGET_TOPIC) this.#onBudget(event.data.payload);
        else if (event.data.topic === BARGE_IN_TOPIC) this.#onBargeIn(event.data.payload);
        else if (event.data.topic === ARBITER_IMPULSE_TOPIC) {
          const impulse = v2Payload(event, ARBITER_IMPULSE_TOPIC);
          if (impulse) this.#onImpulseEvent(impulse);
        } else if (event.data.topic === NOTICE_TOPIC) {
          const notice = v2Payload(event, NOTICE_TOPIC);
          if (notice) this.#onNotice(notice);
        }
        break;
      default:
        break;
    }
  }

  /** The context's handle, creating the context (session and coordinator) if needed. */
  #context(key: ContextKey): ContextHandle {
    const id = contextId(key);
    let handle = this.#contexts.get(id);
    if (!handle) {
      const session = new Session(key, this.config.history_limit, this.ctx.clock);
      const inbox = new Inbox();
      const created: ContextHandle = { session, inbox };
      handle = created;
      this.#contexts.set(id, created);
      const coordinator = new Coordinator(this, key, session, inbox);
      this.ctx.spawn("context", (signal) => coordinator.run(signal));
    }
    return handle;
  }

  /** The context's handle if it exists (a stray signal must not bring a session back). */
  #existing(key: ContextKey): ContextHandle | undefined {
    return this.#contexts.get(contextId(key));
  }

  #onMessage(incoming: IncomingMessage): void {
    const msg = this.#voiceTextChat(incoming);
    if (this.isBlocked(msg.author.account)) {
      this.log.debug(
        { context: contextId(msg.id.context), account: msg.author.account.id },
        "ignoring blocked user",
      );
      return;
    }
    const isSelf = this.isSelf(msg.author.account);
    const ignored = isSelf || (msg.author.is_bot && !this.config.respond_to_bots);
    const verdict = isSelf ? null : this.#inspect(msg, "chat");
    if (verdict?.action === "ignore") return;
    const cold = this.#existing(msg.id.context) === undefined;
    const handle = this.#context(msg.id.context);
    if (cold) startBackfill(this, handle.session, msg);
    handle.session.recordMessage(msg, isSelf);
    this.#take(handle, msg, verdict, ignored);
  }

  /** What the input defence says of `msg` (the same verdict wherever it is asked). */
  #inspect(msg: IncomingMessage, source: "chat" | "voice"): InputVerdict | null {
    return inspectInput(this.ctx.services, {
      id: msg.id.id,
      text: incomingText(msg),
      source,
      author: msg.author.account,
      context: msg.id.context,
    });
  }

  /** A recorded message: flagged as the verdict says, and whether it may start a turn. */
  #take(
    handle: ContextHandle,
    msg: IncomingMessage,
    verdict: InputVerdict | null,
    ignored: boolean,
  ): void {
    if (verdict?.note) handle.session.flag(msg.id.id, verdict.note);
    if (ignored || holdsBack(verdict) || this.muted) return;
    handle.inbox.push({ type: "message", message: msg });
  }

  /**
   * Text typed in the chat of the voice channel she is in belongs to the voice conversation
   * (`voice.text_chat`): she answers it by speaking. On Discord a voice channel's text chat
   * has the channel's own id, so the voice context is the same channel with kind `voice`.
   */
  #voiceTextChat(msg: IncomingMessage): IncomingMessage {
    const room = this.#roomOf(msg.id.context);
    return room === null ? msg : { ...msg, id: { ...msg.id, context: room } };
  }

  /**
   * The voice context a text chat belongs to (`#voiceTextChat`), or `null`. Only while someone
   * in the voice channel can hear her (v4 §7.4: nobody listening, nothing is said aloud): with
   * nobody there, she answers the text chat in writing.
   */
  #roomOf(context: ContextKey): ContextKey | null {
    if (!this.config.voice.text_chat || context.kind !== "channel" || context.scope === null) {
      return null;
    }
    const room = this.handle.voiceContext(context.platform, context.scope);
    if (room === null || room.channel !== context.channel) return null;
    const session = this.#existing(room)?.session;
    if (session !== undefined && session.voiceMembers().length > 0) {
      if (session.listeners().length === 0) return null;
    }
    return room;
  }

  // ---- the context menus (`MessageActionsKey`) ------------------------------------------------

  /** Where she knows the message `ref` names: its session and entry, if she has it. */
  #find(ref: MessageRef): { handle: ContextHandle; entry: HistoryEntry } | null {
    for (const context of [this.#roomOf(ref.context), ref.context]) {
      if (context === null) continue;
      const handle = this.#existing(context);
      const entry = handle?.session.entry(ref.id);
      if (handle !== undefined && entry !== undefined) return { handle, entry };
    }
    return null;
  }

  /**
   * "要她回這則": a turn on that message as if it had called her. The channel's mode still holds
   * (`off`: she does not talk there), and so do the owner's rules, her budget and the Floor: the
   * turn is an addressed one like any other and she may still choose silence.
   */
  #replyTo(request: MessageActionRequest): MessageActionOutcome {
    if (this.muted) return { ok: false, reason: "她現在暫停中。" };
    if (this.isBlocked(request.requested_by)) return { ok: false, reason: "這個功能現在不能用。" };
    const found = this.#find(request.message);
    if (found === null) return { ok: false, reason: "她現在看不到這則訊息。" };
    const { handle, entry } = found;
    if (entry.isSelf) return { ok: false, reason: "這是她自己說的話。" };
    if (this.isBlocked(entry.account)) return { ok: false, reason: "這個功能現在不能用。" };
    if (this.#isExcluded(handle.session.context, request.message.id)) {
      return { ok: false, reason: "這則訊息已經請她不要記住了。" };
    }
    const context = handle.session.context;
    if (this.handle.channelMode(context) === "off") {
      return { ok: false, reason: "她在這個頻道不說話。" };
    }
    this.log.debug(
      { context: contextId(context), message: request.message.id, by: request.requested_by.id },
      "asked to answer a message",
    );
    const pushed = handle.inbox.push({ type: "message", message: entryMessage(context, entry) });
    return pushed ? { ok: true } : { ok: false, reason: "沒有成功,請稍後再試。" };
  }

  /**
   * "不要記住這個": what lives in the agent. The message (and every quote of it) reads as
   * `EXCLUDED_LINE` in the conversation her prompts show from now on, a turn cannot be opened on
   * it, and `agent.message.excluded` tells the rest of her memory, which keeps its own copies.
   */
  #dontRemember(request: MessageActionRequest): MessageActionOutcome {
    const found = this.#find(request.message);
    const context = found?.handle.session.context ?? request.message.context;
    const id = request.message.id;
    let set = this.#excluded.get(contextId(context));
    if (set === undefined) {
      set = new Set();
      this.#excluded.set(contextId(context), set);
    }
    set.add(id);
    while (set.size > MAX_EXCLUDED) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
    if (found !== null) {
      for (const entry of found.handle.session.history()) {
        if (entry.id === id) hideEntry(entry);
        for (const parent of entry.parents) if (parent.id === id) hideEntry(parent);
      }
    }
    const body: MessageExcluded = {
      context,
      message: { context, id },
      author: request.author ?? found?.entry.account ?? null,
      requested_by: request.requested_by,
      at: new Date(this.ctx.clock.now()).toISOString(),
    };
    this.ctx.publish(customEvent(MESSAGE_EXCLUDED_TOPIC, body as unknown as JsonValue));
    return { ok: true };
  }

  #isExcluded(context: ContextKey, id: string): boolean {
    return this.#excluded.get(contextId(context))?.has(id) ?? false;
  }

  /**
   * Where she says something of her own that was meant for `context`: the voice channel she is
   * in on that server, when there is one (`voice.keep_in_voice`), else `context`.
   */
  ownLinesContext(context: ContextKey): ContextKey {
    if (!this.config.voice.keep_in_voice) return context;
    if ((context.kind !== "channel" && context.kind !== "thread") || context.scope === null) {
      return context;
    }
    return this.handle.voiceContext(context.platform, context.scope) ?? context;
  }

  #onVoiceMembers(context: ContextKey, members: readonly VoiceParticipant[]): void {
    this.handle.setVoiceRoom(context, true);
    for (const m of members) {
      if (m.is_self) this.#selfAccounts.set(accountId(m.account), m.account);
    }
    const others = members.filter((m) => !m.is_self);
    const handle = this.#context(context);
    handle.session.setVoiceMembers(others);
    const id = contextId(context);
    const arrival = this.#arrivals.get(id);
    if (arrival) {
      this.#arrivals.delete(id);
      handle.inbox.push({ type: "intent", intent: arrival });
    }
  }

  /**
   * Hands one of her intents to `context`'s coordinator, which opens her turn once the context
   * is free. Returns why it cannot, or `null` when delivered.
   */
  deliverIntent(context: ContextKey, input: IntentTurn): string | null {
    const why = this.muted
      ? "the emergency stop"
      : input.gated
        ? null
        : this.#intentBlocked(context);
    if (why !== null) {
      this.intentSkipped(context, input, why);
      return why;
    }
    if (context.kind === "voice") {
      // Only where she is: a stray intent must not create a voice session.
      const delivered = this.#existing(context)?.inbox.push({ type: "intent", intent: input });
      if (delivered) return null;
      this.intentSkipped(context, input, "not in this voice channel");
      return "not in this voice channel";
    }
    this.#context(context).inbox.push({ type: "intent", intent: input });
    return null;
  }

  /** Opens `input` in the voice `context` once she is there (right away if she already is). */
  deliverOnArrival(context: ContextKey, input: IntentTurn): void {
    if (this.#existing(context)) {
      this.deliverIntent(context, input);
      return;
    }
    this.#arrivals.set(contextId(context), input);
  }

  /** She is in the voice channel `context`. */
  inVoice(context: ContextKey): boolean {
    return context.kind === "voice" && this.#existing(context) !== undefined;
  }

  #intentBlocked(context: ContextKey): string | null {
    // The owner's channel mode stays a guardrail; a DM she opens herself has no mode.
    const why = this.startBlocked(context);
    if (why !== null) return why;
    const budget = this.handle.llmBudget();
    return budget === "ok" ? null : `llm budget ${budget}`;
  }

  /** The owner's level for `context` as a ceiling (`null`: voice, DMs, off / mention-only). */
  ceiling(context: ContextKey): Ceiling | null {
    return ceilingFor(this.handle.channelMode(context), context);
  }

  /**
   * Why the channel's mode or level does not let her start a conversation in `context` now
   * (`off` / `mention-only`, or the level's gap since her last start there), or `null`. DMs
   * she opens herself have no mode. While the Arbiter runs, its ledger says when she may start
   * there next (its one rule set includes the level's gap).
   */
  startBlocked(context: ContextKey): string | null {
    const arbiter = this.ctx.services.get(ArbiterKey);
    if (arbiter) {
      if (context.kind !== "dm") {
        const mode = this.handle.channelMode(context);
        if (mode === "off" || mode === "mention-only") return `mode ${mode}`;
      }
      const limits = arbiter.ledger(context).limits;
      if (limits.waiting_for_response) return "the arbiter: nobody answered her here yet";
      const next = limits.next_initiative_at;
      const left = next === null ? 0 : Date.parse(next) - this.ctx.clock.now();
      if (left <= 0) return null;
      return `the arbiter: next in ${Math.max(Math.ceil(left / MINUTE_MS), 1)} min`;
    }
    if (context.kind === "dm") return null;
    const mode = this.handle.channelMode(context);
    if (mode === "off" || mode === "mention-only") return `mode ${mode}`;
    const gap = ceilingFor(mode, context)?.startGapMs ?? 0;
    const last = this.#starts.get(contextId(context));
    if (gap <= 0 || last === undefined) return null;
    const left = last + gap - this.ctx.clock.now();
    if (left <= 0) return null;
    const ago = Math.max(Math.round((gap - left) / MINUTE_MS), 0);
    const next = Math.max(Math.ceil(left / MINUTE_MS), 1);
    return `level ${mode}: she started talking here ${ago} min ago; next in ${next} min`;
  }

  /** Her lines went unanswered in `context`: she starts nothing there until someone speaks. */
  waitingForResponse(context: ContextKey): boolean {
    const arbiter = this.ctx.services.get(ArbiterKey);
    return arbiter?.ledger(context).limits.waiting_for_response ?? false;
  }

  /** She starts a conversation herself in `context` now (for the level's gap). */
  noteStart(context: ContextKey): void {
    // The Arbiter books her starts itself.
    if (this.ctx.services.get(ArbiterKey)) return;
    if (context.kind === "dm" || context.kind === "voice") return;
    this.#starts.set(contextId(context), this.ctx.clock.now());
  }

  /** Publishes the decision not to open (or to drop) one of her intents. */
  intentSkipped(context: ContextKey, input: IntentTurn, why: string): void {
    this.log.debug(
      { context: contextId(context), capability: input.intent.capability, why },
      "intent skipped",
    );
    agentTurns.inc({ decision: "ignored" });
    this.ctx.publish(
      {
        type: "agent_decision",
        data: {
          turn: input.turn,
          context,
          respond: false,
          score: 0,
          reasons: [`intent:${input.intent.capability}`, `skipped: ${why}`],
        },
      },
      { turn: input.turn },
    );
  }

  // ---- v2: focus, outcomes, prompts, notices, subtitles --------------------------------------

  /**
   * The stable handle of `account` (`HandleDirectoryKey`; without one, the cleaned display
   * name).
   */
  handleOf(account: AccountRef, displayName: string): Handle {
    const dir = this.ctx.services.get(HandleDirectoryKey);
    if (dir) {
      try {
        return dir.ofAccount(account, displayName);
      } catch (error) {
        this.log.debug({ error: errorMessage(error) }, "handle directory failed");
      }
    }
    return safeName(displayName);
  }

  /** Publishes the one `agent.turn.outcome` of a turn. */
  publishOutcome(record: TurnOutcomeRecord): void {
    this.#barges.delete(record.turn);
    this.ctx.publish(v2Event(TURN_OUTCOME_TOPIC, record), { turn: record.turn });
  }

  /** Keeps (every `save_every`-th) saved prompt and publishes it as `agent.prompt`. */
  savePrompt(prompt: SavedPrompt): void {
    const every = this.config.prompt.save_every;
    if (every <= 0) return;
    this.#promptCount += 1;
    if ((this.#promptCount - 1) % every !== 0) return;
    this.prompts.push(prompt);
    this.ctx.publish(customEvent(PROMPT_TOPIC, prompt as unknown as JsonValue), {
      turn: prompt.turn,
    });
  }

  /** Who stopped her speech of `turn` by talking over her, if voice reported it. */
  bargedBy(turn: TurnId): Handle | null {
    return this.#barges.get(turn) ?? null;
  }

  #onBargeIn(payload: JsonValue): void {
    if (!isJsonObject(payload) || payload.action !== "stop") return;
    const turn = typeof payload.turn === "string" ? payload.turn : null;
    if (turn === null) return;
    const account = isJsonObject(payload.account) ? payload.account : null;
    let by: Handle | null = null;
    if (
      account !== null &&
      typeof account.platform === "string" &&
      typeof account.id === "string"
    ) {
      const ref = { platform: account.platform, id: account.id };
      const name =
        [...this.#contexts.values()]
          .flatMap((h) => h.session.voiceMembers())
          .find((m) => sameAccount(m.account, ref))?.display_name ?? ref.id;
      by = this.handleOf(ref, name);
    }
    this.#barges.set(turn, by);
    while (this.#barges.size > MAX_REMEMBERED) {
      const oldest = this.#barges.keys().next().value;
      if (oldest === undefined) break;
      this.#barges.delete(oldest);
    }
  }

  /**
   * A task outcome for her: kept until a turn in its context (or any, without one) shows it.
   * When nobody is talking with her there, a short turn of her own tells it (reason `notice`).
   */
  #onNotice(notice: Notice): void {
    if (Date.parse(notice.expires_at) <= this.ctx.clock.now()) return;
    const context = notice.context === null ? null : this.ownLinesContext(notice.context);
    const id = context === null ? "" : contextId(context);
    const list = this.#notices.get(id) ?? [];
    list.push({ ...notice, context });
    while (list.length > MAX_NOTICES) list.shift();
    this.#notices.set(id, list);
    // What the hands follow they report themselves, with the line that may be waiting for it.
    if (this.mainline?.hands.follows(notice.task)) return;
    if (context !== null) {
      this.#onInitiative(context, { reason: "notice", hint: "", about: [] });
    }
  }

  /** The unexpired notices for `context` (and those for anywhere); they count as told. */
  takeNotices(context: ContextKey): Notice[] {
    const now = this.ctx.clock.now();
    const out: Notice[] = [];
    for (const id of [contextId(context), ""]) {
      const list = this.#notices.get(id);
      if (!list) continue;
      this.#notices.delete(id);
      out.push(...list.filter((n) => Date.parse(n.expires_at) > now));
    }
    return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  /**
   * A line she spoke before writing it (`voice_first`) got its written sentence: her history
   * keeps the written one, and `agent.subtitle` tells the overlay.
   */
  noteSubtitle(context: ContextKey, turn: TurnId, spoken: string, written: string): void {
    const h = this.#existing(context);
    if (!h?.session.replaceSpoken(turn, spoken, written)) {
      let map = this.#subtitles.get(turn);
      if (!map) {
        map = new Map();
        this.#subtitles.set(turn, map);
        while (this.#subtitles.size > MAX_REMEMBERED) {
          const oldest = this.#subtitles.keys().next().value;
          if (oldest === undefined) break;
          this.#subtitles.delete(oldest);
        }
      }
      map.set(spoken.trim(), written);
    }
    this.ctx.publish(
      customEvent(SUBTITLE_TOPIC, {
        turn,
        context: { ...context },
        spoken,
        text: written,
      }),
      { turn },
    );
  }

  /** The written sentence of a spoken line, when it came before playback reported it. */
  #written(turn: TurnId | null, text: string): string {
    if (turn === null) return text;
    return this.#subtitles.get(turn)?.get(text.trim()) ?? text;
  }

  /** Her own talkativeness for `context` (`SelfState`), if she set one. */
  talkativeness(context: ContextKey): TalkLevel | null {
    const t = this.ctx.services.get(SelfStateKey)?.talkativeness(context) ?? null;
    return t === null ? null : { level: t.level, scope: t.scope };
  }

  #onUtterance(utterance: VoiceUtterance): void {
    if (
      utterance.text.trim() === "" ||
      this.isSelf(utterance.speaker.account) ||
      this.isBlocked(utterance.speaker.account)
    ) {
      return;
    }
    this.handle.setVoiceRoom(utterance.context, true);
    const msg = utteranceMessage(utterance);
    const ignored = msg.author.is_bot && !this.config.respond_to_bots;
    const verdict = this.#inspect(msg, "voice");
    if (verdict?.action === "ignore") return;
    const handle = this.#context(utterance.context);
    handle.session.recordUtterance(msg);
    this.#take(handle, msg, verdict, ignored);
  }

  /** Her own speech enters history once it starts playing. */
  #onPlayback(playback: EventData<"voice_playback">): void {
    const { context, turn, state, text, blocked = null } = playback;
    const heardMs = this.mainline?.lines.playback(context, turn, state, text, blocked) ?? 0;
    const h = this.#existing(context);
    if (!h) return;
    const name = this.persona.displayName();
    const me = this.selfAccount(context.platform);
    const now = this.ctx.clock.now();
    const written = this.#written(turn, text);
    switch (state) {
      case "started":
        h.session.recordSpeech(name, me, written, turn, now);
        break;
      case "interrupted":
        h.session.recordInterruption(name, me, written, turn, now);
        // History keeps what was really heard (§7.3), not what she meant to say.
        if (this.mainline)
          h.session.keepHeard(turn, written, this.#heard(written, playback, heardMs));
        break;
      case "finished":
        h.session.noteSelfSpoke(now);
        break;
      case "failed":
        if (this.mainline) h.session.keepHeard(turn, written, "");
        break;
    }
    if (turn !== null) h.inbox.push({ type: "playback", turn, state });
  }

  /**
   * What was heard of a line cut off: voice's measure of the audio, or how long ago it started
   * at the rate speech usually goes, from a publisher that does not say.
   */
  #heard(written: string, playback: EventData<"voice_playback">, sinceStart: number): string {
    const text = written.trim();
    const { heard_ms: ms = null, total_ms: total = null } = playback;
    if (ms !== null && total !== null) return heardShare(text, ms, total);
    return heardPart(text, ms ?? sinceStart, this.config.mainline.ms_per_char);
  }

  /**
   * An `agent.initiative` request (or a notice to tell). While the Arbiter runs it is an impulse
   * for the Arbiter (the one gate); without it the old checks apply here.
   */
  #onInitiative(context: ContextKey, initiative: Initiative): void {
    if (this.muted) {
      this.initiativeSkipped(context, initiative.reason, "the emergency stop");
      return;
    }
    const arbiter = this.ctx.services.get(ArbiterKey);
    if (arbiter) {
      const source = initiativeSource(initiative.reason);
      const now = this.ctx.clock.now();
      const impulse = newImpulse(
        {
          source,
          context,
          account: initiative.about.length === 1 ? (initiative.about[0] ?? null) : null,
          ttlMs: source === "followup" || source === "notice" ? RESULT_TTL_MS : INITIATIVE_TTL_MS,
          why: initiative.reason,
          hint: initiative.hint,
          about: initiative.about,
          reason: initiative.reason,
          coalesce_key: initiative.reason === "notice" ? `notice:${contextId(context)}` : null,
        },
        now,
      );
      void arbiter.submit(impulse).catch((error: unknown) => {
        this.log.warn({ error: errorMessage(error) }, "the arbiter failed on an initiative");
      });
      return;
    }
    this.#legacyInitiative(context, initiative);
  }

  /** The people who hear a line in `context` now. */
  audience(context: ContextKey): Handle[] {
    const members = this.#existing(context)?.session.voiceMembers() ?? [];
    return members.map((m) => this.handleOf(m.account, m.display_name));
  }

  /** A line that needed no turn was written in `context`. */
  noteOwnText(context: ContextKey, text: string, action: ActionId): void {
    const h = this.#existing(context);
    if (!h) return;
    const me = this.selfAccount(context.platform);
    h.session.recordOwn(this.persona.displayName(), me, text, action, this.ctx.clock.now());
    this.trackAction(action, h.session);
  }

  /** A claim of `kind` is coming in `context`: what speaks there gives way as far as it must. */
  yieldTo(context: ContextKey, kind: FloorClaimKind): void {
    const floor = this.mainline?.floor();
    const holder = floor?.holder(context) ?? null;
    if (!floor || holder === null) return;
    const level = floor.interruptLevel(kind, holder.kind);
    if (level === "queue") return;
    this.#existing(context)?.inbox.push({ type: "yield", level });
  }

  /** An `arbiter.impulse` while no Arbiter runs: a speak impulse is an initiative as before. */
  #onImpulseEvent(impulse: Impulse): void {
    if (this.ctx.services.get(ArbiterKey) || this.mainline) return;
    const context = impulse.target?.context ?? null;
    if (impulse.kind !== "speak" || context === null) return;
    if (Date.parse(impulse.expires_at) <= this.ctx.clock.now()) return;
    this.#legacyInitiative(context, {
      reason: impulseReason(impulse),
      hint: impulse.hint ?? "",
      about: [...(impulse.about ?? [])],
    });
  }

  /** Conversation facts for the Arbiter's floors (`ImpulseHost.facts`). */
  facts(context: ContextKey): ConversationFacts {
    const text = context.kind !== "voice" && context.kind !== "dm";
    const mode = text ? this.handle.channelMode(context) : null;
    return {
      mode,
      start_gap_ms: mode === null ? 0 : (ceilingFor(mode, context)?.startGapMs ?? 0),
      present: context.kind !== "voice" || this.inVoice(context),
      last_spoke_at: this.#existing(context)?.session.lastSelfAt() ?? null,
      humans:
        context.kind === "voice" && this.inVoice(context)
          ? (this.#existing(context)?.session.listeners().length ?? 0)
          : null,
    };
  }

  /**
   * Opens a turn of hers for an impulse the Arbiter accepted (not one of her own intents):
   * resolves once the context's coordinator started it or found the place busy.
   */
  openInitiative(target: ContextKey, initiative: Initiative): Promise<ImpulseRun> {
    if (this.muted) {
      return Promise.resolve({ status: "refused", reason: "denied", detail: "緊急停止中" });
    }
    // A result someone asked for is told where they asked: only her own news follows her to voice.
    const asked = initiative.chain?.requester !== undefined && initiative.chain.requester !== null;
    const context =
      aboutHerself(initiative.reason) && !asked ? this.ownLinesContext(target) : target;
    if (context.kind === "voice" && !this.inVoice(context)) {
      return Promise.resolve({ status: "refused", reason: "denied", detail: "不在那個語音頻道" });
    }
    return new Promise<ImpulseRun>((resolve) => {
      let settled = false;
      const reply = (run: ImpulseRun): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(run);
      };
      const timer = setTimeout(
        () => reply({ status: "busy", detail: "the context did not answer" }),
        OPEN_TIMEOUT_MS,
      );
      const pushed = this.#context(context).inbox.push({ type: "initiative", initiative, reply });
      if (!pushed) reply({ status: "busy", detail: "the context is closing" });
    });
  }

  #legacyInitiative(context: ContextKey, initiative: Initiative): void {
    // Without the Floor nothing unasked gets the mic: the main line has no rules of its own.
    if (this.mainline) {
      this.initiativeSkipped(context, initiative.reason, "no floor");
      return;
    }
    const mode = this.handle.channelMode(context);
    if (mode === "off" || mode === "mention-only") {
      this.initiativeSkipped(context, initiative.reason, `mode ${mode}`);
      return;
    }
    // The level's gap between her own starts (not for game commentary or action results).
    const gap = UNCAPPED_INITIATIVES.includes(initiative.reason)
      ? null
      : this.startBlocked(context);
    if (gap !== null) {
      this.initiativeSkipped(context, initiative.reason, gap);
      return;
    }
    const budget = this.handle.llmBudget();
    if (budget !== "ok") {
      this.initiativeSkipped(context, initiative.reason, `llm budget ${budget}`);
      return;
    }
    if (context.kind === "voice") {
      // Only where she is: a stray request must not create a session.
      const delivered =
        this.#existing(context)?.inbox.push({ type: "initiative", initiative }) ?? false;
      if (!delivered) {
        this.initiativeSkipped(context, initiative.reason, "not in this voice channel");
      }
      return;
    }
    this.#context(context).inbox.push({ type: "initiative", initiative });
  }

  /** Publishes the decision not to act on an initiative request. */
  initiativeSkipped(context: ContextKey, reason: string, why: string): void {
    this.log.debug({ context: contextId(context), reason, why }, "initiative skipped");
    const turn = newId();
    agentTurns.inc({ decision: "ignored" });
    this.ctx.publish(
      {
        type: "agent_decision",
        data: {
          turn,
          context,
          respond: false,
          score: 0,
          reasons: [`initiative:${reason}`, `skipped: ${why}`],
        },
      },
      { turn },
    );
  }

  #onBudget(payload: JsonValue): void {
    const raw = isJsonObject(payload) ? payload.state : undefined;
    if (typeof raw !== "string") {
      this.log.warn({ payload }, "llm.budget event without a state");
      return;
    }
    let state: ReturnType<typeof parseBudgetState>;
    try {
      state = parseBudgetState(raw);
    } catch (error) {
      this.log.warn({ error: errorMessage(error) }, "ignoring llm.budget event");
      return;
    }
    const before = this.handle.setLlmBudget(state);
    if (before !== state) this.log.info({ before, state }, "llm budget state changed");
    if (state !== "exhausted") this.#budgetNotices.clear();
  }

  /**
   * Whether she may say she is out of energy in `context` now; records it if so (at most once
   * per `budget_notice_interval_ms`).
   */
  takeBudgetNotice(context: ContextKey): boolean {
    const now = this.ctx.clock.now();
    const id = contextId(context);
    const last = this.#budgetNotices.get(id);
    if (last !== undefined && Math.max(now - last, 0) < this.config.budget_notice_interval_ms) {
      return false;
    }
    this.#budgetNotices.set(id, now);
    return true;
  }

  social(): SocialSignals | undefined {
    return this.ctx.services.get(SocialSignalsKey);
  }

  attitude(account: AccountRef): Attitude | null {
    return this.social()?.attitude(account) ?? null;
  }

  mood(): Mood | null {
    return this.ctx.services.get(MoodSignalsKey)?.mood() ?? null;
  }

  /** She ignores this person entirely (social module decision). */
  isBlocked(account: AccountRef): boolean {
    return this.attitude(account)?.blocked ?? false;
  }

  /**
   * Without the Arbiter: how long after she spoke an initiative waits in `context` (the
   * Arbiter's `after_speech_*_secs` defaults).
   */
  afterSpeechMs(context: ContextKey): number {
    return context.kind === "voice" ? LEGACY_AFTER_SPEECH_VOICE_MS : LEGACY_AFTER_SPEECH_TEXT_MS;
  }

  isSelf(account: AccountRef): boolean {
    return this.#selfAccounts.has(accountId(account));
  }

  /** One of her accounts on `platform`, used to attribute her replies. */
  selfAccount(platform: PlatformId): AccountRef {
    const ids = [...this.#selfAccounts.values()]
      .filter((a) => a.platform === platform)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return ids[0] ?? { platform, id: "self" };
  }

  trackAction(action: ActionId, session: Session): void {
    this.#pendingActions.set(action, session);
  }

  untrackAction(action: ActionId): void {
    this.#pendingActions.delete(action);
  }

  /** Removes an idle context unless input is waiting for it. */
  retire(key: ContextKey, inbox: Inbox): boolean {
    if (!inbox.isEmpty) return false;
    const id = contextId(key);
    if (this.#contexts.get(id)?.inbox === inbox) this.#contexts.delete(id);
    inbox.close();
    return true;
  }

  #isVoice(context: ContextKey): boolean {
    if (context.kind === "voice") return true;
    this.log.debug({ context: contextId(context) }, "ignoring voice event for a non-voice context");
    return false;
  }
}

/** `react` with its own limit per channel (`Rhythm.takeReaction`): she hears why when it is spent. */
class LimitedReact implements Tool {
  readonly spec;
  readonly permission;

  constructor(
    readonly inner: Tool,
    readonly rhythm: Rhythm,
  ) {
    this.spec = inner.spec;
    this.permission = inner.permission ?? null;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const why = this.rhythm.takeReaction(ctx.context);
    if (why !== null) throw new Error(why);
    return await this.inner.call(ctx, args);
  }
}

/** What stands in her history for a message someone asked her not to remember. */
export const EXCLUDED_LINE = "[這則訊息有人請你不要記住]";

/** Excluded message ids remembered per context (older ones live on in memory's own list). */
const MAX_EXCLUDED = 500;

/** The entry keeps its place (the cached prefix moves once) but says nothing of what it said. */
function hideEntry(entry: HistoryEntry): void {
  entry.text = EXCLUDED_LINE;
  entry.attachments = [];
  entry.flagged = null;
  entry.parents = [];
}

/** A history entry as turn input again (the "要她回這則" menu): it calls her now. */
function entryMessage(context: ContextKey, entry: HistoryEntry): IncomingMessage {
  return {
    id: { context, id: entry.id ?? "" },
    author: { account: entry.account, display_name: entry.author, is_bot: entry.isBot },
    text: entry.text,
    mentions_self: true,
    reply_to_self: false,
    attachments: [...entry.attachments],
    ts: toTimestamp(entry.ts),
    reply_to: entry.replyTo === null ? null : { context, id: entry.replyTo },
  };
}

/** A voice utterance as turn input. Its `MessageRef` names the utterance, not a message. */
function utteranceMessage(u: VoiceUtterance): IncomingMessage {
  return {
    id: { context: u.context, id: u.id },
    author: u.speaker,
    text: u.text.trim(),
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: u.ended_at,
    ...(u.turn?.ended_by === "turn" ? { turn_complete: true } : {}),
  };
}
