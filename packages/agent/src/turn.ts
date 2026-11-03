// One turn: attention decision, prompt assembly (contributor sections and everything else
// derived from other people go into the user-role data message, see prompt.ts), generation
// (with the tool loop; tool calls run for the speaker as principal `user`) and output, filtered
// by `filterOutgoing`. Text replies think first and are sent once complete; voice replies do
// not think and are spoken sentence by sentence while the model is still generating (links and
// code blocks go to the voice channel's text chat instead of being read out).
//
// Before generating, a turn waits (bounded) for a cold session's backfill, fetches reply
// parents missing from the history and picks the images she looks at (history.ts, vision.ts).
//
// An initiative turn has no input and skips attention (the coordinator already checked the
// context is quiet). An intent turn (her mind loop decided to act or talk) has no input either,
// skips attention and offers tools, which run as principal `self` (tools that need a person's
// permission node are refused); her plan goes into the data message. While the LLM budget is exhausted nothing is generated: a turn she would
// have answered gets a canned line at most once per context per `budget_notice_interval_ms`.

import { errorMessage, sleep } from "@miyoria/kernel";
import {
  assistantMessage,
  type ChatMessage,
  type ChatRequest,
  type ContentPart,
  contextSession,
  type LlmRouter,
  LlmRouterKey,
  type StreamEvent,
  type ToolCall,
  type ToolSpec,
  toolResultMessage,
  userMessage,
  withLlmTag,
} from "@miyoria/llm";
import type { Tool, ToolContext } from "@miyoria/tools";
import {
  type AccountRef,
  type ActionSink,
  ActionSinkKey,
  AuthorizerKey,
  type ContextKey,
  ConversationStatesKey,
  contextKeyString as contextKeyDisplay,
  filterOutgoing,
  type IncomingMessage,
  type JsonValue,
  type LaneKey,
  LessonsKey,
  MindKey,
  newAction,
  type Participant,
  PlatformSinksKey,
  Principals,
  type Priority,
  PromptContributorsKey,
  type PromptRequest,
  SelfStateKey,
  type SocialSignals,
  safeName,
  sameAccount,
  type TurnId,
  textLane,
  timestampMs,
  toTimestamp,
  VoiceSinkKey,
  voiceLane,
  WorldStateKey,
} from "@miyoria/types";
import { assess, decide as sample, type TalkLevel, type VoiceAttention } from "./attention.js";
import type { AttentionConfig, ChannelMode } from "./config.js";
import { AMBIENT_MODES, typingRefreshMs } from "./config.js";
import { gather } from "./contributors.js";
import type { TurnFlags } from "./coordinator.js";
import { Expression, ExpressionParser, type Segment } from "./expression.js";
import { voiceScope } from "./handle.js";
import { awaitBackfill, replyParents } from "./history.js";
import { ceilingFor, levelHint } from "./levels.js";
import { linkMentions, type MentionTarget } from "./mentions.js";
import { agentTurns } from "./metrics.js";
import {
  afterFold,
  buildMessages,
  checkMessages,
  cleanReply,
  renderSections,
  type SituationData,
  situationData,
  situationPrompt,
  splitMessage,
  transcriptLine,
} from "./prompt.js";

import type { Agent, Initiative, IntentTurn } from "./runtime.js";
import { type HistoryEntry, messageText, type Session } from "./session.js";
import {
  attitudeHint,
  type BudgetState,
  EXHAUSTED_LINE,
  herStatusHint,
  moodHint,
  shownHint,
  unansweredHint,
} from "./signals.js";
import {
  type FencedPiece,
  FenceSplitter,
  isSpeakable,
  LinkSplitter,
  SentenceSplitter,
} from "./speech.js";
import { ReactTool } from "./tools.js";
import { contextId, fixed, guard, TimeoutError, timeout } from "./util.js";
import { imageParts, selectImages } from "./vision.js";

const TYPING_TTL_MS = 10_000;
/** History lines shown to the `fast` model. */
const CHECK_HISTORY = 12;
/** History lines before the input sent to prompt contributors. */
const CONTRIBUTOR_HISTORY = 6;
/** People in the prompt request (text contexts) and with attitude hints. */
const MAX_PEOPLE = 10;
const MAX_ATTITUDE_HINTS = 5;

/**
 * Things she may say she has done that only happen through a tool, by tool name. A reply that
 * says one of these without the tool call gets one reminder (see `#produce`).
 */
const CLAIMS: readonly (readonly [string, RegExp])[] = [
  ["voice_join", /游過去|游去了|進語音了|進去語音|加入語音了|過去語音/],
  ["voice_leave", /離開語音了|退出語音了|游走了|先下語音/],
  ["stream_start", /開台了|開播了|開始直播了/],
  ["stream_stop", /關台了|下播了|結束直播了/],
  ["game_start", /開遊戲了|開始玩了|開好遊戲/],
];

function claimReminder(tool: string): string {
  return `(系統提醒,不是對方說的話)你剛才說的事要呼叫 ${tool} 才會真的發生,但這一回合還沒呼叫。要做就現在呼叫它;決定不做或做不到,就照實跟對方說。`;
}

export class TurnError extends Error {
  override readonly name = "TurnError";
}

/**
 * Runs one turn and publishes `agent.turn.completed`. When `signal` aborts (the coordinator
 * cancelled the turn) it stops without publishing anything more.
 */
export async function runTurn(
  agent: Agent,
  key: ContextKey,
  session: Session,
  turn: TurnId,
  inputs: readonly IncomingMessage[],
  initiative: Initiative | null,
  flags: TurnFlags,
  signal: AbortSignal,
  intent: IntentTurn | null = null,
): Promise<void> {
  const t = new Turn(agent, key, session, turn, inputs, initiative, flags, signal, intent);
  let text: string;
  try {
    text = await t.respond();
  } catch (error) {
    if (signal.aborted) return;
    agent.log.warn({ turn, context: contextId(key), error: errorMessage(error) }, "turn failed");
    text = "";
  }
  if (signal.aborted) return;
  agent.ctx.publish({ type: "agent_turn_completed", data: { turn, context: key, text } }, { turn });
}

/** What attention concluded (not yet published). */
interface Decision {
  respond: boolean;
  direct: boolean;
  score: number;
  reasons: string[];
}

/** Per-turn additions to the prompt. */
interface Extras {
  /** Her own state (mood): the situation (system) message. */
  notes: string[];
  /** Her attitude towards the people of the turn (names them): the data message. */
  people: string[];
  /** Rendered contributor sections (data blocks): the data message. */
  sections: string | null;
  /** For the decision trace. */
  reasons: string[];
}

