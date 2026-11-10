// Content safety (docs/design/v3-architecture.md §16): a review of her output that does not
// depend on the model, and a defence for what comes in.
//
// * Output: every outgoing path (replies, fallback model output, translations, the text just
//   before TTS) calls `ModerationService.screen` with the visible text and the `<voice>` text as
//   separate fields. Blocked text is replaced by the configured filtered line.
// * Input: chat is hostile. `inspect` returns a verdict the main line acts on; it never tells the
//   caller to drop the owner.
//
// The service is local and synchronous on purpose: the voice path cannot wait for a network call.
// Optional providers (`ModerationProvider`) run only in `screenAsync` and can only tighten.

import { type Authorizer, AuthorizerKey } from "./auth.js";
import type { TurnId } from "./ids.js";
import {
  type AccountRef,
  accountRefString,
  type ContextKey,
  contextKeyString,
} from "./platform.js";
import { type ServiceKey, serviceKey } from "./service-key.js";
import { filterOutgoing } from "./untrusted.js";

/** Bus topic of one blocked output. Its payload (`ModerationBlockRecord`) never holds the text. */
export const MODERATION_BLOCK_TOPIC = "moderation.block";
/** Bus topic of an input that was not passed as it is (`InputVerdictRecord`, no text either). */
export const MODERATION_INPUT_TOPIC = "moderation.input";

/** What a rule is about. `custom` is the owner's own. */
export const MODERATION_CATEGORIES = [
  "hate",
  "minors",
  "self_harm",
  "doxxing",
  "secrets",
  "custom",
] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

/** Where a line is about to go. */
export const OUTPUT_PATHS = [
  /** A reply or a line of a turn. */
  "reply",
  /** Output of the fallback model. */
  "fallback",
  /** The translation made for TTS. */
  "translation",
  /** The text handed to TTS (the last stop before a voice). */
  "tts",
  /** Links and code posted beside a voice reply, status lines, subtitles. */
  "aside",
  /** Chat in a game. */
  "game_chat",
  /** Anything else (tools, commands). */
  "other",
] as const;
export type OutputPath = (typeof OUTPUT_PATHS)[number];

/** Which text of a line was checked. */
export type OutputField = "visible" | "voice";

export interface OutputCheck {
  path: OutputPath;
  /** What people read. `null` / absent: nothing to check. */
  visible?: string | null;
  /** What the TTS says (the `<voice>` text, a translation, the text before TTS). */
  voice?: string | null;
  context?: ContextKey | null;
  turn?: TurnId | null;
}

/** One block. It names the rule, never the blocked content. */
export interface ModerationBlock {
  field: OutputField;
  category: ModerationCategory;
  /** Rule id (`hate.en.n-word`), or `<provider>:<category>` for a provider. */
  rule: string;
  layer: "rules" | "provider";
}

export interface OutputVerdict {
  /** True when nothing was blocked. */
  ok: boolean;
  /** The text to use: the original, or the filtered line. `null` when none was given. */
  visible: string | null;
  voice: string | null;
  blocked: ModerationBlock[];
}

/** What is logged and published about a block. No text, only a fingerprint for correlation. */
export interface ModerationBlockRecord extends ModerationBlock {
  at: string;
  path: OutputPath;
  /** Characters of the blocked text. */
  chars: number;
  /** Keyed hash of the blocked text; the key changes on every start, so it cannot be looked up. */
  fingerprint: string;
  context: ContextKey | null;
  turn: TurnId | null;
}

/**
 * An outside check (a hosted moderation endpoint, a small local classifier). It can only say
 * "flagged": there is no way to answer "this is fine" that would loosen a local block.
 */
export interface ModerationProvider {
  readonly id: string;
  check(
    input: { text: string; field: OutputField; path: OutputPath },
    signal: AbortSignal,
  ): Promise<{ flagged: boolean; category?: ModerationCategory }>;
}

// ---- input ----------------------------------------------------------------------------------

export const INPUT_SOURCES = ["chat", "voice", "game_chat", "web", "tool", "other"] as const;
export type InputSource = (typeof INPUT_SOURCES)[number];

export interface InputCheck {
  /**
   * The message or utterance id. More than one place reads a message off the bus: the first
   * `inspect` of an id judges it, the others get the same verdict and it counts once.
   */
  id?: string | null;
  text: string;
  source: InputSource;
  /** Who wrote it; `null` for content nobody wrote (a web page, tool output). */
  author?: { id: string; owner: boolean } | null;
  /** A key for flooding: the context key string, `null` counts all contexts as one. */
  context?: string | null;
  /** Epoch ms (tests); defaults to the clock. */
  now?: number;
}

/** What the main line does with the message. */
export type InputAction =
  /** Nothing unusual. */
  | "pass"
  /** Hand it to the model as suspicious data: never as instructions, with `note` beside it. */
  | "mark"
  /**
   * The author is writing too much or keeps sending flagged messages: their messages do not
   * start a turn or take her attention for `retry_after_ms`. The text may still be seen as data.
   */
  | "rate_limit"
  /** Do not let it into her context at all (for `retry_after_ms`). */
  | "ignore";

export const INPUT_FLAGS = ["injection", "flood", "bait", "impersonation"] as const;
export type InputFlag = (typeof INPUT_FLAGS)[number];

export interface InputVerdict {
  action: InputAction;
  flags: InputFlag[];
  /** Rule ids that matched (`injection.en.ignore-previous`), for the log and the panel. */
  reasons: string[];
  /**
   * The content must be shown to the model as data, not as an instruction. Always true except
   * for chat written by the owner.
   */
  untrusted: boolean;
  /** A short line for the prompt beside suspicious data (`mark`); `null` otherwise. */
  note: string | null;
  /** `rate_limit` and `ignore`: how long until this author is looked at normally again. */
  retry_after_ms: number | null;
  /** The author is the owner: the action is `pass` whatever the flags say. */
  owner: boolean;
}

