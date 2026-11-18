// Her heart (docs/design/v5-contracts.md §3, K12a): the affect module's snapshot, mood and bond
// changes, the inputs other modules send it (rule events, nudges, feelings), the mind's thoughts,
// goals and reminders, and what the social module read of people. Each type is the bus topic it
// is published on, and its payload is that event's data.
//
// Tiers (v5-data §2.5): all kept 90 days (`short`). Her own affect snapshot and mood have no
// outside source: `self`. What the mind saw and thought holds her memories and the people in
// them: for the owner (`owner`), like a saved prompt; so is the numbers of a relationship, which
// she never shows people. Everything that is about someone or somewhere has no default scope, so
// the session decides.

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  JsonValueSchema,
  TimestampSchema,
} from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

// ---- self: drives, emotions, mood --------------------------------------------------------------

/** Her mood: derived from her emotions, drives and the time of day. */
export const MoodSchema = z
  .object({
    /** -1..1 */
    valence: z.number(),
    /** 0..1 */
    arousal: z.number(),
    /** 0..1 */
    energy: z.number(),
  })
  .meta({ id: "EventsMood" });
export type MoodData = z.output<typeof MoodSchema>;

export const DriveNameSchema = z
  .enum(["social", "play", "attention", "rest", "curiosity", "esteem", "hunger", "longing"])
  .meta({ id: "EventsDriveName" });

/** Each 0..1. */
export const DrivesSchema = z
  .object({
    social: z.number(),
    play: z.number(),
    attention: z.number(),
    rest: z.number(),
    curiosity: z.number(),
    esteem: z.number(),
    hunger: z.number(),
    longing: z.number(),
  })
  .meta({ id: "EventsDrives" });

/** Her discrete emotions (七情 and a few more), each 0..1 with its own decay. */
export const EmotionNameSchema = z
  .enum([
    "joy",
    "anger",
    "sorrow",
    "fear",
    "surprise",
    "disgust",
    "shy",
    "pride",
    "jealousy",
    "lonely",
    "missing",
    "gratitude",
    "guilt",
    "frustration",
  ])
  .meta({ id: "EventsEmotionName" });

/** One emotion she feels now. */
export const EmotionReadingSchema = z
  .object({
    name: EmotionNameSchema,
    /** 0..1, decayed to now. */
    intensity: z.number(),
    /** What last stirred it (short, zh-TW; may contain names). */
    cause: z.string(),
    at: TimestampSchema,
    /** Who it is about, when someone. */
    person: z.string().nullable(),
  })
  .meta({ id: "EventsEmotionReading" });

/** What she lets show of what she feels. */
export const ShownEmotionSchema = z
  .object({
    /** The felt emotion it comes from. */
    from: EmotionNameSchema,
    /** The `<emo:…>` tag it shows as. */
    tag: z.string(),
    /** How it shows, in words. */
    style: z.string(),
    /** She hides what she feels. */
    masked: z.boolean(),
  })
  .meta({ id: "EventsShownEmotion" });

/** What her feelings push her toward: added to her talkativeness and initiative, and her wishes. */
export const AffectBiasesSchema = z
  .object({
    /** Added to her talkativeness (-1..1). */
    talkativeness: z.number(),
    /** Added to her willingness to start things (-1..1). */
    initiative: z.number(),
    /** Per wish (`chat_with`, `play`, `stream`, `rest`, `sing`): weight 0..1 and why. */
    wants: z.array(
      z.object({
        want: z.string(),
        weight: z.number(),
        person: z.string().nullable(),
        why: z.string(),
        /** The emotion behind it, when one is (a drive otherwise). */
        from: EmotionNameSchema.optional(),
      }),
    ),
  })
  .meta({ id: "EventsAffectBiases" });

