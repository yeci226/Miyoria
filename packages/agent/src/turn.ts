// One turn: attention decision, prompt assembly (compiler.ts: her own state in the trusted
// system part, everything derived from other people in the user-role data message), generation
// (with the tool loop; tool calls run for the speaker as principal `user`) and output, filtered
// by `safeOutgoing` (moderation, then `filterOutgoing`). The reasoning level comes from `[llm.reasoning]` per reasoning purpose
// (`chat_text`, `chat_voice`, `chat_intent`; off by default for replies). Text replies go out
// line by line as they are written; voice replies are spoken sentence by sentence while the
// model is still generating (links and code blocks go to the voice channel's text chat instead
// of being read out), a bilingual line as soon as its `<voice>` part is complete.
//
// The turn answers its focus (focus.ts): the "要回的訊息" block shows only the focus messages,
// naming who asked, and a reply quotes the first of them. Every turn ends with one
// `agent.turn.outcome` (sent / silence / error here; the coordinator publishes cancellations).
//
// Before generating, a turn waits (bounded) for a cold session's backfill, fetches reply
// parents missing from the history and picks the images she looks at (history.ts, vision.ts).
//
// An initiative turn has no input and skips attention (the coordinator already checked the
// context is quiet). An intent turn (her mind loop decided to act or talk) has no input either,
// skips attention and offers tools, which run as principal `self` (tools that need a person's
// permission node are refused); her plan goes into the data message. While the LLM budget is exhausted nothing is generated: a turn she would
// have answered gets a canned line at most once per context per `budget_notice_interval_ms`.
//
// Under `pipeline = "v3"` (`Agent.mainline`) a turn is a turn of the main line: it holds the Floor,
// makes one call for what she says and does (`TurnOutput`, no tool loop: the hands report back in a
// turn of their own), every line goes through the gate and the ledger (mainline/), and a call that
// fails ends in a fixed line instead of silence. `#speakMain` is that path; the rest is shared.

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
import { isInternalTool, type Tool, type ToolContext } from "@miyoria/tools";
import {
  type AccountRef,
  type ActionSink,
  ActionSinkKey,
  ActivityManagerKey,
  AffectStateKey,
  ArbiterKey,
  AuthorizerKey,
  type CompiledBlock,
  type ContextKey,
  ConversationStatesKey,
  contextKeyString as contextKeyDisplay,
  DirectivesKey,
  dataBlock,
  FileReaderKey,
  type FloorClaimKind,
  GoalAgendaKey,
  type IncomingMessage,
  inspectInput,
  type JsonValue,
  type LaneKey,
  LessonsKey,
  MemoryRetrievalKey,
  type MessageRef,
  MindKey,
  ModerationKey,
  type Notice,
  newAction,
  type Participant,
  PlatformSinksKey,
  Principals,
  type Priority,
  type PromptBlock,
  PromptContributorsKey,
  type PromptRequest,
  type ReasoningLevel,
  type SafeLine,
  type SavedPrompt,
  SelfStateKey,
  type SocialSignals,
  safeOutgoing,
  sameAccount,
  type TurnId,
  type TurnOutcome,
  type TurnOutcomeRecord,
  textLane,
  timestampMs,
  toTimestamp,
  VoiceSinkKey,
  voiceLane,
  WorkingContextKey,
  WorldStateKey,
} from "@miyoria/types";
import {
  assess,
  flooredTalk,
  decide as sample,
  type TalkLevel,
  type VoiceAttention,
} from "./attention.js";
import {
  acceptedRequests,
  asksForGame,
  type Backing,
  claimReminder,
  toolsWrittenAsText,
  toolTextReminder,
  unbackedClaim,
} from "./claims.js";
import { budgetBlocks, budgetSelf, contributedData, savedPrompt } from "./compiler.js";
import type { AttentionConfig, ChannelMode } from "./config.js";
import { AMBIENT_MODES, typingRefreshMs } from "./config.js";
import { gather } from "./contributors.js";
import type { TurnFlags } from "./coordinator.js";
import { Expression, ExpressionParser, type Segment } from "./expression.js";
import { fileParts, selectFiles } from "./files.js";
import { type FocusSelection, focusVerb, type TurnFocusInit } from "./focus.js";
import { voiceScope } from "./handle.js";
import { awaitBackfill, fetchAround, quotedParent, replyParents } from "./history.js";
import { looksLikeReasoning, ReplyScreen } from "./leak.js";
import { ceilingFor, levelHint } from "./levels.js";
import type { HeldLine } from "./mainline/gate.js";
import type { Run } from "./mainline/hands.js";
import {
  ACTING_ALONE,
  FALLBACK_LINES,
  FALLBACK_RESULT_LINE,
  FALLBACK_URGENT_LINE,
  type MainClaim,
  MainTurn,
  sentences,
} from "./mainline/main.js";
import { COMMIT_SPEC, groundArgs, STEER_SPEC, slimTool, turnOutput } from "./mainline/output.js";
import {
  contextData,
  contextState,
  fitHistory,
  mainMessages,
  mainRules,
  pinnedSection,
  promptText,
  proposalData,
  resultData,
  tailSection,
} from "./mainline/prompt.js";
import { linkMentions, type MentionTarget } from "./mentions.js";
import { agentTurns } from "./metrics.js";
import {
  afterFold,
  buildMessages,
  checkMessages,
  cleanReply,
  dataMessage,
  EXAMPLES_TITLE,
  FLAGGED_TITLE,
  flaggedBody,
  focusEntries,
  INITIATIVE_TITLE,
  INTENT_TITLE,
  type IntentData,
  intentBody,
  PRESENT_TITLE,
  rulesPrompt,
  severalPeople,
  situationPrompt,
  splitByReplyMarks,
  splitMessage,
  takeReplyMark,
  transcriptLine,
  VOICE_PRESENT_TITLE,
  whenAndWhere,
} from "./prompt.js";
import type { Agent, Initiative, IntentTurn } from "./runtime.js";
import { type PresentPerson, peopleBody, selfBlocks } from "./self-block.js";
import { type HistoryEntry, messageText, type Session } from "./session.js";
import { type BudgetState, EXHAUSTED_LINE } from "./signals.js";
import {
  type FencedPiece,
  FenceSplitter,
  isSpeakable,
  LinkSplitter,
  SentenceSplitter,
} from "./speech.js";
import { offeredIn, scopeOfHer, scopeOfSnapshot, type ToolScope } from "./tool-scope.js";
import { KeepNoteTool, ReactTool } from "./tools.js";
import { contextId, fixed, guard, TimeoutError, timeout } from "./util.js";
import { imageParts, selectImages } from "./vision.js";

const TYPING_TTL_MS = 10_000;
/** A tool result at least this long gets the keep_note reminder (notes.ts). */
const LONG_RESULT_CHARS = 300;
const KEEP_HINT =
  "\n(這些結果下一回合就看不到了;這段對話之後還會用到的,用 keep_note 用自己的話記下重點)";
/** History lines shown to the `fast` model. */
const CHECK_HISTORY = 12;
/** History lines before the input sent to prompt contributors. */
const CONTRIBUTOR_HISTORY = 6;
/** People in the prompt request and the people block (text contexts). */
const MAX_PEOPLE = 10;
/** The contributor key of the `memory` module. */
const MEMORY_CONTRIBUTOR = "memory";
/** No budget: the agent's own data blocks are only limited by their own budgets. */
const UNLIMITED = Number.MAX_SAFE_INTEGER;
/** History lines looked through for suspicious messages. */
const FLAGGED_HISTORY = 12;

export class TurnError extends Error {
  override readonly name = "TurnError";
}

/** What a turn is for (focus.ts), as the coordinator worked it out. */
export interface TurnPlan {
  /** The focus split of the turn's input (`null`: a turn without input). */
  selection: FocusSelection | null;
  /** What `agent.turn.focus` / `agent.turn.outcome` say about it. */
  focus: TurnFocusInit;
}

/**
 * Runs one turn and publishes `agent.turn.completed` and its `agent.turn.outcome`. When
 * `signal` aborts (the coordinator cancelled the turn) it stops without publishing anything
 * more (the coordinator records the cancellation).
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
  intent: IntentTurn | null,
  plan: TurnPlan,
): Promise<void> {
  const t = new Turn(agent, key, session, turn, inputs, initiative, flags, signal, intent, plan);
  let text: string;
  let outcome: TurnOutcome;
  try {
    try {
      text = await t.respond();
      outcome = t.outcome(text);
    } catch (error) {
      if (signal.aborted) return;
      agent.log.warn({ turn, context: contextId(key), error: errorMessage(error) }, "turn failed");
      text = await t.fallback();
      outcome = { type: "error", error: errorMessage(error) };
    }
  } finally {
    // Every way out of a turn: the Floor frees the mic once its lines settled too.
    t.ended();
  }
  if (signal.aborted) return;
  agent.ctx.publish({ type: "agent_turn_completed", data: { turn, context: key, text } }, { turn });
  agent.publishOutcome(t.outcomeRecord(outcome));
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
  /** Her own state (the trusted system part), one entry per block. */
  self: string[];
  /** The agent's own data blocks (people present, initiative hint, intent), rendered. */
  own: string[];
  /** Contributor sections, rendered within their budgets. */
  sections: string[];
  /** What the compiler did with each block (for the saved prompt). */
  compiled: CompiledBlock[];
  /** For the decision trace. */
  reasons: string[];
}

