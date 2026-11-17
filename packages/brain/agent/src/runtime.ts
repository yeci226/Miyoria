// The agent's event loop: hands every line of a conversation to the text runner (Core installs
// `@miyoria/brain/selfhost`), after the checks every line goes through (her own accounts, blocked
// people, the input defence), and keeps what the runner and the other modules ask of it: who is in
// each voice channel she is in, the focus of every turn in flight (`TurnFocusBoard`, provided as
// `TurnFocusViewKey`), turn outcomes (`agent.turn.outcome`) and notices waiting to be told.
//
// It also keeps her rhythm in text channels (`Rhythm`, levels.ts: reactions, pacing) and provides
// `MessageActionsKey` for the context menus: "要她回這則" asks the text runner for a run on that
// message, "不要記住這個" tells the rest of her (`agent.message.excluded`).

import type { Tool, ToolContext, ToolRegistry } from "@miyoria/llm/tools";
import {
  errorMessage,
  type Logger,
  type ModuleContext,
  type Subscription,
} from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  ActuatorExecutorKey,
  ArbiterKey,
  type Attitude,
  type ContextKey,
  type ConversationFacts,
  type Envelope,
  type EventPayload,
  Events,
  type FloorClaimKind,
  type Handle,
  HandleDirectoryKey,
  type ImpulseSource,
  type IncomingMessage,
  type InputVerdict,
  type InterruptLevel,
  incomingText,
  inspectInput,
  is,
  isJsonObject,
  type JsonValue,
  type MessageActionOutcome,
  type MessageActionRequest,
  type MessageActions,
  MessageActionsKey,
  type MessageExcluded,
  type MessageRef,
  type Mood,
  MoodSignalsKey,
  type Notice,
  newId,
  newImpulse,
  type PlatformId,
  type SocialSignals,
  SocialSignalsKey,
  safeName,
  sameAccount,
  type TurnId,
  type TurnOutcomeRecord,
  type VoiceParticipant,
  type VoiceUtterance,
} from "@miyoria/types";
import type { AgentCommands } from "./commands.js";
import { SavedPrompts } from "./compiler.js";
import type { AgentConfig } from "./config.js";
import { TurnFocusBoard } from "./focus.js";
import type { AgentHandle } from "./handle.js";
import { ceilingFor, Rhythm, RhythmSectionSchema } from "./levels.js";
import { heardPart, heardShare, MainLine } from "./mainline/main.js";
import { agentTurns } from "./metrics.js";
import type { PersonaHandle } from "./persona.js";
import { parseBudgetState } from "./signals.js";
import { ReactTool } from "./tools.js";
import { accountId, contextId } from "./util.js";
import { type FetchLike, ImageLoader } from "./vision.js";

/** Module whose restart means the agent commands must be registered again. */
const COMMANDS_MODULE = "commands";
const MINUTE_MS = 60_000;
/** Notices kept per context while nobody reads them. */
const MAX_NOTICES = 10;
/** Barge-ins remembered (by turn). */
const MAX_REMEMBERED = 64;

/** An `agent.initiative` request (or a notice to tell). */
export interface Initiative {
  reason: string;
  hint: string;
  about: AccountRef[];
}

/**
 * The Arbiter's source for an `agent.initiative` reason (publishers that were not converted to
 * impulses yet, extensions): game commentary, a song, a notice, else a reaction to
 * the world. None of them is her own initiative.
 */
export function initiativeSource(reason: string): ImpulseSource {
  if (reason === "game") return "game";
  if (reason === "notice") return "notice";
  if (reason.startsWith("song_")) return "song";
  return "world";
}

/** How long a converted `agent.initiative` stays worth saying while the place is busy. */
const INITIATIVE_TTL_MS = 2 * MINUTE_MS;
/** Results someone waits for stay longer (the old follow-up retry window). */
const RESULT_TTL_MS = 10 * MINUTE_MS;

/** What the agent knows of a text line it hands to a `TextRunner`. */
export interface TextLineMarks {
  /** Her own line (the platform's echo of what she sent). */
  own: boolean;
  /** A bot's line she does not answer (`respond_to_bots` off). */
  bot: boolean;
  /** What the input defence said of it (an `ignore` verdict never reaches the runner). */
  verdict: InputVerdict | null;
  /** The emergency stop is on: she keeps what she hears and answers nothing. */
  muted: boolean;
}