/** Her state of feeling, when it changed noticeably: `affect.changed`. */
export const AffectSnapshotSchema = z
  .object({
    at: TimestampSchema,
    drives: DrivesSchema,
    /** 0..1 */
    boredom: z.number(),
    /** The strongest 2 or 3 emotions only. */
    top: z.array(EmotionReadingSchema),
    mood: MoodSchema,
    /** One line for the prompt (`心情不錯、有點累`). */
    mood_line: z.string(),
    shown: ShownEmotionSchema.nullable(),
    biases: AffectBiasesSchema,
  })
  .meta({ id: "EventsAffectSnapshot" });
export type AffectSnapshotData = z.output<typeof AffectSnapshotSchema>;

/** Her mood moved: `mood.changed`. `reason` is always `affect` today. */
export const MoodChangedSchema = z
  .object({
    valence: z.number(),
    arousal: z.number(),
    energy: z.number(),
    reason: z.string(),
  })
  .meta({ id: "EventsMoodChanged" });
export type MoodChangedData = z.output<typeof MoodChangedSchema>;

/** What a rule event is about. */
export const AffectEventKindSchema = z
  .enum([
    "praised",
    "cared_arrived",
    "topic_ignored",
    "song_finished",
    "song_applauded",
    "interrupted",
    "ignored",
    "cared_close_with_other",
    "task_succeeded",
    "task_failed",
    "game_won",
    "game_lost",
  ])
  .meta({ id: "EventsAffectEventKind" });

/** A rule event for her emotions (the arbiter publishes it; the affect module maps it): `affect.event`. */
export const AffectEventSchema = z
  .object({
    kind: AffectEventKindSchema,
    /** Who it involves, when someone. */
    person: z.string().nullable(),
    handle: z.string().nullable(),
    context: ContextKeySchema.nullable(),
    /** Short neutral zh-TW detail (the cause she remembers). */
    detail: z.string(),
    /** Repeats with the same key within the habituation window count as the same cause. */
    key: z.string(),
    at: TimestampSchema,
  })
  .meta({ id: "EventsAffectEvent" });
export type AffectEventData = z.output<typeof AffectEventSchema>;

/**
 * A nudge to her drives from a game or an extension: `self.nudge`. Nothing in the repository
 * publishes it; the keys are the ones the self module reads (each drive and `boredom`, at most
 * 0.5 either way).
 */
export const SelfNudgeSchema = z
  .object({
    social: z.number().optional(),
    play: z.number().optional(),
    attention: z.number().optional(),
    rest: z.number().optional(),
    curiosity: z.number().optional(),
    esteem: z.number().optional(),
    hunger: z.number().optional(),
    longing: z.number().optional(),
    boredom: z.number().optional(),
    reason: z.string().optional(),
  })
  .meta({ id: "EventsSelfNudge" });
export type SelfNudgeData = z.output<typeof SelfNudgeSchema>;

/**
 * A nudge to her emotions from a game or an extension: `self.feel`. Nothing in the repository
 * publishes it; the keys are the ones the self module reads: `emotion` or `emotions` with
 * `amount`, or `toward` (a person emotion) with `person`.
 */
export const SelfFeelSchema = z
  .object({
    emotion: z.string().optional(),
    emotions: z.record(z.string(), z.number()).optional(),
    amount: z.number().optional(),
    toward: z.string().optional(),
    person: z.string().optional(),
    cause: z.string().optional(),
    reason: z.string().optional(),
  })
  .meta({ id: "EventsSelfFeel" });
export type SelfFeelData = z.output<typeof SelfFeelSchema>;

// ---- mind: thoughts, goals, reminders ----------------------------------------------------------

export const ThoughtTriggerKindSchema = z
  .enum(["heartbeat", "salient", "suggestion", "turn", "voice_quiet", "manual"])
  .meta({ id: "EventsThoughtTriggerKind" });

/** What woke her. */
export const ThoughtTriggerSchema = z
  .object({
    kind: ThoughtTriggerKindSchema,
    /** A short neutral description (may contain untrusted names). */
    detail: z.string(),
    context: ContextKeySchema.nullable(),
    at: TimestampSchema,
  })
  .meta({ id: "EventsThoughtTrigger" });