/** How soon a corrective call in voice must start, or the first answer stands. */
const VOICE_CORRECTION_MS = 4_000;

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

/** One line through the output review: `aloud` when the written text is what TTS gets. */
type Safe = (text: string, spoken: string | null, aloud: boolean) => SafeLine;

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
   * here until the next line (or a pause, an emotion change, the end). `sent`: the line was
   * spoken already (`voiceFirst`), as this; the written text only becomes its subtitle.
   */
  #pair: { spoken: string; text: string; sent: string | null } | null = null;
  /**
   * How this reply pairs lines and sentences, from whichever came first: `line` (as asked:
   * `<voice>…</voice>written`, lines may go out early) or `written` (`written<voice>…</voice>`).
   */
  #order: "line" | "written" | null = null;

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
    readonly prepare:
      | ((text: string, spoken?: string, emotion?: string | null) => void)
      | null = null,
    /** She is heard in another language and writes `<voice>` lines (`VoiceSink.speaksIn`). */
    readonly bilingual = false,
    /** A `<voice>` line written first goes out as soon as it is complete. */
    readonly voiceFirst = false,
    /** Called with every submitted line (output counting, latency). */
    readonly onOutput: (() => void) | null = null,
    /** A line spoken first got its written sentence (the subtitle and history text). */
    readonly onSubtitle: ((spoken: string, written: string) => void) | null = null,
    /** The main line's gate: `false`, and the sentence does not go out now. */
    readonly screen: ((line: HeldLine) => boolean) | null = null,
    /** Every sentence passes here before anything is done with it. */
    readonly safe: Safe = (text, spoken) => safeOutgoing(null, { path: "reply", text, spoken }),
  ) {}

  /** Her speech was interrupted, or she gave way: nothing more is said. */
  stopped(): boolean {
    return this.flags.interrupted || this.flags.yielded === true;
  }

  /** Says a sentence the gate held. */
  async release(line: HeldLine): Promise<void> {
    await this.#say(line.text, line.spoken ?? undefined, line.emotion, true, line.blocked);
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
    this.#order ??= "written";
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
    if (line.trim() === "") return;
    this.#order ??= "line";
    const sent = this.voiceFirst && this.#order === "line" ? await this.#sayLine(line) : null;
    this.#pair = { spoken: line, text: "", sent };
  }

  async #endPair(): Promise<void> {
    const pair = this.#pair;
    if (pair === null) return;
    this.#pair = null;
    if (pair.sent !== null) {
      const written = this.safe(cleanReply(pair.text, this.names), null, false).text.trim();
      if (written === "") return;
      this.spoken += written;
      this.onSubtitle?.(pair.sent, written);
      return;
    }
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

  /**
   * Speaks a `<voice>` line before its written sentence exists: the line itself is the text
   * of the action (handed to the sink as its own spoken words, so nothing is translated).
   * Returns what was said (`null`: nothing).
   */
  async #sayLine(line: string): Promise<string | null> {
    if (this.stopped()) return null;
    const safe = this.safe(cleanReply(line, this.names), null, true);
    const said = safe.text.replace(/[ \t]{2,}/g, " ").trim();
    if (!isSpeakable(said)) return null;
    this.prepare?.(said, said, this.#emotion);
    await this.#submit(said, safe.blocked);
    return said;
  }

  async #submit(text: string, blocked: string | null): Promise<void> {
    const action = newAction(
      this.lane,
      this.priority,
      { type: "speak", context: this.context, text, emotion: this.#emotion },
      { ttl: this.ttlMs, turn: this.turn, blocked },
    );
    try {
      await guard(this.sink.submit(action), this.signal);
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new TurnError(`submitting speech: ${errorMessage(error)}`, { cause: error });
    }
    this.flags.queued = true;
    this.flags.sentences += 1;
    this.onOutput?.();
  }

  async #say(
    sentence: string,
    spoken?: string,
    emotion = this.#emotion,
    screened = false,
    held: string | null | undefined = null,
  ): Promise<void> {
    if (this.stopped()) return;
    const voiced = spoken === undefined ? "" : cleanReply(spoken, this.names).trim();
    const safe = this.safe(
      cleanReply(sentence, this.names),
      voiced === "" ? null : voiced,
      voiced === "",
    );
    const blocked = safe.blocked ?? held ?? null;
    // Links taken out may leave double spaces behind.
    const text = safe.text.replace(/[ \t]{2,}/g, " ");
    if (!isSpeakable(text)) return;
    // Her reasoning is no sentence to say (leak.ts).
    if (looksLikeReasoning(text)) return;
    // The filtered line is said as it is: there is nothing to translate.
    const said = (safe.spoken ?? (safe.blocked === null ? "" : text)).trim();
    const line = { text, spoken: said === "" ? null : said, emotion, blocked };
    if (!screened && this.screen !== null && !this.screen(line)) return;
    this.prepare?.(text, said === "" ? undefined : said, emotion);
    const action = newAction(
      this.lane,
      this.priority,
      { type: "speak", context: this.context, text, emotion },
      { ttl: this.ttlMs, turn: this.turn, blocked },
    );
    try {
      await guard(this.sink.submit(action), this.signal);
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new TurnError(`submitting speech: ${errorMessage(error)}`, { cause: error });
    }
    this.flags.queued = true;
    this.flags.sentences += 1;
    this.spoken += text;
    this.onOutput?.();
  }
}

/**
 * Text replies go out line by line while the model writes (a line break outside code blocks
 * ends a message). A line that claims something only a tool does, with nothing backing it
 * (claims.ts), is held back (with the rest of the response), so the reminder in `#produce` can
 * still replace it.
 */
class TextSegments {
  /** UTF-16 offset into the step's text up to which it was handled. */
  #sent = 0;
  #held = false;

  constructor(
    readonly send: (text: string) => Promise<void>,
    readonly hold: (text: string) => boolean,
  ) {}

  /** A new model response starts. */
  step(): void {
    this.#sent = 0;
    this.#held = false;
  }