/** One model response of the generation loop. */
interface Step {
  expression: Expression;
  /** Raw text as the model wrote it (tags included). */
  raw: string;
  calls: ToolCall[];
}

interface CheckReply {
  respond: boolean;
  reason: string;
}

/** Written sentences a bilingual reply may hold before their `<voice>` line is given up on. */
const MAX_UNVOICED = 2;

/**
 * Streams a voice reply: every completed sentence is submitted as a `speak` action right away,
 * so the first one plays while the rest is generated.
 */
class Speech {
  readonly #splitter = new SentenceSplitter();
  /** Code blocks and links are never read out. */
  readonly #fences = new FenceSplitter();
  readonly #links = new LinkSplitter();
  /** Latest `<emo:...>`; sent with each sentence. */
  #emotion: string | null = null;
  /** Everything submitted so far. */
  spoken = "";
  /** Links and code blocks she wrote, for the text chat instead of speech. */
  readonly aside: string[] = [];
  /**
   * Bilingual replies (`bilingual`): each written sentence comes with its spoken line,
   * `written<voice>spoken</voice>` (asked for) or `<voice>spoken</voice>written`. Written
   * sentences wait in `#written` for the line that follows them ...
   */
  #written: { text: string; emotion: string | null }[] = [];
  /**
   * ... or, when the line came first, the line and the written text after it are collected
   * here until the next line (or a pause, an emotion change, the end).
   */
  #pair: { spoken: string; text: string } | null = null;

  constructor(
    readonly sink: ActionSink,
    readonly flags: TurnFlags,
    readonly names: readonly string[],
    readonly context: ContextKey,
    readonly turn: TurnId,
    readonly lane: LaneKey,
    readonly priority: Priority,
    readonly ttlMs: number,
    readonly signal: AbortSignal,
    /** Tells the voice sink a sentence is coming (`VoiceSink.prepare`). */
    readonly prepare: ((text: string, spoken?: string) => void) | null = null,
    /** She is heard in another language and writes `<voice>` lines (`VoiceSink.speaksIn`). */
    readonly bilingual = false,
  ) {}

  /** Her speech was interrupted: nothing more is said. */
  stopped(): boolean {
    return this.flags.interrupted;
  }

  async text(text: string): Promise<void> {
    for (const piece of this.#fences.push(text)) await this.#piece(piece);
  }

  async #piece(piece: FencedPiece): Promise<void> {
    if (piece.code) {
      if (piece.text.trim() !== "") this.aside.push(`\`\`\`${piece.text}\`\`\``);
      return;
    }
    for (const part of this.#links.push(piece.text)) await this.#part(part);
  }

  /** Text outside code blocks: links aside, the rest cut into sentences. */
  async #part(part: FencedPiece): Promise<void> {
    if (part.code) {
      this.aside.push(part.text);
      return;
    }
    if (this.#pair !== null) {
      this.#pair.text += part.text;
      return;
    }
    for (const sentence of this.#splitter.push(part.text)) await this.#sentence(sentence);
  }

  async #sentence(sentence: string): Promise<void> {
    if (!this.bilingual) return this.#say(sentence);
    this.#written.push({ text: sentence, emotion: this.#emotion });
    // A reply that does not write the lines is not held back for long: the oldest sentences
    // go out on their own (the voice sink translates them).
    while (this.#written.length > MAX_UNVOICED) {
      const first = this.#written.shift();
      if (first) await this.#say(first.text, undefined, first.emotion);
    }
  }

  /** A `<voice>` line: for the written sentences before it, or else the text after it. */
  async voiceLine(line: string): Promise<void> {
    if (this.#pair !== null) {
      await this.#endPair();
    } else {
      const rest = this.#splitter.flush();
      if (rest !== null) this.#written.push({ text: rest, emotion: this.#emotion });
      if (this.#written.length > 0) {
        const written = this.#written;
        this.#written = [];
        await this.#say(written.map((w) => w.text).join(""), line, written[0]?.emotion ?? null);
        return;
      }
    }
    if (line.trim() !== "") this.#pair = { spoken: line, text: "" };
  }

  async #endPair(): Promise<void> {
    const pair = this.#pair;
    if (pair === null) return;
    this.#pair = null;
    // A line nobody wrote down: subtitles and her history only ever carry the written text, so
    // it is said only when it is all she said (better than silence).
    if (pair.text.trim() === "" && this.spoken !== "") return;
    await this.#say(pair.text.trim() === "" ? pair.spoken : pair.text, pair.spoken);
  }

  /** Written sentences still waiting for a line go out on their own. */
  async #sayWritten(): Promise<void> {
    const written = this.#written;
    this.#written = [];
    for (const w of written) await this.#say(w.text, undefined, w.emotion);
  }

  /**
   * A new emotion applies from the next sentence on: a finished sentence that was still held
   * is said with the previous one first.
   */
  async emotion(emotion: string): Promise<void> {
    // `<voice>…</voice><emo:x>written` : the emotion belongs to the line just opened.
    if (this.#pair !== null && this.#pair.text.trim() === "") {
      this.#emotion = emotion;
      return;
    }
    await this.#endPair();
    const done = this.#splitter.flushComplete();
    if (done !== null) await this.#sentence(done);
    this.#emotion = emotion;
  }

  /** Says the unfinished rest (end of a response, or a pause). */
  async flush(): Promise<void> {
    await this.#endPair();
    const rest = this.#splitter.flush();
    if (rest !== null) await this.#sentence(rest);
  }

  /** End of a response: an unclosed code block ends here too. */
  async finish(): Promise<void> {
    for (const piece of this.#fences.flush()) await this.#piece(piece);
    for (const part of this.#links.flush()) await this.#part(part);
    await this.flush();
    await this.#sayWritten();
  }

  async #say(sentence: string, spoken?: string, emotion = this.#emotion): Promise<void> {
    if (this.stopped()) return;
    // Links taken out may leave double spaces behind.
    const text = filterOutgoing(cleanReply(sentence, this.names)).replace(/[ \t]{2,}/g, " ");
    if (!isSpeakable(text)) return;
    const said = spoken === undefined ? "" : filterOutgoing(cleanReply(spoken, this.names)).trim();
    this.prepare?.(text, said === "" ? undefined : said);
    const action = newAction(
      this.lane,
      this.priority,
      { type: "speak", context: this.context, text, emotion },
      { ttl: this.ttlMs, turn: this.turn },
    );
    try {
      await guard(this.sink.submit(action), this.signal);
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new TurnError(`submitting speech: ${errorMessage(error)}`, { cause: error });
    }
    this.flags.queued = true;
    this.spoken += text;
  }
}