/** A gate decision made for one of her intents. */
export const ThoughtDecisionSchema = z
  .object({
    at: TimestampSchema,
    capability: z.string(),
    allowed: z.boolean(),
    stage: z.string(),
    reason: z.string(),
  })
  .meta({ id: "EventsThoughtDecision" });

export const IntentStatusSchema = z
  .enum(["pending", "started", "done", "denied", "dropped", "failed"])
  .meta({ id: "EventsIntentStatus" });

/** Something she decided to do, and what became of it. */
export const ThoughtIntentSchema = z
  .object({
    id: z.string(),
    capability: z.string(),
    args: JsonValueSchema,
    /** Her reason, in her own words. */
    why: z.string(),
    opening: z.string().nullable(),
    context: ContextKeySchema.nullable(),
    about: AccountRefSchema.nullable(),
    expires_at: TimestampSchema,
    status: IntentStatusSchema,
    detail: z.string().nullable(),
    turn: z.string().nullable(),
    decisions: z.array(ThoughtDecisionSchema),
    /** What she said in the turn she opened. */
    said: z.string().nullable(),
    /** Every status it went through, oldest first (newer journals only). */
    history: z
      .array(
        z.object({
          at: TimestampSchema,
          status: IntentStatusSchema,
          detail: z.string().nullable(),
        }),
      )
      .optional(),
  })
  .meta({ id: "EventsThoughtIntent" });

/** A reason to think, offered by another module. */
export const MindSuggestionSchema = z
  .object({
    /** The module, e.g. `initiative`. */
    source: z.string(),
    /** `idle_channel`, `greeting`, `voice_join`, `followup`, ... */
    reason: z.string(),
    context: ContextKeySchema.nullable(),
    /** What it is about (may quote other people). */
    hint: z.string(),
    about: z.array(AccountRefSchema),
  })
  .meta({ id: "EventsMindSuggestion" });

