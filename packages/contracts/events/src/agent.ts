// The agent's turns besides its decision and outcome (`turn.ts`), in docs/design/v5-contracts.md
// §3, K12a: a turn started and ended, whom it is for, the prompt it sent, the tools it ran, the
// emotions she showed, a request to start a turn on her own, a message someone asked her not to
// remember, and the notices her conversation should hear about. Each type is the bus topic it is
// published on, and its payload is that event's data.
//
// Turn internals: kept 90 days (`short`), no default scope (the session decides), except the
// saved prompt, which holds what the model saw from every source at once: for the owner (`owner`),
// like LLM call metadata. A message excluded from her memory is a privacy request: for the owner,
// kept (`keep`), like `privacy.redacted`.

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  MessageRefSchema,
  TimestampSchema,
  TurnIdSchema,
} from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";
import { TaskFailureCodeSchema } from "./task.js";
import { TurnReasonSchema } from "./turn.js";

/** A turn started: `agent.turn.started`. */
export const TurnStartedSchema = z
  .object({ turn: TurnIdSchema, context: ContextKeySchema })
  .meta({ id: "EventsTurnStarted" });
export type TurnStartedData = z.output<typeof TurnStartedSchema>;

/**
 * A turn's generation ended: `agent.turn.completed`. `text`: what she
 * wrote, empty for a cancelled or dropped turn.
 */
export const TurnCompletedSchema = z
  .object({ turn: TurnIdSchema, context: ContextKeySchema, text: z.string() })
  .meta({ id: "EventsTurnCompleted" });
export type TurnCompletedData = z.output<typeof TurnCompletedSchema>;

/** Asks the agent to start a turn on her own: `agent.initiative`. */
export const AgentInitiativeSchema = z
  .object({
    context: ContextKeySchema,
    /** Why, for the decision trace (`idle_channel`, `followup`). */
    reason: z.string(),
    /** What she might bring up. */
    hint: z.string(),
    /** Accounts the hint is about. */
    about: z.array(AccountRefSchema),
  })
  .meta({ id: "EventsAgentInitiative" });
export type AgentInitiativeData = z.output<typeof AgentInitiativeSchema>;

/**
 * `debounce`: collecting input; `generating`: the model is writing; `speaking`: her speech of the
 * turn is queued or playing; `done`.
 */
export const TurnPhaseSchema = z
  .enum(["debounce", "generating", "speaking", "done"])
  .meta({ id: "EventsTurnPhase" });

