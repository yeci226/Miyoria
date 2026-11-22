// The part of `[modules.cards]` about the cards she drops in a channel (docs/design/v5-play.md
// §6.2), spread into `CardsConfigSchema` (`config.ts`). Off by default, and on only in the channels
// listed. The design's draft numbers are the defaults where it gives one (three people, twenty
// lines, ten minutes; one a day per person; two or three a day per channel, here two); the rest are
// cautious choices of this module's (the chance, the gap, the delay, how long a drop lasts).
//
// Per place (phase 6): `drop_channels` is each server's own list (a channel of another server never
// counts, so a list set for the whole cluster is the original server's), and `drops` may be turned
// on or off per channel. A channel drops cards when it is in its server's list and `drops` is on
// for it. The limits and how lively a channel must be are the same everywhere; what one person may
// pick up in a day counts across servers.
//
// ```toml
// [modules.cards]
// drops = true
// drop_channels = ["123456789012345678"]
// ```

import { setting } from "@miyoria/runtime/kernel";
import { z } from "zod";

const group = "drops";

export const DROP_CONFIG = {
  /** Whether she drops cards at all. Off by default; on, only in `drop_channels`. */
  drops: z
    .boolean()
    .default(false)
    .meta(
      setting({
        kind: "switch",
        scope: "room",
        label: "掉落卡片",
        help: "只在下面的頻道掉;可以每個頻道各自開關",
        group,
      }),
    ),
  /** The channel ids (Discord snowflakes) where she may drop a card: each channel's own opt-in. */
  drop_channels: z
    .array(z.string().min(1))
    .default([])
    .meta(
      setting({
        kind: "channel",
        multiple: true,
        room: "text",
        ref: "id",
        scope: "space",
        label: "掉落的頻道",
        help: "每個伺服器各自的頻道",
        group,
      }),
    ),
  /** A channel is lively when, within this many minutes, ... */
  drop_window_mins: z
    .number()
    .int()
    .positive()
    .default(10)
    .meta(
      setting({
        kind: "duration",
        unit: "min",
        label: "熱鬧的判斷時間",
        help: "這段時間內的人數和句數夠多,頻道才算熱鬧",
        group,
      }),
    ),
  /** ... at least this many people ... */
  drop_min_people: z
    .number()
    .int()
    .positive()
    .default(3)
    .meta(setting({ kind: "number", label: "至少幾人", group })),
  /** ... said at least this many lines together. */
  drop_min_lines: z
    .number()
    .int()
    .positive()
    .default(20)
    .meta(setting({ kind: "number", label: "至少幾句", group })),
  /** The chance she drops one when a channel is lively, rolled at most once a window. */
  drop_chance: z
    .number()
    .min(0)
    .max(1)
    .default(0.25)
    .meta(setting({ kind: "ratio", label: "掉落機率", help: "頻道熱鬧時掉一張的機率", group })),
  /** Drops per channel per local day, at most. */
  drops_per_channel_day: z
    .number()
    .int()
    .nonnegative()
    .default(2)
    .meta(setting({ kind: "number", label: "每頻道每天最多", group })),
  /** At least this many minutes between two drops in one channel. */
  drop_gap_mins: z
    .number()
    .int()
    .nonnegative()
    .default(120)
    .meta(setting({ kind: "duration", unit: "min", label: "兩次掉落至少相隔", group })),
  /** A drop appears after a random delay between these (seconds), so nobody can time it. */
  drop_delay_min_secs: z
    .number()
    .int()
    .nonnegative()
    .default(30)
    .meta(setting({ kind: "duration", unit: "s", label: "延遲最短", group })),
  drop_delay_max_secs: z
    .number()
    .int()
    .nonnegative()
    .default(180)
    .meta(setting({ kind: "duration", unit: "s", label: "延遲最長", group })),
  /** An unclaimed drop is gone after this many minutes. */
  drop_expire_mins: z
    .number()
    .int()
    .positive()
    .default(10)
    .meta(setting({ kind: "duration", unit: "min", label: "沒人撿就消失", group })),
  /** Dropped cards one person may pick up per local day. */
  drops_per_person_day: z
    .number()
    .int()
    .positive()
    .default(1)
    .meta(setting({ kind: "number", label: "每人每天能撿", group })),
};
