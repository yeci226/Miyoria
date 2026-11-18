// The economy's bus topics (docs/design/v5-contracts.md §3, K12a): a commission someone paid for
// and how it ended, a room item the community funded, a paid message for the
// screen, a gift, and a paid danmaku line (with the owner's "clear the layer"). Each type is the bus topic it is published on, and its payload is that
// event's data. Written from what `packages/economy` publishes today; the economy's own new
// topics (`economy.posted`) are defined in the file that comes with them.
//
// Tiers (v5-data §2.5): money is kept (`keep`): a commission, its outcome, a gift and a funded
// room item, all paid for with coins. A paid line for the screen is a display request whose text
// was already screened, kept 90 days (`short`). A commission names the person and what they asked
// for, and its outcome what she handed back: no default scope. A gift, a funded room item and a
// line for the screen are drawn on the public stage (`public`).

import { z } from "zod";
import { AccountRefSchema, TimestampSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

export const CommissionKindSchema = z
  .enum(["poem", "name", "tool", "song", "voice"])
  .meta({ id: "EventsCommissionKind" });

/** Someone paid for a commission, which now waits for her: `economy.commission`. */
export const CommissionAskedSchema = z
  .object({
    /** The short code she and the commissioner use. */
    id: z.string(),
    /** The commission's document id. */
    commission: z.string(),
    kind: CommissionKindSchema,
    /** What they asked for, after review. */
    brief: z.string(),
    /** The commissioner's display name (untrusted). */
    name: z.string(),
    account: AccountRefSchema,
    /** What they paid, in coins. */
    price: z.number(),
    /** Untouched after this, the whole price goes back. */
    due_at: TimestampSchema,
  })
  .meta({ id: "EventsCommissionAsked" });
export type CommissionAskedData = z.output<typeof CommissionAskedSchema>;

/** She handed a commission in, or declined it: `economy.commission.done`. */
export const CommissionDoneSchema = z
  .object({
    id: z.string(),
    status: z.enum(["delivered", "declined"]),
    kind: CommissionKindSchema,
    /** The commissioner; `null` when the commission has no owner left. */
    account: AccountRefSchema.nullable(),
    /** What she handed over, or why she declined. */
    text: z.string(),
  })
  .meta({ id: "EventsCommissionDone" });
export type CommissionDoneData = z.output<typeof CommissionDoneSchema>;

/** The community funded a room item in full: `economy.room.placed`. */
export const RoomPlacedSchema = z
  .object({
    item: z.string(),
    label: z.string(),
    kind: z.enum(["furniture", "outfit", "background"]),
  })
  .meta({ id: "EventsRoomPlaced" });
export type RoomPlacedData = z.output<typeof RoomPlacedSchema>;

/** A paid message put on the stream's screen: `economy.screen`. */
export const ScreenLineSchema = z
  .object({
    /** Who paid (display name, untrusted). */
    name: z.string(),
    /** The message; already screened. */
    text: z.string(),
  })
  .meta({ id: "EventsScreenLine" });
export type ScreenLineData = z.output<typeof ScreenLineSchema>;

/**
 * A paid danmaku line for the overlay: `economy.danmaku`. `id` is the ledger row of its charge (the
 * stage answers with it, `stage.danmaku`); `name` is `null` when names are hidden. The limits are
 * the owner's settings, sent with every line.
 */
export const DanmakuLineSchema = z
  .object({
    id: z.string(),
    /** Who paid (display name, untrusted), or `null`. */
    name: z.string().nullable(),
    /** The line; already screened and cleaned. */
    text: z.string(),
    max_on_screen: z.number(),
    queue_max: z.number(),
    max_wait_ms: z.number(),
  })
  .meta({ id: "EventsDanmakuLine" });
export type DanmakuLineData = z.output<typeof DanmakuLineSchema>;

/** Take every danmaku line off the overlay (an owner's action): `economy.danmaku.clear`. */
export const DanmakuClearSchema = z.object({}).meta({ id: "EventsDanmakuClear" });
export type DanmakuClearData = z.output<typeof DanmakuClearSchema>;

/** What a gift is: a food item. */
export const GiftItemSchema = z
  .enum(["rice", "big_bowl", "dessert"])
  .meta({ id: "EventsGiftItem" });

/** Someone paid for a gift: `economy.gift`. */
export const GiftSchema = z
  .object({
    /** The giver's display name (untrusted). */
    name: z.string(),
    item: GiftItemSchema,
    count: z.number(),
    /** `一碗白飯`. */
    label: z.string(),
  })
  .meta({ id: "EventsGift" });
export type GiftData = z.output<typeof GiftSchema>;

export const EconomyCommission = defineEvent({
  type: "economy.commission",
  v: 1,
  data: CommissionAskedSchema,
  tier: "keep",
});

export const EconomyCommissionDone = defineEvent({
  type: "economy.commission.done",
  v: 1,
  data: CommissionDoneSchema,
  tier: "keep",
});

export const EconomyRoomPlaced = defineEvent({
  type: "economy.room.placed",
  v: 1,
  data: RoomPlacedSchema,
  scope: "public",
  tier: "keep",
});

export const EconomyScreen = defineEvent({
  type: "economy.screen",
  v: 1,
  data: ScreenLineSchema,
  scope: "public",
  tier: "short",
});

export const EconomyGift = defineEvent({
  type: "economy.gift",
  v: 1,
  data: GiftSchema,
  scope: "public",
  tier: "keep",
});

export const EconomyDanmaku = defineEvent({
  type: "economy.danmaku",
  v: 1,
  data: DanmakuLineSchema,
  scope: "public",
  tier: "short",
});

export const EconomyDanmakuClear = defineEvent({
  type: "economy.danmaku.clear",
  v: 1,
  data: DanmakuClearSchema,
  scope: "owner",
  tier: "short",
});

/** Every economy type published today. */
export const ECONOMY_BUS_EVENTS = [
  EconomyCommission,
  EconomyCommissionDone,
  EconomyRoomPlaced,
  EconomyScreen,
  EconomyGift,
  EconomyDanmaku,
  EconomyDanmakuClear,
] as const;