  /** Sends the complete lines written so far. */
  async update(expression: Expression): Promise<void> {
    if (this.#held || expression.silence) return;
    const text = expression.text;
    let cut = -1;
    let fenced = false;
    for (let i = 0; i < text.length; i++) {
      if (text.startsWith("```", i)) {
        fenced = !fenced;
        i += 2;
      } else if (!fenced && text[i] === "\n" && i >= this.#sent) {
        cut = i;
      }
    }
    if (cut < 0) return;
    const piece = text.slice(this.#sent, cut);
    if (this.hold(piece)) {
      this.#held = true;
      return;
    }
    this.#sent = cut + 1;
    if (piece.trim() !== "") await this.send(piece);
  }

  /** What was not sent yet of `expression`. */
  rest(expression: Expression): string {
    return expression.text.slice(this.#sent);
  }
}

/**
 * `shown` (what the prompt will show) with a parent for every reply whose parent is outside it:
 * the session keeps more lines than the prompt shows, and `replyParents` skips parents the session
 * has, so a reply to an older line would otherwise reach her with nothing to say what it answers.
 */
export function withOlderParents(
  shown: readonly HistoryEntry[],
  lookup: (id: string) => HistoryEntry | undefined,
  around: (id: string) => { before: HistoryEntry[]; after: HistoryEntry[] } = () => ({
    before: [],
    after: [],
  }),
): HistoryEntry[] {
  const ids = new Set(shown.flatMap((e) => (e.id === null ? [] : [e.id])));
  return shown.map((e) => {
    if (e.replyTo == null || ids.has(e.replyTo) || (e.parents?.length ?? 0) > 0) return e;
    const parent = lookup(e.replyTo);
    if (parent === undefined) return e;
    return { ...e, parents: [{ ...parent, parents: [], around: around(e.replyTo) }] };
  });
}

/**
 * `history` with the messages this turn answers marked `current` (copies; the session is
 * untouched); `verbs` says how the focus block introduces each (`Owen 問你:…`).
 */
export function markCurrent(
  history: readonly HistoryEntry[],
  inputs: readonly Pick<IncomingMessage, "id">[],
  verbs: ReadonlyMap<string, string> = new Map(),
): HistoryEntry[] {
  const ids = new Set(inputs.map((m) => m.id.id));
  return history.map((e) => {
    if (e.id === null || !ids.has(e.id)) return e;
    const verb = verbs.get(e.id);
    return verb === undefined ? { ...e, current: true } : { ...e, current: true, focusVerb: verb };
  });
}

/** How the focus block introduces each focus message: `問你` first, then `接著說`. */
export function focusVerbs(selection: FocusSelection): Map<string, string> {
  const seen = new Set<string>();
  const out = new Map<string, string>();
  selection.focus.forEach((m, i) => {
    const who = `${m.author.account.platform}:${m.author.account.id}`;
    out.set(m.id.id, focusVerb(selection.kinds[i] ?? null, !seen.has(who)));
    seen.add(who);
  });
  return out;
}

/** Cuts `text` to `maxChars` characters (plus `…`). */
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
  /** Messages sent / sentences submitted. */
  #parts = 0;
  /** When the first of them went out (clock ms). */
  #firstOutputAt: number | null = null;
  /** The reasoning level of the reply (`null` until generated). */
  #level: ReasoningLevel | null = null;
  /** Messages a text reply of this turn quoted already. */
  #quotedIds = new Set<string>();
  /** The focus messages as the prompt numbered them (`[回覆 N]`). */
  #replyTargets: readonly HistoryEntry[] = [];
  /** The compressed prompt of this turn, saved once the reply is out. */
  #saved: SavedPrompt | null = null;
  /** Prompt tokens of the first model response, as the provider reported them. */
  #promptTokens: number | null = null;
  /** The notices she was told in this turn (they may back what she says she did). */
  #notices: readonly Notice[] = [];
  /** Tools of this turn that answered without an error. */
  readonly #succeeded = new Set<string>();
  /** `pipeline = "v3"`: this turn of the main line. */
  readonly #main: MainTurn | null;
  /** The router says a fallback model is answering: its words are reviewed as such. */
  #fallback = false;

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
    readonly intent: IntentTurn | null,
    readonly plan: TurnPlan,
  ) {
    this.voice = key.kind === "voice";
    this.social = agent.social();
    const main = agent.mainline;
    this.#main = main === null ? null : new MainTurn(main, agent, turn, key, this.#claim());
  }

  /** What the Floor knows this turn as. */
  #claim(): MainClaim {
    const i = this.initiative;
    const first = this.#focused[0];
    const reason = this.plan.focus.reason;
    let kind: FloorClaimKind;
    if (this.intent !== null) kind = "wish";
    else if (i?.claim !== undefined) kind = i.claim;
    else if (reason === "addressed") kind = "addressed";
    else if (reason === "reply_to_her") kind = "reply";
    else if (reason === "ambient") kind = "ambient";
    else if (reason === "notice") kind = "result";
    else kind = "notable";
    const spoken = first === undefined ? false : this.session.entry(first.id.id)?.spoken === true;
    const answers =
      first === undefined
        ? null
        : {
            key: spoken
              ? `voice:utterance:${first.id.id}`
              : `msg:${first.id.context.platform}:${first.id.id}`,
            repeat_after_ms: 0,
            revision: 1,
          };
    const proposal =
      this.intent !== null
        ? { id: this.intent.intent.id, tool: this.intent.tool ?? null }
        : (i?.proposal ?? null);
    return {
      kind,
      attention: i?.attention ?? answers,
      cause: this.agent.mainline?.causeOf(first?.id.id) ?? null,
      muted: this.intent?.muted === true,
      proposal,
      chain: i?.chain ?? null,
    };
  }

  /** Generation is over, however it went. */
  ended(): void {
    this.#main?.ended();
  }

  /**
   * The call failed: someone waiting still gets a fixed line (§21), and nothing that was already
   * said is repeated. What she says on her own just does not happen.
   */
  async fallback(): Promise<string> {
    const main = this.#main;
    if (main === null || !main.owed || this.#parts > 0 || main.claim.muted) return "";
    if (!main.main.takeFallback(this.key)) return "";
    const lines =
      main.claim.kind === "result"
        ? [FALLBACK_RESULT_LINE]
        : main.claim.kind === "urgent"
          ? [FALLBACK_URGENT_LINE]
          : FALLBACK_LINES;
    const line =
      lines[Math.floor(this.agent.random.nextF32() * lines.length)] ?? FALLBACK_RESULT_LINE;
    try {
      return await this.#canned(line, main.claim.kind === "addressed", null);
    } catch (error) {
      this.agent.log.warn({ turn: this.turn, error: errorMessage(error) }, "no fixed line either");
      return "";
    }
  }

  /** One line of this turn through the output review. */
  #safe(text: string, spoken: string | null = null, aloud = false): SafeLine {
    // A `[回覆 N]` mark is for the text sink; nothing reads or shows it (text paths take it first).
    return safeOutgoing(this.agent.ctx.services.get(ModerationKey), {
      path: this.#fallback ? "fallback" : "reply",
      text: takeReplyMark(text).text,
      spoken: spoken === null ? null : takeReplyMark(spoken).text,
      aloud,
      context: this.key,
      turn: this.turn,
    });
  }

