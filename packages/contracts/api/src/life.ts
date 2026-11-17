// Her own life, read-only except for cancelling a timer: what she did today and lately, the timers
// she set, and the table of things she can do with which of them she has the means for.

import { z } from "zod";
import { AccountRefSchema, ContextKeySchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";

export const LifeActivityIdSchema = z
  .enum([
    "browse",
    "diary",
    "code",
    "practice",
    "game",
    "recap",
    "business",
    "care",
    "event",
    "sing",
  ])
  .meta({ id: "ApiLifeActivityId" });
export type LifeActivityId = z.output<typeof LifeActivityIdSchema>;

/** One thing she did. */
export const LifeEntrySchema = z
  .object({
    id: z.string(),
    activity: LifeActivityIdSchema,
    /** What exactly, short and in her terms; may quote others. */
    what: z.string(),
    /** When it started (a single act: when it happened). */
    at: TimestampSchema,
    /** How long it ran; `null`: a single act (a search, a post). */
    minutes: z.number().nullable(),
    /** The capability that did it, when one did. */
    capability: z.string().nullable(),
  })
  .meta({ id: "ApiLifeEntry" });
export type LifeEntry = z.output<typeof LifeEntrySchema>;

/** `GET /api/life/today`. */
export const LifeDayViewSchema = z
  .object({
    /** Today's entries (her local day), oldest first. */
    today: z.array(LifeEntrySchema),
    /** The last seven days, today included, oldest first. */
    lately: z.array(LifeEntrySchema),
    /** What her prompt says of today and of the last days; `null`: nothing. */
    summary_today: z.string().nullable(),
    summary_lately: z.string().nullable(),
  })
  .meta({ id: "ApiLifeDayView" });
export type LifeDayView = z.output<typeof LifeDayViewSchema>;

/** A timer she set, for herself or because someone asked. */
export const ReminderViewSchema = z
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
    /** Where it was set. */
    context: ContextKeySchema.nullable(),
    /** Who it is about. */
    person: z.string().nullable(),
    /** The account that asked for it; `null`: she set it for herself. */
    for_account: AccountRefSchema.nullable(),
    /** How many times it came due so far. */
    fired: z.number(),
    created_at: TimestampSchema,
  })
  .meta({ id: "ApiReminderView" });
export type ReminderView = z.output<typeof ReminderViewSchema>;

/** `GET /api/life/reminders`: the timers, soonest first. */
export const RemindersViewSchema = z
  .object({ reminders: z.array(ReminderViewSchema) })
  .meta({ id: "ApiRemindersView" });
export type RemindersView = z.output<typeof RemindersViewSchema>;

/** One thing she can do, and which of the capabilities that do it are registered. */
export const ActivityViewSchema = z
  .object({
    id: LifeActivityIdSchema,
    label: z.string(),
    does: z.string(),
    leaves: z.string(),
    people: z.enum(["any", "someone", "group"]),
    /** The local hours it fits (start inclusive, end exclusive); `null`: any. */
    hours: z.tuple([z.number(), z.number()]).nullable(),
    per_day: z.number().nullable(),
    share: z.number(),
    /** `false`: other desires cover it; it is only listed and logged. */
    generic: z.boolean(),
    capabilities: z.array(z.object({ id: z.string(), registered: z.boolean() })),
    /** The capability she would use: the first registered one; `null`: none is registered. */
    capability: z.string().nullable(),
    /** At least one of its capabilities is registered. */
    available: z.boolean(),
    /** How many times she did it today; `null` when the life log is not running. */
    done_today: z.number().nullable(),
  })
  .meta({ id: "ApiActivityView" });
export type ActivityView = z.output<typeof ActivityViewSchema>;

/** `GET /api/life/activities`. */
export const ActivitiesViewSchema = z
  .object({ activities: z.array(ActivityViewSchema) })
  .meta({ id: "ApiActivitiesView" });
export type ActivitiesView = z.output<typeof ActivitiesViewSchema>;

export const life = {
  /** What she did today and in the last days, and what the prompt says of it. */
  today: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/life/today" })
    .output(LifeDayViewSchema),
  reminders: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/life/reminders" })
    .output(RemindersViewSchema),
  /** Cancels one by its short key or its id; `404` when there is no such open timer. */
  cancelReminder: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "DELETE", path: "/api/life/reminders/{key}" })
    .input(z.object({ params: z.object({ key: z.string() }) }))
    .output(z.object({ cancelled: z.literal(true), key: z.string() })),
  activities: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/life/activities" })
    .output(ActivitiesViewSchema),
};