/** Where the conversations go (`@miyoria/brain/selfhost`): text, and voice when it has `voice`. */
export interface TextRunner {
  /** A line of a channel, thread or DM, after the agent's own checks (blocked users, `ignore`). */
  line(msg: IncomingMessage, marks: TextLineMarks): void;
  /** Someone types in a text place. */
  typing(context: ContextKey): void;
  /** The emergency stop: what runs ends, what waits is dropped. */
  halt(): void;
  stop(): void;
  /**
   * "要她回這則" on a line of a place it runs: a run on that line as if it had called her. Unset:
   * the menu does not reach its places.
   */
  replyTo?(message: MessageRef): TextReplyOutcome;
  /** Whether one of its runs started `task` and is woken by its end. Unset: none. */
  follows?(task: string | null): boolean;
  /**
   * The voice conversations. The agent still keeps who is in each voice channel she is in and
   * hands over what is said in it.
   */
  voice?: VoiceRunner;
}

/** What the agent hands a text runner that runs voice conversations (`TextRunner.voice`). */
export interface VoiceRunner {
  /** An utterance (`spoken`), or a line typed in the voice channel's chat, after the agent's checks. */
  line(msg: IncomingMessage, marks: TextLineMarks, spoken: boolean): void;
  /** Who is in the voice channel `context` now, her not included. */
  members(context: ContextKey, members: readonly VoiceParticipant[]): void;
  /** Someone started or stopped speaking there. */
  speaking(context: ContextKey, account: AccountRef, speaking: boolean): void;
  /** A sentence of hers started, ended, was cut off or failed; `heard`: what of one cut off was heard. */
  playback(playback: EventPayload<typeof Events.VoicePlaybackEvent>, heard: string | null): void;
  /** A claim cuts into her speech in `context`, this hard (§7.3). */
  yieldTo(context: ContextKey, level: InterruptLevel): void;
  /** She left the voice channel `context`. */
  left(context: ContextKey): void;
}

/** How a text runner took a "要她回這則" (`ok`: a run is on its way). */
export type TextReplyOutcome = "ok" | "unseen" | "own" | "blocked" | "off" | "failed";

/** What the menu says when "要她回這則" cannot be done. */
const REPLY_REFUSALS: Readonly<Record<Exclude<TextReplyOutcome, "ok">, string>> = {
  unseen: "她現在看不到這則訊息。",
  own: "這是她自己說的話。",
  blocked: "這個功能現在不能用。",
  off: "她在這個頻道不說話。",
  failed: "沒有成功,請稍後再試。",
};

/** Makes the text runner of an agent (Core passes one). */
export type TextRunnerFactory = (agent: Agent) => TextRunner;

/** A voice channel she is in: who is there, and when she was last heard there. */
interface VoiceRoom {
  context: ContextKey;
  /** Everyone there but her. */
  members: VoiceParticipant[];
  lastSelfAt: number | null;
}

