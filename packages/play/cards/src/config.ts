// `[modules.cards]` (docs/design/v5-play.md §2, §6.2, §8): the price of a daily card, how many a
// person may buy a day, the pity and the rarity weights, and the cards she drops in a channel (off
// by default). Every field has a default. The weights are the public odds (`odds.ts` prints them):
// changing them is a config change, and a config revision is the record cards.md §2.3 asks for.

import { setting, settingGroups } from "@miyoria/runtime/kernel";
import { z } from "zod";
import type { DrawRules } from "./draw.js";
import { DROP_CONFIG } from "./drop-config.js";

const weight = () => z.number().nonnegative();

/**
 * ```toml
 * [modules.cards]
 * price = 30
 * daily_cap = 5
 * pity = 20
 * rarity_weights = { N = 70, R = 22, SR = 7, SSR = 1 }
 * portrait = "live2d"
 * portrait_model = "C:/.../Live2DModels/DeepSeek-chan/大肥鱼.model3.json"
 * ```
 */
export const CardsConfigSchema = z
  .object({
    /** Her local time zone as a UTC offset: what a "day" is for the daily cap (the heart's). */
    utc_offset_minutes: z
      .number()
      .int()
      .min(-720)
      .max(840)
      .default(8 * 60),
    /** Fish coins per daily card; the first card of the day costs the same (owner, 2026-11-14). */
    price: z
      .number()
      .int()
      .nonnegative()
      .default(30)
      .meta(setting({ kind: "coins", label: "一張的價格", group: "daily" })),
    /** Daily cards one person may get per local day. */
    daily_cap: z
      .number()
      .int()
      .positive()
      .default(5)
      .meta(setting({ kind: "number", label: "每人每天幾張", group: "daily" })),
    /** Cards in a row without an SR-or-better part after which the next one is guaranteed one. */
    pity: z
      .number()
      .int()
      .positive()
      .default(20)
      .meta(
        setting({
          kind: "number",
          label: "保底",
          help: "連續這麼多張沒有 SR 以上,下一張保證有",
          group: "daily",
        }),
      ),
    /** The chance of each rarity, as weights (they need not sum to 100). */
    rarity_weights: z
      .object({
        N: weight().default(70),
        R: weight().default(22),
        SR: weight().default(7),
        SSR: weight().default(1),
      })
      .refine((w) => w.N + w.R + w.SR + w.SSR > 0, {
        message: "at least one weight must be above 0",
      })
      .prefault({}),
    /**
     * Her picture on a daily card (cards.md §6): `live2d` renders it from her model by what was drawn
     * and falls back to the fixed portraits whenever it cannot; `fixed` always uses those.
     */
    portrait: z.enum(["live2d", "fixed"]).default("live2d"),
    /** Her model's `.model3.json` for `live2d`; empty: not set, the fixed portraits are used. */
    portrait_model: z.string().default(""),
    /** The card studio's folder (built per its `vendor.md`), relative to the working folder. */
    portrait_studio: z.string().default("tools/card-studio"),
    /** Where rendered pictures are kept, by the hash of what they are drawn from. */
    portrait_cache: z.string().default("data/cards/portraits"),
    /**
     * Most megabytes the kept pictures may take (about one per card): past it the ones used longest
     * ago go. Any of them can be rendered again from its card.
     */
    portrait_cache_max_mb: z.number().int().positive().default(2048),
    /** The browser playwright-core starts: `msedge` or `chrome`. */
    portrait_browser: z.enum(["msedge", "chrome"]).default("msedge"),
    /** Longest wait for one picture. */
    portrait_timeout_secs: z.number().positive().max(600).default(30),
    // The cards she drops in a channel (§6.2), off by default.
    ...DROP_CONFIG,
  })
  .meta(
    settingGroups([
      { id: "daily", label: "每日卡" },
      { id: "drops", label: "掉落" },
    ]),
  );

export type CardsConfig = z.output<typeof CardsConfigSchema>;

/** The defaults, optionally overridden. */
export function cardsConfig(overrides: Partial<CardsConfig> = {}): CardsConfig {
  return { ...CardsConfigSchema.parse({}), ...overrides };
}

/** The draw's part of the config. */
export function drawRules(config: Pick<CardsConfig, "rarity_weights" | "pity">): DrawRules {
  return { weights: config.rarity_weights, pity: config.pity };
}