/** What is published on `MODERATION_INPUT_TOPIC`. */
export interface InputVerdictRecord {
  at: string;
  source: InputSource;
  author: string | null;
  action: InputAction;
  flags: InputFlag[];
  reasons: string[];
  owner: boolean;
}

// ---- service --------------------------------------------------------------------------------

export interface ModerationService {
  /** The line shown in place of blocked text. */
  readonly filteredLine: string;
  /** The line said in place of blocked spoken text. */
  readonly filteredVoiceLine: string;
  /**
   * Local rules only: no network, no waiting. Safe to call per sentence on the voice path.
   * Checks `visible` and `voice` separately and replaces only the one that is blocked.
   */
  screen(check: OutputCheck): OutputVerdict;
  /**
   * `screen`, then the registered providers on what the rules passed, each with a timeout. A
   * provider can only add blocks. For paths that can wait (written replies, fallback output).
   */
  screenAsync(check: OutputCheck, signal?: AbortSignal): Promise<OutputVerdict>;
  /**
   * A raw model reply that may hold `<voice>…</voice>`: the voice part and the rest are checked
   * separately. Returns the reply with blocked parts replaced.
   */
  screenReply(
    path: OutputPath,
    raw: string,
    meta?: { context?: ContextKey | null; turn?: TurnId | null },
  ): { text: string; verdict: OutputVerdict };
  /** Chat is hostile: what to do with this message. Never drops the owner. */
  inspect(input: InputCheck): InputVerdict;
  /** Adds an outside check for `screenAsync`; returns its remover. */
  addProvider(provider: ModerationProvider): () => void;
  /** A value that must never be said (the admin token); returns its remover. */
  protect(secret: string): () => void;
  /** The latest blocks, newest last. */
  recent(limit?: number): ModerationBlockRecord[];
}

export const ModerationKey = serviceKey<ModerationService>("ModerationService");

// ---- what the outgoing and incoming paths share ----------------------------------------------

/** One line on its way out. */
export interface OutgoingLine {
  path: OutputPath;
  /** What people read. */
  text: string;
  /** Her `<voice>` line for it. */
  spoken?: string | null;
  /** `text` itself goes to TTS: it is checked, and replaced, as spoken text. */
  aloud?: boolean;
  context?: ContextKey | null;
  turn?: TurnId | null;
}

export interface SafeLine {
  text: string;
  spoken: string | null;
  /** The rule that replaced it (never what it said); `null`: it goes out as written. */
  blocked: string | null;
}

/**
 * The one way out for her words: `screen`, then `filterOutgoing`. The order is the point:
 * masking a secret first would hide it from the rules and let the rest of the line through.
 * A line and its `<voice>` are the same sentence, so when either is blocked both are replaced
 * (the Japanese half must not carry what the written half could not). Without the service
 * (`moderation` off) only `filterOutgoing` runs.
 */
export function safeOutgoing(
  moderation: ModerationService | null | undefined,
  line: OutgoingLine,
): SafeLine {
  const spoken = line.spoken ?? null;
  const aloud = line.aloud === true && spoken === null;
  const verdict =
    moderation?.screen({
      path: line.path,
      visible: aloud ? null : line.text,
      voice: aloud ? line.text : spoken,
      context: line.context ?? null,
      turn: line.turn ?? null,
    }) ?? null;
  const block = verdict?.blocked[0];
  if (moderation == null || block === undefined) {
    return {
      text: filterOutgoing(line.text),
      spoken: spoken === null ? null : filterOutgoing(spoken),
      blocked: null,
    };
  }
  return {
    text: aloud ? moderation.filteredVoiceLine : moderation.filteredLine,
    spoken: spoken === null ? null : moderation.filteredVoiceLine,
    blocked: block.rule,
  };
}

/** Held by owners alone: `owner` has `*`, and no other role reaches an `owner.*` node. */
export const NODE_TRUSTED_INPUT = "owner.moderation.trusted";

/** Whether `account` is an owner: what the Authorizer says, never a name in a message. */
export function isOwnerAccount(authorizer: Authorizer | undefined, account: AccountRef): boolean {
  return authorizer?.allows(account, NODE_TRUSTED_INPUT) === true;
}

/** What `inspectInput` needs of the services. */
export interface InputServices {
  get<T>(key: ServiceKey<T>): T | undefined;
}

export interface IncomingInput {
  /** The message or utterance id, when it has one (see `InputCheck.id`). */
  id?: string | null;
  text: string;
  source: InputSource;
  /** Who wrote it; `null`: nobody (a web page, tool output). */
  author?: AccountRef | null;
  context?: ContextKey | null;
}

/** `inspect` with who the author is filled in. `null`: `moderation` is off, everything passes. */
export function inspectInput(services: InputServices, input: IncomingInput): InputVerdict | null {
  const moderation = services.get(ModerationKey);
  if (moderation === undefined) return null;
  const { author = null, context = null } = input;
  const owner = author !== null && isOwnerAccount(services.get(AuthorizerKey), author);
  return moderation.inspect({
    id: input.id ?? null,
    text: input.text,
    source: input.source,
    author: author === null ? null : { id: accountRefString(author), owner },
    context: context === null ? null : contextKeyString(context),
  });
}

/** Whether a verdict keeps a message from starting a turn or taking her attention. */
export function holdsBack(verdict: InputVerdict | null): boolean {
  return verdict?.action === "ignore" || verdict?.action === "rate_limit";
}
