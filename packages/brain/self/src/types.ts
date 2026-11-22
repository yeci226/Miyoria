// What one run of the turn runner takes and gives: who woke her, the edges it works through
// (every one an interface, so Core's wiring and the eval subject are thin), and the events it
// reports.

import type {
  ChatRequest,
  ChatResponse,
  ContentPart,
  Pricing,
  StreamEvent,
  ToolCall,
  Usage,
} from "@miyoria/llm/llm";
import type {
  LoadedTools,
  ToolContext,
  ToolEntry,
  ToolRefusalCode,
  ToolResult,
} from "@miyoria/llm/tools";
import type { TranscriptStore } from "@miyoria/memory/transcript";
import type { Logger } from "@miyoria/runtime/kernel";
import type {
  AccountRef,
  Clock,
  ContextKey,
  FloorClaimKind,
  JsonValue,
  MessageRef,
  Timestamp,
} from "@miyoria/types";
import type { LimitName, ProfileName, RunProfile } from "./profiles.js";

/** One conversation she is part of: its transcript's name and the place it is. */
export interface RunSession {
  id: string;
  context: ContextKey;
}

/** Who said the line that woke her. */
export interface WakeAuthor {
  account: AccountRef;
  name: string;
}

/** Why a line is for her (`directReason` of today's attention, as a word). */
export type AddressedReason = "mention" | "name" | "reply" | "dm";

/** What woke her. The line itself is in the transcript already; this says what the run is. */
export type Wake =
  /** Someone spoke to her: someone waits for an answer. */
  | {
      kind: "addressed";
      reason: AddressedReason;
      from: WakeAuthor;
      message: MessageRef;
      /**
       * What block 7 says woke her, when the host words it itself (someone asked her from the
       * message's menu to answer a line that need not be the newest). Unset: by `reason`.
       */
      line?: string;
      /**
       * Everyone who called her in the lines the run answers, in order, each with their newest
       * line that called her; `from` is the first. Unset: only `from`.
       */
      callers?: readonly { from: WakeAuthor; message: MessageRef }[];
    }
  /** Something she started came back. */
  | {
      kind: "result";
      tool: string;
      job: string | null;
      ok: boolean;
      text: string;
      /** Who asked for it, when someone did: tools of the run act for them. */
      from?: WakeAuthor | null;
    }
  /** A time she set came. */
  | { kind: "timer"; note: string }
  /**
   * Something happened in the world that is worth a look. `claim`: the Floor row the Arbiter
   * admitted it under (a game's narration, a song's announcement); unset: `notable`.
   */
  | { kind: "world"; what: string; claim?: FloorClaimKind }
  /** Nobody called her: a look at what people said here lately. */
  | { kind: "glance"; lines: number }
  /** Her own time: nobody spoke and nothing came back. */
  | { kind: "self"; note: string | null };

export type WakeKind = Wake["kind"];

/** Whether someone waits for her to say something: only then is a failure worth a fixed line. */
export function someoneWaits(wake: Wake): boolean {
  return wake.kind === "addressed";
}

/** The person a run's tools act for, when there is one. */
export function wakeAuthor(wake: Wake): WakeAuthor | null {
  if (wake.kind === "addressed") return wake.from;
  if (wake.kind === "result") return wake.from ?? null;
  return null;
}

// ---- the model ---------------------------------------------------------------------------------

/** A response stream that may say which model answers (`RoutedStream`). */
export type ModelStream = AsyncIterable<StreamEvent> & { readonly model?: string };

