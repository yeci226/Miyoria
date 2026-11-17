// The owner's per-channel levels: how much she may talk in each text channel.

import { z } from "zod";
import { ContextKeySchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { ContextKeyInSchema } from "./shared.js";

/** One level: `off`, `mention-only`, `quiet`, `normal`, `lively` or `always`, in words. */
export const ChannelLevelInfoSchema = z
  .object({
    mode: z.string(),
    /** In words (`安靜`). */
    label: z.string(),
    description: z.string(),
  })
  .meta({ id: "ApiChannelLevelInfo" });
export type ChannelLevelInfo = z.output<typeof ChannelLevelInfoSchema>;

/** The level of one text channel. */
export const ChannelLevelViewSchema = z
  .object({
    context: ContextKeySchema,
    /** The channel's name when the platform knows it. */
    label: z.string().nullable(),
    mode: z.string(),
    /** Set at runtime (`/channel mode` or the panel); `false`: from config or the profile. */
    custom: z.boolean(),
    /** The mode without the runtime setting: what resetting goes back to. */
    default: z.string(),
  })
  .meta({ id: "ApiChannelLevelView" });
export type ChannelLevelView = z.output<typeof ChannelLevelViewSchema>;

/** `GET /api/channels/levels`: the levels, and the text channels she has seen lately or that have their own. */
export const ChannelLevelsViewSchema = z
  .object({ levels: z.array(ChannelLevelInfoSchema), channels: z.array(ChannelLevelViewSchema) })
  .meta({ id: "ApiChannelLevelsView" });
export type ChannelLevelsView = z.output<typeof ChannelLevelsViewSchema>;

/** Body of `PUT /api/channels/level`. */
export const SetChannelLevelRequestSchema = z
  .object({
    context: ContextKeyInSchema,
    /** A level, or `null` to go back to the configured one. */
    mode: z.string().nullable(),
  })
  .meta({ id: "ApiSetChannelLevelRequest" });
export type SetChannelLevelRequest = z.input<typeof SetChannelLevelRequestSchema>;

export const channels = {
  levels: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/channels/levels" })
    .output(ChannelLevelsViewSchema),
  /** Sets or resets one channel's level, like `/channel mode`; needs the same node. */
  setLevel: route
    .meta({ audience: "admin", permission: "admin.channel.mode" })
    .route({ method: "PUT", path: "/api/channels/level" })
    .input(z.object({ body: SetChannelLevelRequestSchema }))
    .output(ChannelLevelViewSchema),
};