/** State shared by the event loop, the text runner and the main line. */
export class Agent {
  readonly #selfAccounts = new Map<string, AccountRef>();
  /** The voice channels she is in, by context id. */
  readonly #rooms = new Map<string, VoiceRoom>();
  /** Downloads the images she looks at (cached by attachment id). */
  readonly images: ImageLoader;
  /** The focus of every turn in flight (`TurnFocusViewKey`). */
  readonly focusBoard: TurnFocusBoard;
  /** Compressed prompts of recent turns (`SavedPromptsKey`). */
  readonly prompts: SavedPrompts;
  /** Notices not shown to her yet, by context id (`""`: wherever she talks next). */
  readonly #notices = new Map<string, Notice[]>();
  /** Who barged in on her speech, by turn (`voice.barge_in` with `stop`). */
  readonly #barges = new Map<TurnId, Handle | null>();
  /** The mouth and what it keeps. */
  readonly mainline: MainLine;
  /** Her rhythm in text channels: reactions, pacing (`[modules.agent.rhythm]`). */
  readonly rhythm: Rhythm;
  /** Messages people asked her not to remember, by context id (bounded). */
  readonly #excluded = new Map<string, Set<string>>();
  /** The conversations' runner; `null`: none installed, nothing answers. Set before `run`. */
  textRunner: TextRunner | null = null;
  /** The context menus' requests (`MessageActionsKey`). */
  readonly messageActions: MessageActions = {
    replyTo: (request) => Promise.resolve(this.#replyTo(request)),
    dontRemember: (request) => Promise.resolve(this.#dontRemember(request)),
  };

  constructor(
    readonly ctx: ModuleContext,
    readonly config: AgentConfig,
    readonly persona: PersonaHandle,
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
      (focus) => ctx.publish(Events.AgentTurnFocus, focus, { turn: focus.turn }),
    );
    this.prompts = new SavedPrompts(config.prompt.saved);
    this.mainline = new MainLine(this);
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
    const floor = this.mainline.floor();
    for (const room of this.#rooms.values()) floor?.releaseContext(room.context, why);
    this.textRunner?.halt();
  }

  static topics(): string[] {
    return [
      Events.ActionSettled.type,
      Events.PlatformReady.type,
      Events.PlatformMessageCreated.type,
      Events.PlatformTyping.type,
      "voice.*",
      Events.SystemModuleState.type,
      Events.AgentInitiative.type,
      Events.AgentNotice.type,
      Events.LlmBudget.type,
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
    if (is(Events.PlatformReady, env)) {
      const account = env.data.self_account;
      this.log.debug({ platform: account.platform, id: account.id }, "self account ready");
      this.#selfAccounts.set(accountId(account), account);
    } else if (is(Events.PlatformMessageCreated, env)) {
      this.#onMessage(env.data);
    } else if (is(Events.PlatformTyping, env)) {
      const { context, account } = env.data;
      if (!this.isSelf(account) && context.kind !== "voice") this.textRunner?.typing(context);
    } else if (is(Events.VoiceJoined, env) || is(Events.VoiceParticipants, env)) {
      if (this.#isVoice(env.data.context)) {
        this.#onVoiceMembers(env.data.context, env.data.participants);
      }
    } else if (is(Events.VoiceLeft, env)) {
      const { context, reason } = env.data;
      if (!this.#isVoice(context)) return;
      this.log.debug({ context: contextId(context), reason }, "left voice");
      this.handle.setVoiceRoom(context, false);
      this.mainline.lines.dropContext(context, "she left the voice channel");
      this.mainline.floor()?.releaseContext(context, "she left the voice channel");
      this.#rooms.delete(contextId(context));
      this.textRunner?.voice?.left(context);
    } else if (is(Events.VoiceSpeaking, env)) {
      const { context, account, speaking } = env.data;
      if (!this.#isVoice(context) || this.isSelf(account)) return;
      this.textRunner?.voice?.speaking(context, account, speaking);
    } else if (is(Events.VoiceUtteranceEvent, env)) {
      if (this.#isVoice(env.data.context)) this.#onUtterance(env.data);
    } else if (is(Events.VoicePlaybackEvent, env)) {
      if (this.#isVoice(env.data.context)) this.#onPlayback(env.data);
    } else if (is(Events.SystemModuleState, env)) {
      if (env.data.state === "running" && env.data.module === COMMANDS_MODULE) {
        this.commands.install(this.ctx.services, this.handle, this.persona);
      }
    } else if (is(Events.AgentInitiative, env)) {
      const { context, reason, hint, about } = env.data;
      this.#onInitiative(context, { reason, hint, about: [...about] });
    } else {
      // Every other topic it follows.
      const payload = env.data as JsonValue;
      if (this.mainline.custom(env.type, payload)) return;
      if (env.type === Events.LlmBudget.type) this.#onBudget(payload);
      else if (env.type === Events.VoiceBargeIn.type) this.#onBargeIn(payload);
      else if (is(Events.AgentNotice, env) && isJsonObject(payload)) this.#onNotice(env.data);
    }
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
    const own = this.isSelf(msg.author.account);
    const verdict = own ? null : this.#inspect(msg, "chat");
    if (verdict?.action === "ignore") return;
    const marks: TextLineMarks = {
      own,
      bot: msg.author.is_bot && !this.config.respond_to_bots,
      verdict,
      muted: this.muted,
    };
    if (msg.id.context.kind === "voice") {
      this.textRunner?.voice?.line(msg, marks, false);
      return;
    }
    this.textRunner?.line(msg, marks);
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
    const members = this.#rooms.get(contextId(room))?.members ?? [];
    if (members.length > 0 && listeners(members).length === 0) return null;
    return room;
  }

  // ---- the context menus (`MessageActionsKey`) ------------------------------------------------

  /**
   * "要她回這則": a run on that message as if it had called her (the text runner's). The channel's
   * mode still holds, and so do the owner's rules, her budget and the Floor. A line of a voice
   * channel's chat is the voice conversation's, which the menu does not reach.
   */
  #replyTo(request: MessageActionRequest): MessageActionOutcome {
    if (this.muted) return { ok: false, reason: "她現在暫停中。" };
    if (this.isBlocked(request.requested_by)) return { ok: false, reason: REPLY_REFUSALS.blocked };
    const ref = request.message;
    const runner = this.textRunner;
    if (runner?.replyTo === undefined || this.#roomOf(ref.context) !== null) {
      return { ok: false, reason: REPLY_REFUSALS.unseen };
    }
    if (this.#isExcluded(ref.context, ref.id)) {
      return { ok: false, reason: "這則訊息已經請她不要記住了。" };
    }
    const taken = runner.replyTo(ref);
    return taken === "ok" ? { ok: true } : { ok: false, reason: REPLY_REFUSALS[taken] };
  }

  /**
   * "不要記住這個": it is remembered as excluded here (the menu cannot ask for a run on it any
   * more) and `agent.message.excluded` tells the rest of her (the text runner redacts it from its
   * transcript, the facts module its events).
   */
  #dontRemember(request: MessageActionRequest): MessageActionOutcome {
    const context = this.#roomOf(request.message.context) ?? request.message.context;
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
    const body: MessageExcluded = {
      context,
      message: { context, id },
      author: request.author ?? null,
      requested_by: request.requested_by,
      at: new Date(this.ctx.clock.now()).toISOString(),
    };
    this.ctx.publish(Events.AgentMessageExcluded, body);
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
    this.#room(context).members = others;
    this.textRunner?.voice?.members(context, others);
  }

  /** The voice channel `context` she is in, kept from now on. */
  #room(context: ContextKey): VoiceRoom {
    const id = contextId(context);
    let room = this.#rooms.get(id);
    if (room === undefined) {
      room = { context, members: [], lastSelfAt: null };
      this.#rooms.set(id, room);
    }
    return room;
  }

  /** She is in the voice channel `context`. */
  inVoice(context: ContextKey): boolean {
    return context.kind === "voice" && this.#rooms.has(contextId(context));
  }

  // ---- focus, outcomes, notices ---------------------------------------------------------------

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
    this.ctx.publish(Events.AgentTurnOutcome, record, { turn: record.turn });
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
      const members = [...this.#rooms.values()].flatMap((r) => r.members);
      const name = members.find((m) => sameAccount(m.account, ref))?.display_name ?? ref.id;
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
   * A task outcome for her: kept until a run in its context (or any, without one) shows it. When
   * it names a place, a run of hers there may tell it (an impulse of source `notice`).
   */
  #onNotice(notice: Notice): void {
    if (Date.parse(notice.expires_at) <= this.ctx.clock.now()) return;
    // A run that started the task hears its end as a result already.
    if (this.textRunner?.follows?.(notice.task) === true) return;
    const context = notice.context === null ? null : this.ownLinesContext(notice.context);
    const id = context === null ? "" : contextId(context);
    const list = this.#notices.get(id) ?? [];
    list.push({ ...notice, context });
    while (list.length > MAX_NOTICES) list.shift();
    this.#notices.set(id, list);
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

  #onUtterance(utterance: VoiceUtterance): void {
    if (
      utterance.text.trim() === "" ||
      this.isSelf(utterance.speaker.account) ||
      this.isBlocked(utterance.speaker.account)
    ) {
      return;
    }
    this.handle.setVoiceRoom(utterance.context, true);
    this.#room(utterance.context);
    const msg = utteranceMessage(utterance);
    const verdict = this.#inspect(msg, "voice");
    if (verdict?.action === "ignore") return;
    this.textRunner?.voice?.line(
      msg,
      {
        own: false,
        bot: msg.author.is_bot && !this.config.respond_to_bots,
        verdict,
        muted: this.muted,
      },
      true,
    );
  }

  /** Her own speech: the line book closes its lines; the runner keeps what was heard. */
  #onPlayback(playback: EventPayload<typeof Events.VoicePlaybackEvent>): void {
    const { context, turn, state, text, blocked = null } = playback;
    const heardMs = this.mainline.lines.playback(context, turn, state, text, blocked) ?? 0;
    this.textRunner?.voice?.playback(
      playback,
      state === "interrupted" ? this.#heard(text, playback, heardMs) : null,
    );
    const room = this.#rooms.get(contextId(context));
    if (room !== undefined && state !== "failed") room.lastSelfAt = this.ctx.clock.now();
  }

  /**
   * What was heard of a line cut off: voice's measure of the audio, or how long ago it started
   * at the rate speech usually goes, from a publisher that does not say.
   */
  #heard(
    written: string,
    playback: EventPayload<typeof Events.VoicePlaybackEvent>,
    sinceStart: number,
  ): string {
    const text = written.trim();
    const { heard_ms: ms = null, total_ms: total = null } = playback;
    if (ms !== null && total !== null) return heardShare(text, ms, total);
    return heardPart(text, ms ?? sinceStart, this.config.mainline.ms_per_char);
  }

  /**
   * An `agent.initiative` request (or a notice to tell): an impulse for the Arbiter, the one
   * gate. What it admits is run by the text runner (`ImpulseHostKey`).
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
          ttlMs: source === "notice" ? RESULT_TTL_MS : INITIATIVE_TTL_MS,
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
    // Nothing unasked gets the mic without the Arbiter. Only before it has started: the module
    // is required, but the agent starts first.
    this.initiativeSkipped(context, initiative.reason, "the arbiter is not running");
  }

  /** The people who hear a line in `context` now. */
  audience(context: ContextKey): Handle[] {
    const members = this.#rooms.get(contextId(context))?.members ?? [];
    return members.map((m) => this.handleOf(m.account, m.display_name));
  }

  /** A claim of `kind` is coming in `context`: what speaks there gives way as far as it must. */
  yieldTo(context: ContextKey, kind: FloorClaimKind): void {
    const floor = this.mainline.floor();
    const holder = floor?.holder(context) ?? null;
    if (!floor || holder === null) return;
    const level = floor.interruptLevel(kind, holder.kind);
    if (level === "queue") return;
    this.textRunner?.voice?.yieldTo(context, level);
  }

  /** Conversation facts for the Arbiter's floors (`ImpulseHost.facts`). */
  facts(context: ContextKey): ConversationFacts {
    const text = context.kind !== "voice" && context.kind !== "dm";
    const mode = text ? this.handle.channelMode(context) : null;
    const room = context.kind === "voice" ? this.#rooms.get(contextId(context)) : undefined;
    return {
      mode,
      start_gap_ms: mode === null ? 0 : (ceilingFor(mode, context)?.startGapMs ?? 0),
      present: context.kind !== "voice" || room !== undefined,
      last_spoke_at: room?.lastSelfAt ?? null,
      humans: room === undefined ? null : listeners(room.members).length,
    };
  }

  /** Publishes the decision not to act on an initiative request. */
  initiativeSkipped(context: ContextKey, reason: string, why: string): void {
    this.log.debug({ context: contextId(context), reason, why }, "initiative skipped");
    const turn = newId();
    agentTurns.inc({ decision: "ignored" });
    this.ctx.publish(
      Events.AgentDecision,
      {
        turn,
        context,
        respond: false,
        score: 0,
        reasons: [`initiative:${reason}`, `skipped: ${why}`],
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

  #isVoice(context: ContextKey): boolean {
    if (context.kind === "voice") return true;
    this.log.debug({ context: contextId(context) }, "ignoring voice event for a non-voice context");
    return false;
  }
}

/** Those in a voice channel who can hear her. */
function listeners(members: readonly VoiceParticipant[]): VoiceParticipant[] {
  return members.filter((m) => !m.deafened);
}

/** `react` with its own limit per channel (`Rhythm.takeReaction`): she hears why when it is spent. */
class LimitedReact implements Tool {
  readonly spec;
  readonly meta;
  readonly parameters;
  readonly permission;

  constructor(
    readonly inner: Tool,
    readonly rhythm: Rhythm,
  ) {
    this.spec = inner.spec;
    this.meta = inner.meta;
    this.parameters = inner.parameters;
    this.permission = inner.permission ?? null;
  }

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    const why = this.rhythm.takeReaction(ctx.context);
    if (why !== null) throw new Error(why);
    return await this.inner.call(ctx, args);
  }
}

/** Excluded message ids remembered per context (the event log redacts the message itself). */
const MAX_EXCLUDED = 500;

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
