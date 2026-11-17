// The numbers of her own initiative on the new runner. Wherever today's chain has a number for the
// same thing it is read from there (`[modules.arbiter]` for the caps, the gaps and the back-off,
// `[modules.mind]` for her morning and whom she cares about), so the owner's settings carry over;
// `[modules.agent.initiative]` holds only what is new:
//
//   [modules.agent.initiative]
//   home = "<channel id>"   # where she wakes for what belongs to no place (default: none)

import type { Config } from "@miyoria/runtime/kernel";
import { type ContextKey, contextKeyString } from "@miyoria/types";
import { z } from "zod";
import {
  type ArbiterConfig,
  ArbiterConfigSchema,
  type LocalTime,
} from "../../arbiter/src/index.js";
import { DEFAULT_TRIAGE } from "../../self/src/index.js";
import type { GateConfig, OpportunityKind } from "./gates.js";

const count = () => z.number().int().nonnegative();
const fraction = () => z.number().min(0).max(1);

export const InitiativeConfigSchema = z.object({
  /** Glances a day over all places (owner decision Q5; `DEFAULT_TRIAGE.perDay`). */
  glances_per_day: count().default(DEFAULT_TRIAGE.perDay),
  /**
   * Where she wakes for what belongs to no place (a home schedule, her morning): a channel's id,
   * or its display form (`discord:<guild>:<channel>`). Unset: such things wait in her inbox for
   * her next run anywhere.
   */
  home: z.string().nullable().default(null),
  /** A place counts as quiet after this long without a line (the Arbiter's `gap_text_secs`). */
  quiet_mins: z.number().positive().default(10),
  /** How much she must miss someone (0..1, the `missing` feeling) to think of a DM. New. */
  longing_min: fraction().default(0.5),
  /**
   * How much her feelings move her own starts (0: not at all). Her wish to start things
   * (`biases.initiative`, -1..1) shortens or lengthens the quiet she waits for and lowers or
   * raises how much she must miss someone, by up to half; wanting to talk with someone lowers it
   * for them by this times how much. New (phase 4).
   */
  mood_weight: fraction().default(0.5),
  /** Between two starts of the same kind (minutes; 0: none). */
  cooldown_mins: z
    .object({
      /** The old greetings' cooldown (`voice_join_cooldown_secs`, 30 min). */
      world: count().default(30),
      /** New. */
      quiet: count().default(60),
      /** New. */
      longing: count().default(240),
    })
    .prefault({}),
  /** "Not the same kind twice in a row" looks this far back (minutes). New. */
  row_window_mins: count().default(60),
  /** How often schedules, followups and promises are looked at (the Arbiter's `tick_secs`). */
  tick_secs: z.number().int().positive().default(30),
  /** Inbox items shown in one run at most. New. */
  inbox_items: z.number().int().positive().default(12),
  /** Open schedules at most, both tools together (`[modules.mind] reminders_max`). */
  schedules_max: z.number().int().positive().default(20),
  /** Open `remind_me` timers one person asked for (`[modules.mind] reminders_per_person`). */
  schedules_per_person: z.number().int().positive().default(3),
  /** How far ahead (`[modules.mind] reminder_max_days`). */
  schedule_max_days: z.number().int().positive().default(30),
});
export type InitiativeConfig = z.output<typeof InitiativeConfigSchema>;

/** What she reads of `[modules.mind]`: her morning. */
const MindPartSchema = z.looseObject({
  /** Her day starts at this local hour (`daily_hour`). */
  daily_hour: z.number().int().min(0).max(23).default(6),
});

/** Everything the initiative reads, from three sections. */
export interface InitiativeSettings {
  own: InitiativeConfig;
  arbiter: ArbiterConfig;
  morningHour: number;
  /** Salient world events below this score do not wake her (mind's `SALIENT_MIN_SCORE`). */
  salientMin: number;
}

/** Below this score a salient world event does not wake her (as the old Plan had it). */
export const SALIENT_MIN_SCORE = 0.5;

export function initiativeSettings(
  own: Partial<InitiativeConfig> = {},
  arbiter: Partial<ArbiterConfig> = {},
  mind: { daily_hour?: number } = {},
): InitiativeSettings {
  const m = MindPartSchema.parse(mind);
  return {
    own: { ...InitiativeConfigSchema.parse({}), ...own },
    arbiter: { ...ArbiterConfigSchema.parse({}), ...arbiter },
    morningHour: m.daily_hour,
    salientMin: SALIENT_MIN_SCORE,
  };
}

/** The settings from the app's config (Core passes them to `selfHost`). */
export function initiativeFromConfig(config: Config): InitiativeSettings {
  const own = config.get("modules.agent.initiative", InitiativeConfigSchema);
  const arbiter = ArbiterConfigSchema.safeParse(config.module("arbiter").config ?? {});
  const mind = MindPartSchema.safeParse(config.module("mind").config ?? {});
  return {
    own,
    arbiter: arbiter.success ? arbiter.data : ArbiterConfigSchema.parse({}),
    morningHour: mind.success ? mind.data.daily_hour : 6,
    salientMin: SALIENT_MIN_SCORE,
  };
}

const MINUTE_MS = 60_000;

/** The gates' numbers; `quiet`: her clock and quiet hours (the host's), `null`: none. */
export function gateConfig(s: InitiativeSettings, quiet: LocalTime | null): GateConfig {
  const a = s.arbiter;
  const cooldownMs: Partial<Record<OpportunityKind, number>> = {
    world: s.own.cooldown_mins.world * MINUTE_MS,
    quiet: s.own.cooldown_mins.quiet * MINUTE_MS,
    longing: s.own.cooldown_mins.longing * MINUTE_MS,
  };
  return {
    quiet,
    maxPerDay: a.max_per_day,
    maxPerPlacePerDay: a.max_per_context_per_day,
    maxPerPersonPerDay: a.max_per_person_per_day,
    minGapMs: a.min_gap_secs * 1000,
    gapMs: a.gap_text_secs * 1000,
    maxBackoff: a.max_backoff,
    backoffDecayMs: a.backoff_decay_hours * 60 * MINUTE_MS,
    replyWindowMs: a.reply_window_text_secs * 1000,
    maxUnanswered: a.max_unanswered,
    cooldownMs,
    rowWindowMs: s.own.row_window_mins * MINUTE_MS,
    disabled: (place: ContextKey) =>
      a.disabled_contexts.length > 0 &&
      a.disabled_contexts.some((d) => d === contextKeyString(place) || d === place.channel),
  };
}
