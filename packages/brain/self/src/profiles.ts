// The four ways the one turn runner is run (docs/design/v5-brain.md 「設計的結論」): the same loop
// with different limits, reasoning and tools. A profile never changes within a session, so the
// tools it leaves out are left out for the whole session and the tool list keeps its prefix.

import type { ToolEntry } from "@miyoria/llm/tools";
import type { ReasoningLevel } from "@miyoria/types";
import type { TextUnit } from "./screens.js";

export type ProfileName = "text" | "voice" | "subagent" | "reflect";

export const PROFILE_NAMES: readonly ProfileName[] = ["text", "voice", "subagent", "reflect"];

/** Which limit ended a run's loop. */
export type LimitName = "rounds" | "time" | "tokens" | "spend";

export interface RunLimits {
  /** Model steps that may call tools; one more step, without tools, follows when they are used up. */
  rounds: number;
  /** Tool calls run of one step; the rest are refused. */
  callsPerRound: number;
  /** Wall time of a run, checked between steps (ms). */
  wallMs: number;
  /** One tool call may take this long (ms). */
  toolMs: number;
  /**
   * The pictures her tools fetched (`ToolResult.images`) may be this many bytes together in one
   * run; unset: 10,000,000. The host sets the vision cap.
   */
  pictureBytes?: number;
  /** Prompt and completion tokens of a run, all steps together. */
  tokens: number;
  /** What a session may spend on models in an hour (USD). Owner decision Q6: 1. */
  sessionUsdPerHour: number;
  /**
   * The same cap in tokens, for a session whose model has no price in `[llm.pricing]`: its cost
   * cannot be counted, so its tokens are.
   */
  sessionTokensPerHour: number;
}

export interface RunProfile {
  name: ProfileName;
  /** The model chain (`[llm.purposes]`). */
  purpose: string;
  /** The `[llm.reasoning]` entry that decides the level when `reasoning` is `null`. */
  reasoningPurpose: string;
  /** A fixed level; `null`: what the purpose is configured for. */
  reasoning: ReasoningLevel | null;
  /** What she writes is said in the focus place. `false`: it is the run's result, shown to nobody. */
  speaks: boolean;
  limits: RunLimits;
  /** `max_tokens` of one step; `null`: the provider's. */
  maxStepTokens: number | null;
  /** Whether this profile offers `tool` at all. */
  offers(tool: ToolEntry): boolean;
  /** What one line of her text is: a message, or a sentence said as soon as it is written. */
  unit: TextUnit;
  /**
   * Count the rounds whose tools ran this long while nothing of hers had gone out in the run
   * (`silent_waits` of the run's `finished`); `null`: not counted.
   */
  silentWaitMs: number | null;
}

const everything = (): boolean => true;
/** Not a tool that puts her words in front of people. */
const quiet = (tool: ToolEntry): boolean => tool.effect !== "say";

/**
 * The profile whose block 1 and tool list a profile's requests open with. Voice opens like text,
 * so the provider's prefix cache holds across both; its own note goes to block 7 instead.
 */
export const PREFIX_PROFILE: Readonly<Record<ProfileName, ProfileName>> = {
  text: "text",
  voice: "text",
  subagent: "subagent",
  reflect: "reflect",
};

/**
 * What a voice run may call, by name, of the tools it is offered (the text profile's, so the
 * prefix holds): it answers within a breath. A call of anything else is refused at call time and
 * she reads why (the host's guard). Long actions (voice, songs, games, party games, going live, a
 * helper's job) only start something and come back with a receipt, as in text.
 */
export const VOICE_TOOLS: ReadonlySet<string> = new Set([
  "delegate",
  "find_tools",
  "recall",
  "remember",
  "web_search",
  "check_coins",
  "set_call_name",
  "remind_me",
  "say",
  "voice_status",
  "voice_join",
  "voice_leave",
  "sing_request",
  "sing_start",
  "sing_stop",
  "game_start",
  "game_goal",
  "game_stop",
  "party_start",
  "party_host",
  "party_play",
  "party_ask",
  "stream_start",
  "stream_stop",
  "watch_start",
  "watch_stop",
  "watch_look",
]);

/**
 * A voice run's tools ran this long with nothing of hers said yet: the stretch the old turn filled
 * with a fixed wait line (「我查一下。」, owner decision Q8 #12, not kept) is counted instead.
 */
export const SILENT_WAIT_MS = 1_000;

const HOUR_USD = 1;
/** About what 1 USD buys of a flash model's cached input; only used when no price is known. */
const HOUR_TOKENS = 3_000_000;

export const PROFILES: Readonly<Record<ProfileName, RunProfile>> = {
  text: {
    name: "text",
    purpose: "chat",
    reasoningPurpose: "chat_text",
    reasoning: null,
    speaks: true,
    limits: {
      rounds: 10,
      callsPerRound: 6,
      wallMs: 120_000,
      toolMs: 30_000,
      tokens: 400_000,
      sessionUsdPerHour: HOUR_USD,
      sessionTokensPerHour: HOUR_TOKENS,
    },
    maxStepTokens: null,
    offers: everything,
    unit: "line",
    silentWaitMs: null,
  },
  voice: {
    name: "voice",
    purpose: "chat",
    reasoningPurpose: "chat_voice",
    reasoning: "off",
    speaks: true,
    limits: {
      rounds: 2,
      callsPerRound: 2,
      wallMs: 12_000,
      toolMs: 6_000,
      tokens: 60_000,
      sessionUsdPerHour: HOUR_USD,
      sessionTokensPerHour: HOUR_TOKENS,
    },
    maxStepTokens: 600,
    offers: everything,
    unit: "sentence",
    silentWaitMs: SILENT_WAIT_MS,
  },
  subagent: {
    name: "subagent",
    purpose: "work",
    reasoningPurpose: "work",
    reasoning: "high",
    speaks: false,
    limits: {
      rounds: 40,
      callsPerRound: 8,
      wallMs: 10 * 60_000,
      toolMs: 60_000,
      tokens: 1_500_000,
      sessionUsdPerHour: HOUR_USD,
      sessionTokensPerHour: HOUR_TOKENS,
    },
    maxStepTokens: null,
    offers: quiet,
    unit: "line",
    silentWaitMs: null,
  },
  reflect: {
    name: "reflect",
    purpose: "chat",
    reasoningPurpose: "reflect",
    reasoning: "high",
    speaks: false,
    limits: {
      rounds: 12,
      callsPerRound: 6,
      wallMs: 5 * 60_000,
      toolMs: 60_000,
      tokens: 600_000,
      sessionUsdPerHour: HOUR_USD,
      sessionTokensPerHour: HOUR_TOKENS,
    },
    maxStepTokens: null,
    offers: quiet,
    unit: "line",
    silentWaitMs: null,
  },
};

/** `profile` with some limits replaced (tests, and a subagent's own budget). */
export function withLimits(profile: RunProfile, limits: Partial<RunLimits>): RunProfile {
  return { ...profile, limits: { ...profile.limits, ...limits } };
}