  /** The messages the reply answers (all inputs when nothing was selected). */
  get #focused(): readonly IncomingMessage[] {
    const focus = this.plan.selection?.focus ?? [];
    return focus.length > 0 ? focus : this.inputs;
  }

  /** The `[llm.reasoning]` purpose of the reply. */
  #reasoningPurpose(): string {
    if (this.voice) return "chat_voice";
    return this.intent !== null ? "chat_intent" : "chat_text";
  }

  /** Something went out (a message, a sentence). */
  #output(): void {
    this.#parts += 1;
    if (this.#firstOutputAt === null) {
      this.#firstOutputAt = this.#now;
      if (this.voice) this.agent.focusBoard.phase(this.turn, "speaking");
    }
  }

  /** The outcome of a turn that ran to its end. */
  outcome(text: string): TurnOutcome {
    if (this.voice && this.flags.interrupted) {
      return { type: "cancelled", cause: "barge_in", by: this.agent.bargedBy(this.turn) };
    }
    if (this.#parts > 0 || text.trim() !== "") return { type: "sent", parts: this.#parts };
    return { type: "silence" };
  }

  outcomeRecord(outcome: TurnOutcome): TurnOutcomeRecord {
    const f = this.plan.focus;
    const last = this.#focused.at(-1);
    const latency =
      this.#firstOutputAt === null || last === undefined
        ? null
        : Math.max(this.#firstOutputAt - timestampMs(last.ts), 0);
    return {
      turn: this.turn,
      context: this.key,
      reason: f.reason,
      outcome,
      addressed_by: [...f.addressed_by],
      focus: f.focus.map((m) => ({ ...m })),
      restarts: f.restarts,
      reasoning: this.#level,
      latency_ms: latency,
      at: toTimestamp(this.#now),
    };
  }

  get #now(): number {
    return this.agent.ctx.clock.now();
  }

  #priority(direct: boolean): Priority {
    return direct ? "direct" : "initiative";
  }

  /** What she decided to do, for the data message. */
  #intentData(): IntentData | null {
    const i = this.intent;
    if (i === null) return null;
    return {
      capability: i.intent.capability,
      // The main line has to do it itself, so it needs to know with what.
      summary: typeof i.tool === "string" ? `${i.summary ?? ""}(工具 ${i.tool})` : i.summary,
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
      this.#main?.silent(reasons.at(-1) ?? "");
      return "";
    }
    const refused = this.#main?.take() ?? null;
    if (refused !== null) {
      reasons.push(`floor: ${refused}`);
      this.#publishDecision(false, score, reasons);
      this.#main?.silent(refused);
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
    const [extras, looked, files] = await Promise.all([
      this.#extras(),
      this.#lookAround(),
      this.#readFiles(),
    ]);
    reasons.push(...extras.reasons);
    const seen = looked.filter((p) => p.type === "image_url").length;
    if (seen > 0) reasons.push(`looking at ${seen} image(s)`);
    if (files.length > 0) reasons.push(`reading ${files.length} file(s)`);
    const images = [...files, ...looked];
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
        // What came with the reply goes in first, so a slow or failed fetch never leaves the
        // reply without the line it answers; a fetched chain replaces it.
        const quoted = quotedParent(this.agent, input);
        if (quoted !== null) this.session.setParents(input.id.id, [quoted]);
        // The parent chain and the lines around the direct parent, both within one timeout.
        const h = cfg.history;
        const [chainRead, aroundRead] = await Promise.allSettled([
          timeout(h.timeout_ms, this.signal, (signal) =>
            replyParents(this.agent, this.session, input, signal),
          ),
          timeout(h.timeout_ms, this.signal, (signal) =>
            fetchAround(
              this.agent,
              ref.context,
              ref.id,
              h.reply_context_before,
              h.reply_context_after,
              signal,
            ),
          ),
        ]);
        this.signal.throwIfAborted();
        if (chainRead.status === "rejected") {
          this.agent.log.warn(
            { turn: this.turn, error: errorMessage(chainRead.reason), quoted: quoted !== null },
            "could not fetch reply parents",
          );
        }
        const chain =
          chainRead.status === "fulfilled" && chainRead.value.length > 0
            ? chainRead.value
            : quoted
              ? [quoted]
              : [];
        const direct = chain.at(-1);
        if (direct !== undefined && aroundRead.status === "fulfilled") {
          const keep = (e: HistoryEntry) => !this.#hidden(e) && e.id !== input.id.id;
          chain[chain.length - 1] = {
            ...direct,
            around: {
              before: aroundRead.value.before.filter(keep),
              after: aroundRead.value.after.filter(keep),
            },
          };
        }
        if (chain.length > 0) this.session.setParents(input.id.id, chain);
        return chain.at(-1) ?? null;
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

  /**
   * The files of the messages she answers, read in the sandbox (files.ts). Best effort: a
   * failure only costs the file.
   */
  async #readFiles(): Promise<ContentPart[]> {
    const cfg = this.agent.config.files;
    const services = this.agent.ctx.services;
    const reader = services.get(FileReaderKey);
    if (!cfg.enabled || cfg.max_files === 0 || reader === undefined || this.inputs.length === 0) {
      return [];
    }
    const picked = selectFiles(this.inputs, reader, services.get(AuthorizerKey), cfg);
    if (picked.length === 0) return [];
    return await fileParts(picked, reader, this.signal, (name, error) =>
      this.agent.log.warn({ file: name, error }, "could not read file"),
    );
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

  /** The session lines around `id` (config counts), without hidden ones. */
  #shownAround(id: string): { before: HistoryEntry[]; after: HistoryEntry[] } {
    const h = this.agent.config.history;
    const found = this.session.around(id, h.reply_context_before, h.reply_context_after);
    const keep = (e: HistoryEntry) => !this.#hidden(e);
    return { before: found.before.filter(keep), after: found.after.filter(keep) };
  }

  /** A session line by id, unless hidden from her prompt (`#hidden`). */
  #shownEntry(id: string): HistoryEntry | undefined {
    const entry = this.session.entry(id);
    return entry === undefined || this.#hidden(entry) ? undefined : entry;
  }

  /**
   * The message her tools act for: the latest one that @-mentions her or replies to her, else
   * the latest one. Someone chatting right after a request must not become its requester.
   */
  #requester(): IncomingMessage | undefined {
    const pool = this.#focused;
    return (
      pool.findLast((m) => m.mentions_self || m.reply_to_self) ??
      pool.at(-1) ??
      (this.#main?.claim.chain?.requester as IncomingMessage | undefined)
    );
  }

  /** Who a tool of the main line acts for: the speakers, or who the turn it follows answered. */
  #askers(): AccountRef[] {
    const authors = this.#authors();
    if (authors.length > 0) return authors;
    const requester = this.#main?.claim.chain?.requester as IncomingMessage | undefined;
    return requester === undefined ? [] : [requester.author.account];
  }

  /**
   * Her talkativeness here, shifted by the lessons that apply to this place and these speakers
   * (`LessonsKey`, e.g. "阿明不喜歡被打斷" makes her less likely to chime in while he talks).
   */
  #talkativeness(): TalkLevel | null {
    const base = this.agent.talkativeness(this.key);
    const floor = this.agent.config.attention.talk_floor;
    // Her feelings (`AffectSnapshot.biases`) shift it too, instead of the attention multipliers.
    const bias = this.agent.ctx.services.get(AffectStateKey)?.snapshot().biases.talkativeness ?? 0;
    const lessons = this.agent.ctx.services.get(LessonsKey);
    const people = this.#authors().flatMap((a) => {
      const p = this.social?.attitude(a)?.person ?? null;
      return p === null ? [] : [p];
    });
    const shift = (lessons?.talkShift(this.key, people) ?? 0) + bias;
    if (shift === 0) return flooredTalk(base, base, floor);
    // Without her own setting, the shift moves the level's default (the level caps the result).
    const usual = this.agent.ceiling(this.key)?.defaultTalk ?? 0.5;
    const level = Math.min(Math.max((base?.level ?? usual) + shift, 0), 1);
    const scope = `${base?.scope ?? "default"}${lessons ? "+lessons" : ""}${bias !== 0 ? "+affect" : ""}`;
    return flooredTalk({ level, scope }, base, floor);
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
    const voiceCfg = cfg.voice;
    let attentionCfg: AttentionConfig;
    let maxShare: number;
    if (this.voice) {
      attentionCfg = {
        ...cfg.attention,
        llm_check: voiceCfg.llm_check,
        gray_low: voiceCfg.gray_low,
      };
      maxShare = voiceCfg.max_share_of_recent;
    } else {
      attentionCfg = cfg.attention;
      maxShare = cfg.attention.max_share_of_recent ?? profileShare;
    }
    // §2: asking a model whether to speak is close to a coin toss; the Floor decides by rules.
    if (this.#main !== null) attentionCfg = { ...attentionCfg, llm_check: false };
    const voice: VoiceAttention | null = this.voice
      ? {
          someoneSpeaking: this.session.someoneSpeaking(),
          questionWindowMs: voiceCfg.question_window_ms,
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
      reasoning_purpose: "fast",
      session: `${this.#llmSession()}-attention`,
    };
    // The voice gray-zone check is on the reply's critical path: never any reasoning. Text
    // checks use `[llm.reasoning] fast` (default off).
    if (this.voice) request.reasoning = "off";
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
  #about(): AccountRef[] {
    const out = [...this.#authors()];
    const about = [...(this.initiative?.about ?? [])];
    if (this.intent?.intent.about) about.push(this.intent.intent.about);
    for (const account of about) {
      if (!out.some((a) => sameAccount(a, account))) out.push(account);
    }
    return out;
  }

  /** The people present for the people block (speakers first, with their handles). */
  #present(speakers: readonly AccountRef[]): PresentPerson[] {
    const person = (account: AccountRef) => this.social?.attitude(account)?.person ?? null;
    const members = this.session.voiceMembers();
    const seen: { account: AccountRef; name: string }[] =
      this.voice && members.length > 0
        ? members.map((m) => ({ account: m.account, name: m.display_name }))
        : this.session
            .participants()
            .slice(0, MAX_PEOPLE)
            .map((p) => ({ account: p.account, name: p.displayName }));
    for (const account of speakers) {
      if (seen.some((p) => sameAccount(p.account, account))) continue;
      const name = this.#nameOf(account);
      if (name !== null) seen.push({ account, name });
    }
    return seen.map((p) => ({
      account: p.account,
      handle: this.agent.handleOf(p.account, p.name),
      person: person(p.account),
      speaker: speakers.some((a) => sameAccount(a, p.account)),
    }));
  }

  /**
   * Her own state (self blocks), the agent's own data blocks (people present, initiative hint,
   * intent) and the sections of prompt contributors, each within its budget.
   */
  async #extras(): Promise<Extras> {
    const extras: Extras = { self: [], own: [], sections: [], compiled: [], reasons: [] };
    const cfg = this.agent.config;
    const services = this.agent.ctx.services;
    const about = this.#about();
    const present = this.#present(about);
    if (this.#main !== null) await this.#mainMemory(extras, present, about);
    const self = services.get(SelfStateKey) ?? null;
    const affect = services.get(AffectStateKey) ?? null;
    // Her secret crush (the `self` module's; with person cards, W4's affect owns it).
    const crush = affect === null ? (self?.crush?.() ?? null) : null;
    const crushHere = crush !== null && present.some((p) => p.person === crush.person);
    const own = selfBlocks({
      context: this.key,
      now: this.#now,
      affect,
      activity: services.get(ActivityManagerKey)?.snapshot() ?? null,
      ledger: services.get(ArbiterKey)?.ledger(this.key) ?? null,
      goals: services.get(GoalAgendaKey)?.goals() ?? null,
      present: present.map((p) => p.handle),
      mood: this.agent.mood(),
      self,
      her: services.get(WorldStateKey)?.snapshot().her ?? null,
      unanswered: services.get(MindKey)?.unanswered?.(this.key) ?? [],
      // The owner's ceiling for this channel, so she knows it when asked to be quieter.
      level: levelHint(this.agent.handle.channelMode(this.key), this.key),
      notices: this.#takeNotices(),
      crushHere,
    });
    const selfChars = this.#main === null ? cfg.prompt.self_chars : cfg.mainline.self_chars;
    const selfBudget = budgetSelf(own, selfChars);
    extras.self = selfBudget.notes;
    extras.compiled.push(...selfBudget.compiled);

    const blocks: PromptBlock[] = [];
    const people = peopleBody(
      present,
      { affect, attitude: (a) => this.social?.attitude(a) ?? null, self },
      crushHere ? (crush?.person ?? null) : null,
    );
    if (people !== "") {
      blocks.push(ownBlock("people", this.voice ? VOICE_PRESENT_TITLE : PRESENT_TITLE, people, 0));
    }
    const hint = this.initiative?.hint.trim() ?? "";
    if (this.initiative !== null && hint !== "") {
      blocks.push(ownBlock(`initiative:${this.initiative.reason}`, INITIATIVE_TITLE, hint, 1));
    }
    const intent = this.#intentData();
    if (intent !== null) blocks.push(ownBlock("mind", INTENT_TITLE, intentBody(intent), 2));
    const flagged = flaggedBody(
      this.session.recent(FLAGGED_HISTORY).filter((e) => !this.#hidden(e)),
    );
    if (flagged !== "") blocks.push(ownBlock("flagged", FLAGGED_TITLE, flagged, 3));
    const mine = budgetBlocks(blocks, {
      total: UNLIMITED,
      budgets: cfg.prompt.budgets,
      defaultBudget: cfg.prompt.default_budget,
    });
    extras.own = mine.blocks;
    extras.compiled.push(...mine.compiled);

    const registry = services.get(PromptContributorsKey);
    if (!registry || registry.all().length === 0) return extras;
    const request = this.#promptRequest(about);
    // The main line reads memory through its layers (`#mainMemory`), not the V2 contributor.
    const skip =
      this.#main !== null && services.has(MemoryRetrievalKey) ? [MEMORY_CONTRIBUTOR] : [];
    const gathered = await gather(registry, request, cfg.contributor_timeout_ms, this.signal, skip);
    extras.reasons = gathered.reasons();
    const { data, superseded } = contributedData(gathered.sections);
    if (superseded.length > 0)
      extras.reasons.push(`rendered by the agent: ${superseded.join(", ")}`);
    const contributed = budgetBlocks(data, {
      total: this.#main === null ? cfg.max_context_chars : cfg.mainline.data_chars,
      budgets: cfg.prompt.budgets,
      defaultBudget: cfg.prompt.default_budget,
    });
    extras.sections = contributed.blocks;
    extras.compiled.push(...contributed.compiled);
    const cut = contributed.compiled.filter((b) => b.fate !== "kept");
    if (cut.length > 0) {
      extras.reasons.push(`context budgeted: ${cut.map((b) => `${b.key} ${b.fate}`).join(", ")}`);
    }
    return extras;
  }

  /** The example dialogues as one data block (`null`: none). */
  #examples(): string | null {
    const examples = this.agent.persona.examples().filter((e) => e.trim() !== "");
    if (examples.length === 0) return null;
    const cfg = this.agent.config.prompt;
    const { blocks } = budgetBlocks(
      [ownBlock("examples", EXAMPLES_TITLE, examples.join("\n\n"), 0)],
      {
        total: UNLIMITED,
        budgets: cfg.budgets,
        defaultBudget: cfg.default_budget,
      },
    );
    return blocks.length === 0 ? null : blocks.join("");
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
          : this.#focused.map((m) => `${m.author.display_name}: ${messageText(m)}`).join("\n");
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
    if (this.#main !== null)
      return await this.#speakMain(this.#main, direct, names, extras, images);
    const cfg = this.agent.config;
    const services = this.agent.ctx.services;
    const router = services.require(LlmRouterKey);
    const sink = services.require(ActionSinkKey);

    const voiceSink = this.voice ? services.get(VoiceSinkKey) : undefined;
    const core = this.agent.persona.corePrompt();
    const rules = rulesPrompt(this.voice, voiceSink?.speaksIn ?? null);
    const persona = core === "" ? rules : `${core}\n\n${rules}`;
    const situation = situationPrompt(
      {
        context: this.key,
        direct,
        notice: this.initiative?.reason === "notice",
        initiative: this.initiative?.hint ?? null,
        intent: this.intent !== null,
        speaksIn: voiceSink?.speaksIn ?? null,
        notes: extras.self,
      },
      new Date(this.#now),
    );
    const data = dataMessage([...extras.own, ...extras.sections]);
    const selection = this.plan.selection;
    const focusInputs = selection?.focus ?? [];
    const verbs = selection === null ? new Map<string, string>() : focusVerbs(selection);
    // What her conversation notes already cover is not repeated raw (a few lines always stay).
    const folded = services.get(ConversationStatesKey)?.get(this.key) ?? null;
    const marked = withOlderParents(
      markCurrent(
        afterFold(
          this.session.recent(cfg.prompt_history).filter((e) => !this.#hidden(e)),
          folded?.folded_up_to ?? null,
          cfg.history_after_fold,
        ),
        focusInputs,
        verbs,
      ),
      (id) => this.#shownEntry(id),
      (id) => this.#shownAround(id),
    );
    this.#replyTargets = focusEntries(marked);
    const messages = buildMessages(
      persona,
      situation,
      marked,
      data,
      {
        maxChars: cfg.max_prompt_chars,
        maxEntryChars: cfg.max_entry_chars,
        gapMs: cfg.time_gap_ms,
      },
      images,
      this.#examples(),
    );
    this.#saved = savedPrompt({
      turn: this.turn,
      context: this.key,
      at: toTimestamp(this.#now),
      reasoning: "off",
      blocks: extras.compiled,
      messages,
      maxChars: cfg.prompt.saved_message_chars,
    });

    const priority = this.#priority(direct);
    if (this.voice) {
      const [platform, scope] = voiceScope(this.key);
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
        voiceSink?.prepare
          ? (text, spoken, emotion) => voiceSink.prepare?.(this.key, text, spoken, emotion)
          : null,
        Boolean(voiceSink?.speaksIn),
        cfg.voice.voice_first,
        () => this.#output(),
        (spoken, written) => this.agent.noteSubtitle(this.key, this.turn, spoken, written),
        null,
        (text, spoken, aloud) => this.#safe(text, spoken, aloud),
      );
      await this.#produce(router, messages, priority, speech);
      this.#save();
      await this.#postAside(sink, this.#voicePosts(speech), priority);
      if (speech.spoken === "") this.agent.log.debug({ turn: this.turn }, "she stayed quiet");
      return speech.spoken;
    }

    const lane = textLane(this.key);
    // Typing is refreshed until the reply is ready; cancelling the turn stops it too.
    const typing = new AbortController();
    const stopTyping = () => typing.abort();
    this.signal.addEventListener("abort", stopTyping, { once: true });
    const typingLoop = this.#keepTyping(sink, lane, priority, typing.signal);
    // Complete lines go out while she writes, and what she writes alongside a tool call
    // ("好，我寫寫看，等我一下") goes out at once, so a slow tool never leaves the person waiting
    // in silence.
    const early: string[] = [];
    // Her reasoning is no reply (leak.ts).
    type Line = { text: string; blocked: string | null; n: number | null };
    const screen = new ReplyScreen<Line>();
    const send = async (raw: string) => {
      for (const part of splitByReplyMarks(raw)) {
        const mark = takeReplyMark(part);
        const safe = this.#safe(cleanReply(mark.text, names));
        const text = this.#linkMentions(safe.text);
        if (text === "") continue;
        const { send: now } = screen.push({ text, blocked: safe.blocked, n: mark.n });
        for (const item of now) {
          early.push(await this.#sendText(sink, item.text, direct, priority, item.blocked, item.n));
        }
      }
    };
    const offered = new Set(this.#toolSpecs().map((t) => t.name));
    const segments = new TextSegments(
      send,
      (text) => unbackedClaim(text, offered, this.#backing()) !== null,
    );
    const interim = async (e: Expression) => send(segments.rest(e));
    let expression: Expression;
    try {
      expression = await this.#produce(router, messages, priority, null, interim, segments);
      this.#save();
    } finally {
      typing.abort();
      this.signal.removeEventListener("abort", stopTyping);
      await typingLoop;
    }
    const flush = async () => {
      for (const item of screen.flush()) {
        early.push(await this.#sendText(sink, item.text, direct, priority, item.blocked, item.n));
      }
    };
    if (expression.isSilent()) {
      await flush();
      if (early.length === 0) this.agent.log.debug({ turn: this.turn }, "she chose silence");
      return early.join("\n");
    }
    await send(segments.rest(expression));
    await flush();
    return early.join("\n");
  }

  // ---- the main line ---------------------------------------------------------------------------

  /** The scheduler as this turn uses it. */
  #out(sink: ActionSink): ActionSink {
    const main = this.#main;
    if (main === null) return sink;
    return main.mouth(sink, () =>
      this.voice ? this.agent.audience(this.key) : this.plan.focus.addressed_by,
    );
  }

  /**
   * The memory layers of §11. Pinned sections that come from people go in as data, retrieved
   * memories too, with what she was told marked as such. Neither runs a model; a slow or broken
   * store costs the memories, never the turn.
   */
  async #mainMemory(
    extras: Extras,
    present: readonly PresentPerson[],
    about: AccountRef[],
  ): Promise<void> {
    const services = this.agent.ctx.services;
    const limit = this.agent.config.contributor_timeout_ms;
    const now = toTimestamp(this.#now);
    const where = {
      context: this.key,
      present: present.flatMap((p) => (p.person === null ? [] : [p.person])),
      accounts: present.map((p) => p.account),
      now,
    };
    const pinned = this.#main?.main.pinned() ?? null;
    if (pinned !== null) {
      try {
        const read = await timeout(limit, this.signal, () => pinned.pinned(where));
        for (const section of read.sections) {
          if (section.key === "commitments" || section.key === "people") {
            const body = section.lines.join("\n");
            extras.own.push(dataBlock(`pinned.${section.key}`, section.title, body));
          }
        }
      } catch (error) {
        if (this.signal.aborted) throw error;
        extras.reasons.push(`pinned memory skipped: ${errorMessage(error)}`);
      }
    }
    const retrieval = services.get(MemoryRetrievalKey);
    const text = this.#promptRequest(about).query;
    if (retrieval && text.trim() !== "") {
      try {
        const memories = await timeout(limit, this.signal, (signal) =>
          retrieval.retrieve({ ...where, text }, signal),
        );
        const body = retrieval.format(memories, now);
        if (body.trim() !== "") {
          const room = Math.floor(this.agent.config.mainline.data_chars / 2);
          extras.own.push(dataBlock("memory", "你記得的事", truncate(body, room)));
        }
      } catch (error) {
        if (this.signal.aborted) throw error;
        extras.reasons.push(`memories skipped: ${errorMessage(error)}`);
      }
    }
  }

  /** The tools on offer: what she can do, how to promise and how to change a running task. */
  #mainTools(main: MainTurn): ToolSpec[] {
    const cfg = this.agent.config;
    const depth = main.claim.chain?.depth ?? 0;
    if (!cfg.tools_enabled || depth > cfg.max_tool_steps) return [];
    const steerable = main.main.tasks().length > 0;
    const allowed = this.agent.ctx.services.get(DirectivesKey);
    const specs = allowed?.filterTools(this.#toolSpecs(), this.key) ?? this.#toolSpecs();
    return [...specs.map(slimTool), COMMIT_SPEC, ...(steerable ? [STEER_SPEC] : [])];
  }

  /** The prompt of §10.4. */
  #mainPrompt(
    main: MainTurn,
    extras: Extras,
    images: readonly ContentPart[],
    tools: readonly ToolSpec[],
    speaksIn: string | null,
  ): ChatMessage[] {
    const cfg = this.agent.config;
    const m = cfg.mainline;
    const line = main.main;
    const services = this.agent.ctx.services;
    const now = this.#now;
    const offset = -new Date(now).getTimezoneOffset();
    const core = this.agent.persona.corePrompt();
    const rules = mainRules(this.voice, speaksIn);
    const buckets = services.get(WorkingContextKey)?.buckets(this.key) ?? [];
    main.shown(line.commitments.overdue(this.key));
    const own = this.intent?.intent.id ?? main.claim.proposal?.id ?? null;
    const examples = m.examples_chars > 0 ? this.#examples() : null;
    const wishes = services.get(DirectivesKey)?.wishes(this.key) ?? [];
    const telling = [...line.hands.peekResults(ACTING_ALONE), ...line.hands.peekResults(this.key)];
    main.telling(telling);
    const data = [
      ...extras.own,
      ...extras.sections,
      contextData(buckets, m.context_entries),
      proposalData(
        // The turn's own proposal stays when it names a tool: its arguments are only here.
        line.proposals.open(this.key).filter((p) => p.id !== own || p.capability !== undefined),
        m.proposals,
      ),
      // What she did with nobody there (`ACTING_ALONE`) she hears of wherever she speaks next.
      resultData(telling),
      wishes.length === 0 ? null : dataBlock("viewers", "觀眾的要求", wishes.join("\n")),
      examples === null ? null : truncate(examples, m.examples_chars),
    ].filter((d): d is string => d !== null);
    const tail = tailSection({
      head: whenAndWhere(this.key, new Date(now), offset),
      kind: main.claim.kind,
      muted: main.claim.muted,
      notes: extras.self,
      state: contextState(buckets),
      tasks: line.tasks().map((t) => `${t.task}(${t.owner}):${t.text}`),
      recent: main.main.recent(this.key, m.recent_lines),
      actions: [...line.hands.recent(ACTING_ALONE, 2), ...line.hands.recent(this.key, 3)],
      speaksIn: this.voice ? speaksIn : null,
    });
    const selection = this.plan.selection;
    const verbs = selection === null ? new Map<string, string>() : focusVerbs(selection);
    const folded = services.get(ConversationStatesKey)?.get(this.key) ?? null;
    const history = withOlderParents(
      markCurrent(
        afterFold(
          this.session.recent(m.history_lines).filter((e) => !this.#hidden(e)),
          folded?.folded_up_to ?? null,
          Math.min(cfg.history_after_fold, m.history_lines),
        ),
        selection?.focus ?? [],
        verbs,
      ),
      (id) => this.#shownEntry(id),
      (id) => this.#shownAround(id),
    );
    this.#replyTargets = focusEntries(history);
    const build = (kept: readonly HistoryEntry[]) =>
      mainMessages({
        fixed: core === "" ? rules : `${core}\n\n${rules}`,
        pinned: pinnedSection(
          line.ownerRules(this.key),
          line.commitments.open(this.key),
          now,
          offset,
        ),
        data,
        history: kept,
        tail,
        transcript: {
          maxChars: m.history_chars,
          maxEntryChars: m.entry_chars,
          gapMs: cfg.time_gap_ms,
        },
        images,
      });
    return fitHistory(build, history, tools, m.prompt_tokens, m.history_floor);
  }

  /** The turn of `#generate` under the main line. */
  async #speakMain(
    main: MainTurn,
    direct: boolean,
    names: readonly string[],
    extras: Extras,
    images: readonly ContentPart[],
  ): Promise<string> {
    const cfg = this.agent.config;
    const services = this.agent.ctx.services;
    const router = services.require(LlmRouterKey);
    const sink = this.#out(services.require(ActionSinkKey));
    const voiceSink = this.voice ? services.get(VoiceSinkKey) : undefined;
    const tools = this.#mainTools(main);
    const messages = this.#mainPrompt(main, extras, images, tools, voiceSink?.speaksIn ?? null);
    this.#saved = savedPrompt({
      turn: this.turn,
      context: this.key,
      at: toTimestamp(this.#now),
      reasoning: "off",
      blocks: extras.compiled,
      messages,
      maxChars: cfg.prompt.saved_message_chars,
    });
    const priority = this.#priority(direct);
    if (this.voice) {
      const [platform, scope] = voiceScope(this.key);
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
        voiceSink?.prepare
          ? (text, spoken, emotion) => voiceSink.prepare?.(this.key, text, spoken, emotion)
          : null,
        Boolean(voiceSink?.speaksIn),
        // A `<voice>` line first would be out before the gate can read the sentence it stands for.
        false,
        () => this.#output(),
        (spoken, written) => this.agent.noteSubtitle(this.key, this.turn, spoken, written),
        (line) => main.screen(line),
        (text, spoken, aloud) => this.#safe(text, spoken, aloud),
      );
      await this.#mainCall(main, router, messages, tools, priority, speech, null, null);
      this.#save();
      await this.#postAside(sink, this.#voicePosts(speech), priority);
      return speech.spoken;
    }
    const lane = textLane(this.key);
    const typing = new AbortController();
    const stopTyping = () => typing.abort();
    this.signal.addEventListener("abort", stopTyping, { once: true });
    const typingLoop = main.claim.muted
      ? Promise.resolve()
      : this.#keepTyping(sink, lane, priority, typing.signal);
    const early: string[] = [];
    // Her reasoning is no reply (leak.ts).
    type Line = { text: string; blocked: string | null; n: number | null };
    const screen = new ReplyScreen<Line>();
    const out = async (item: Line) => {
      early.push(await this.#sendText(sink, item.text, direct, priority, item.blocked, item.n));
    };
    const send = async (raw: string) => {
      for (const part of splitByReplyMarks(raw)) {
        if (main.claim.muted) return;
        const mark = takeReplyMark(part);
        const safe = this.#safe(cleanReply(mark.text, names));
        const text = this.#linkMentions(safe.text);
        if (text === "") continue;
        main.sent(text);
        const was = screen.dropped;
        const { send: now, retracted } = screen.push({ text, blocked: safe.blocked, n: mark.n });
        if (retracted) main.said.pop();
        if (screen.dropped && !was) {
          this.agent.log.warn(
            { turn: this.turn },
            "her reasoning was written as the reply: dropped",
          );
        }
        for (const item of now) await out(item);
      }
    };
    const segments = new TextSegments(send, (text) => main.holdsText(text));
    try {
      await this.#mainCall(main, router, messages, tools, priority, null, segments, send);
      if (!main.claim.muted) for (const item of screen.flush()) await out(item);
      this.#save();
    } finally {
      typing.abort();
      this.signal.removeEventListener("abort", stopTyping);
      await typingLoop;
    }
    return early.join("\n");
  }

  /** Streams one response. A model that does not start in time counts as failed. */
  async #mainStream(
    main: MainTurn,
    router: LlmRouter,
    request: ChatRequest,
    speech: Speech | null,
    segments: TextSegments | null,
    firstTokenMs: number | null = null,
  ): Promise<Step> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.signal.reason);
    if (this.signal.aborted) onAbort();
    this.signal.addEventListener("abort", onAbort, { once: true });
    const deadline =
      (this.#level ?? "off") === "off"
        ? main.config.first_token_timeout_ms
        : main.config.reasoning_first_token_timeout_ms;
    const timer = setTimeout(
      () => controller.abort(new TimeoutError()),
      firstTokenMs === null ? deadline : Math.min(firstTokenMs, deadline),
    );
    try {
      return await this.#streamStep(router, request, speech, segments, controller.signal, () =>
        clearTimeout(timer),
      );
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * One call of the main line: what she says goes out while it is written, then her words are
   * compared with her actions. Only a claim with nothing behind it costs a second call (claims.ts:
   * the last resort, as §10.1 has it).
   */
  async #mainCall(
    main: MainTurn,
    router: LlmRouter,
    initial: ChatMessage[],
    tools: ToolSpec[],
    priority: Priority,
    speech: Speech | null,
    segments: TextSegments | null,
    send: ((text: string) => Promise<void>) | null,
  ): Promise<void> {
    const cfg = this.agent.config;
    const messages = [...initial];
    main.offered(tools.map((t) => t.name));
    const offered = new Set(tools.map((t) => t.name));
    let prompt: string | null = null;
    /** The response a corrective call stands in for: what is left if that call fails. */
    let before: Step | null = null;
    for (;;) {
      const request: ChatRequest = {
        messages: [...messages],
        tools,
        temperature: cfg.temperature,
        max_tokens: cfg.max_tokens,
        reasoning_purpose: this.#reasoningPurpose(),
        session: this.#llmSession(),
      };
      this.#level ??= router.reasoningFor("chat", request);
      segments?.step();
      let step: Step;
      let fellBack = false;
      try {
        // In voice the person waits in silence: a correction starts soon or not at all.
        const deadline = before !== null && this.voice ? VOICE_CORRECTION_MS : null;
        step = await this.#mainStream(main, router, request, speech, segments, deadline);
      } catch (error) {
        if (before === null || this.signal.aborted) throw error;
        this.agent.log.warn(
          { turn: this.turn, error: errorMessage(error) },
          "the corrective call failed; the first answer stands",
        );
        step = before;
        fellBack = true;
      }
      before = null;
      const { expression, raw, calls } = step;
      if (speech?.stopped()) {
        this.agent.log.debug({ turn: this.turn }, "speech interrupted, generation stopped");
        return;
      }
      if (segments !== null && !expression.isSilent() && !fellBack) {
        for (const text of sentences(segments.rest(expression))) {
          main.gate.hold({ text, spoken: null, emotion: null });
        }
      }
      // A tool written as a tag runs nothing (it may be words she was talked into). She is asked
      // once, in the same turn, to call it or not claim it; the lines she said stand.
      prompt ??= promptText(initial);
      const called = calls.map((c) => c.name);
      const written = fellBack ? [] : toolsWrittenAsText(expression.tools, offered, called, prompt);
      main.wrote(written);
      const depth = main.claim.chain?.depth ?? 0;
      if (
        written.length > 0 &&
        calls.length === 0 &&
        depth < cfg.max_tool_steps &&
        main.takeCorrection()
      ) {
        this.agent.log.info(
          { turn: this.turn, tools: written },
          "asking her to call what she wrote",
        );
        before = step;
        messages.push(assistantMessage(raw, []));
        messages.push(userMessage(toolTextReminder(written)));
        continue;
      }
      const output = turnOutput(expression, calls, main.said);
      const outcome = main.finish(output);
      if (outcome.remind !== null) {
        messages.push(assistantMessage(raw, []));
        messages.push(userMessage(claimReminder(outcome.remind.tool)));
        continue;
      }
      for (const line of outcome.release) {
        if (speech !== null) {
          main.said.push({ text: line.text, voice: line.spoken, emotion: line.emotion });
          await speech.release(line);
        } else await send?.(line.text);
      }
      // A model that gave nothing at all is no decision to be quiet.
      if (main.owed && main.said.length === 0 && !output.silence && output.actions.length === 0) {
        throw new TurnError("the model returned nothing");
      }
      main.conclude(
        { ...output, say: [...main.said] },
        (tool, id, args, signal) =>
          this.#hand({ id, name: tool, arguments: args }, priority, signal),
        this.#requester(),
      );
      return;
    }
  }

  /** One action, in the hands: it may outlive this turn. */
  async #hand(call: ToolCall, priority: Priority, signal: AbortSignal): Promise<Run> {
    let data: JsonValue = null;
    const [ok, full] = await this.#tryTool(call, priority, signal, (d) => {
      data = d;
    });
    const text = truncate(full, this.agent.config.max_tool_result_chars);
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
            result: text,
          },
        },
      },
      { turn: this.turn },
    );
    return { ok, text, data };
  }

  /** Keeps the compressed prompt of this turn (sampled, see `[modules.agent.prompt]`). */
  #save(): void {
    const saved = this.#saved;
    if (saved === null) return;
    this.#saved = null;
    saved.reasoning = this.#level ?? "off";
    saved.prompt_tokens = this.#promptTokens;
    this.agent.savePrompt(saved);
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

  /** What a voice reply posts to the channel's text chat (`text_echo`, `text_aside`). */
  #voicePosts(speech: { spoken: string; aside: readonly string[] }): string[] {
    const cfg = this.agent.config.voice;
    return [
      ...(cfg.text_echo && speech.spoken.trim() !== "" ? [speech.spoken] : []),
      ...(cfg.text_aside ? speech.aside : []),
    ];
  }

  /**
   * What she said (`voice.text_echo`) and the links and code from her spoken reply
   * (`voice.text_aside`), posted to the voice channel's text chat (same channel id).
   * Best effort: a failure is only logged.
   */
  async #postAside(sink: ActionSink, aside: readonly string[], priority: Priority): Promise<void> {
    const cfg = this.agent.config;
    if (aside.length === 0 || this.flags.interrupted) return;
    const chat: ContextKey = { ...this.key, kind: "channel" };
    const safe = safeOutgoing(this.agent.ctx.services.get(ModerationKey), {
      path: "aside",
      text: aside.join("\n"),
      context: chat,
      turn: this.turn,
    });
    const text = truncate(safe.text, Math.max(cfg.max_message_chars, 1));
    if (text === "") return;
    const action = newAction(
      textLane(chat),
      priority,
      { type: "send_message", context: chat, message: { text, reply_to: null } },
      { ttl: cfg.reply_ttl_ms, turn: this.turn, blocked: safe.blocked },
    );
    try {
      await guard(sink.submit(action), this.signal);
    } catch (error) {
      if (this.signal.aborted) throw error;
      this.agent.log.warn({ turn: this.turn, error: errorMessage(error) }, "could not post links");
    }
  }

  /**
   * Which message a reply quotes. Her `[回覆 N]` names one of the numbered focus messages, each
   * quoted once. Without it: the first focus message, once a turn, but only when one person is
   * talking to her; with several, an unmarked reply quotes nobody rather than the wrong person.
   */
  #replyTarget(mark: number | null): MessageRef | null {
    if (mark !== null) {
      const id = this.#replyTargets[mark - 1]?.id ?? null;
      if (id === null || this.#quotedIds.has(id)) return null;
      this.#quotedIds.add(id);
      return this.#focused.find((m) => m.id.id === id)?.id ?? { context: this.key, id };
    }
    if (this.#quotedIds.size > 0 || severalPeople(this.#focused.map((m) => m.author))) return null;
    const ref = this.#focused[0]?.id ?? null;
    if (ref !== null) this.#quotedIds.add(ref.id);
    return ref;
  }

  /** Sends `text` (split into several messages if long) as her reply. */
  async #sendText(
    sink: ActionSink,
    text: string,
    direct: boolean,
    priority: Priority,
    blocked: string | null = null,
    mark: number | null = null,
  ): Promise<string> {
    const cfg = this.agent.config;
    const lane = textLane(this.key);
    const replyTo =
      cfg.reply_reference && direct && this.key.kind !== "dm" ? this.#replyTarget(mark) : null;
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
        { ttl: cfg.reply_ttl_ms, turn: this.turn, blocked },
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
      this.#output();
    }
    return text;
  }

  /** Budget exhausted: says (or writes) the constant out-of-energy line. */
  async #sayExhausted(direct: boolean): Promise<string> {
    return await this.#canned(EXHAUSTED_LINE, direct, "tired");
  }

  /** Says (or writes) a constant line. No model is involved. */
  async #canned(line: string, direct: boolean, emotion: string | null): Promise<string> {
    const sink = this.#out(this.agent.ctx.services.require(ActionSinkKey));
    const priority = this.#priority(direct);
    const safe = this.#safe(line, null, this.voice);
    if (!this.voice) {
      return await this.#sendText(sink, safe.text, direct, priority, safe.blocked);
    }
    const [platform, scope] = voiceScope(this.key);
    const action = newAction(
      voiceLane(platform, scope),
      priority,
      { type: "speak", context: this.key, text: safe.text, emotion },
      { ttl: this.agent.config.voice.speak_ttl_ms, turn: this.turn, blocked: safe.blocked },
    );
    try {
      await guard(sink.submit(action), this.signal);
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new TurnError(`submitting speech: ${errorMessage(error)}`, { cause: error });
    }
    this.#output();
    return safe.text;
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
    segments: TextSegments | null = null,
  ): Promise<Expression> {
    const cfg = this.agent.config;
    // Reactive turns and the turns she starts herself act; initiative turns only talk.
    const toolsEnabled = cfg.tools_enabled && (this.inputs.length > 0 || this.intent !== null);
    const messages = [...initial];
    let earlier: Expression | null = null;
    let reminded = false;
    for (let step = 0; step <= cfg.max_tool_steps; step++) {
      const tools = toolsEnabled ? this.#toolSpecs() : [];
      const offered = tools.length > 0;
      const request: ChatRequest = {
        messages: [...messages],
        tools,
        temperature: cfg.temperature,
        max_tokens: cfg.max_tokens,
        // `[llm.reasoning]` chat_text / chat_voice / chat_intent (replies: off by default).
        reasoning_purpose: this.#reasoningPurpose(),
        session: this.#llmSession(),
      };
      this.#level ??= router.reasoningFor("chat", request);
      segments?.step();
      const { expression, raw, calls } = await this.#streamStep(router, request, speech, segments);
      if (speech?.stopped()) {
        this.agent.log.debug({ turn: this.turn }, "speech interrupted, generation stopped");
        return expression;
      }
      // She said she did something only a tool does ("我游過去了") and nothing backs it (no
      // accepted transition of this turn, no notice, not already so; claims.ts): once per turn
      // she is told it has not happened, and either does it or says so. In text the claim was
      // not sent yet and the corrected reply replaces it.
      if (calls.length === 0 && offered && !reminded && step < cfg.max_tool_steps) {
        const names = new Set(tools.map((t) => t.name));
        const claim = unbackedClaim(expression.text, names, this.#backing());
        // The same for a tool she wrote as a tag: it runs nothing, she is asked to call it.
        const written =
          claim === null
            ? toolsWrittenAsText(expression.tools, names, [], promptText(initial))
            : [];
        if (claim || written.length > 0) {
          reminded = true;
          this.agent.log.info(
            { turn: this.turn, tool: claim?.tool ?? written.join(",") },
            "she claimed an action without doing it",
          );
          messages.push(assistantMessage(raw, []));
          messages.push(userMessage(claim ? claimReminder(claim.tool) : toolTextReminder(written)));
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
  async #streamStep(
    router: LlmRouter,
    request: ChatRequest,
    speech: Speech | null,
    segments: TextSegments | null = null,
    signal: AbortSignal = this.signal,
    onFirst: (() => void) | null = null,
  ): Promise<Step> {
    const offeredTools = (request.tools?.length ?? 0) > 0;
    const stream = await guard(
      withLlmTag({ module: "agent", turn: this.turn, label: "reply" }, () =>
        router.stream("chat", request, signal),
      ),
      signal,
    );
    this.#fallback = stream.fallback;
    const iterator = stream[Symbol.asyncIterator]();
    const parser = new ExpressionParser();
    const expression = new Expression();
    let raw = "";
    const calls: ToolCall[] = [];
    let finished = false;
    try {
      for (;;) {
        const next: IteratorResult<StreamEvent> = await guard(iterator.next(), signal);
        onFirst?.();
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
          if (segments) await segments.update(expression);
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
          if (event.type === "done" && event.usage)
            this.#promptTokens ??= event.usage.prompt_tokens;
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
    // A tool written as a tag is only logged, never run: text she was talked into repeating must
    // not become an action. Tools run from native tool calls alone.
    if (expression.tools.length > 0) {
      this.agent.log.warn({ turn: this.turn, tools: expression.tools }, "tool written as text");
    }
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
    if (ok) this.#succeeded.add(call.name);
    let result = truncate(full, this.agent.config.max_tool_result_chars);
    // A long result (a search, lyrics, a page) is gone next turn unless she keeps what matters.
    if (ok && result.length >= LONG_RESULT_CHARS && call.name !== KeepNoteTool.NAME) {
      const offered = this.#toolSpecs().some((t) => t.name === KeepNoteTool.NAME);
      if (offered) result += KEEP_HINT;
    }
    this.agent.log.info({ turn: this.turn, tool: call.name, ok, result }, "tool call");
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

  /**
   * What she is doing now, for which tools are offered (tool-scope.ts): the ActivityManager's
   * snapshot, else world's `her`; `null` (unknown): every tool is.
   */
  #toolScope(): ToolScope | null {
    const services = this.agent.ctx.services;
    const activity = services.get(ActivityManagerKey);
    const gameHeld = this.#gameHeld();
    if (activity) return { ...scopeOfSnapshot(activity.snapshot()), gameHeld };
    const her = services.get(WorldStateKey)?.snapshot().her;
    return her ? { ...scopeOfHer(her), gameHeld } : null;
  }

  /** Her game was closed and the messages she answers do not ask her to start one. */
  #gameHeld(): boolean {
    const held = this.agent.ctx.services.get(ArbiterKey)?.held?.("game.start") ?? null;
    return held !== null && !this.#focused.some((m) => asksForGame(m.text));
  }

  /** The tools offered in this context now (`react` makes no sense in voice). */
  #offers(tool: Tool, scope: ToolScope | null): boolean {
    if (isInternalTool(tool.spec.name)) return false;
    if (this.voice && tool.spec.name === ReactTool.NAME) return false;
    return offeredIn(tool, scope);
  }

  #toolSpecs(): ToolSpec[] {
    const scope = this.#toolScope();
    const tools = this.agent.tools;
    return tools.names().flatMap((name) => {
      const tool = tools.get(name);
      return tool && this.#offers(tool, scope) ? [tool.spec] : [];
    });
  }

  #tool(name: string): Tool | undefined {
    const tool = this.agent.tools.get(name);
    return tool && this.#offers(tool, this.#toolScope()) ? tool : undefined;
  }

  /** The notices for this context, told in this turn (kept: they may back her claims). */
  #takeNotices(): Notice[] {
    const notices = this.agent.takeNotices(this.key);
    this.#notices = notices;
    return notices;
  }

  /** What backs what she says she did (claims.ts). */
  #backing(): Backing {
    const manager = this.agent.ctx.services.get(ActivityManagerKey) ?? null;
    return {
      requests: acceptedRequests(manager, this.turn, this.#notices),
      tools: this.#succeeded,
      scope: this.#toolScope(),
      heard: this.inputs.map((m) => m.text),
    };
  }

  async #tryTool(
    call: ToolCall,
    priority: Priority,
    turnSignal: AbortSignal = this.signal,
    report: ((data: JsonValue) => void) | null = null,
  ): Promise<[boolean, string]> {
    const tool = this.#tool(call.name);
    if (!tool) return [false, `error: unknown tool \`${call.name}\``];
    const node = tool.permission ?? null;
    const asked = this.#main === null ? this.#authors() : this.#askers();
    if (node !== null && (this.intent !== null || (this.#main !== null && asked.length === 0))) {
      // Nobody asked: tools that need a person's permission are not hers to use alone.
      return [false, "error: permission denied (needs someone who may use this tool to ask)"];
    }
    if (node !== null) {
      const authorizer = this.agent.ctx.services.get(AuthorizerKey);
      const allowed = authorizer !== undefined && asked.every((a) => authorizer.allows(a, node));
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
    if (this.#main !== null) args = groundArgs(call.name, args, this.key);
    const last = this.#requester();
    if (!last && this.intent === null && this.#main === null) {
      return [false, "error: no triggering message"];
    }
    const me = this.agent.selfAccount(this.key.platform);
    try {
      const out = await timeout(this.agent.config.tool_timeout_ms, turnSignal, (signal) => {
        const ctx: ToolContext = last
          ? {
              turn: this.turn,
              context: this.key,
              account: last.author.account,
              // The person she is answering asked: a request she may decline (see the gate).
              principal: Principals.user(last.author.account, this.key),
              // Everyone this turn speaks for: rules are made with the weakest of them.
              askers: asked,
              message: last.id,
              priority,
              signal,
              ...(report === null ? {} : { report }),
            }
          : {
              // Her own turn: she acts as herself (her own limits, consent of whom it concerns).
              turn: this.turn,
              context: this.key,
              account: me,
              principal: Principals.self(this.intent?.intent.context ?? this.key, null),
              message: { context: this.key, id: this.turn },
              priority,
              signal,
              ...(report === null ? {} : { report }),
            };
        return tool.call(ctx, args);
      });
      return [true, this.#outside(out)];
    } catch (error) {
      if (turnSignal.aborted) throw error;
      if (error instanceof TimeoutError) return [false, "error: timed out"];
      return [false, `error: ${errorMessage(error)}`];
    }
  }

  /** What a tool brought back is outside content: it goes in with a warning when it needs one. */
  #outside(text: string): string {
    const verdict = inspectInput(this.agent.ctx.services, {
      text,
      source: "tool",
      context: this.key,
    });
    return verdict?.note ? `${verdict.note}\n${text}` : text;
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
      case "tool":
      case "markup":
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

/** One of the agent's own data blocks. */
function ownBlock(key: string, title: string, body: string, order: number): PromptBlock {
  return {
    key,
    title,
    body,
    order,
    authority: "data",
    source: key,
    budget_chars: null,
    overflow: "summarize",
  };
}

/** The context as a JSON object (event payloads). */
function contextJson(key: ContextKey): JsonValue {
  return { platform: key.platform, scope: key.scope, channel: key.channel, kind: key.kind };
}
