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
  accountRefString,
  type CompiledBlock,
  type ContextKey,
  ConversationStatesKey,
  type CountedOutcome,
  contextKeyString as contextKeyDisplay,
  DATA_OPEN,
  DirectivesKey,
  dataBlock,
  escapeXml,
  FileReaderKey,
  type FloorClaimKind,
  GoalAgendaKey,
  type IncomingMessage,
  inspectInput,
  isJsonObject,
  type JsonValue,
  type LaneKey,
  LessonsKey,
  LifeLogKey,
  MemoryRetrievalKey,
  type MessageRef,
  MindKey,
  ModerationKey,
  type Notice,
  neutralize,
  newAction,
  type Participant,
  PartyStatusKey,
  type PersonId,
  PersonProfilesKey,
  type PinnedContext,
  PlatformSinksKey,
  Principals,
  type Priority,
  type PromptBlock,
  type PromptContributors,
  PromptContributorsKey,
  type PromptRequest,
  type PromptSection,
  type ReasoningLevel,
  type RetrievedMemory,
  type SafeLine,
  type SavedPrompt,
  SelfStateKey,
  SkillIndexKey,
  type SocialSignals,
  safeName,
  safeOutgoing,
  sameAccount,
  type TurnId,
  type TurnOutcome,
  type TurnRetrievalQuery,
  textLane,
  timestampMs,
  toTimestamp,
  VoiceSinkKey,
  type VoiceTurnMark,
  type VoiceTurnMarks,
  type VoiceTurnStages,
  VoiceTurnsKey,
  voiceLane,
  WorkingContextKey,
  WorldStateKey,
  xmlAttrs,
} from "@miyoria/types";
import {
  assess,
  directReason,
  flooredTalk,
  type LookFacts,
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
import {
  type Gathered,
  gather,
  mergeGathered,
  readWarm,
  WarmContext,
  type WarmRead,
} from "./contributors.js";
import type { TurnFlags } from "./coordinator.js";
import { Expression, ExpressionParser, type Segment } from "./expression.js";
import { fileParts, selectFiles } from "./files.js";
import {
  type CallFor,
  callFor,
  FOR_ARG,
  FOR_PROPERTY,
  type FocusSelection,
  focusVerb,
  type TurnFocusInit,
} from "./focus.js";
import { voiceScope } from "./handle.js";
import { awaitBackfill, fetchAround, quotedParent, replyParents } from "./history.js";
import { isSelfTalk, looksLikeReasoning, ReplyScreen } from "./leak.js";
import { ceilingFor, levelHint, paceMs } from "./levels.js";
import {
  pickKaomoji,
  RECENT_OWN_LINES,
  SCAN_LINES,
  styleNote,
  triggeredEntries,
} from "./lorebook.js";
import type { HeldLine } from "./mainline/gate.js";
import { type Run, resultsFor } from "./mainline/hands.js";
import {
  asksSeriously,
  CUT_OFF,
  handedOver,
  handOver,
  higher,
  NOT_OFFERED,
  OUT_OF_TIME,
  QUESTION_PURPOSE,
  ROUND_CUT,
  ROUND_MIN_CHARS,
  STILL_RUNNING,
  TOO_MANY,
  TOOL_STEP_PURPOSE,
} from "./mainline/loop.js";
import {
  ACTING_ALONE,
  FALLBACK_LINES,
  FALLBACK_RESULT_LINE,
  FALLBACK_URGENT_LINE,
  type MainClaim,
  MainTurn,
  sentences,
} from "./mainline/main.js";
import {
  COMMIT_SPEC,
  groundArgs,
  isPseudoTool,
  STEER_SPEC,
  slimTool,
  turnOutput,
} from "./mainline/output.js";
import {
  contextData,
  contextState,
  exampleDialogues,
  examplesBlock,
  fitHistory,
  historyWindow,
  mainMessages,
  mainRules,
  pinnedSection,
  promptText,
  proposalData,
  resultData,
  rotatedExamples,
  SlowBlocks,
  stableHash,
  ToolTraces,
  type TraceCall,
  tailSection,
  traceText,
} from "./mainline/prompt.js";
import { linkMentions, type MentionTarget } from "./mentions.js";
import { agentTurns, CorrectionTally } from "./metrics.js";
import { KEEP_HINT, LONG_RESULT_CHARS, loopKeepHint, NOTE_TOOLS } from "./notes.js";
import { prohibitionOf } from "./prohibition.js";
import {
  afterFold,
  buildMessages,
  checkMessages,
  cleanReply,
  dataMessage,
  EXAMPLES_TITLE,
  FEELING_TITLE,
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
  type TraceAnchor,
  takeReplyMark,
  traceAnchor,
  transcriptLine,
  VOICE_PRESENT_TITLE,
  whenAndWhere,
} from "./prompt.js";
import type { Agent, Initiative, IntentTurn } from "./runtime.js";
import {
  feelingCauseBody,
  type PresentPerson,
  peopleBody,
  personTag,
  selfBlocks,
} from "./self-block.js";
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
import { charCount, contextId, fixed, guard, TimeoutError, timeout, toolBatches } from "./util.js";
import { imageParts, selectImages } from "./vision.js";

const TYPING_TTL_MS = 10_000;
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
/**
 * Contributor sections the main line shows before the history (v4 §4.1), the most stable first:
 * the server's own emoji (`server_emoji` of packages/discord emoji.ts: they change when someone
 * adds one) and her notebook's index (when she writes a page). The rest of what contributors say
 * is data of the turn.
 */
const SLOW_ORDER: readonly string[] = ["server_emoji", "notebook"];
const SLOW_SECTIONS: ReadonlySet<string> = new Set(SLOW_ORDER);
/** Title of 「今天的她」 (v4 §6.2). */
const LIFE_TITLE = "今天的你";
/** An emotion she feels at least this much counts as her mood for the lorebook. */
const MOOD_MIN = 0.3;
const DAY_MS = 86_400_000;
/**
 * The party tools that act in a running game, with the game they are for (`null`: any). Offered
 * only while `PartyStatus` says one runs here, and `party_start` only while none does (all of
 * them only in voice: `NEEDS` of tool-scope.ts).
 */
const PARTY_MOVES: ReadonlyMap<string, string | null> = new Map([
  ["party_host", null],
  ["party_play", null],
  ["party_ask", "soup"],
]);
const PARTY_START = "party_start";

/** What a conversation keeps for the main line's prompt from one turn to the next. */
interface Kept {
  slow: SlowBlocks;
  traces: ToolTraces;
  /** The people she talked with since the people block was last written. */
  talking: Set<PersonId>;
  /** Who was here when the people block was last written. */
  here: string;
}

/** Kept per session: a forgotten session forgets it too. */
const KEPT = new WeakMap<Session, Kept>();

/** What a voice turn reads without waiting (contributors.ts), per voice session. */
const WARM = new WeakMap<Session, WarmContext>();

/** What is read in the background for later voice turns may take this long (nobody waits). */
const WARM_LOAD_MS = 10_000;

/** A voice turn's view of what is kept warm: for whom, and how it may wait. */
interface VoiceWarm {
  kept: WarmContext;
  /** The people here: a value made for other people is not used. */
  key: string;
  read: WarmRead;
}

function warmOf(session: Session): WarmContext {
  let warm = WARM.get(session);
  if (warm === undefined) {
    warm = new WarmContext();
    WARM.set(session, warm);
  }
  return warm;
}

function keptOf(session: Session): Kept {
  let kept = KEPT.get(session);
  if (kept === undefined) {
    kept = { slow: new SlowBlocks(), traces: new ToolTraces(), talking: new Set(), here: "" };
    KEPT.set(session, kept);
  }
  return kept;
}

export class TurnError extends Error {
  override readonly name = "TurnError";
}

/** What a turn is for (focus.ts), as the coordinator worked it out. */
export interface TurnPlan {
  /** The focus split of the turn's input (`null`: a turn without input). */
  selection: FocusSelection | null;
  /** What `agent.turn.focus` / `agent.turn.outcome` say about it. */
  focus: TurnFocusInit;
  /**
   * The coordinator saw its one question stand `rhythm.question_secs` by its own clock with
   * nobody saying anything after it (v4 §7.2).
   */
  stood?: boolean;
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
      await t.keepRules();
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
  /**
   * The main line's slow-changing data (skills, notebook index, 「今天的她」, the profiles of the
   * people here), rendered: before the history (v4 §4.1).
   */
  slow: string[];
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
    /** `true`: the sentence is a note to herself and is not said (the turn counts it). */
    readonly selfTalk: (text: string) => boolean = isSelfTalk,
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

  /**
   * What was written so far is complete: the next `<voice>` line begins, or the tool calls do.
   * The sentence of the open line is said now. It used to wait until the next line was written
   * to its end, or for the end of the stream behind every tool argument, and all of that was
   * silence in the channel.
   */
  async settle(): Promise<void> {
    if (this.#pair !== null) {
      if (this.#pair.text.trim() !== "") await this.#endPair();
      return;
    }
    const done = this.#splitter.flushComplete();
    if (done !== null) await this.#sentence(done);
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
    // Her reasoning, or a note to herself, is no sentence to say (leak.ts).
    if (looksLikeReasoning(text) || this.selfTalk(text)) return;
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

/** A line of a list, or a link: long content, kept in one message with its neighbours. */
function listLine(line: string): boolean {
  return (
    /^\s*(?:[-*•‧·]\s|\d{1,3}[.)、]\s?|[(（]\d{1,3}[)）])/.test(line) || /https?:\/\//.test(line)
  );
}

/** What is written so far of a line might still turn into a list item. */
function maybeListLine(partial: string): boolean {
  return /^\s*(?:\d{1,3}[.)、]?|[-*•‧·(（]|[(（]\d{1,3})?$/.test(partial);
}

/**
 * Whether a message may end at the line break at `i` of `text`: not inside long content (v4 §7.3:
 * a list, its lead-in line ending in a colon, a run of links goes as one message, never split).
 * After a list line it waits until the next line shows whether the list goes on.
 */
export function breaksAt(text: string, i: number): boolean {
  const start = text.lastIndexOf("\n", i - 1) + 1;
  const before = text.slice(start, i);
  const end = text.indexOf("\n", i + 1);
  const after = text.slice(i + 1, end === -1 ? undefined : end);
  const leadIn = /[:：]\s*$/.test(before);
  const known = end !== -1 || !maybeListLine(after);
  if (leadIn) return known ? !listLine(after) && after.trim() !== "" : false;
  if (!listLine(before)) return true;
  return known && !listLine(after);
}

/**
 * The rest of a finished text reply as the gate holds it, one piece per message: plain lines
 * sentence by sentence (`sentences`), but a code block, a list or a run of links whole.
 */
export function textPieces(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  let fenced = false;
  const flush = (to: number) => {
    const piece = text.slice(from, to);
    from = to + 1;
    if (piece.trim() === "") return;
    const long = piece.includes("```") || piece.includes("\n") || listLine(piece);
    out.push(...(long ? [piece] : sentences(piece)));
  };
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("```", i)) {
      fenced = !fenced;
      i += 2;
    } else if (!fenced && text[i] === "\n" && breaksAt(`${text}\n`, i)) {
      flush(i);
    }
  }
  flush(text.length);
  return out;
}

/**
 * Text replies go out line by line while the model writes (a line break outside code blocks
 * ends a message, unless it is inside a list or a run of links: `breaksAt`). A line that claims
 * something only a tool does, with nothing backing it (claims.ts), is held back (with the rest of
 * the response), so the reminder in `#produce` can still replace it.
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
    const cuts: number[] = [];
    let fenced = false;
    for (let i = 0; i < text.length; i++) {
      if (text.startsWith("```", i)) {
        fenced = !fenced;
        i += 2;
      } else if (!fenced && text[i] === "\n" && i >= this.#sent && breaksAt(text, i)) {
        cuts.push(i);
      }
    }
    // Lines that arrived together still go out as messages of their own (paced by `#sendText`).
    for (const cut of cuts) {
      const piece = text.slice(this.#sent, cut);
      if (this.hold(piece)) {
        this.#held = true;
        return;
      }
      this.#sent = cut + 1;
      if (piece.trim() !== "") await this.send(piece);
    }
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
  /** The calls of the tool loop in this turn, for the trace kept beside her reply (v4 §4.2). */
  readonly #traced: TraceCall[] = [];
  /** The line this turn's trace follows, once kept. */
  #traceAfter: TraceAnchor | null = null;
  /** When her last text message of this turn went out (clock ms): the pace of the next. */
  #lastTextAt: number | null = null;
  /** Voice: where the turn's time went, for `VoiceTurns.mark` and its outcome's `voice_stages`. */
  readonly #marks: VoiceTurnMarks = {};
  /** What the code changed of her output in this turn (docs/design/v4-patches.md). */
  readonly #tally: CorrectionTally;
  /** The turn reached the model: its outcome carries the corrections, `{}` included. */
  #generated = false;

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
    this.#tally = new CorrectionTally(this.voice);
    const main = agent.mainline;
    this.#main =
      main === null ? null : new MainTurn(main, agent, turn, key, this.#claim(), this.#tally);
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
    // Nobody spoke and nobody in the voice channel can hear her: she may act, not talk.
    const unheard = this.voice && this.inputs.length === 0 && this.session.listeners().length === 0;
    return {
      kind,
      attention: i?.attention ?? answers,
      cause: this.agent.mainline?.causeOf(first?.id.id) ?? null,
      muted: this.intent?.muted === true || unheard,
      proposal,
      chain: i?.chain ?? null,
    };
  }

  /** Generation is over, however it went. */
  ended(): void {
    this.#main?.ended();
    // Whatever she says now is on its way (or nothing is): no filler for this turn any more.
    if (this.voice) this.agent.ctx.services.get(VoiceTurnsKey)?.settle(this.turn);
  }

  // ---- voice latency (v4 §7.5) ------------------------------------------------------------------

  /** Voice: the turn reached `mark` (the first time counts); the voice module hears of it. */
  #mark(mark: VoiceTurnMark): void {
    if (!this.voice || this.#marks[mark] !== undefined) return;
    const at = this.#now;
    this.#marks[mark] = at;
    // What a turn that started early and is dropped cost (coordinator.ts).
    if (mark === "request") this.flags.requestedAt = at;
    this.agent.ctx.services.get(VoiceTurnsKey)?.mark(this.turn, this.plan.focus.focus, mark, at);
  }

  /**
   * A voice turn that started before the wait after the utterance was over (`TurnFlags.hold`)
   * says, does and concludes nothing until the coordinator confirms it; someone going on drops it
   * meanwhile (its signal aborts).
   */
  async #confirmed(): Promise<void> {
    const hold = this.flags.hold;
    if (hold === undefined || hold === null) return;
    await guard(hold, this.signal);
    this.#mark("confirmed");
  }

  /**
   * She will answer someone who called her in voice: the voice module may fill the silence before
   * her first sentence with a short sound of hers (not before a turn started early is confirmed).
   */
  #expectAnswer(direct: boolean): void {
    if (!this.voice || !direct || this.inputs.length === 0) return;
    const turns = this.agent.ctx.services.get(VoiceTurnsKey);
    if (turns === undefined) return;
    const startedAt = this.#marks.started ?? this.#now;
    const expect = () => {
      if (!this.signal.aborted) turns.expect(this.key, this.turn, startedAt);
    };
    const hold = this.flags.hold;
    if (hold === undefined || hold === null) expect();
    else hold.then(expect, () => undefined);
  }

  /**
   * Where a voice turn's time went, from the person's last sound (the newest focus utterance's
   * end) to her first sentence; the known parts add up to `latency_ms`. `null` outside voice or
   * without input.
   */
  #voiceStages(last: IncomingMessage | undefined): VoiceTurnStages | null {
    if (!this.voice || last === undefined) return null;
    const m = this.#marks;
    const released =
      m.first_token === undefined ? undefined : Math.max(m.first_token, m.confirmed ?? 0);
    const points = [
      timestampMs(last.ts),
      this.flags.heardAt,
      m.started,
      m.decided,
      m.context,
      m.request,
      m.first_token,
      released,
      this.#firstOutputAt ?? undefined,
    ];
    // Made non-decreasing, so no part is negative and the known ones add up.
    let floor = Number.NEGATIVE_INFINITY;
    const t = points.map((v) => {
      if (v === undefined || v === null) return null;
      floor = Math.max(floor, v);
      return floor;
    });
    const span = (i: number): number | null => {
      const a = t[i];
      const b = t[i + 1];
      return a === null || a === undefined || b === null || b === undefined ? null : b - a;
    };
    return {
      heard_ms: span(0),
      wait_ms: span(1),
      decide_ms: span(2),
      context_ms: span(3),
      prompt_ms: span(4),
      first_token_ms: span(5),
      held_ms: span(6),
      first_sentence_ms: span(7),
      speculative: this.flags.hold !== undefined && this.flags.hold !== null,
    };
  }

  /**
   * The call failed: someone waiting still gets a fixed line (§21), and nothing that was already
   * said is repeated. What she says on her own just does not happen.
   */
  async fallback(): Promise<string> {
    const main = this.#main;
    if (main === null || !main.owed || this.#parts > 0 || main.claim.muted) return "";
    // A voice turn started early that failed says nothing before it is confirmed (or dropped).
    try {
      await this.#confirmed();
    } catch {
      return "";
    }
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
      const said = await this.#canned(line, main.claim.kind === "addressed", null);
      this.#tally.count("fallback_line");
      return said;
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

  /**
   * Whom her lines of this turn answer (`HistoryEntry.answering`): the people of its focus; nobody
   * in a turn she started herself. Who goes on talking with her next is read off it (attention's
   * `conversing`).
   */
  #answering(): AccountRef[] {
    if (this.inputs.length === 0) return [];
    const out: AccountRef[] = [];
    for (const m of this.#focused) {
      if (!out.some((a) => sameAccount(a, m.author.account))) out.push(m.author.account);
    }
    return out;
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

  outcomeRecord(outcome: TurnOutcome): CountedOutcome & { voice_stages?: VoiceTurnStages } {
    const f = this.plan.focus;
    const last = this.#focused.at(-1);
    const latency =
      this.#firstOutputAt === null || last === undefined
        ? null
        : Math.max(this.#firstOutputAt - timestampMs(last.ts), 0);
    // Voice: the same latency split by where it went (the decision log keeps it per turn).
    const stages = this.#voiceStages(last);
    return {
      ...(stages === null ? {} : { voice_stages: stages }),
      // Only a turn that reached the model is measured: its counts, `{}` when nothing fired.
      ...(this.#generated ? { corrections: this.#tally.counts() } : {}),
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
    this.#mark("started");
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
      // Voice, started early: the person may still go on, and then this turn never was.
      await this.#confirmed();
      this.#publishDecision(false, score, reasons);
      this.#main?.silent(reasons.at(-1) ?? "");
      return "";
    }
    const refused = this.#main?.take() ?? null;
    if (refused !== null) {
      await this.#confirmed();
      reasons.push(`floor: ${refused}`);
      this.#publishDecision(false, score, reasons);
      this.#main?.silent(refused);
      return "";
    }
    this.#mark("decided");
    if (budget === "exhausted") {
      await this.#confirmed();
      const notice = this.agent.takeBudgetNotice(this.key);
      reasons.push(
        notice
          ? "llm budget exhausted: out-of-energy line"
          : "llm budget exhausted: already told them, staying quiet",
      );
      this.#publishDecision(notice, score, reasons);
      return notice ? await this.#sayExhausted(direct) : "";
    }
    this.#expectAnswer(direct);
    const [extras, looked, files] = await Promise.all([
      this.#extras(),
      this.#lookAround(),
      this.#readFiles(),
    ]);
    this.#mark("context");
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
   * A plain "don't play <game>" in this turn that she did not write down herself is written for
   * her (prohibition.ts), as the person who said it; the directive service decides whether it
   * counts. Never throws. A correction (`prohibition_written`, `[modules.agent.corrections]
   * prohibition_write`).
   */
  async keepRules(): Promise<void> {
    if (!this.agent.config.corrections.prohibition_write) return;
    if (this.#succeeded.has("directive_add")) return;
    const directives = this.agent.ctx.services.get(DirectivesKey);
    if (!directives) return;
    for (const input of this.inputs) {
      if (input.author.is_bot || this.agent.isSelf(input.author.account)) continue;
      const found = prohibitionOf(input.text);
      if (found === null) continue;
      try {
        const change = await directives.add({
          by: {
            type: "account",
            subject: {
              account: input.author.account,
              context: this.key,
              platform_roles: [],
              is_guild_admin: false,
            },
            askers: [],
          },
          text: found.text,
          effect: "deny",
          scope: { activity: found.activity },
          minutes: found.minutes,
          source_event: `msg:${input.id.id}`,
        });
        this.#tally.count("prohibition_written");
        this.agent.log.info(
          { turn: this.turn, activity: found.activity, status: change.status },
          "wrote down a prohibition she did not",
        );
      } catch (error) {
        this.agent.log.warn(
          { turn: this.turn, error: errorMessage(error) },
          "could not write a rule",
        );
      }
    }
  }

  /**
   * A sentence to say that is a note to herself (leak.ts `isSelfTalk`) is not said, and counted
   * (`self_talk_cut`); `[modules.agent.corrections] self_talk = false` says it.
   */
  #selfTalk(text: string): boolean {
    if (!this.agent.config.corrections.self_talk || !isSelfTalk(text)) return false;
    this.#tally.count("self_talk_cut");
    return true;
  }

  /**
   * The message her tools act for: the latest one that @-mentions her or replies to her, else
   * the latest one. Someone chatting right after a request must not become its requester, and a
   * reply to her that is said to someone else or only laughs (attention's `directReason`) asks
   * her for nothing.
   */
  #requester(): IncomingMessage | undefined {
    const pool = this.#focused;
    const names = this.agent.persona.names();
    return (
      pool.findLast(
        (m) => m.mentions_self || (m.reply_to_self && directReason(m, names) === "reply"),
      ) ??
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
          roster: this.session.voiceMembers().map((m) => m.display_name),
        }
      : null;
    // v4 §7.2: under the main line a text channel with a level gets looks instead of the dice.
    const rhythm = this.agent.rhythm;
    const look: LookFacts | null =
      this.#main !== null && !this.voice && ceiling !== null
        ? {
            used: rhythm.looksUsed(this.key),
            perHour: rhythm.config.looks_per_hour,
            questionSecs: rhythm.config.question_secs,
            topicGapMs: rhythm.config.topic_gap_mins * 60_000,
            close: this.#close(rhythm.config.close_affinity),
            stood: this.plan.stood === true,
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
      modelMayPass: this.#main !== null,
      look,
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
    if (respond) {
      // A look or a reaction to her line is a model call: it counts against the cap.
      const opened = assessment.opened ?? null;
      if (opened === "look" || opened === "reaction") rhythm.noteLook(this.key);
      rhythm.took(this.inputs.map((m) => m.id.id));
    }
    return { respond, direct: assessment.direct, score: assessment.score, reasons };
  }

  /** A speaker of this turn she is close to (affinity, or her owner), by name, if any. */
  #close(affinity: number): string | null {
    for (const m of this.inputs) {
      const a = this.social?.attitude(m.author.account) ?? null;
      if (a !== null && !a.blocked && (a.owner === true || a.affinity >= affinity)) {
        return m.author.display_name;
      }
    }
    return null;
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
    const extras: Extras = {
      self: [],
      own: [],
      sections: [],
      slow: [],
      compiled: [],
      reasons: [],
    };
    const cfg = this.agent.config;
    const services = this.agent.ctx.services;
    const about = this.#about();
    const present = this.#present(about);
    const request = this.#promptRequest(about);
    const self = services.get(SelfStateKey) ?? null;
    const affect = services.get(AffectStateKey) ?? null;
    // Her secret crush (the `self` module's; with person cards, W4's affect owns it).
    const crush = affect === null ? (self?.crush?.() ?? null) : null;
    const crushHere = crush !== null && present.some((p) => p.person === crush.person);
    // The contributors are asked while her memory is read: the two waits overlap.
    const registry = services.get(PromptContributorsKey);
    // The main line reads memory through its layers (`#mainMemory`), not the V2 contributor.
    const skip =
      this.#main !== null && services.has(MemoryRetrievalKey) ? [MEMORY_CONTRIBUTOR] : [];
    // Voice: what does not depend on her line is read warm, the rest waited for briefly (§7.5).
    const warm = this.#warm(present);
    const gathering =
      registry && registry.all().length > 0
        ? warm === null
          ? gather(registry, request, cfg.contributor_timeout_ms, this.signal, skip)
          : this.#gatherVoice(registry, request, skip, warm)
        : null;
    gathering?.catch(() => undefined);
    const skills = this.#main !== null ? this.#mainSkills(warm) : null;
    skills?.catch(() => undefined);
    let people: string | null | undefined;
    if (this.#main !== null) {
      // With person profiles, the people present are one slow block of theirs instead of the
      // agent's people line and the pinned people section (v4 §5.6).
      const profiled = services.has(PersonProfilesKey);
      const crushOf = crushHere ? (crush?.person ?? null) : null;
      if (warm !== null) {
        // Side by side: the profiles cannot leave out what this turn's retrieval brings, but
        // they no longer wait for it (two 800 ms waits in a row before, 2026-11-10).
        const [, read] = await Promise.all([
          this.#mainMemory(extras, present, request, profiled, warm),
          profiled ? this.#mainPeople(extras, present, [], crushOf, warm) : undefined,
        ]);
        people = read;
      } else {
        const retrieved = await this.#mainMemory(extras, present, request, profiled);
        if (profiled) people = await this.#mainPeople(extras, present, retrieved, crushOf);
      }
    }
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
    // Without profiles (or when they failed), the people line of each turn, as before.
    if (people === undefined) {
      const body = peopleBody(
        present,
        { affect, attitude: (a) => this.social?.attitude(a) ?? null, self },
        crushHere ? (crush?.person ?? null) : null,
      );
      if (body !== "") {
        blocks.push(ownBlock("people", this.#peopleTitle(), body, 0));
      }
    }
    const feeling = feelingCauseBody({
      context: this.key,
      now: this.#now,
      affect,
      self,
      presentPeople: present.flatMap((p) => (p.person === null ? [] : [p.person])),
    });
    if (feeling !== "") blocks.push(ownBlock("feeling", FEELING_TITLE, feeling, 1));
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
    extras.own.push(...mine.blocks);
    extras.compiled.push(...mine.compiled);

    const gathered = gathering === null ? null : await gathering;
    const sections = gathered?.sections ?? [];
    if (gathered !== null) extras.reasons.push(...gathered.reasons());
    const { data, superseded } = contributedData(
      this.#main === null ? sections : sections.filter((s) => !SLOW_SECTIONS.has(s.key)),
    );
    if (superseded.length > 0)
      extras.reasons.push(`rendered by the agent: ${superseded.join(", ")}`);
    const m = cfg.mainline;
    const contributed = budgetBlocks(data, {
      total: this.#main === null ? cfg.max_context_chars : m.data_chars,
      // §5's readers bring more than the default budget of a section.
      budgets:
        this.#main === null
          ? cfg.prompt.budgets
          : {
              ...cfg.prompt.budgets,
              just_now: m.just_now_chars,
              elsewhere: m.elsewhere_chars,
            },
      defaultBudget: cfg.prompt.default_budget,
    });
    extras.sections = contributed.blocks;
    extras.compiled.push(...contributed.compiled);
    const cut = contributed.compiled.filter((b) => b.fate !== "kept");
    if (cut.length > 0) {
      extras.reasons.push(`context budgeted: ${cut.map((b) => `${b.key} ${b.fate}`).join(", ")}`);
    }
    if (this.#main !== null) {
      const slow = sections.filter((s) => SLOW_SECTIONS.has(s.key));
      this.#mainSlow(extras, slow, skills === null ? null : await skills, people ?? null);
    }
    return extras;
  }

  /** The people block's title. */
  #peopleTitle(): string {
    return this.voice ? VOICE_PRESENT_TITLE : PRESENT_TITLE;
  }

  /**
   * The slow part of the main line's data (v4 §4.1), the most stable first: her skills, the
   * server's emoji, her notebook's index, 「今天的她」, the people here. Each has a budget of its own, never a share
   * of a pool that the turn's other data could change.
   */
  #mainSlow(
    extras: Extras,
    contributed: readonly PromptSection[],
    skills: string | null,
    people: string | null,
  ): void {
    const m = this.agent.config.mainline;
    if (skills !== null && skills.trim() !== "") {
      // The skill index comes as a data block; anything else is made one.
      extras.slow.push(
        skills.includes(DATA_OPEN) ? skills : dataBlock("skills", "你的技能", skills),
      );
    }
    const sections: PromptSection[] = [...contributed]
      .sort((a, b) => SLOW_ORDER.indexOf(a.key) - SLOW_ORDER.indexOf(b.key))
      .map((s, i) => ({ ...s, order: i }));
    const life = this.#mainLife();
    if (life !== null) {
      sections.push({ key: "life", title: LIFE_TITLE, body: life, order: sections.length });
    }
    if (people !== null) {
      // Over its budget the block keeps whole lines: a cut `<person/>` would read as nothing.
      sections.push(ownBlock("people", this.#peopleTitle(), people, sections.length));
    }
    const { data } = contributedData(sections);
    const slow = budgetBlocks(data, {
      total: UNLIMITED,
      budgets: {
        server_emoji: m.emoji_chars,
        notebook: m.notebook_chars,
        life: m.life_chars,
        people: m.people_chars,
      },
      defaultBudget: m.notebook_chars,
    });
    extras.slow.push(...slow.blocks);
    extras.compiled.push(...slow.compiled);
  }

  /**
   * Voice with `warm_context`: the values kept for this channel, for the people here (a value
   * made for other listeners is never shown to these).
   */
  #warm(present: readonly PresentPerson[]): VoiceWarm | null {
    const v = this.agent.config.voice;
    if (!this.voice || !v.warm_context) return null;
    return {
      kept: warmOf(this.session),
      key: present
        .map((p) => accountRefString(p.account))
        .sort()
        .join(","),
      read: {
        now: () => this.#now,
        maxAgeMs: v.warm_max_age_ms,
        waitMs: v.live_context_ms,
        signal: this.signal,
      },
    };
  }

  /**
   * Voice: the contributors of `warm_contributors` as they were last read (and read again in the
   * background for the next turn), the others asked now and given `live_context_ms`.
   */
  async #gatherVoice(
    registry: PromptContributors,
    request: PromptRequest,
    skip: readonly string[],
    warm: VoiceWarm,
  ): Promise<Gathered> {
    const v = this.agent.config.voice;
    const keys = registry
      .all()
      .map((c) => c.key)
      .filter((k) => !skip.includes(k));
    const kept = keys.filter((k) => v.warm_contributors.includes(k));
    const live = keys.filter((k) => !kept.includes(k));
    // The refresh outlives the turn: the next one reads it, and nobody waits for it.
    const background = this.agent.ctx.signal;
    const limit = Math.max(this.agent.config.contributor_timeout_ms, WARM_LOAD_MS);
    const [warmed, asked] = await Promise.all([
      kept.length === 0
        ? undefined
        : readWarm(warm.kept.contributors, warm.key, warm.read, () =>
            gather(registry, request, limit, background, [...skip, ...live]),
          ),
      live.length === 0
        ? undefined
        : gather(registry, request, v.live_context_ms, this.signal, [...skip, ...kept]),
    ]);
    const out = mergeGathered(warmed, asked);
    if (warmed === undefined) out.skipped.push(...kept.map((k) => `${k} (warming up)`));
    return out;
  }

  /** Her skills, a name and a line each (`SkillIndex`); `null` when none or too slow. */
  async #mainSkills(warm: VoiceWarm | null = null): Promise<string | null> {
    const index = this.agent.ctx.services.get(SkillIndexKey);
    const chars = this.agent.config.mainline.skills_chars;
    if (index === undefined || chars <= 0) return null;
    if (warm !== null) {
      // Voice: the index as it was last read; it changes when she learns a skill.
      const limit = Math.max(this.agent.config.contributor_timeout_ms, WARM_LOAD_MS);
      const background = this.agent.ctx.signal;
      const text = await readWarm(warm.kept.skills, `skills:${chars}`, warm.read, async () => {
        const read = await timeout(limit, background, () => index.index(chars));
        return read.trim() === "" ? null : read;
      });
      return text ?? null;
    }
    try {
      const text = await timeout(this.agent.config.contributor_timeout_ms, this.signal, () =>
        index.index(chars),
      );
      return text.trim() === "" ? null : text;
    } catch (error) {
      if (this.signal.aborted) throw error;
      this.agent.log.warn({ turn: this.turn, error: errorMessage(error) }, "no skill index");
      return null;
    }
  }

  /**
   * 「今天的她」 (v4 §6.2, §8.1): what she did today, or the last days when nothing yet today. It
   * is written again only when what she did changes, so the clock in it says up to when the list
   * is complete, and the block keeps its place in the cached prefix between her activities.
   */
  #mainLife(): string | null {
    const life = this.agent.ctx.services.get(LifeLogKey);
    if (life === undefined || this.agent.config.mainline.life_chars <= 0) return null;
    try {
      const now = this.#now;
      const today = life.today();
      const scope = today.length > 0 ? "today" : "lately";
      const entries = today.length > 0 ? today : life.entries(now - 3 * DAY_MS);
      const key = `${scope}|${entries.map((e) => e.id).join(",")}`;
      const slow = keptOf(this.session).slow;
      const kept = slow.get("life", key, now, Infinity);
      if (kept !== undefined) return kept;
      const text = life.summary(scope);
      const body = text === null || text.trim() === "" ? null : text;
      slow.set("life", key, now, body);
      return body;
    } catch (error) {
      this.agent.log.warn({ turn: this.turn, error: errorMessage(error) }, "no life log");
      return null;
    }
  }

  /**
   * The profiles of the people here (`PersonProfiles`, v4 §5.6), what retrieval shows this turn
   * left out. Kept as written while the same people are here and nobody new talked with her, for
   * at most `people_refresh_mins` (§4.1: it sits before the history). `undefined`: no profiles
   * this turn, the people line of the turn stands in.
   */
  async #mainPeople(
    extras: Extras,
    present: readonly PresentPerson[],
    retrieved: readonly RetrievedMemory[],
    crush: PersonId | null,
    warm: VoiceWarm | null = null,
  ): Promise<string | null | undefined> {
    const profiles = this.agent.ctx.services.get(PersonProfilesKey);
    const m = this.agent.config.mainline;
    if (profiles === undefined) return undefined;
    if (m.people_chars <= 0) return null;
    const now = this.#now;
    const persons = present.flatMap((p) => (p.person === null ? [] : [p.person]));
    const kept = keptOf(this.session);
    const here = `${this.voice ? "voice" : "text"}|${[...persons].sort().join(",")}|${crush ?? ""}`;
    if (kept.here !== here) {
      kept.here = here;
      kept.talking = new Set();
    }
    for (const p of present) if (p.speaker && p.person !== null) kept.talking.add(p.person);
    const talking = [...kept.talking].sort();
    const key = `${here}|${talking.join(",")}`;
    const cached = kept.slow.get("people", key, now, m.people_refresh_mins * 60_000);
    if (cached !== undefined) return cached;
    const render = async (signal: AbortSignal, limit: number): Promise<string | null> => {
      const where = {
        context: this.key,
        present: persons,
        talking_with: talking,
        accounts: present.map((p) => p.account),
        now: toTimestamp(now),
      };
      const exclude = retrieved.flatMap((r) => [r.id, r.content]);
      const body = await timeout(limit, signal, (s) =>
        profiles.render(where, m.people_chars, { exclude }, s),
      );
      const handle = present.find((p) => crush !== null && p.person === crush)?.handle;
      const text = handle === undefined ? body.trim() : markSecret(body.trim(), handle);
      const out = text === "" ? null : text;
      kept.slow.set("people", key, now, out);
      return out;
    };
    if (warm !== null) {
      // Voice: rendered in the background for the next turn when it is not ready in time; this
      // turn has the people line meanwhile.
      const limit = Math.max(this.agent.config.contributor_timeout_ms, WARM_LOAD_MS);
      const read = await readWarm(warm.kept.people, key, { ...warm.read, maxAgeMs: 0 }, () =>
        render(this.agent.ctx.signal, limit),
      );
      if (read === undefined) extras.reasons.push("person profiles: still being written");
      return read;
    }
    try {
      return await render(this.signal, this.agent.config.contributor_timeout_ms);
    } catch (error) {
      if (this.signal.aborted) throw error;
      extras.reasons.push(`person profiles skipped: ${errorMessage(error)}`);
      return undefined;
    }
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

  /**
   * The main line's example dialogues as one data block (`null`: none). V3 left them out (the
   * prompt had 4000 tokens); they show how she talks better than any rule. Which ones turns over
   * with the session and stays put within it, as the prefix they sit in must.
   */
  #mainExamples(): string | null {
    const chars = this.agent.config.mainline.examples_chars;
    if (chars <= 0) return null;
    // In voice, a dialogue with code in it shows a line that cannot be read aloud.
    const dialogues = exampleDialogues(this.agent.persona.examples()).filter(
      (d) => !this.voice || !d.includes("`"),
    );
    const seed = stableHash(`${contextId(this.key)}:${this.session.startedAt}`);
    const picked = rotatedExamples(dialogues, seed, chars);
    return examplesBlock(picked, this.agent.persona.names());
  }

  /**
   * The turn's `<style_note>` (`lorebook.ts`): the lorebook entries that what was just said or her
   * mood bring up and, in text, a few kaomoji for her mood that she has not used lately.
   */
  #styleNote(history: readonly HistoryEntry[]): string {
    const book = this.agent.persona.lorebook();
    const moods = this.#moods();
    const answered = focusEntries(history);
    const others = history.filter((e) => !e.isSelf && e.current !== true).slice(-SCAN_LINES);
    const scan = [...others, ...answered].map((e) => e.text).join("\n");
    const entries = triggeredEntries(book, scan, moods, this.voice);
    if (this.voice) return styleNote(true, [], entries);
    const own = history
      .filter((e) => e.isSelf)
      .slice(-RECENT_OWN_LINES)
      .map((e) => e.text);
    const seed = stableHash(`${contextId(this.key)}:${this.#now}:${history.at(-1)?.ts ?? 0}`);
    return styleNote(false, pickKaomoji(book, moods, own, seed), entries);
  }

  /** Her emotions now, by name: the tag she shows and the strongest ones she feels. */
  #moods(): Set<string> {
    const services = this.agent.ctx.services;
    const moods = new Set<string>();
    try {
      const snap = services.get(AffectStateKey)?.snapshot() ?? null;
      const self = services.get(SelfStateKey) ?? null;
      const shown = snap !== null ? snap.shown : (self?.shown() ?? null);
      if (shown !== null) moods.add(shown.tag);
      const felt = snap !== null ? snap.top : (self?.emotions() ?? []);
      for (const e of felt.slice(0, 2)) if (e.intensity >= MOOD_MIN) moods.add(e.name);
    } catch (error) {
      this.agent.log.warn(
        { turn: this.turn, error: errorMessage(error) },
        "no mood for the lorebook",
      );
    }
    if (moods.size === 0) moods.add("neutral");
    return moods;
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
    this.#generated = true;
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
        (text) => this.#selfTalk(text),
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
    const screen = new ReplyScreen<Line>(cfg.corrections.leak_screen, cfg.corrections.self_talk);
    const send = async (raw: string) => {
      for (const part of splitByReplyMarks(raw)) {
        const mark = takeReplyMark(part);
        const safe = this.#safe(cleanReply(mark.text, names));
        const text = this.#linkMentions(safe.text);
        if (text === "") continue;
        const before = screen.droppedLines;
        const cut = screen.selfTalk;
        const { send: now } = screen.push({ text, blocked: safe.blocked, n: mark.n });
        this.#tally.count("leak_dropped", screen.droppedLines - before);
        this.#tally.count("self_talk_cut", screen.selfTalk - cut);
        for (const item of now) {
          early.push(await this.#sendText(sink, item.text, direct, priority, item.blocked, item.n));
        }
      }
    };
    const offered = new Set(this.#toolSpecs().map((t) => t.name));
    const segments = new TextSegments(send, (text) => {
      const hold = cfg.corrections.claims && unbackedClaim(text, offered, this.#backing()) !== null;
      if (hold) this.#tally.count("claim_held");
      return hold;
    });
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
    request: PromptRequest,
    profiled: boolean,
    warm: VoiceWarm | null = null,
  ): Promise<RetrievedMemory[]> {
    const limit = this.agent.config.contributor_timeout_ms;
    const now = toTimestamp(this.#now);
    const where = {
      context: this.key,
      present: present.flatMap((p) => (p.person === null ? [] : [p.person])),
      accounts: present.map((p) => p.account),
      now,
    };
    const pinned = this.#main?.main.pinned() ?? null;
    // The pinned sections and the retrieval run side by side: they waited for each other before
    // (up to 800 ms each, 2026-11-10). In voice the pinned ones come warm (they depend on who is
    // here, not on the line) and the retrieval for the line gets `live_context_ms`.
    const reading =
      pinned === null
        ? Promise.resolve(undefined)
        : warm === null
          ? timeout(limit, this.signal, () => pinned.pinned(where))
          : readWarm(warm.kept.pinned, warm.key, warm.read, () =>
              timeout(Math.max(limit, WARM_LOAD_MS), this.agent.ctx.signal, () =>
                pinned.pinned(where),
              ),
            );
    reading.catch(() => undefined);
    const retrieving = this.#retrieve(
      extras,
      present,
      request,
      where,
      warm === null ? limit : this.agent.config.voice.live_context_ms,
    );
    try {
      const read = await reading;
      for (const section of read?.sections ?? []) {
        // The profiles say what the pinned people section said, once (v4 §5.6).
        const shown = section.key === "commitments" || (section.key === "people" && !profiled);
        if (shown) {
          const body = section.lines.join("\n");
          extras.own.push(dataBlock(`pinned.${section.key}`, section.title, body));
        }
      }
      if (pinned !== null && read === undefined) {
        extras.reasons.push("pinned memory skipped: not ready");
      }
    } catch (error) {
      if (this.signal.aborted) throw error;
      extras.reasons.push(`pinned memory skipped: ${errorMessage(error)}`);
    }
    const [memories, block] = await retrieving;
    if (block !== null) extras.own.push(block);
    return memories;
  }

  /** What memory finds for the line she answers, and its data block (`null`: none). */
  async #retrieve(
    extras: Extras,
    present: readonly PresentPerson[],
    request: PromptRequest,
    where: PinnedContext,
    limit: number,
  ): Promise<[RetrievedMemory[], string | null]> {
    const m = this.agent.config.mainline;
    const now = where.now;
    const retrieval = this.agent.ctx.services.get(MemoryRetrievalKey);
    const text = request.query;
    if (!retrieval || text.trim() === "") return [[], null];
    try {
      // v4 §5.4: the lines before the one she answers and who she talks with find memories too,
      // so a reply like 「好啊」 still brings back what the talk is about.
      const query: TurnRetrievalQuery = {
        ...where,
        text,
        recent: this.#linesBefore(m.memory_recent_lines),
        talking_with: present.flatMap((p) => (p.speaker && p.person !== null ? [p.person] : [])),
        ...(m.memory_lines > 0 ? { limit: m.memory_lines } : {}),
      };
      const memories = await timeout(limit, this.signal, (signal) =>
        retrieval.retrieve(query, signal),
      );
      const body = retrieval.format(memories, now);
      const room = Math.floor(m.data_chars / 2);
      const block =
        body.trim() === "" ? null : dataBlock("memory", "你記得的事", truncate(body, room));
      return [memories, block];
    } catch (error) {
      if (this.signal.aborted) throw error;
      extras.reasons.push(`memories skipped: ${errorMessage(error)}`);
      return [[], null];
    }
  }

  /**
   * The `n` lines before the newest one she answers, oldest first, as the transcript reads them:
   * the other messages of the same turn count too (`PromptRequest.recent` stops before them).
   */
  #linesBefore(n: number): string[] {
    if (n <= 0) return [];
    const her = this.agent.persona.displayName();
    const history = this.session.history().filter((e) => !this.#hidden(e));
    const last = this.#focused.at(-1);
    const end = last === undefined ? -1 : history.findIndex((e) => e.id === last.id.id);
    const before = end < 0 ? history : history.slice(0, end);
    return before.slice(-n).map((e) => transcriptLine(e, her));
  }

  /** The tools on offer: what she can do, how to promise and how to change a running task. */
  #mainTools(main: MainTurn): ToolSpec[] {
    const cfg = this.agent.config;
    const depth = main.claim.chain?.depth ?? 0;
    if (!cfg.tools_enabled || depth > cfg.max_tool_steps) return [];
    const steerable = main.main.tasks().length > 0;
    const allowed = this.agent.ctx.services.get(DirectivesKey);
    const specs = allowed?.filterTools(this.#toolSpecs(), this.key) ?? this.#toolSpecs();
    const limits = { description: cfg.mainline.tool_chars, argument: cfg.mainline.tool_arg_chars };
    return [
      ...specs.map((s) => slimTool(s, limits)),
      COMMIT_SPEC,
      ...(steerable ? [STEER_SPEC] : []),
    ];
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
    const examples = this.#mainExamples();
    const wishes = services.get(DirectivesKey)?.wishes(this.key) ?? [];
    // A turn answering someone tells what they (or nobody) asked for, not another person's.
    const answering = main.claim.kind === "addressed" || main.claim.kind === "reply";
    const telling = resultsFor(
      [...line.hands.peekResults(ACTING_ALONE), ...line.hands.peekResults(this.key)],
      answering ? this.#authors() : null,
    );
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
    ].filter((d): d is string => d !== null);
    const selection = this.plan.selection;
    const verbs = selection === null ? new Map<string, string>() : focusVerbs(selection);
    const folded = services.get(ConversationStatesKey)?.get(this.key) ?? null;
    const fold = folded?.folded_up_to ?? null;
    // The history starts where the last turn's did, and only grows (`historyWindow`): unless the
    // session edited a line since, the prefix up to the newest line is the last turn's, which the
    // provider has cached (an edited line costs a cache miss, nothing else).
    const window = historyWindow(
      markCurrent(
        this.session.history().filter((e) => !this.#hidden(e)),
        selection?.focus ?? [],
        verbs,
      ),
      this.session.promptStart,
      {
        lines: m.history_lines,
        chars: m.history_chars,
        entryChars: m.entry_chars,
        trim: m.history_trim,
      },
      fold === null ? null : timestampMs(fold.ts),
      Math.min(cfg.history_after_fold, m.history_lines),
    );
    this.session.promptStart = window.start;
    const history = withOlderParents(
      window.shown,
      (id) => this.#shownEntry(id),
      (id) => this.#shownAround(id),
    );
    this.#replyTargets = focusEntries(history);
    const tail = tailSection({
      head: whenAndWhere(this.key, new Date(now), offset),
      notes: extras.self,
      state: contextState(buckets),
      tasks: line.tasks().map((t) => `${t.task}(${t.owner}):${t.text}`),
      recent: main.main.recent(this.key, m.recent_lines),
      actions: [...line.hands.recent(ACTING_ALONE, 2), ...line.hands.recent(this.key, 3)],
      speaksIn: this.voice ? speaksIn : null,
      now,
      party: services.get(PartyStatusKey)?.running(this.key) ?? null,
      style: this.#styleNote(history),
    });
    // What her tools brought back in earlier turns, beside her lines (v4 §4.2).
    const traces = [...keptOf(this.session).traces.list()];
    const build = (kept: readonly HistoryEntry[]) =>
      mainMessages({
        fixed: core === "" ? rules : `${core}\n\n${rules}`,
        pinned: pinnedSection(
          line.ownerRules(this.key),
          line.commitments.open(this.key),
          now,
          offset,
        ),
        slow: [...(examples === null ? [] : [examples]), ...extras.slow],
        data,
        history: kept,
        tail,
        turn: { kind: main.claim.kind, muted: main.claim.muted },
        transcript: {
          // The window is within `history_chars` already; this only stops what it misjudged.
          maxChars: m.history_chars * 2,
          maxEntryChars: m.entry_chars,
          gapMs: cfg.time_gap_ms,
          traces,
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
        (text) => this.#selfTalk(text),
      );
      await this.#mainCall(main, router, messages, tools, priority, speech, null, null, null);
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
    // Her reasoning is no reply (leak.ts). Each response of the tool loop is judged on its own.
    type Line = { text: string; blocked: string | null; n: number | null };
    const screening = cfg.corrections.leak_screen;
    const selfTalk = cfg.corrections.self_talk;
    let screen = new ReplyScreen<Line>(screening, selfTalk);
    let first: Line | null = null;
    let leaked = 0;
    const out = async (item: Line) => {
      early.push(await this.#sendText(sink, item.text, direct, priority, item.blocked, item.n));
    };
    const send = async (raw: string) => {
      for (const part of splitByReplyMarks(raw)) {
        if (main.claim.muted) return;
        const mark = takeReplyMark(part);
        // What an earlier round of the tool loop already said is not sent twice.
        mark.text = main.cutRepeats(mark.text);
        if (mark.text.trim() === "") continue;
        const safe = this.#safe(cleanReply(mark.text, names));
        const text = this.#linkMentions(safe.text);
        if (text === "") continue;
        // Noted as said before the screen decides: the first line it holds is still hers to say.
        main.sent(text);
        const was = screen.droppedLines;
        const cut = screen.selfTalk;
        const item = { text, blocked: safe.blocked, n: mark.n };
        const { send: now, retracted } = screen.push(item);
        if (screen.selfTalk > cut) {
          // A note to herself (leak.ts `isSelfTalk`): only this line is left out, and it is not
          // what she said. It is not the first line the screen holds either.
          main.unsent(text);
          this.#tally.count("self_talk_cut");
          continue;
        }
        if (screen.droppedLines > was) {
          // Neither this line nor a first line it took back reached anyone: they are not what she
          // said (2026-11-10 review: the dropped lines stayed in `said`, and a line of reasoning
          // like 「我可以說:「我馬上進語音」」 could become a promise she made).
          main.unsent(text);
          if (retracted && first !== null) main.unsent(first.text);
          this.#tally.count("leak_dropped", screen.droppedLines - was);
          if (was === 0) {
            this.agent.log.warn(
              { turn: this.turn },
              "her reasoning was written as the reply: dropped",
            );
          }
          leaked += screen.droppedLines - was;
        } else if (now.length === 0) first = item;
        for (const sent of now) await out(sent);
      }
    };
    const segments = new TextSegments(send, (text) => main.holdsText(text));
    // A round of the tool loop ended: its first line, if the screen still holds it, goes out
    // before the tools run, and so the person sees 「我查一下」 while she looks.
    const between = async () => {
      if (!main.claim.muted) for (const item of screen.flush()) await out(item);
      screen = new ReplyScreen<Line>(screening, selfTalk);
      first = null;
    };
    try {
      await this.#mainCall(main, router, messages, tools, priority, null, segments, send, between);
      if (!main.claim.muted) for (const item of screen.flush()) await out(item);
      this.#save();
    } finally {
      typing.abort();
      this.signal.removeEventListener("abort", stopTyping);
      await typingLoop;
    }
    if (leaked > 0) this.#leakEvidence(router);
    return early.join("\n");
  }

  /**
   * Her reasoning was written as the reply (leak.ts). Why is not known yet (docs/design/backlog.md,
   * docs/design/v4-patches.md): the call log that could tell is in memory only and gone with a
   * restart. So what the provider said about this turn's calls goes to the log now, without any
   * text: whether the request asked for thinking, whether the provider sent reasoning apart from
   * the reply (its characters and tokens), which model answered and whether it was a fallback.
   */
  #leakEvidence(router: LlmRouter): void {
    const log = (router as Partial<Pick<LlmRouter, "calls">>).calls;
    if (log === undefined || typeof log.list !== "function") return;
    const calls = log.list({ turn: this.turn, module: "agent" }, 8).items.map((c) => ({
      id: c.id,
      model: c.model,
      reasoning: c.reasoning,
      thinking: c.thinking,
      reasoning_chars: c.reasoning_chars,
      reasoning_tokens: c.usage?.reasoning_tokens ?? null,
      text_chars: c.text_chars,
      finish_reason: c.finish_reason,
      fallbacks: c.fallbacks.length,
    }));
    this.agent.log.warn(
      { turn: this.turn, calls },
      "leaked reasoning: what the provider said about the calls of this turn",
    );
  }

  /** Streams one response. A model that does not start in time counts as failed. */
  async #mainStream(
    main: MainTurn,
    router: LlmRouter,
    request: ChatRequest,
    speech: Speech | null,
    segments: TextSegments | null,
    firstTokenMs: number | null = null,
    level: ReasoningLevel = this.#level ?? "off",
  ): Promise<Step> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.signal.reason);
    if (this.signal.aborted) onAbort();
    this.signal.addEventListener("abort", onAbort, { once: true });
    const deadline =
      level === "off"
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
   * The reasoning purpose of a call of the main line (v4 §4.4) and its level: a call that reads
   * what her tools brought back is `chat_tools`, a text reply to a real question `chat_question`.
   * Never less than the turn's own purpose would get, so a tier nobody configured changes nothing.
   */
  #mainReasoning(
    main: MainTurn,
    router: LlmRouter,
    request: ChatRequest,
    afterTools: boolean,
  ): ReasoningLevel {
    const base = this.#reasoningPurpose();
    const question =
      !this.voice &&
      this.intent === null &&
      main.claim.kind === "addressed" &&
      this.#focused.some((m) => asksSeriously(messageText(m)));
    const purpose = afterTools ? TOOL_STEP_PURPOSE : question ? QUESTION_PURPOSE : base;
    const level = higher(
      router.reasoningFor("chat", { ...request, reasoning_purpose: base }),
      router.reasoningFor("chat", { ...request, reasoning_purpose: purpose }),
    );
    request.reasoning_purpose = purpose;
    request.reasoning = level;
    return level;
  }

  /**
   * One turn of the main line: what she says goes out while it is written, then her words are
   * compared with her actions. The tools of `loop_tools` run inside the turn (v4 §4.2): their
   * results go back to her with the transcript of the turn so far, for up to `max_tool_steps`
   * rounds; what is left for the hands goes out with the last response. Only a claim with nothing
   * behind it costs a corrective call (claims.ts: the last resort, as §10.1 has it).
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
    between: (() => Promise<void>) | null,
  ): Promise<void> {
    const cfg = this.agent.config;
    const messages = [...initial];
    main.offered(tools.map((t) => t.name));
    const offered = new Set(tools.map((t) => t.name));
    // Only what is on offer: the Directives' filter decided that, and it holds inside the loop too.
    const loop = new Set(main.config.loop_tools.filter((t) => offered.has(t) && !isPseudoTool(t)));
    let prompt: string | null = null;
    /** The response a corrective call stands in for: what is left if that call fails. */
    let before: Step | null = null;
    /** Calls of earlier rounds that are the hands' (and `commit`): they go with the output. */
    const later: ToolCall[] = [];
    let rounds = 0;
    // All the loop's tools of the turn together: the turn holds the Floor while they run.
    const budget = this.voice ? main.config.voice_loop_budget_ms : main.config.loop_budget_ms;
    const started = this.#now;
    const left = () => budget - (this.#now - started);
    const run = (tool: string, id: string, args: string, signal: AbortSignal) =>
      this.#hand({ id, name: tool, arguments: args }, priority, signal);
    /** A round of tools ran: leaving now must not lose what it did or handed over. */
    let looped = false;
    let concluded = false;
    const leave = (why: "failed" | "stopped") => {
      if (concluded || !looped) return;
      concluded = true;
      const output = turnOutput(new Expression(), handOver(later), main.said);
      main.leave({ ...output, say: [...main.said] }, run, this.#requester(), why);
    };
    try {
      for (;;) {
        const request: ChatRequest = {
          messages: [...messages],
          tools,
          temperature: cfg.temperature,
          max_tokens: cfg.max_tokens,
          reasoning_purpose: this.#reasoningPurpose(),
          session: this.#llmSession(),
        };
        const level = this.#mainReasoning(main, router, request, rounds > 0);
        this.#level ??= level;
        segments?.step();
        let step: Step;
        let fellBack = false;
        try {
          // In voice the person waits in silence: a correction starts soon or not at all.
          const deadline = before !== null && this.voice ? VOICE_CORRECTION_MS : null;
          step = await this.#mainStream(main, router, request, speech, segments, deadline, level);
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
          leave("stopped");
          return;
        }
        const now = fellBack ? [] : calls.filter((c) => loop.has(c.name));
        if (now.length > 0 && rounds < cfg.max_tool_steps && left() > 0) {
          looped = true;
          await this.#roundEnded(main, expression, now, speech, segments, send, between);
          messages.push(assistantMessage(raw, calls));
          let ran = 0;
          // A page is one result now: what a round adds together keeps the bound it had.
          let roundLeft = main.config.loop_round_chars;
          for (const call of calls) {
            let result: string;
            if (!main.isOffered(call.name)) {
              this.agent.log.warn(
                { turn: this.turn, tool: call.name },
                "a tool not on offer was called",
              );
              result = NOT_OFFERED;
            } else if (!loop.has(call.name)) {
              later.push(call);
              result = handedOver(call.name);
            } else if (speech?.stopped() || this.signal.aborted) {
              // A barge-in does not abort the turn: the rest of the round must not run behind it.
              result = CUT_OFF;
            } else if (ran >= main.config.loop_calls) {
              result = TOO_MANY;
            } else if (left() <= 0) {
              result = OUT_OF_TIME;
            } else {
              ran += 1;
              result = await this.#inTurn(main, call, offered, priority, left(), roundLeft);
              roundLeft = Math.max(0, roundLeft - result.length);
            }
            messages.push(toolResultMessage(call.id, result));
          }
          rounds += 1;
          main.round();
          this.signal.throwIfAborted();
          if (speech?.stopped()) {
            leave("stopped");
            return;
          }
          continue;
        }
        if (segments !== null && !expression.isSilent() && !fellBack) {
          for (const text of textPieces(segments.rest(expression))) {
            main.gate.hold({ text, spoken: null, emotion: null });
          }
        }
        // A tool written as a tag runs nothing (it may be words she was talked into). She is asked
        // once, in the same turn, to call it or not claim it; the lines she said stand.
        prompt ??= promptText(initial);
        const called = calls.map((c) => c.name);
        const written = fellBack
          ? []
          : toolsWrittenAsText(expression.tools, offered, called, prompt);
        main.wrote(written);
        const depth = main.claim.chain?.depth ?? 0;
        if (
          cfg.corrections.tool_text_reask &&
          written.length > 0 &&
          calls.length === 0 &&
          depth < cfg.max_tool_steps &&
          main.takeCorrection()
        ) {
          this.agent.log.info(
            { turn: this.turn, tools: written },
            "asking her to call what she wrote",
          );
          main.tally.count("tool_text_reask");
          before = step;
          messages.push(assistantMessage(raw, []));
          messages.push(userMessage(toolTextReminder(written)));
          continue;
        }
        // Calls of the loop past the last round go to the hands too: a result turn tells her.
        const output = turnOutput(expression, handOver([...later, ...calls]), main.said);
        const fresh = new Set(calls.map((c) => c.name));
        const outcome = main.finish(
          output,
          later.map((c) => c.name).filter((t) => !fresh.has(t)),
        );
        if (outcome.remind !== null) {
          messages.push(assistantMessage(raw, []));
          messages.push(userMessage(claimReminder(outcome.remind.tool)));
          continue;
        }
        for (const line of main.releasable(outcome.release)) {
          if (speech !== null) {
            main.said.push({ text: line.text, voice: line.spoken, emotion: line.emotion });
            await speech.release(line);
          } else await send?.(line.text);
        }
        // A model that gave nothing at all is no decision to be quiet.
        if (main.owed && main.said.length === 0 && !output.silence && output.actions.length === 0) {
          throw new TurnError("the model returned nothing");
        }
        concluded = true;
        main.conclude({ ...output, say: [...main.said] }, run, this.#requester());
        return;
      }
    } catch (error) {
      leave(this.signal.aborted ? "stopped" : "failed");
      throw error;
    }
  }

  /**
   * A response of the tool loop ended with calls of the loop: what she wrote after the last line
   * break goes out (or waits behind a held line, as the gate decides), and in voice someone who has
   * heard nothing yet hears a line before the tools run.
   */
  async #roundEnded(
    main: MainTurn,
    expression: Expression,
    calls: readonly ToolCall[],
    speech: Speech | null,
    segments: TextSegments | null,
    send: ((text: string) => Promise<void>) | null,
    between: (() => Promise<void>) | null,
  ): Promise<void> {
    if (segments !== null && !expression.isSilent()) {
      const rest = segments.rest(expression);
      if (rest.trim() !== "") {
        if (main.holdsText(rest)) {
          for (const text of textPieces(rest))
            main.gate.hold({ text, spoken: null, emotion: null });
        } else await send?.(rest);
      }
    }
    await between?.();
    if (speech === null) return;
    const wait = main.waitFor(calls.map((c) => c.name));
    if (wait === null) return;
    const line = { text: wait, spoken: null, emotion: null };
    main.said.push({ text: line.text, voice: null, emotion: null });
    await speech.release(line);
  }

  /**
   * A call of the loop, run now within `leftMs` of the turn's time for tools: what goes back to her
   * in the same chain. What a tool brought back is outside content (a page, a search, someone's
   * note): it goes back as data, like the results the hands report.
   */
  async #inTurn(
    main: MainTurn,
    call: ToolCall,
    offered: ReadonlySet<string>,
    priority: Priority,
    leftMs: number,
    roundChars: number = Number.POSITIVE_INFINITY,
  ): Promise<string> {
    const limit = Math.max(1, Math.min(this.agent.config.tool_timeout_ms, leftMs));
    const { run, accepted } = await main.inTurn(
      call.name,
      call.arguments,
      () => this.#hand(call, priority, this.signal, limit),
      this.#requesterOf(call),
    );
    if (run.ok) this.#succeeded.add(call.name);
    this.#trace(call, run.ok, run.text);
    // Cut before it is wrapped, so the block it goes back in stays whole.
    const room = Math.max(ROUND_MIN_CHARS, roundChars);
    const body = run.text.length > room ? `${truncate(run.text, room)}${ROUND_CUT}` : run.text;
    let text = dataBlock("tool", `${call.name} 的結果`, neutralize(body));
    if (run.ok && accepted) text = `${text}\n${STILL_RUNNING}`;
    // Read in this turn; the next keeps the head of it in the trace, unless she keeps more.
    if (
      run.ok &&
      text.length >= LONG_RESULT_CHARS &&
      !NOTE_TOOLS.has(call.name) &&
      offered.has(KeepNoteTool.NAME)
    ) {
      const hint = loopKeepHint(charCount(run.text.trim()), accepted, this.#tracedChars());
      if (hint !== null) {
        text += hint;
        main.tally.count("keep_hint");
      }
    }
    return text;
  }

  /**
   * How much of one result of the loop the trace keeps beside her reply (`null`: no trace is kept
   * this turn). A turn's calls share `trace_chars`: once they are past it a call may be left out
   * of the trace altogether, so that counts as no trace.
   */
  #tracedChars(): number | null {
    const m = this.agent.config.mainline;
    if (m.traces <= 0 || m.trace_chars <= 0 || this.#traceAfter === null) return null;
    const used = this.#traced.reduce(
      (n, c) => n + Math.min(charCount(c.result), m.trace_result_chars),
      0,
    );
    return used > m.trace_chars ? null : m.trace_result_chars;
  }

  /**
   * Keeps what a call of the loop brought back, in a few lines beside her reply (v4 §4.2): the
   * next turn knows what she looked up and what it said. Kept after every call, so it is complete
   * before any later line of hers is recorded. Her notes are shown on their own: not traced.
   */
  #trace(call: ToolCall, ok: boolean, result: string): void {
    if (NOTE_TOOLS.has(call.name)) return;
    const m = this.agent.config.mainline;
    if (m.traces <= 0) return;
    this.#traced.push({ tool: call.name, args: call.arguments, ok, result });
    const text = traceText(this.#traced, m.trace_chars, m.trace_result_chars);
    if (text === null) return;
    // After the line that is last now: what she said before the lookup, else what she answers.
    this.#traceAfter ??= traceAnchor(this.session.history().filter((e) => !this.#hidden(e)));
    if (this.#traceAfter === null) return;
    keptOf(this.session).traces.put(this.turn, this.#traceAfter, text, m.traces);
  }

  /** One action, in the hands: it may outlive this turn. */
  async #hand(
    call: ToolCall,
    priority: Priority,
    signal: AbortSignal,
    limitMs?: number,
  ): Promise<Run> {
    let data: JsonValue = null;
    const [ok, full] = await this.#tryTool(
      call,
      priority,
      signal,
      (d) => {
        data = d;
      },
      limitMs,
    );
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
      // The pieces of one long message follow each other at once; a new message waits its turn.
      if (i === 0) await this.#pace(sink, lane, priority, chunk);
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
      this.session.recordOwn(displayName, me, chunk, id, this.#now, this.#answering());
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
      this.#lastTextAt = this.#now;
    }
    return text;
  }

  /**
   * v4 §7.3: the second and later messages of a reply wait for about as long as typing them takes
   * (`paceMs`, from when the one before went out; generating them counts), with typing shown, so
   * several short lines do not land at once. The first message never waits here.
   */
  async #pace(sink: ActionSink, lane: LaneKey, priority: Priority, text: string): Promise<void> {
    const last = this.#lastTextAt;
    if (last === null) return;
    const wait = paceMs(this.agent.rhythm.config, text) - (this.#now - last);
    if (wait <= 0) return;
    try {
      await sink.submit(this.#typingAction(lane, priority));
    } catch (error) {
      this.agent.log.warn({ error: errorMessage(error) }, "could not submit typing action");
    }
    await sleep(wait, this.signal);
  }

  #typingAction(lane: LaneKey, priority: Priority) {
    return newAction(
      lane,
      priority,
      { type: "typing", context: this.key },
      {
        ttl: TYPING_TTL_MS,
        turn: this.turn,
        coalesce_key: `typing:${contextKeyDisplay(this.key)}`,
      },
    );
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
      try {
        await sink.submit(this.#typingAction(lane, priority));
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
        const flags = cfg.corrections;
        const claim = flags.claims ? unbackedClaim(expression.text, names, this.#backing()) : null;
        // The same for a tool she wrote as a tag: it runs nothing, she is asked to call it.
        const written =
          claim === null && flags.tool_text_reask
            ? toolsWrittenAsText(expression.tools, names, [], promptText(initial))
            : [];
        if (claim || written.length > 0) {
          reminded = true;
          this.#tally.count(claim ? "claim_reask" : "tool_text_reask");
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
      // Calls that only look (a search, a balance) run side by side; anything else alone, in order.
      const readOnly = (call: ToolCall) => this.#tool(call.name)?.readOnly === true;
      for (const batch of toolBatches(calls, readOnly)) {
        const tried = await Promise.all(batch.map((call) => this.#tryTool(call, priority)));
        batch.forEach((call, i) => {
          const result = this.#toolResult(call, tried[i] as [boolean, string]);
          messages.push(toolResultMessage(call.id, result));
        });
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
    this.#mark("request");
    const stream = await guard(
      withLlmTag({ module: "agent", turn: this.turn, label: this.voice ? "voice" : "reply" }, () =>
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
    let first = true;
    try {
      for (;;) {
        const next: IteratorResult<StreamEvent> = await guard(iterator.next(), signal);
        onFirst?.();
        if (first) {
          first = false;
          this.#mark("first_token");
          // A voice turn started early: nothing it wrote is said or done before it is confirmed.
          await this.#confirmed();
        }
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
          // Her words are written before her tool calls: the last sentence need not wait for them.
          if (calls.length === 0 && speech !== null && !expression.silence) await speech.settle();
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
  /** What a call brought back, as the model reads it; publishes `agent.tool`. */
  #toolResult(call: ToolCall, [ok, full]: [boolean, string]): string {
    if (ok) this.#succeeded.add(call.name);
    let result = truncate(full, this.agent.config.max_tool_result_chars);
    // A long result (a search, lyrics, a page) is gone next turn unless she keeps what matters.
    if (ok && result.length >= LONG_RESULT_CHARS && call.name !== KeepNoteTool.NAME) {
      const offered = this.#toolSpecs().some((t) => t.name === KeepNoteTool.NAME);
      if (offered) {
        result += KEEP_HINT;
        this.#tally.count("keep_hint");
      }
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
    const name = tool.spec.name;
    if (isInternalTool(name)) return false;
    if (this.voice && name === ReactTool.NAME) return false;
    if (!offeredIn(tool, scope)) return false;
    // A game's moves only while one runs here, turtle soup's referee only for turtle soup, and
    // no second game over a running one (one per channel).
    const game = PARTY_MOVES.get(name);
    const starts = name === PARTY_START;
    if (game === undefined && !starts) return true;
    const party = this.agent.ctx.services.get(PartyStatusKey);
    if (party === undefined) return true;
    const running = party.running(this.key);
    if (starts) return running === null;
    return running !== null && (game === null || running.game === game);
  }

  #toolSpecs(): ToolSpec[] {
    const scope = this.#toolScope();
    const tools = this.agent.tools;
    const several = severalPeople(this.#focused.map((m) => m.author));
    return tools.names().flatMap((name) => {
      const tool = tools.get(name);
      if (!tool || !this.#offers(tool, scope)) return [];
      return [several && tool.actsFor === true ? withFor(tool.spec) : tool.spec];
    });
  }

  /**
   * The message a call acts for (`callFor`): its `for_whom` (taken off `args`) among the people of
   * the focus when several called her at once, else `#requester`.
   */
  #callFor(tool: Tool | undefined, args: JsonValue): CallFor {
    let pick: unknown;
    if (isJsonObject(args) && FOR_ARG in args) {
      pick = args[FOR_ARG];
      delete args[FOR_ARG];
    }
    const names = this.agent.persona.names();
    return callFor(
      this.#focused,
      this.#replyTargets,
      pick,
      tool?.actsFor === true,
      (m) => m.mentions_self || (m.reply_to_self && directReason(m, names) === "reply"),
      () => this.#requester(),
    );
  }

  /** The message a call acts for, for the hands' record (`#requester` when it cannot tell). */
  #requesterOf(call: ToolCall): IncomingMessage | undefined {
    let args: JsonValue = {};
    try {
      args = JSON.parse(call.arguments.trim() === "" ? "{}" : call.arguments) as JsonValue;
    } catch {
      return this.#requester();
    }
    const found = this.#callFor(this.#tool(call.name), args);
    return found.ok ? found.message : this.#requester();
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
    limitMs: number = this.agent.config.tool_timeout_ms,
  ): Promise<[boolean, string]> {
    // The main line runs only what this turn offered: the Directives' filter is not just a list
    // shown to the model (a name it wrote anyway used to reach the hands and run).
    if (this.#main !== null && !this.#main.isOffered(call.name)) {
      this.agent.log.warn({ turn: this.turn, tool: call.name }, "a tool not on offer was called");
      return [false, `error: ${NOT_OFFERED}`];
    }
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
    // Whom it is for, before anything runs: never silently the latest speaker (`callFor`).
    const target = this.#callFor(tool, args);
    if (!target.ok) return [false, `error: ${target.error}`];
    if (this.#main !== null) {
      const grounded = groundArgs(call.name, args, this.key);
      if (JSON.stringify(grounded) !== JSON.stringify(args)) this.#tally.count("ground_args");
      args = grounded;
    }
    const last = target.message;
    if (!last && this.intent === null && this.#main === null) {
      return [false, "error: no triggering message"];
    }
    const me = this.agent.selfAccount(this.key.platform);
    try {
      const out = await timeout(limitMs, turnSignal, (signal) => {
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
    // Flooding is something people do: lyrics repeating 「我喜歡你」 are no flood (2026-11-09), and
    // she was told the song she looked up was spam. Only what a tool's text says can earn a note.
    if (!verdict?.note || verdict.flags.every((f) => f === "flood")) return text;
    return `${verdict.note}\n${text}`;
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
      case "spoken_start":
        await out.settle();
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
/** What the people block says of her crush. */
const SECRET = "你偷偷喜歡他";

/**
 * The profiles of the people here with her crush marked on `handle`'s `<person>` tag (a tag of its
 * own when the profiles have none for them).
 */
export function markSecret(body: string, handle: string): string {
  const name = ` name="${escapeXml(safeName(handle))}"`;
  const lines = body === "" ? [] : body.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`<person${name}`) && l.endsWith("/>"));
  if (at < 0) return [...lines, personTag({ name: handle, secret: SECRET })].join("\n");
  const line = lines[at] as string;
  lines[at] = `${line.slice(0, -2)}${xmlAttrs({ secret: SECRET })}/>`;
  return lines.join("\n");
}

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

/**
 * `spec` with a required `for_whom` (`callFor`): several people called her at once, so a tool that
 * acts for someone says whom.
 */
function withFor(spec: ToolSpec): ToolSpec {
  const params = isJsonObject(spec.parameters) ? spec.parameters : { type: "object" };
  const properties = isJsonObject(params.properties) ? params.properties : {};
  const required = Array.isArray(params.required)
    ? params.required.filter((r) => r !== FOR_ARG)
    : [];
  return {
    ...spec,
    parameters: {
      ...params,
      properties: { ...properties, [FOR_ARG]: { ...FOR_PROPERTY } },
      required: [...required, FOR_ARG],
    },
  };
}
