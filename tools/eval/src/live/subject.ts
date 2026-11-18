// What a live eval runs against. A `Subject` is a brain: it is shown a scene and what it does is
// collected in a `Reply`. The suites only know this file, so another brain (the phase-3 runner) is
// one more implementation of `Subject` and nothing else changes.

import type { ToolEnv } from "../tasks/run.js";

/** How close someone is to her: her bond level with them (-100..1000) and how well she knows them. */
export interface Closeness {
  /** Bond level, -100..1000 (0: a stranger; 75 and up with familiarity: a close friend). */
  bond: number;
  /** 0..100, how much they have talked (default: follows the bond). */
  familiarity?: number;
  /** 0..100 (default: follows the bond). */
  trust?: number;
}

export interface ScenePerson {
  /** The name the others see; the lines name their speaker by it. */
  name: string;
  /** Set when the scene depends on it; unset: she knows nothing about them. */
  closeness?: Closeness;
}

export interface SceneLine {
  who: string;
  text: string;
}

/**
 * How the last line reaches her. `mention`: it names her in a text channel; `dm`: the place is a
 * direct message. Both always get a turn, so whether she answers is never her attention's dice.
 * `none`: nobody called her (people talking to each other); whether she gets a turn at all is the
 * subject's own attention.
 */
export type Address = "mention" | "dm" | "none";

export interface Scene {
  /** For the result files. */
  id: string;
  place: "text" | "dm";
  people: ScenePerson[];
  /** What was said, oldest first; every `who` is one of `people`. The last line is the one she answers. */
  lines: SceneLine[];
  address: Address;
  /** Her state line ("now"), when the scene sets one. */
  state?: string;
  /** Tools she is offered, answering from a fake world. Their names are `tools.tools`. */
  tools?: ToolEnv;
  /** The local time it is (`YYYY-MM-DD HH:MM`), when the fake world's clock matters. */
  now?: string;
  /** She answers aloud (the voice profile: sentences, said as written); unset: in writing. */
  spoken?: boolean;
  /**
   * Something happened in the world that is worth a look (a note from a module, the way a card
   * worth a word reaches her): the run is a `world` wake with this text, not an answer to the last
   * line. `lines` may then be empty or be the chat going on around it; set `address: "none"`.
   */
  world?: string;
}

export interface ReplyCall {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  text: string;
}

export interface ModelUsage {
  /** Model calls made. */
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  reasoning_tokens: number;
}

export const NO_USAGE: ModelUsage = {
  calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  cached_prompt_tokens: 0,
  reasoning_tokens: 0,
};

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    calls: a.calls + b.calls,
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    cached_prompt_tokens: a.cached_prompt_tokens + b.cached_prompt_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
  };
}

export function subUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    calls: a.calls - b.calls,
    prompt_tokens: a.prompt_tokens - b.prompt_tokens,
    completion_tokens: a.completion_tokens - b.completion_tokens,
    cached_prompt_tokens: a.cached_prompt_tokens - b.cached_prompt_tokens,
    reasoning_tokens: a.reasoning_tokens - b.reasoning_tokens,
  };
}

export interface Reply {
  /** The messages she sent, in order. */
  lines: string[];
  /** The tool calls she made, in order. */
  calls: ReplyCall[];
  /** She sent nothing. */
  silent: boolean;
  /** Everything the subject spent on models for this scene. */
  usage: ModelUsage;
  /** Wall time from the scene's last line to the end of what she did (ms). */
  ms: number;
  /** The subject gave up waiting for her to finish; what is here is what she did until then. */
  timed_out?: boolean;
  /**
   * The inside of each `<feel>` block she wrote (never part of `lines`); unset: the subject does
   * not report them.
   */
  feel?: string[];
}

export interface Subject {
  readonly name: string;
  /** Why this subject cannot be shown `scene` (`null`: it can). Such a scene is never run. */
  unsupported(scene: Scene): string | null;
  respond(scene: Scene): Promise<Reply>;
  /** Releases what the subject holds. */
  close?(): Promise<void>;
}

/** Her reply as one text, as a person reads it. */
export function replyText(reply: Reply): string {
  return reply.lines.join("\n");
}