/** Cuts `text` to `maxChars` characters (plus `…`). */
/** `history` with the messages this turn answers marked `current` (copies; the session is untouched). */
export function markCurrent(
  history: readonly HistoryEntry[],
  inputs: readonly IncomingMessage[],
): HistoryEntry[] {
  const ids = new Set(inputs.map((m) => m.id.id));
  return history.map((e) => (e.id !== null && ids.has(e.id) ? { ...e, current: true } : e));
}

export function truncate(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : text;
}

export class CheckError extends Error {
  override readonly name = "CheckError";
}

/** Parses the `fast` model's `{"respond": bool, "reason": "..."}` reply. */
export function parseCheck(text: string): CheckReply {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || start >= end) {
    throw new CheckError("no JSON object in fast model reply");
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new CheckError(`invalid JSON from fast model: ${errorMessage(error)}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CheckError("invalid JSON from fast model: expected an object");
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.respond !== "boolean") {
    throw new CheckError("invalid JSON from fast model: `respond` must be a boolean");
  }
  const reason = obj.reason ?? "";
  if (typeof reason !== "string") {
    throw new CheckError("invalid JSON from fast model: `reason` must be a string");
  }
  return { respond: obj.respond, reason };
}

/** Topic of latency measurements (the `voice` package's `LATENCY_TOPIC`). */
const VOICE_LATENCY_TOPIC = "voice.latency";

class Turn {
  /** A voice channel: the reply is spoken. */
  readonly voice: boolean;
  readonly social: SocialSignals | undefined;
  /** The first model response's latency was published (`voice.latency`, stage `llm`). */
  #latencyReported = false;

  constructor(
    readonly agent: Agent,
    readonly key: ContextKey,
    readonly session: Session,
    readonly turn: TurnId,
    readonly inputs: readonly IncomingMessage[],
    /** She starts the conversation on her own (`inputs` is empty). */
    readonly initiative: Initiative | null,
    readonly flags: TurnFlags,
    readonly signal: AbortSignal,
    /** She decided on this herself (her mind loop): principal `self`, with tools. */
    readonly intent: IntentTurn | null = null,
  ) {
    this.voice = key.kind === "voice";
    this.social = agent.social();
  }

  get #now(): number {
    return this.agent.ctx.clock.now();
  }

  #priority(direct: boolean): Priority {
    return direct ? "direct" : "initiative";
  }

  /** What she decided to do, for the data message. */
  #intentData(): SituationData["intent"] {
    const i = this.intent;
    if (i === null) return null;
    return {
      capability: i.intent.capability,
      summary: i.summary,
      done: i.done,
      why: i.intent.why,
      opening: i.intent.opening,
    };
  }

  /** Returns the text she sent or said (empty if she stayed quiet). */
  async respond(): Promise<string> {
    const names = this.agent.persona.names();
    const budget = this.agent.handle.llmBudget();
    // A cold session's earlier messages (bounded by `history.timeout_ms` from their fetch).
    await awaitBackfill(this.agent, this.session, this.signal);
    let decision: Decision;
    if (this.intent !== null) {
      const reasons = [`intent:${this.intent.intent.capability}`];
      const respond = budget === "ok";
      if (!respond) reasons.push(`skipped: llm budget ${budget}`);
      decision = { respond, direct: false, score: 0, reasons };
    } else if (this.initiative !== null) {
      const reasons = [`initiative:${this.initiative.reason}`];
      const respond = budget === "ok";
      if (!respond) reasons.push(`skipped: llm budget ${budget}`);
      decision = { respond, direct: false, score: 0, reasons };
    } else {
      decision = await this.#decide(names, budget);
    }
    const { respond, direct, score, reasons } = decision;
    if (!respond) {
      this.#publishDecision(false, score, reasons);
      return "";
    }
    if (budget === "exhausted") {
      const notice = this.agent.takeBudgetNotice(this.key);
      reasons.push(
        notice
          ? "llm budget exhausted: out-of-energy line"
          : "llm budget exhausted: already told them, staying quiet",
      );
      this.#publishDecision(notice, score, reasons);
      return notice ? await this.#sayExhausted(direct) : "";
    }
    const [extras, images] = await Promise.all([this.#extras(), this.#lookAround()]);
    reasons.push(...extras.reasons);
    const seen = images.filter((p) => p.type === "image_url").length;
    if (seen > 0) reasons.push(`looking at ${seen} image(s)`);
    this.#publishDecision(true, score, reasons);
    return await this.#generate(direct, names, extras, images);
  }

  /**
   * Context of the messages she answers that she did not see: the reply parents missing from
   * the history (noted on the session, so they stay quoted), then the images she looks at.
   * Best effort: failures and timeouts only cost the context.
   */
  async #lookAround(): Promise<ContentPart[]> {
    const cfg = this.agent.config;
    // All inputs at once, so the wait is one `history.timeout_ms` at most.
    const found = await Promise.all(
      this.inputs.map(async (input): Promise<HistoryEntry | null> => {
        const ref = input.reply_to ?? null;
        if (ref === null) return null;
        const known = this.session.entry(ref.id);
        if (known) return known;
        try {
          const chain = await timeout(cfg.history.timeout_ms, this.signal, (signal) =>
            replyParents(this.agent, this.session, input, signal),
          );
          this.session.setParents(input.id.id, chain);
          return chain.at(-1) ?? null;
        } catch (error) {
          if (this.signal.aborted) throw error;
          this.agent.log.debug(
            { turn: this.turn, error: errorMessage(error) },
            "could not fetch reply parents",
          );
          return null;
        }
      }),
    );
    const parents = found.filter((p): p is HistoryEntry => p !== null);
    const vision = cfg.vision;
    if (!vision.enabled || vision.max_images === 0 || this.inputs.length === 0) return [];
    const router = this.agent.ctx.services.get(LlmRouterKey);
    if (!router?.takesImages("chat")) return [];
    const candidates = selectImages(this.inputs, this.session, parents, vision);
    if (candidates.length === 0) return [];
    const loaded = await this.agent.images.load(candidates, vision, this.signal);
    return imageParts(loaded, vision.detail);
  }

  #publishDecision(respond: boolean, score: number, reasons: string[]): void {
    this.signal.throwIfAborted();
    agentTurns.inc({ decision: respond ? "responded" : "ignored" });
    this.agent.ctx.publish(
      {
        type: "agent_decision",
        data: { turn: this.turn, context: this.key, respond, score, reasons },
      },
      { turn: this.turn },
    );
  }

  /**
   * Someone she ignores entirely (only their old lines can still be in history: new ones are
   * not recorded).
   */
  #hidden(entry: HistoryEntry): boolean {
    return !entry.isSelf && (this.social?.attitude(entry.account)?.blocked ?? false);
  }

  /**
   * Mean affinity of the turn's speakers (unknown people count as 0), if social signals are
   * available.
   */
  /**
   * The message her tools act for: the latest one that @-mentions her or replies to her, else
   * the latest one. Someone chatting right after a request must not become its requester.
   */
  #requester(): IncomingMessage | undefined {
    return this.inputs.findLast((m) => m.mentions_self || m.reply_to_self) ?? this.inputs.at(-1);
  }

  #speakerAffinity(): number | null {
    const social = this.social;
    if (!social) return null;
    const authors = this.#authors();
    if (authors.length === 0) return null;
    const sum = authors.reduce((acc, a) => acc + (social.attitude(a)?.affinity ?? 0), 0);
    return sum / authors.length;
  }

  /**
   * Her talkativeness here, shifted by the lessons that apply to this place and these speakers
   * (`LessonsKey`, e.g. "阿明不喜歡被打斷" makes her less likely to chime in while he talks).
   */
  #talkativeness(): TalkLevel | null {
    const base = this.agent.talkativeness(this.key);
    const lessons = this.agent.ctx.services.get(LessonsKey);
    if (!lessons) return base;
    const people = this.#authors().flatMap((a) => {
      const p = this.social?.attitude(a)?.person ?? null;
      return p === null ? [] : [p];
    });
    const shift = lessons.talkShift(this.key, people);
    if (shift === 0) return base;
    // Without her own setting, lessons shift the level's default (the level caps the result).
    const usual = this.agent.ceiling(this.key)?.defaultTalk ?? 0.5;
    const level = Math.min(Math.max((base?.level ?? usual) + shift, 0), 1);
    return { level, scope: `${base?.scope ?? "default"}+lessons` };
  }

  /** Runs attention. */
  async #decide(names: readonly string[], budget: BudgetState): Promise<Decision> {
    const cfg = this.agent.config;
    const [interests, profileShare] = this.agent.persona.read(
      (p) => [p.manifest.interests, p.manifest.behavior.max_share_of_recent] as const,
    );
    const configured = this.agent.handle.channelMode(this.key);
    // Short on budget: no joining in, no fast-model checks.
    const mode: ChannelMode =
      budget !== "ok" && AMBIENT_MODES.includes(configured) ? "mention-only" : configured;
    const ceiling = ceilingFor(mode, this.key);
    const activeness = this.agent.handle.activeness(this.key);
    const talkativeness = this.#talkativeness();
    const affinity = this.#speakerAffinity();
    const mood = this.agent.mood();
    const voiceCfg = cfg.voice;
    let attentionCfg: AttentionConfig;
    let maxShare: number;
    if (this.voice) {
      attentionCfg = {
        ...cfg.attention,
        cooldown_ms: voiceCfg.cooldown_ms,
        min_cooldown_ms: voiceCfg.min_cooldown_ms,
        llm_check: voiceCfg.llm_check,
        gray_low: voiceCfg.gray_low,
      };
      maxShare = voiceCfg.max_share_of_recent;
    } else {
      attentionCfg = cfg.attention;
      maxShare = cfg.attention.max_share_of_recent ?? profileShare;
    }
    const voice: VoiceAttention | null = this.voice
      ? {
          someoneSpeaking: this.session.someoneSpeaking(),
          ambientFactor: voiceCfg.ambient_factor,
          questionWindowMs: voiceCfg.question_window_ms,
          interruptScale: voiceCfg.interrupt_scale,
          others: this.session.voiceMembers().length,
        }
      : null;
    const assessment = assess({
      config: attentionCfg,
      mode,
      activeness,
      talkativeness,
      ceiling,
      names,
      interests,
      maxShare,
      session: this.session,
      inputs: this.inputs,
      now: this.#now,
      voice,
      affinity,
      mood,
    });
    const reasons = assessment.reasons;
    if (mode !== configured) reasons.push(`llm budget ${budget}: as mention-only`);
    const scale = assessment.ambientScale;
    const ambient = (p: number): number => Math.min(Math.max(p * scale, 0), 1);
    let probability: number;
    switch (assessment.gate.kind) {
      case "ignore":
        probability = 0;
        break;
      case "sample":
        probability = assessment.gate.probability;
        break;
      case "ask_llm": {
        try {
          const reply = await this.#llmCheck();
          if (reply.respond) {
            reasons.push(`fast model: respond (${reply.reason})`);
            probability = ambient(cfg.attention.llm_yes_probability);
          } else {
            reasons.push(`fast model: stay quiet (${reply.reason})`);
            probability = 0;
          }
        } catch (error) {
          if (this.signal.aborted) throw error;
          reasons.push(`fast model check failed: ${errorMessage(error)}`);
          probability = ambient(assessment.score);
        }
        break;
      }
    }
    const [respond, roll] = sample(probability, this.agent.random);
    reasons.push(
      roll === null
        ? `p ${fixed(probability, 2)}`
        : `p ${fixed(probability, 2)}, roll ${fixed(roll, 2)}`,
    );
    return { respond, direct: assessment.direct, score: assessment.score, reasons };
  }

  /** Stable id of this conversation for the LLM provider (routing, prompt caching). */
  #llmSession(): string {
    const profile = this.agent.persona.read((p) => p.id);
    return contextSession(profile, this.key);
  }

  async #llmCheck(): Promise<CheckReply> {
    const router = this.agent.ctx.services.require(LlmRouterKey);
    const name = this.agent.persona.displayName();
    const messages = checkMessages(
      name,
      this.session.recent(CHECK_HISTORY).filter((e) => !this.#hidden(e)),
    );
    const request: ChatRequest = {
      messages,
      temperature: 0,
      max_tokens: 1000, // reasoning models spend part of this on thinking
      json_mode: true,
      session: `${this.#llmSession()}-attention`,
    };
    // The voice gray-zone check is on the reply's critical path: no thinking. Text checks use
    // `[llm.thinking]` for the purpose.
    if (this.voice) request.thinking = false;
    const response = await timeout(
      this.agent.config.attention.llm_check_timeout_ms,
      this.signal,
      (signal) =>
        withLlmTag({ module: "agent", turn: this.turn, label: "attention" }, () =>
          router.complete("fast", request, signal),
        ),
    );
    return parseCheck(response.text);
  }

  /** The name she knows `account` by in this turn. */
  #nameOf(account: AccountRef): string | null {
    const input = this.inputs.find((m) => sameAccount(m.author.account, account));
    if (input) return input.author.display_name;
    const member = this.session.voiceMembers().find((m) => sameAccount(m.account, account));
    if (member) return member.display_name;
    const seen = this.session.participants().find((p) => sameAccount(p.account, account));
    return seen ? seen.displayName : null;
  }

  /**
   * The people this turn is about: its speakers, or for an initiative the accounts its hint is
   * about.
   */
  #focus(): AccountRef[] {
    const out = [...this.#authors()];
    const about = [...(this.initiative?.about ?? [])];
    if (this.intent?.intent.about) about.push(this.intent.intent.about);
    for (const account of about) {
      if (!out.some((a) => sameAccount(a, account))) out.push(account);
    }
    return out;
  }

  /** Mood and attitude lines, plus the sections of prompt contributors. */
  async #extras(): Promise<Extras> {
    const extras: Extras = { notes: [], people: [], sections: null, reasons: [] };
    const mood = this.agent.mood();
    if (mood !== null) extras.notes.push(moodHint(mood));
    // What she shows of her emotion (felt vs shown): her lines and `<emo:…>` follow it.
    const shown = this.agent.ctx.services.get(SelfStateKey)?.shown?.() ?? null;
    if (shown !== null) extras.notes.push(shownHint(shown));
    const her = this.agent.ctx.services.get(WorldStateKey)?.snapshot().her ?? null;
    if (her !== null) extras.notes.push(herStatusHint(her));
    // The owner's ceiling for this channel, so she knows it when asked to be quieter or chattier.
    const level = levelHint(this.agent.handle.channelMode(this.key), this.key);
    if (level !== null) extras.notes.push(level);
    // Her own state: what she raised here herself that nobody picked up (not to repeat it).
    const unanswered = unansweredHint(
      this.agent.ctx.services.get(MindKey)?.unanswered?.(this.key) ?? [],
    );
    if (unanswered !== "") extras.notes.push(unanswered);
    const focus = this.#focus();
    const social = this.social;
    if (social) {
      const hints: string[] = [];
      for (const account of focus) {
        if (hints.length >= MAX_ATTITUDE_HINTS) break;
        const attitude = social.attitude(account);
        if (!attitude) continue;
        const name = this.#nameOf(account);
        if (name === null) continue;
        hints.push(attitudeHint(safeName(name), attitude));
      }
      extras.people.push(...hints);
    }
    const registry = this.agent.ctx.services.get(PromptContributorsKey);
    if (!registry || registry.all().length === 0) return extras;
    const request = this.#promptRequest(focus);
    const cfg = this.agent.config;
    const gathered = await gather(registry, request, cfg.contributor_timeout_ms, this.signal);
    extras.reasons = gathered.reasons();
    extras.sections = renderSections(gathered.sections, cfg.max_context_chars);
    return extras;
  }

  /** What prompt contributors get to see of this turn. */
  #promptRequest(speakers: AccountRef[]): PromptRequest {
    const her = this.agent.persona.displayName();
    const profile = this.agent.persona.read((p) => p.id);
    const person = (account: AccountRef) => this.social?.attitude(account)?.person ?? null;
    const members = this.session.voiceMembers();
    const participants: Participant[] =
      this.voice && members.length > 0
        ? members.map((m) => ({
            account: m.account,
            display_name: m.display_name,
            person: person(m.account),
          }))
        : this.session
            .participants()
            .slice(0, MAX_PEOPLE)
            .map((p) => ({
              account: p.account,
              display_name: p.displayName,
              person: person(p.account),
            }));
    // Speakers are always among the participants.
    for (const account of speakers) {
      if (participants.some((p) => sameAccount(p.account, account))) continue;
      const name = this.#nameOf(account);
      if (name !== null) {
        participants.push({ account, display_name: name, person: person(account) });
      }
    }
    const shownSpeakers = speakers.filter((a) =>
      participants.some((p) => sameAccount(p.account, a)),
    );
    const query =
      this.intent !== null
        ? [this.intent.intent.opening ?? "", this.intent.intent.why].join("\n").trim()
        : this.initiative !== null
          ? this.initiative.hint.trim()
          : this.inputs.map((m) => `${m.author.display_name}: ${messageText(m)}`).join("\n");
    const firstInput =
      this.inputs.length === 0 ? null : Math.min(...this.inputs.map((m) => timestampMs(m.ts)));
    const before = this.session
      .history()
      .filter((e) => (firstInput === null || e.ts < firstInput) && !this.#hidden(e));
    const recent = before
      .slice(Math.max(before.length - CONTRIBUTOR_HISTORY, 0))
      .map((e) => transcriptLine(e, her));
    return {
      profile,
      turn: this.turn,
      context: this.key,
      participants,
      speakers: shownSpeakers,
      query,
      recent,
      voice: this.voice,
      now: toTimestamp(this.#now),
    };
  }

  async #generate(
    direct: boolean,
    names: readonly string[],
    extras: Extras,
    images: readonly ContentPart[],
  ): Promise<string> {
    const cfg = this.agent.config;
    const services = this.agent.ctx.services;
    const router = services.require(LlmRouterKey);
    const sink = services.require(ActionSinkKey);

    const persona = this.agent.persona.personaPrompt();
    const members = this.session.voiceMembers();
    const present =
      this.voice && members.length > 0
        ? members.map((m) => m.display_name)
        : this.session
            .participants()
            .slice(0, MAX_PEOPLE)
            .map((p) => p.displayName);
    const situation = situationPrompt(
      {
        context: this.key,
        direct,
        initiative: this.initiative?.hint ?? null,
        intent: this.intent !== null,
        notes: extras.notes,
        speaksIn: this.voice ? (services.get(VoiceSinkKey)?.speaksIn ?? null) : null,
      },
      new Date(this.#now),
    );
    const data = situationData({
      voice: this.voice,
      present,
      people: extras.people,
      initiative:
        this.initiative === null
          ? null
          : { reason: this.initiative.reason, hint: this.initiative.hint },
      intent: this.#intentData(),
      sections: extras.sections,
    });
    // What her conversation notes already cover is not repeated raw (a few lines always stay).
    const folded = services.get(ConversationStatesKey)?.get(this.key) ?? null;
    const messages = buildMessages(
      persona,
      situation,
      markCurrent(
        afterFold(
          this.session.recent(cfg.prompt_history).filter((e) => !this.#hidden(e)),
          folded?.folded_up_to ?? null,
          cfg.history_after_fold,
        ),
        this.inputs,
      ),
      data,
      {
        maxChars: cfg.max_prompt_chars,
        maxEntryChars: cfg.max_entry_chars,
        gapMs: cfg.time_gap_ms,
      },
      images,
    );

    const priority = this.#priority(direct);
    if (this.voice) {
      const [platform, scope] = voiceScope(this.key);
      const voiceSink = this.agent.ctx.services.get(VoiceSinkKey);
      const speech = new Speech(
        sink,
        this.flags,
        names,
        this.key,
        this.turn,
        voiceLane(platform, scope),
        priority,
        cfg.voice.speak_ttl_ms,
        this.signal,
        voiceSink?.prepare ? (text, spoken) => voiceSink.prepare?.(this.key, text, spoken) : null,
        Boolean(voiceSink?.speaksIn),
      );
      await this.#produce(router, messages, priority, speech);
      const posts = [
        ...(cfg.voice.text_echo && speech.spoken.trim() !== "" ? [speech.spoken] : []),
        ...(cfg.voice.text_aside ? speech.aside : []),
      ];
      await this.#postAside(sink, posts, priority);
      if (speech.spoken === "") this.agent.log.debug({ turn: this.turn }, "she stayed quiet");
      return speech.spoken;
    }

    const lane = textLane(this.key);
    // Typing is refreshed until the reply is ready; cancelling the turn stops it too.
    const typing = new AbortController();
    const stopTyping = () => typing.abort();
    this.signal.addEventListener("abort", stopTyping, { once: true });
    const typingLoop = this.#keepTyping(sink, lane, priority, typing.signal);
    // What she writes alongside a tool call ("好，我寫寫看，等我一下") goes out at once, so a
    // slow tool never leaves the person waiting in silence.
    const early: string[] = [];
    const interim = async (e: Expression) => {
      const text = this.#linkMentions(filterOutgoing(cleanReply(e.text, names)));
      if (text !== "") early.push(await this.#sendText(sink, text, direct, priority));
    };
    let expression: Expression;
    try {
      expression = await this.#produce(router, messages, priority, null, interim);
    } finally {
      typing.abort();
      this.signal.removeEventListener("abort", stopTyping);
      await typingLoop;
    }
    if (expression.isSilent()) {
      if (early.length === 0) this.agent.log.debug({ turn: this.turn }, "she chose silence");
      return early.join("\n");
    }
    const text = this.#linkMentions(filterOutgoing(cleanReply(expression.text, names)));
    if (text === "") return early.join("\n");
    return [...early, await this.#sendText(sink, text, direct, priority)].join("\n");
  }

  /** `@name` of people in this conversation as the platform's mentions (`mention_users`). */
  #linkMentions(text: string): string {
    if (!this.agent.config.mention_users) return text;
    const sink = this.agent.ctx.services.get(PlatformSinksKey)?.get(this.key.platform);
    const mention = sink?.mention?.bind(sink);
    if (!mention) return text;
    const people = new Map<string, AccountRef>();
    for (const p of this.session.participants()) people.set(p.displayName, p.account);
    for (const m of this.inputs) people.set(m.author.display_name, m.author.account);
    const targets: MentionTarget[] = [];
    for (const [name, account] of people) {
      const markup = mention(account);
      if (markup !== null && !this.#hiddenAccount(account)) targets.push({ name, markup });
    }
    return linkMentions(text, targets);
  }

  #hiddenAccount(account: AccountRef): boolean {
    return this.social?.attitude(account)?.blocked ?? false;
  }

  /**
   * What she said (`voice.text_echo`) and the links and code from her spoken reply
   * (`voice.text_aside`), posted to the voice channel's text chat (same channel id).
   * Best effort: a failure is only logged.
   */
  async #postAside(sink: ActionSink, aside: readonly string[], priority: Priority): Promise<void> {
    const cfg = this.agent.config;
    if (aside.length === 0 || this.flags.interrupted) return;
    const text = truncate(filterOutgoing(aside.join("\n")), Math.max(cfg.max_message_chars, 1));
    if (text === "") return;
    const chat: ContextKey = { ...this.key, kind: "channel" };
    const action = newAction(
      textLane(chat),
      priority,
      { type: "send_message", context: chat, message: { text, reply_to: null } },
      { ttl: cfg.reply_ttl_ms, turn: this.turn },
    );
    try {
      await guard(sink.submit(action), this.signal);
    } catch (error) {
      if (this.signal.aborted) throw error;
      this.agent.log.warn({ turn: this.turn, error: errorMessage(error) }, "could not post links");
    }
  }

  /** Sends `text` (split into several messages if long) as her reply. */
  async #sendText(
    sink: ActionSink,
    text: string,
    direct: boolean,
    priority: Priority,
  ): Promise<string> {
    const cfg = this.agent.config;
    const lane = textLane(this.key);
    const replyTo =
      cfg.reply_reference && direct && this.key.kind !== "dm"
        ? (this.inputs.at(-1)?.id ?? null)
        : null;
    const displayName = this.agent.persona.displayName();
    const me = this.agent.selfAccount(this.key.platform);
    this.signal.throwIfAborted();
    this.flags.committed = true;
    const chunks = splitMessage(text, cfg.max_message_chars);
    for (const [i, chunk] of chunks.entries()) {
      const action = newAction(
        lane,
        priority,
        {
          type: "send_message",
          context: this.key,
          message: { text: chunk, reply_to: i === 0 ? replyTo : null },
        },
        { ttl: cfg.reply_ttl_ms, turn: this.turn },
      );
      const id = action.id;
      this.session.recordOwn(displayName, me, chunk, id, this.#now);
      this.agent.trackAction(id, this.session);
      try {
        await guard(sink.submit(action), this.signal);
      } catch (error) {
        this.agent.untrackAction(id);
        this.session.forgetAction(id);
        if (this.signal.aborted) throw error;
        throw new TurnError(`submitting reply: ${errorMessage(error)}`, { cause: error });
      }
    }
    return text;
  }

  /** Budget exhausted: says (or writes) the constant out-of-energy line. */
  async #sayExhausted(direct: boolean): Promise<string> {
    const sink = this.agent.ctx.services.require(ActionSinkKey);
    const priority = this.#priority(direct);
    if (!this.voice) return await this.#sendText(sink, EXHAUSTED_LINE, direct, priority);
    const [platform, scope] = voiceScope(this.key);
    const action = newAction(
      voiceLane(platform, scope),
      priority,
      { type: "speak", context: this.key, text: EXHAUSTED_LINE, emotion: "tired" },
      { ttl: this.agent.config.voice.speak_ttl_ms, turn: this.turn },
    );
    try {
      await guard(sink.submit(action), this.signal);
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new TurnError(`submitting speech: ${errorMessage(error)}`, { cause: error });
    }
    return EXHAUSTED_LINE;
  }

  /** Submits a typing indicator every `typing_refresh_ms` until `signal` aborts. */
  async #keepTyping(
    sink: ActionSink,
    lane: LaneKey,
    priority: Priority,
    signal: AbortSignal,
  ): Promise<void> {
    const refresh = typingRefreshMs(this.agent.config);
    while (!signal.aborted) {
      const typing = newAction(
        lane,
        priority,
        { type: "typing", context: this.key },
        {
          ttl: TYPING_TTL_MS,
          turn: this.turn,
          coalesce_key: `typing:${contextKeyDisplay(this.key)}`,
        },
      );
      try {
        await sink.submit(typing);
      } catch (error) {
        this.agent.log.warn({ error: errorMessage(error) }, "could not submit typing action");
      }
      try {
        await sleep(refresh, signal);
      } catch {
        return;
      }
    }
  }

  /**
   * Runs the model, executing tool calls for up to `max_tool_steps` rounds, and returns the
   * reply to send.
   *
   * Text written alongside tool calls is kept in the conversation sent back to the model. With
   * `interim` (text) it is sent at once, before the tools run; otherwise it is only used as the
   * reply if the final response has none, so it is never sent twice. With `speech` (voice), all
   * text is spoken as it streams in, including text written alongside tool calls.
   */
  async #produce(
    router: LlmRouter,
    initial: ChatMessage[],
    priority: Priority,
    speech: Speech | null,
    interim: ((expression: Expression) => Promise<void>) | null = null,
  ): Promise<Expression> {
    const cfg = this.agent.config;
    // Reactive turns and the turns she starts herself act; initiative turns only talk.
    const toolsEnabled = cfg.tools_enabled && (this.inputs.length > 0 || this.intent !== null);
    const messages = [...initial];
    let earlier: Expression | null = null;
    const used = new Set<string>();
    let reminded = false;
    for (let step = 0; step <= cfg.max_tool_steps; step++) {
      const tools = toolsEnabled ? this.#toolSpecs() : [];
      const offered = tools.length > 0;
      const request: ChatRequest = {
        messages: [...messages],
        tools,
        temperature: cfg.temperature,
        max_tokens: cfg.max_tokens,
        // Text replies may think first; spoken ones must start talking right away.
        thinking: !this.voice,
        session: this.#llmSession(),
      };
      const { expression, raw, calls } = await this.#streamStep(router, request, speech);
      if (speech?.stopped()) {
        this.agent.log.debug({ turn: this.turn }, "speech interrupted, generation stopped");
        return expression;
      }
      // She said she did something only a tool does ("我游過去了") without calling it: once per
      // turn she is told it has not happened, and either does it or says so. In text the claim
      // was not sent yet and the corrected reply replaces it.
      if (calls.length === 0 && offered && !reminded && step < cfg.max_tool_steps) {
        const names = new Set(tools.map((t) => t.name));
        const claim = CLAIMS.find(
          ([tool, said]) => names.has(tool) && !used.has(tool) && said.test(expression.text),
        );
        if (claim) {
          reminded = true;
          this.agent.log.info(
            { turn: this.turn, tool: claim[0] },
            "she claimed an action without doing it",
          );
          messages.push(assistantMessage(raw, []));
          messages.push(userMessage(claimReminder(claim[0])));
          continue;
        }
      }
      if (calls.length === 0 || !offered || step === cfg.max_tool_steps) {
        if (calls.length > 0) {
          this.agent.log.warn(
            { turn: this.turn, offered },
            "ignoring tool calls (disabled or step limit reached)",
          );
        }
        return earlier !== null && expression.isSilent() ? earlier : expression;
      }
      if (!expression.isSilent()) {
        if (interim) await interim(expression);
        else earlier = expression;
      }
      messages.push(assistantMessage(raw, calls));
      for (const call of calls) {
        used.add(call.name);
        const result = await this.#runTool(call, priority);
        messages.push(toolResultMessage(call.id, result));
      }
    }
    return earlier ?? new Expression();
  }

  /**
   * Streams one model response, publishing emotions as they arrive (and speaking its
   * sentences, with `speech`).
   */
  async #streamStep(router: LlmRouter, request: ChatRequest, speech: Speech | null): Promise<Step> {
    const offeredTools = (request.tools?.length ?? 0) > 0;
    const stream = await guard(
      withLlmTag({ module: "agent", turn: this.turn, label: "reply" }, () =>
        router.stream("chat", request, this.signal),
      ),
      this.signal,
    );
    const iterator = stream[Symbol.asyncIterator]();
    const parser = new ExpressionParser();
    const expression = new Expression();
    let raw = "";
    const calls: ToolCall[] = [];
    let finished = false;
    try {
      for (;;) {
        const next: IteratorResult<StreamEvent> = await guard(iterator.next(), this.signal);
        if (next.done) {
          finished = true;
          break;
        }
        const event = next.value;
        if (event.type === "text_delta") {
          raw += event.text;
          for (const segment of parser.push(event.text)) {
            await this.#take(expression, segment, speech);
          }
          // With tools on offer, calls may still follow the silence.
          if (expression.silence && !offeredTools) break;
          if (speech?.stopped()) break;
        } else if (event.type === "reasoning_delta") {
          this.agent.log.debug({ turn: this.turn, reasoning: event.text }, "reasoning");
        } else if (event.type === "tool_call_delta") {
          while (calls.length <= event.index) calls.push({ id: "", name: "", arguments: "" });
          const call = calls[event.index] as ToolCall;
          if (event.id !== null) call.id = event.id;
          if (event.name !== null) call.name += event.name;
          call.arguments += event.arguments;
        } else {
          break;
        }
      }
    } finally {
      if (!finished) {
        // Like dropping the Rust stream; never wait for a provider that ignores aborts.
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      }
    }
    this.#reportLatency(stream.model, stream.firstTokenMs);
    for (const segment of parser.finish()) await this.#take(expression, segment, speech);
    if (speech) await speech.finish();
    const named = calls.filter((c) => c.name !== "");
    named.forEach((call, i) => {
      if (call.id === "") call.id = `call_${i}`;
    });
    return { expression, raw, calls: named };
  }

  /**
   * Publishes the first token latency of the turn's first model response in a voice channel
   * (`voice.latency`, stage `llm`; the panel's voice monitor shows it).
   */
  #reportLatency(model: string, firstTokenMs: number | null): void {
    if (!this.voice || this.#latencyReported || firstTokenMs === null) return;
    this.#latencyReported = true;
    this.agent.ctx.publish(
      {
        type: "custom",
        data: {
          topic: VOICE_LATENCY_TOPIC,
          payload: {
            stage: "llm",
            context: contextJson(this.key),
            turn: this.turn,
            model,
            first_token_ms: Math.round(firstTokenMs),
          },
        },
      },
      { turn: this.turn },
    );
  }

  /** Distinct authors of the turn's messages; a tool permission must be granted to all. */
  #authors(): AccountRef[] {
    const out: AccountRef[] = [];
    for (const m of this.inputs) {
      if (!out.some((a) => sameAccount(a, m.author.account))) out.push(m.author.account);
    }
    return out;
  }

  /** Runs one tool call; the result (or error) is a short text for the model. */
  async #runTool(call: ToolCall, priority: Priority): Promise<string> {
    const [ok, full] = await this.#tryTool(call, priority);
    const result = truncate(full, this.agent.config.max_tool_result_chars);
    this.agent.log.debug({ turn: this.turn, tool: call.name, ok, result }, "tool call");
    this.signal.throwIfAborted();
    this.agent.ctx.publish(
      {
        type: "custom",
        data: {
          topic: "agent.tool",
          payload: {
            turn: this.turn,
            context: contextJson(this.key),
            tool: call.name,
            ok,
            result,
          },
        },
      },
      { turn: this.turn },
    );
    return result;
  }

  /** The tools offered in this context (`react` makes no sense in voice). */
  #offers(name: string): boolean {
    return !(this.voice && name === ReactTool.NAME);
  }

  #toolSpecs(): ToolSpec[] {
    return this.agent.tools.specs().filter((t) => this.#offers(t.name));
  }

  #tool(name: string): Tool | undefined {
    return this.#offers(name) ? this.agent.tools.get(name) : undefined;
  }

  async #tryTool(call: ToolCall, priority: Priority): Promise<[boolean, string]> {
    const tool = this.#tool(call.name);
    if (!tool) return [false, `error: unknown tool \`${call.name}\``];
    const node = tool.permission ?? null;
    if (node !== null && this.intent !== null) {
      // Nobody asked: tools that need a person's permission are not hers to use alone.
      return [false, "error: permission denied (needs someone who may use this tool to ask)"];
    }
    if (node !== null) {
      const authorizer = this.agent.ctx.services.get(AuthorizerKey);
      const allowed =
        authorizer !== undefined && this.#authors().every((a) => authorizer.allows(a, node));
      if (!allowed) {
        return [false, "error: permission denied (the user who asked may not use this tool)"];
      }
    }
    let args: JsonValue;
    if (call.arguments.trim() === "") {
      args = {};
    } else {
      try {
        args = JSON.parse(call.arguments) as JsonValue;
      } catch (error) {
        return [false, `error: arguments are not valid JSON: ${errorMessage(error)}`];
      }
    }
    const last = this.#requester();
    if (!last && this.intent === null) return [false, "error: no triggering message"];
    const me = this.agent.selfAccount(this.key.platform);
    try {
      const out = await timeout(this.agent.config.tool_timeout_ms, this.signal, (signal) => {
        const ctx: ToolContext = last
          ? {
              turn: this.turn,
              context: this.key,
              account: last.author.account,
              // The person she is answering asked: a request she may decline (see the gate).
              principal: Principals.user(last.author.account, this.key),
              message: last.id,
              priority,
              signal,
            }
          : {
              // Her own turn: she acts as herself (her own limits, consent of whom it concerns).
              turn: this.turn,
              context: this.key,
              account: me,
              principal: Principals.self(this.key, null),
              message: { context: this.key, id: this.turn },
              priority,
              signal,
            };
        return tool.call(ctx, args);
      });
      return [true, out];
    } catch (error) {
      if (this.signal.aborted) throw error;
      if (error instanceof TimeoutError) return [false, "error: timed out"];
      return [false, `error: ${errorMessage(error)}`];
    }
  }

  /**
   * Folds a segment into `expression`; with `speech`, also speaks text and tracks the emotion
   * for the next sentence (nothing after a silence).
   */
  async #take(expression: Expression, segment: Segment, speech: Speech | null): Promise<void> {
    const out = expression.silence ? null : speech;
    if (out === null) {
      this.#apply(expression, segment);
      return;
    }
    switch (segment.type) {
      case "text":
        this.#apply(expression, segment);
        await out.text(segment.text);
        return;
      case "emotion":
        await out.emotion(segment.emotion);
        break;
      case "pause":
        await out.flush();
        break;
      case "spoken":
        await out.voiceLine(segment.text);
        break;
      case "silence":
        break;
    }
    this.#apply(expression, segment);
  }

  #apply(expression: Expression, segment: Segment): void {
    if (segment.type === "emotion" && !expression.silence) {
      this.signal.throwIfAborted();
      this.agent.ctx.publish(
        {
          type: "custom",
          data: {
            topic: "agent.emotion",
            payload: {
              turn: this.turn,
              context: contextJson(this.key),
              emotion: segment.emotion,
              ...(segment.intensity === undefined ? {} : { intensity: segment.intensity }),
            },
          },
        },
        { turn: this.turn },
      );
    }
    expression.apply(segment);
  }
}

/** The context as a JSON object (event payloads). */
function contextJson(key: ContextKey): JsonValue {
  return { platform: key.platform, scope: key.scope, channel: key.channel, kind: key.kind };
}