/** What one thought changed, item by item (`changes` says it in words). */
export const ThoughtEffectsSchema = z
  .object({
    drives: z.record(z.string(), z.number()),
    /** Emotion changes (name: change). */
    emotions: z.record(z.string(), z.number()).optional(),
    talkativeness: z.array(
      z.object({ scope: z.string(), level: z.number(), minutes: z.number(), why: z.string() }),
    ),
    initiative: z.object({ level: z.number(), why: z.string() }).nullable(),
    feelings: z.array(
      z.object({
        person: z.string(),
        name: z.string(),
        note: z.string().nullable(),
        hint: z.enum(["+", "-"]).nullable(),
      }),
    ),
    agenda_added: z.array(z.object({ text: z.string(), why: z.string() })),
    agenda_done: z.array(z.string()),
    agenda_dropped: z.array(z.string()),
    documents: z.array(
      z.object({
        type: z.string(),
        title: z.string().nullable(),
        ok: z.boolean(),
        error: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: "EventsThoughtEffects" });

/** What one thought saw (bounded copies; only the newest thoughts of the journal keep it). */
export const ThoughtInputSchema = z
  .object({
    /** Her local time as she was told it. */
    time: z.string(),
    night: z.boolean(),
    self: z
      .object({
        mood: MoodSchema.nullable(),
        boredom: z.number(),
        drives: z.record(z.string(), z.number()),
        initiative: z.number(),
        /** Her emotions (name: intensity) and what showed of them. */
        emotions: z.record(z.string(), z.number()).optional(),
        shown: z.string().nullable().optional(),
      })
      .nullable(),
    suggestions: z.array(MindSuggestionSchema),
    world: z.string(),
    places: z.array(
      z.object({ ref: z.string(), label: z.string(), note: z.string(), here: z.boolean() }),
    ),
    people: z.array(
      z.object({
        ref: z.string(),
        name: z.string(),
        person: z.string().nullable(),
        relation: z.string().nullable(),
        feeling: z.string().nullable(),
        doing: z.string().nullable(),
        heart: z.string().nullable().optional(),
      }),
    ),
    agenda: z.array(
      z.object({
        ref: z.string(),
        text: z.string(),
        due: TimestampSchema.nullable(),
        blocked: z.string().nullable(),
      }),
    ),
    memories: z.string().nullable(),
    documents: z.string().nullable(),
    lessons: z.array(z.string()),
    recap: z.string().nullable(),
    digest: z.string().nullable(),
    unanswered: z.array(z.string()),
    blocked: z.array(z.object({ capability: z.string(), reason: z.string() })),
    /** Thoughts in a row that did nothing, and since when (minutes). */
    idle: z.object({ thoughts: z.number(), minutes: z.number() }).nullable(),
    /** Capabilities she was offered. */
    capabilities: z.array(z.string()),
    /** Her earlier thoughts she was shown. */
    recent: z.number(),
  })
  .meta({ id: "EventsThoughtInput" });

/** One entry of her thought journal, new or updated: `mind.thought`. */
export const ThoughtSchema = z
  .object({
    id: z.string(),
    at: TimestampSchema,
    triggers: z.array(ThoughtTriggerSchema),
    /** Her inner monologue (first person, in her voice). */
    thought: z.string(),
    /** What she changed in her inner state, in words. */
    changes: z.array(z.string()),
    intents: z.array(ThoughtIntentSchema),
    /** Prompt and completion tokens of the call, when reported. */
    tokens: z.number().nullable(),
    /** The call or the reply failed; `thought` is empty then. */
    error: z.string().nullable(),
    /** Latency of the call. */
    ms: z.number(),
    /** The suggestions that woke her (newer journals only). */
    suggestions: z.array(MindSuggestionSchema).optional(),
    /** What she saw (only the newest thoughts keep it). */
    input: ThoughtInputSchema.nullable().optional(),
    /** The model's reasoning, when it thought out loud (only the newest thoughts keep it). */
    reasoning: z.string().nullable().optional(),
    effects: ThoughtEffectsSchema.nullable().optional(),
    /** Ids of her LLM calls for this thought. */
    calls: z.array(z.string()).optional(),
    /** Cost of those calls in USD. */
    cost_usd: z.number().nullable().optional(),
    /** Calls made (2 = one repair). */
    attempts: z.number().optional(),
    /** Thoughts in a row that did nothing before this one, and for how long. */
    idle: z.object({ thoughts: z.number(), minutes: z.number() }).nullable().optional(),
  })
  .meta({ id: "EventsThought" });
export type ThoughtData = z.output<typeof ThoughtSchema>;

/** When a goal should be acted on. */
export const GoalTriggerSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("at"), time: TimestampSchema }),
    z.object({ kind: z.literal("when_online"), person: z.string() }),
    /** An activity type, optionally with its target (`game:minecraft`). */
    z.object({ kind: z.literal("after_activity"), activity: z.string() }),
    /** Any time it fits. */
    z.object({ kind: z.literal("whenever") }),
  ])
  .meta({ id: "EventsGoalTrigger" });

export const GoalStatusSchema = z
  .enum(["pending", "active", "done", "dropped"])
  .meta({ id: "EventsGoalStatus" });

export const GoalSourceSchema = z
  .enum(["plan", "plan_daily", "reflect", "panel"])
  .meta({ id: "EventsGoalSource" });

/** One of her goals, new or changed: `plan.goal`. */
export const GoalSchema = z
  .object({
    id: z.string(),
    what: z.string(),
    why: z.string(),
    trigger: GoalTriggerSchema,
    /** Coarse steps; empty: none. */
    steps: z.array(z.string()),
    status: GoalStatusSchema,
    /** Past it the goal is dropped automatically. */
    expires: TimestampSchema,
    /** Who it is about (a handle), when someone. */
    person: z.string().nullable(),
    /** Where it should happen, when somewhere specific. */
    context: ContextKeySchema.nullable(),
    source: GoalSourceSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    /** When it was done or dropped. */
    closed_at: TimestampSchema.nullable(),
    /** Why it was dropped (expired, she changed her mind, a step failed). */
    close_reason: z.string().nullable(),
  })
  .meta({ id: "EventsGoal" });
