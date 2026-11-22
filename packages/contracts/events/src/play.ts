// What she plays and what viewers queue (docs/design/v5-contracts.md §3, K12a): a game account
// link attempt, the game director's sessions, goals, skills and decision traces, the mood nudge a
// decision may carry, and the request queue's activations, votes and snapshots. Each type is the
// bus topic it is published on, and its payload is that event's data. The events a game adapter
// sends (`game.<id>.<kind>`) are a family of their own (`extension.ts`).
//
// Tiers (v5-data §2.5): all kept 90 days (`short`), except the queue's snapshot, which is sent on
// every change and mirrors state the queue keeps itself (`ambient`). A link attempt names a
// game account: for the owner (`owner`). A decision trace holds what the game reported to the
// model: for the owner. A skill is what she learned by playing, with no outside source (`self`).
// Everything else belongs to a place or a person and has no default scope.

import { z } from "zod";
import { AccountRefSchema, ContextKeySchema, TimestampSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";
import { TaskFailureCodeSchema } from "./task.js";

/** A game account link attempt, from the in-game `link` command: `game.chat.link`. */
export const GameChatLinkSchema = z
  .object({
    game: z.string(),
    /** The in-game account id that asked. */
    account: z.string(),
    /** `invalid_code`, `unavailable`, or what the social module answered (`linked`, ...). */
    outcome: z.string(),
  })
  .meta({ id: "EventsGameChatLink" });
export type GameChatLinkData = z.output<typeof GameChatLinkSchema>;

/** A game session started or ended: `game.director.session`. */
export const GameSessionSchema = z
  .object({
    state: z.enum(["started", "stopped"]),
    game: z.string(),
    game_name: z.string(),
    context: ContextKeySchema,
    /** Why a session ended because the game went away (`stopped` only). */
    code: TaskFailureCodeSchema.optional(),
    reason: z.string().optional(),
  })
  .meta({ id: "EventsGameSession" });
export type GameSessionData = z.output<typeof GameSessionSchema>;

/** How a goal ended: a task's failure code, or one of the director's own. */
export const GoalEndCodeSchema = z
  .union([z.enum(["done", "reported", "gave_up", "no_progress"]), TaskFailureCodeSchema])
  .meta({ id: "EventsGoalEndCode" });

/** A goal of the game director ended: `game.director.goal`. */
export const GoalEndSchema = z
  .object({
    game: z.string(),
    goal: z.string(),
    /** Who set it: `director`, `command`, `queue` or `survival`. */
    source: z.enum(["director", "command", "queue", "survival"]),
    status: z.enum(["done", "failed"]),
    code: GoalEndCodeSchema,
    /** The goal's last task, if it had one. */
    task: z.string().nullable(),
    detail: z.string(),
    at: TimestampSchema,
    /** What it was about (`goalKey`). */
    attention_key: z.string(),
  })
  .meta({ id: "EventsGoalEnd" });
export type GoalEndData = z.output<typeof GoalEndSchema>;

/** A method sequence that worked, kept for next time: `game.director.skill`. */
export const GameSkillSchema = z
  .object({
    game: z.string(),
    /** The item the goal wanted. */
    target: z.string(),
    /** The goal as she put it. */
    goal: z.string(),
    /** The methods that made progress, in order (`obtain {"item":"cooked_beef"}`). */
    steps: z.array(z.string()),
    /** When it was learned: epoch milliseconds, not a timestamp. */
    at: z.number(),
  })
  .meta({ id: "EventsGameSkill" });
export type GameSkillData = z.output<typeof GameSkillSchema>;

/** A goal's success condition: her inventory holds at least `count` of `item`. */
export const GameWantSchema = z
  .object({ item: z.string(), count: z.number() })
  .meta({ id: "EventsGameWant" });

/** One decision of the game director, with what she saw and what was on hold: `game.director.decision`. */
export const DirectorTraceSchema = z
  .object({
    game: z.string(),
    /** What woke the director, one line each. */
    trigger: z.array(z.string()),
    goal: z.string().nullable(),
    /** The action it picked, as the call reads. */
    action: z.string().nullable(),
    /** `Step`, `Replace` or `Keep("...")`: what the anti-spam rule made of it. */
    verdict: z.string().nullable(),
    commentary: z.string().nullable(),
    busy: z.boolean().nullable(),
    /** The observation summary the decision was made from. */
    observation: z.string(),
    want: GameWantSchema.nullable(),
    /** Methods and goals on hold at the time. */
    held: z.array(z.string()),
  })
  .meta({ id: "EventsDirectorTrace" });
export type DirectorTraceData = z.output<typeof DirectorTraceSchema>;

/** A shift of her mood that a game decision carried: `mood.nudge`. Nothing reads it today. */
export const MoodNudgeSchema = z
  .object({
    valence: z.number(),
    arousal: z.number(),
    energy: z.number(),
    reason: z.string(),
  })
  .meta({ id: "EventsMoodNudge" });
export type MoodNudgeData = z.output<typeof MoodNudgeSchema>;

export const QueueItemStateSchema = z
  .enum(["pending", "active", "done", "skipped", "removed"])
  .meta({ id: "EventsQueueItemState" });

/** A request in the queue as overlays and consumers see it (the voters are left out). */
export const QueueItemSchema = z
  .object({
    id: z.number(),
    requester: AccountRefSchema,
    requester_name: z.string(),
    /** Free-form, e.g. `game_goal`, `song`, `chat`. */
    kind: z.string(),
    text: z.string(),
    /** Where the request was made, for replying later. */
    context: ContextKeySchema.nullable(),
    created_at: TimestampSchema,
    /** Moderator-set; higher goes first, ahead of fairness. */
    priority: z.number(),
    votes: z.number(),
    state: QueueItemStateSchema,
    /** 1-based place among pending items; `null` when it has none (an activated item). */
    position: z.number().nullable(),
  })
  .meta({ id: "EventsQueueItem" });
export type QueueItemData = z.output<typeof QueueItemSchema>;

/** A vote ended: `queue.vote_result`. */
export const QueueVoteResultSchema = z
  .object({
    options: z.array(z.string()),
    /** Ballots per option. */
    tallies: z.array(z.number()),
    /** Index of the winning option; `null` without ballots. */
    winner: z.number().nullable(),
    winner_option: z.string().nullable(),
    total: z.number(),
    ended_at: TimestampSchema,
  })
  .meta({ id: "EventsQueueVoteResult" });
export type QueueVoteResultData = z.output<typeof QueueVoteResultSchema>;

/**
 * One Space's queue as it stands, on every change: `queue.changed`. `vote` only while one runs.
 * The envelope's `space_id` names the Space (`null` on a Core without places, one queue).
 */
export const QueueChangedSchema = z
  .object({
    items: z.array(QueueItemSchema),
    paused: z.boolean(),
    vote: z
      .object({
        options: z.array(z.string()),
        tallies: z.array(z.number()),
        total: z.number(),
        started_at: TimestampSchema,
        ends_at: TimestampSchema,
      })
      .optional(),
  })
  .meta({ id: "EventsQueueChanged" });
export type QueueChangedData = z.output<typeof QueueChangedSchema>;

export const GameChatLink = defineEvent({
  type: "game.chat.link",
  v: 1,
  data: GameChatLinkSchema,
  scope: "owner",
  tier: "short",
});

export const GameDirectorSession = defineEvent({
  type: "game.director.session",
  v: 1,
  data: GameSessionSchema,
  tier: "short",
});

export const GameDirectorGoal = defineEvent({
  type: "game.director.goal",
  v: 1,
  data: GoalEndSchema,
  tier: "short",
});

export const GameDirectorSkill = defineEvent({
  type: "game.director.skill",
  v: 1,
  data: GameSkillSchema,
  scope: "self",
  tier: "short",
});

export const GameDirectorDecision = defineEvent({
  type: "game.director.decision",
  v: 1,
  data: DirectorTraceSchema,
  scope: "owner",
  tier: "short",
});

export const MoodNudge = defineEvent({
  type: "mood.nudge",
  v: 1,
  data: MoodNudgeSchema,
  tier: "short",
});

export const QueueItemActivated = defineEvent({
  type: "queue.item_activated",
  v: 1,
  data: QueueItemSchema,
  tier: "short",
});

export const QueueVoteResult = defineEvent({
  type: "queue.vote_result",
  v: 1,
  data: QueueVoteResultSchema,
  tier: "short",
});

export const QueueChanged = defineEvent({
  type: "queue.changed",
  v: 1,
  data: QueueChangedSchema,
  tier: "ambient",
});

/** Every game director, mood nudge and queue type. */
export const PLAY_EVENTS = [
  GameChatLink,
  GameDirectorSession,
  GameDirectorGoal,
  GameDirectorSkill,
  GameDirectorDecision,
  MoodNudge,
  QueueItemActivated,
  QueueVoteResult,
  QueueChanged,
] as const;