/** Whom a turn answers, whenever its focus or phase changes: `agent.turn.focus`. */
export const TurnFocusSchema = z
  .object({
    turn: TurnIdSchema,
    context: ContextKeySchema,
    reason: TurnReasonSchema,
    phase: TurnPhaseSchema,
    /** Handles of the people the reply is for, in the order they addressed her. */
    addressed_by: z.array(z.string()),
    /** Their accounts, same order. */
    addressed_accounts: z.array(AccountRefSchema),
    /** The messages the reply answers, oldest first. */
    focus: z.array(MessageRefSchema),
    /** Other input of the turn: context only. */
    background: z.array(MessageRefSchema),
    restarts: z.number(),
    started_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .meta({ id: "EventsTurnFocus" });
export type TurnFocusData = z.output<typeof TurnFocusSchema>;

export const ReasoningLevelSchema = z
  .enum(["off", "low", "medium", "high"])
  .meta({ id: "EventsReasoningLevel" });

/** What the prompt compiler did with one block. */
export const CompiledBlockSchema = z
  .object({
    key: z.string(),
    /** `self`: her own state; `data`: derived from other people or the outside. */
    authority: z.enum(["self", "data"]),
    source: z.string(),
    /** Characters before and after budgeting. */
    chars_in: z.number(),
    chars_out: z.number(),
    budget_chars: z.number(),
    fate: z.enum(["kept", "summarized", "truncated", "dropped"]),
  })
  .meta({ id: "EventsCompiledBlock" });

/** A compressed copy of the prompt one turn sent (every turn, or sampled): `agent.prompt`. */
export const SavedPromptSchema = z
  .object({
    turn: TurnIdSchema,
    context: ContextKeySchema,
    at: TimestampSchema,
    /** The LLM purpose (`chat`). */
    purpose: z.string(),
    reasoning: ReasoningLevelSchema,
    blocks: z.array(CompiledBlockSchema),
    /** The messages as sent, possibly compressed. */
    messages: z.array(
      z.object({ role: z.enum(["system", "user", "assistant"]), text: z.string() }),
    ),
    /** As the provider reported them (`null`: not reported). */
    prompt_tokens: z.number().nullable(),
  })
  .meta({ id: "EventsSavedPrompt" });
export type SavedPromptData = z.output<typeof SavedPromptSchema>;

/** A tool call of a turn ran: `agent.tool`. `result`: its text, cut to the configured length. */
export const AgentToolSchema = z
  .object({
    turn: TurnIdSchema,
    context: ContextKeySchema,
    tool: z.string(),
    ok: z.boolean(),
    result: z.string(),
  })
  .meta({ id: "EventsAgentTool" });
export type AgentToolData = z.output<typeof AgentToolSchema>;

/**
 * A tool call of a turn started or ended (`agent.tool.running`), while the turn runs: the overlay
 * says she is using a tool. Only the tool's name, never its arguments or result.
 */
export const AgentToolRunningSchema = z
  .object({
    turn: TurnIdSchema,
    context: ContextKeySchema,
    tool: z.string(),
    state: z.enum(["started", "ended"]),
  })
  .meta({ id: "EventsAgentToolRunning" });
export type AgentToolRunningData = z.output<typeof AgentToolRunningSchema>;

/** An emotion tag in her reply: `agent.emotion`. */
export const AgentEmotionSchema = z
  .object({
    turn: TurnIdSchema,
    context: ContextKeySchema,
    /** Lower-cased. */
    emotion: z.string(),
    /** 0 to 1, when the tag gave one. */
    intensity: z.number().optional(),
  })
  .meta({ id: "EventsAgentEmotion" });
export type AgentEmotionData = z.output<typeof AgentEmotionSchema>;

/**
 * Someone asked her not to remember a message: `agent.message.excluded`. It names the message,
 * never its text.
 */
export const MessageExcludedSchema = z
  .object({
    /** The context she knows the message in. */
    context: ContextKeySchema,
    message: MessageRefSchema,
    /** Who wrote it, when known. */
    author: AccountRefSchema.nullable(),
    /** Who asked. */
    requested_by: AccountRefSchema,
    at: TimestampSchema,
  })
  .meta({ id: "EventsMessageExcluded" });
export type MessageExcludedData = z.output<typeof MessageExcludedSchema>;

/**
 * Something she should hear about in a conversation that nobody said (a task outcome):
 * `agent.notice`. Shown in her own state, never as a user message.
 */
export const NoticeSchema = z
  .object({
    id: z.string(),
    at: TimestampSchema,
    /** The module that reports it (`activity`, `actions`, `economy`). */
    source: z.string(),
    /** The task it reports on, if any. */
    task: z.string().nullable(),
    /** Her turn that asked for it (`null`: nobody waits for it). */
    turn: TurnIdSchema.nullable(),
    /** Where to tell her (`null`: wherever she talks next). */
    context: ContextKeySchema.nullable(),
    ok: z.boolean(),
    /** Set when `ok` is false. */
    code: TaskFailureCodeSchema.nullable(),
    /** What happened, short, for her (may hold untrusted names). */
    text: z.string(),
    /** Dropped unshown after this. */
    expires_at: TimestampSchema,
  })
  .meta({ id: "EventsNotice" });
export type NoticeData = z.output<typeof NoticeSchema>;

export const AgentTurnStarted = defineEvent({
  type: "agent.turn.started",
  v: 1,
  data: TurnStartedSchema,
  tier: "short",
});

export const AgentTurnCompleted = defineEvent({
  type: "agent.turn.completed",
  v: 1,
  data: TurnCompletedSchema,
  tier: "short",
});

export const AgentInitiative = defineEvent({
  type: "agent.initiative",
  v: 1,
  data: AgentInitiativeSchema,
  tier: "short",
});

export const AgentTurnFocus = defineEvent({
  type: "agent.turn.focus",
  v: 1,
  data: TurnFocusSchema,
  tier: "short",
});

export const AgentPrompt = defineEvent({
  type: "agent.prompt",
  v: 1,
  data: SavedPromptSchema,
  scope: "owner",
  tier: "short",
});

export const AgentTool = defineEvent({
  type: "agent.tool",
  v: 1,
  data: AgentToolSchema,
  tier: "short",
});

export const AgentToolRunning = defineEvent({
  type: "agent.tool.running",
  v: 1,
  data: AgentToolRunningSchema,
  tier: "ambient",
});

export const AgentEmotion = defineEvent({
  type: "agent.emotion",
  v: 1,
  data: AgentEmotionSchema,
  tier: "short",
});

export const AgentMessageExcluded = defineEvent({
  type: "agent.message.excluded",
  v: 1,
  data: MessageExcludedSchema,
  scope: "owner",
  tier: "keep",
});

export const AgentNotice = defineEvent({
  type: "agent.notice",
  v: 1,
  data: NoticeSchema,
  tier: "short",
});

/** Every agent type besides the turn records (`TURN_EVENTS`). */
export const AGENT_EVENTS = [
  AgentTurnStarted,
  AgentTurnCompleted,
  AgentInitiative,
  AgentTurnFocus,
  AgentPrompt,
  AgentTool,
  AgentToolRunning,
  AgentEmotion,
  AgentMessageExcluded,
  AgentNotice,
] as const;