/** What the runner needs of the LLM router; `LlmRouter` is one. */
export interface RunModel {
  stream(purpose: string, request: ChatRequest, signal?: AbortSignal): Promise<ModelStream>;
  complete(purpose: string, request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  /** `[llm.pricing]` by `provider:model`. Unset, or a model not in it: its tokens are counted. */
  prices?(): Record<string, Pricing>;
}

// ---- tools -------------------------------------------------------------------------------------

/** What the runner needs of the tool registry; `ToolRegistry` is one. */
export interface RunTools {
  offered(session: string): ToolEntry[];
  entry(name: string): ToolEntry | undefined;
  run(name: string, ctx: ToolContext, args: JsonValue): Promise<ToolResult>;
  readonly loaded: LoadedTools;
}

// ---- the prompt --------------------------------------------------------------------------------

/** What a block of the prompt may depend on. */
export interface PromptInput {
  session: RunSession;
  wake: Wake;
  profile: ProfileName;
  turn: string;
  now: number;
}

/**
 * Where the blocks around the transcript come from (docs/design/v5-brain.md 「提示詞版面」). Each
 * gives its text, or `null` for nothing. `place` and `recalled` are data: what they return is
 * already framed (`dataBlock` of `@miyoria/types`, names through `safeName`).
 */
export interface PromptSource {
  /** Block 1: the persona core. The runner adds its rules (`rules.ts`) after it. */
  fixed(input: PromptInput): Promise<string | null>;
  /** Block 3: the owner's rules and her own document. Changes about once a day. */
  pinned(input: PromptInput): Promise<string | null>;
  /** Block 4: the summary of this place and the cards of its regulars. */
  place(input: PromptInput): Promise<string | null>;
  /** Block 6: what was retrieved for this run, and her inbox. */
  recalled(input: PromptInput): Promise<string | null>;
  /**
   * Block 6, after `recalled`: what the lines of this run carry that is not text in the
   * transcript (the files read for her, the images with a line saying whose and where). Only this
   * run sees them; the transcript keeps references and alt text. Unset: nothing.
   */
  attachments?(input: PromptInput): Promise<ContentPart[]>;
  /** Block 7: the inside of `<now>`: time, place, state, mood, what she has going on. */
  now(input: PromptInput): Promise<string | null>;
  /**
   * Block 7, after `<now>`: the inside of `<style_note>`, this run's reminders of how she sounds
   * (the lorebook entries what was just said brings up, a few kaomoji). Unset: none.
   */
  style?(input: PromptInput): Promise<string | null>;
}

// ---- the guard ---------------------------------------------------------------------------------

/** What a check is told about the run. */
export interface GuardContext {
  session: RunSession;
  turn: string;
  wake: Wake;
  profile: ProfileName;
  now: number;
}

export interface GuardCall {
  call: ToolCall;
  /** The parsed arguments. */
  args: JsonValue;
  entry: ToolEntry;
}

export type GuardVerdict =
  | { allow: true }
  | {
      allow: false;
      /** A stable word for the event (`directive`, `permission`, `rate`, `moderation`, ...). */
      code: string;
      /** What she is told, in her language. */
      text: string;
      /**
       * A refused line only: a fixed line said in its place (a game's plain answer for a line that
       * gave its secret away), itself checked like any line. Unset: nothing is said.
       */
      instead?: string;
    };

export const ALLOW: GuardVerdict = { allow: true };

export function refuse(code: string, text: string, instead?: string): GuardVerdict {
  return instead === undefined
    ? { allow: false, code, text }
    : { allow: false, code, text, instead };
}

/**
 * Asked before every tool call and before every line of hers leaves. It only allows or refuses;
 * her words are never rewritten (a refused line may name a fixed line to say instead). A refusal
 * is never dropped: the runner gives a refused call's text to her as the call's result, and a
 * refused line's as a note of the next round.
 */
export interface Guard {
  checkCall(call: GuardCall, ctx: GuardContext): Promise<GuardVerdict>;
  checkLine(place: ContextKey, line: string, ctx: GuardContext): Promise<GuardVerdict>;
  /**
   * What a tool brought back, before she reads it: the input defence may put a warning in front
   * (`inspectInput`, source `tool`). Unset: as it came.
   */
  screenResult?(text: string, ctx: GuardContext): string;
}

// ---- the way out -------------------------------------------------------------------------------

export interface OutgoingLine {
  place: ContextKey;
  text: string;
  /** The emotion she marked it with, for the stage; `null`: none. */
  emotion: string | null;
  turn: string;
  /** It is a line of the place the run is in (streamed as she writes); `false`: a `say` elsewhere. */
  focus: boolean;
  /** The message it answers, when the run was woken by one. */
  replyTo: MessageRef | null;
}

export type Delivery =
  | {
      status: "delivered";
      message_id: string | null;
      /**
       * The outlet puts the line in the transcript itself, once it is heard (a spoken line: when
       * it starts playing, and only the part heard when she is cut off). The run's own next steps
       * still read it. Unset: the runner writes it when the step ends.
       */
      later?: boolean;
    }
  | { status: "blocked"; reason: string };

/** Puts one line of hers in a place. The focus place gets them one by one as she writes. */
export interface Outlet {
  deliver(line: OutgoingLine, signal: AbortSignal): Promise<Delivery>;
}

// ---- events ------------------------------------------------------------------------------------

/**
 * The screens kept from today's turn (docs/design/v4-patches.md §2: 9, 11/18, 15, 19), and
 * `feel_cut`: a line that read like a feel block without its tags (v5-heart.md §2.9).
 */
export type ScreenKind =
  | "leak_dropped"
  | "self_talk_cut"
  | "tag_stripped"
  | "fallback_line"
  | "feel_cut";

export interface RunUsage {
  /** Model calls made. */
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  reasoning_tokens: number;
}

export type RunOutcome =
  /** At least one line of hers reached someone (or, for a quiet profile, she wrote a result). */
  | "said"
  /** She wrote nothing: her choice. */
  | "silent"
  /**
   * The model failed, or gave nothing (not even `<silence/>`) to someone waiting; the one waiting
   * got the fixed line when it could be sent.
   */
  | "failed"
  /** The signal aborted the run. */
  | "cancelled"
  /**
   * The session's hourly cap was reached before the first step: no model call was made. Someone
   * waiting was told when she is back, once per capped stretch (`HOUR_CAP_LINE`).
   */
  | "over_budget";

export type RunEvent =
  | {
      type: "started";
      turn: string;
      session: string;
      profile: ProfileName;
      wake: WakeKind;
      at: Timestamp;
    }
  | {
      type: "step";
      turn: string;
      round: number;
      /** `provider:model` that answered, when the router said. */
      model: string | null;
      usage: Usage | null;
      cost_usd: number | null;
      finish_reason: string | null;
      text_chars: number;
      reasoning_chars: number;
      calls: number;
      /** The step ran without tools because a limit was reached. */
      final: boolean;
    }
  | {
      /**
       * The first visible text of the run began to stream (once per run): not a `<feel>` block, a
       * `<silence/>`, an emotion tag or a tool call. The host shows her typing from here.
       */
      type: "speaking";
      turn: string;
    }
  | {
      type: "line";
      turn: string;
      place: ContextKey;
      text: string;
      emotion: string | null;
      /** `text`: she wrote it; `say`: the tool; `fixed`: a fixed line of the program. */
      via: "text" | "say" | "fixed";
      message_id: string | null;
    }
  | {
      /** A tool is about to run (after the guard let it through); `tool_call` follows when it ends. */
      type: "tool_start";
      turn: string;
      name: string;
    }
  | {
      type: "tool_call";
      turn: string;
      round: number;
      id: string;
      name: string;
      ok: boolean;
      code: ToolRefusalCode | "refused" | null;
      ms: number;
      job: string | null;
    }
  | {
      type: "refusal";
      turn: string;
      what: "call" | "line";
      /** The tool, for a call. */
      name: string | null;
      code: string;
    }
  | { type: "screened"; turn: string; kind: ScreenKind; count: number }
  | {
      type: "finished";
      turn: string;
      outcome: RunOutcome;
      rounds: number;
      lines: number;
      calls: number;
      usage: RunUsage;
      cost_usd: number;
      /** How the session's hourly cap was counted: `tokens` when its model has no price. */
      spend_basis: "usd" | "tokens";
      limits: LimitName[];
      ms: number;
      compacted: boolean;
      /**
       * Rounds whose tools ran at least the profile's `silentWaitMs` while nothing of hers had gone
       * out in the run: where the old turn said a fixed wait line (owner decision Q8, #12, not kept).
       * Only for a profile that sets `silentWaitMs`.
       */
      silent_waits?: number;
    };

// ---- a run -------------------------------------------------------------------------------------

export interface RunPorts {
  transcript: TranscriptStore;
  tools: RunTools;
  model: RunModel;
  prompt: PromptSource;
  guard: Guard;
  outlet: Outlet;
  clock: Clock;
  log: Logger;
  onEvent?: (event: RunEvent) => void;
  /** Her own account on `platform`: whom a tool acts as when nobody asked. Default `{platform, id: "self"}`. */
  selfAccount?: (platform: string) => AccountRef;
  /** Picks the fixed line (0..1). Default `Math.random`. */
  random?: () => number;
  /**
   * Called with a session and the cut before its transcript is compacted, so her memory reads the
   * lines first (`SegmentFlushKey`). It bounds its own wait; the compaction goes ahead after it.
   */
  beforeCompaction?: (session: string, uptoSeq: number) => Promise<unknown>;
}

export interface RunInput {
  session: RunSession;
  wake: Wake;
  profile: RunProfile;
  signal: AbortSignal;
  /** The turn id written on every entry and event; default: a new one. */
  turn?: string;
}

/** One tool call of a run and how it ended. */
export interface CallRecord {
  id: string;
  name: string;
  /** The arguments as she wrote them. */
  arguments: string;
  ok: boolean;
  /** `refused`: the runner or the guard did not let it run. */
  code: ToolRefusalCode | "refused" | null;
  /** What she read as the result. */
  text: string;
  /** The id of what a `long` tool started, when its executor gave one. */
  job: string | null;
}

export interface RunResult {
  turn: string;
  outcome: RunOutcome;
  /** The lines that reached someone, in order (the focus place and `say`). */
  lines: string[];
  /** What a profile that does not speak wrote in its last step. */
  text: string;
  calls: CallRecord[];
  rounds: number;
  usage: RunUsage;
  cost_usd: number;
  limits: LimitName[];
  compacted: boolean;
  /**
   * The inside of each `<feel>` block she wrote in the run, in order (never shown, never in the
   * transcript); the host applies them once the run ended.
   */
  feel: string[];
}