export type GoalData = z.output<typeof GoalSchema>;

/** A timer she set, for herself or because someone asked. */
export const ReminderSchema = z
  .object({
    id: z.string(),
    /** The short key she and the panel use (`R7XK2P`). */
    key: z.string(),
    /** What to remember, in her words. */
    what: z.string(),
    /** The next time it is due. */
    due: TimestampSchema,
    /** It comes back every day at the same local time. */
    daily: z.boolean(),
    /** Where it was set; the proposal goes there. */
    context: ContextKeySchema.nullable(),
    /** Who it is about (a handle). */
    person: z.string().nullable(),
    /** The account that asked for it; `null`: she set it for herself. */
    for_account: AccountRefSchema.nullable(),
    /** How many times it came due so far. */
    fired: z.number(),
    created_at: TimestampSchema,
  })
  .meta({ id: "EventsReminder" });
export type ReminderData = z.output<typeof ReminderSchema>;

/** A reminder was set, came due, was held, done or cancelled: `mind.reminder`. */
export const ReminderChangedSchema = z
  .object({
    state: z.enum(["set", "fired", "held", "done", "cancelled"]),
    reminder: ReminderSchema,
  })
  .meta({ id: "EventsReminderChanged" });
export type ReminderChangedData = z.output<typeof ReminderChangedSchema>;

// ---- social ------------------------------------------------------------------------------------

/**
 * A social event someone caused toward her: `social.event`. The social module publishes it for
 * every one, whether or not the daily caps let it change the numbers; the economy publishes
 * `gift` the same way (it also says `hunger: 0`).
 */
export const SocialEventSchema = z
  .object({
    person: z.string(),
    /** Display name (untrusted). */
    name: z.string().nullable(),
    /** `praise`, `insult`, `warm`, `gift`, ... */
    kind: z.string(),
    /** `rule` (keywords), `appraisal` (the LLM), `mind` (her own hint) or `economy`. */
    source: z.string(),
    /** Strength for `warm` / `cold` (0..1), 1 otherwise. */
    scale: z.number(),
    context: ContextKeySchema.nullable(),
    /** Only on the economy's gift event: how much it fed her hunger drive (always 0). */
    hunger: z.number().optional(),
  })
  .meta({ id: "EventsSocialEvent" });
export type SocialEventData = z.output<typeof SocialEventSchema>;

export const AffectChanged = defineEvent({
  type: "affect.changed",
  v: 1,
  data: AffectSnapshotSchema,
  scope: "self",
  tier: "short",
});

export const MoodChanged = defineEvent({
  type: "mood.changed",
  v: 1,
  data: MoodChangedSchema,
  scope: "self",
  tier: "short",
});

export const AffectEvent = defineEvent({
  type: "affect.event",
  v: 1,
  data: AffectEventSchema,
  tier: "short",
});

export const SelfNudge = defineEvent({
  type: "self.nudge",
  v: 1,
  data: SelfNudgeSchema,
  tier: "short",
});

export const SelfFeel = defineEvent({
  type: "self.feel",
  v: 1,
  data: SelfFeelSchema,
  tier: "short",
});

export const MindThought = defineEvent({
  type: "mind.thought",
  v: 1,
  data: ThoughtSchema,
  scope: "owner",
  tier: "short",
});

export const PlanGoal = defineEvent({
  type: "plan.goal",
  v: 1,
  data: GoalSchema,
  tier: "short",
});

export const MindReminder = defineEvent({
  type: "mind.reminder",
  v: 1,
  data: ReminderChangedSchema,
  tier: "short",
});

export const SocialEvent = defineEvent({
  type: "social.event",
  v: 1,
  data: SocialEventSchema,
  tier: "short",
});

/** Every heart type. */
export const HEART_EVENTS = [
  AffectChanged,
  MoodChanged,
  AffectEvent,
  SelfNudge,
  SelfFeel,
  MindThought,
  PlanGoal,
  MindReminder,
  SocialEvent,
] as const;
