// The owner's per-channel levels: how much she may talk in each text channel, and the level of a
// whole server for its channels that have none of their own (docs/design/v5-places.md). Both
// routes take `?space=` (identity's Space id; default: the primary).

import { z } from "zod";
import { ContextKeySchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { ContextKeyInSchema, SpaceQuery } from "./shared.js";

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

/** The level of a whole server: what its channels without one of their own get. */
export const SpaceLevelViewSchema = z
  .object({
    /** Identity's Space id. */
    id: z.string(),
    name: z.string(),
    mode: z.string(),
    /** Set for this server; `false`: from config or the profile (a server joined later: 只回提及). */
    custom: z.boolean(),
    /** The level without the server's own: what resetting goes back to. */
    default: z.string(),
  })
  .meta({ id: "ApiSpaceLevelView" });
export type SpaceLevelView = z.output<typeof SpaceLevelViewSchema>;

/**
 * `GET /api/channels/levels`: the levels, and the text channels of the Space she has seen lately
 * or that have their own. `space` is that Space's own level; `null` without Spaces (every channel
 * she knows is listed then).
 */
export const ChannelLevelsViewSchema = z
  .object({
    levels: z.array(ChannelLevelInfoSchema),
    channels: z.array(ChannelLevelViewSchema),
    space: SpaceLevelViewSchema.nullable(),
  })
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

/** Body of `PUT /api/channels/space-level`: the level of the Space `?space=` names. */
export const SetSpaceLevelRequestSchema = z
  .object({
    /** A level, or `null` to go back to the configured one. */
    mode: z.string().nullable(),
  })
  .meta({ id: "ApiSetSpaceLevelRequest" });
export type SetSpaceLevelRequest = z.input<typeof SetSpaceLevelRequestSchema>;
export type SetChannelLevelRequest = z.input<typeof SetChannelLevelRequestSchema>;

export const channels = {
  levels: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/channels/levels" })
    // Optional, so a caller from before phase 6 (no `?space=`) still fits: the primary's.
    .input(z.object({ query: SpaceQuery }).optional())
    .output(ChannelLevelsViewSchema),
  /** Sets or resets one channel's level, like `/channel mode`; needs the same node. */
  setLevel: route
    .meta({ audience: "admin", permission: "admin.channel.mode" })
    .route({ method: "PUT", path: "/api/channels/level" })
    .input(z.object({ body: SetChannelLevelRequestSchema }))
    .output(ChannelLevelViewSchema),
  /**
   * Sets or resets the level of a whole Space (`?space=`, default the primary): what its
   * channels without one of their own get, like `/channel mode 範圍:整個伺服器`.
   */
  setSpaceLevel: route
    .meta({ audience: "admin", permission: "admin.channel.mode" })
    .route({ method: "PUT", path: "/api/channels/space-level" })
    .input(z.object({ query: SpaceQuery, body: SetSpaceLevelRequestSchema }))
    .output(SpaceLevelViewSchema),
};
