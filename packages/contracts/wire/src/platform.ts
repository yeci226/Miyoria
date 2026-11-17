import { z } from "zod";
import { PlatformIdSchema, TimestampSchema } from "./ids.js";

/**
 * An account on a platform. Platform user ids are globally unique per platform, so the bot and
 * self accounts on Discord resolve the same person to the same `AccountRef`.
 */
export const AccountRefSchema = z
  .object({ platform: PlatformIdSchema, id: z.string() })
  .meta({ id: "WireAccountRef" });
export type AccountRef = z.output<typeof AccountRefSchema>;

export const ContextKindSchema = z
  .enum(["channel", "thread", "dm", "voice"])
  .meta({ id: "WireContextKind" });
export type ContextKind = z.output<typeof ContextKindSchema>;

/**
 * Identifies one conversation context. It is independent of which connection (bot or self
 * account) observed it.
 */
export const ContextKeySchema = z
  .object({
    platform: PlatformIdSchema,
    /** Guild / server id. `null` for DMs. */
    scope: z.string().nullable(),
    channel: z.string(),
    kind: ContextKindSchema,
  })
  .meta({ id: "WireContextKey" });
export type ContextKey = z.output<typeof ContextKeySchema>;

export const MessageRefSchema = z
  .object({ context: ContextKeySchema, id: z.string() })
  .meta({ id: "WireMessageRef" });
export type MessageRef = z.output<typeof MessageRefSchema>;

export const AuthorSchema = z
  .object({ account: AccountRefSchema, display_name: z.string(), is_bot: z.boolean() })
  .meta({ id: "WireAuthor" });
export type Author = z.output<typeof AuthorSchema>;

export const AttachmentSchema = z
  .object({
    url: z.string(),
    filename: z.string(),
    content_type: z.string().nullable(),
    /** Platform id of the attachment (stable, unlike signed CDN URLs); the download cache key. */
    id: z.string().nullable().optional(),
    /** Size in bytes, when the platform reports it. */
    size: z.number().nullable().optional(),
    /** Alt text the author wrote. */
    description: z.string().nullable().optional(),
  })
  .meta({ id: "WireAttachment" });
export type Attachment = z.output<typeof AttachmentSchema>;

/** A sticker sent with a message. */
export const StickerSchema = z
  .object({ id: z.string(), name: z.string() })
  .meta({ id: "WireSticker" });
export type Sticker = z.output<typeof StickerSchema>;

/** A rich embed (link preview, bot card): only the parts worth reading. */
export const EmbedSchema = z
  .object({
    title: z.string().nullable(),
    description: z.string().nullable(),
    url: z.string().nullable(),
    /**
     * The large preview picture, as the platform's own proxy serves it (never the third-party
     * original, which only the platform's proxy is allowed to fetch).
     */
    image: z.string().nullable().optional(),
    /** The small preview picture, by the same rule. */
    thumbnail: z.string().nullable().optional(),
  })
  .meta({ id: "WireEmbed" });
export type Embed = z.output<typeof EmbedSchema>;

/** The message another one replies to, as far as the platform delivered it with the reply. */
export const QuotedMessageSchema = z
  .object({ author: AccountRefSchema.nullable(), author_name: z.string(), text: z.string() })
  .meta({ id: "WireQuotedMessage" });
export type QuotedMessage = z.output<typeof QuotedMessageSchema>;

/** A forwarded message's snapshot (the forwarder's message itself is usually empty). */
export const ForwardedMessageSchema = z
  .object({
    text: z.string(),
    attachments: z.array(AttachmentSchema),
    stickers: z.array(StickerSchema),
    embeds: z.array(EmbedSchema),
  })
  .meta({ id: "WireForwardedMessage" });
export type ForwardedMessage = z.output<typeof ForwardedMessageSchema>;

/** Someone other than her that a message @-mentions (people and bots, never roles). */
export const MentionedAccountSchema = z
  .object({ account: AccountRefSchema, display_name: z.string(), is_bot: z.boolean() })
  .meta({ id: "WireMentionedAccount" });
export type MentionedAccount = z.output<typeof MentionedAccountSchema>;

/**
 * A message as the platform delivered it.
 *
 * The fields after `ts` were added later. They are optional so producers that predate them
 * (extensions, the CLI platform, stored events) stay valid; consumers treat a missing field as
 * `null` / empty.
 */
export const IncomingMessageSchema = z
  .object({
    id: MessageRefSchema,
    author: AuthorSchema,
    /** Text with mentions and custom emoji resolved to names by the platform adapter. */
    text: z.string(),
    /** The message @-mentions one of her accounts. */
    mentions_self: z.boolean(),
    /** The message replies to one of her messages. */
    reply_to_self: z.boolean(),
    attachments: z.array(AttachmentSchema),
    ts: TimestampSchema,
    /** The message this one replies to. */
    reply_to: MessageRefSchema.nullable().optional(),
    /** Author and text of `reply_to`, when the platform had it at hand. */
    referenced: QuotedMessageSchema.nullable().optional(),
    stickers: z.array(StickerSchema).optional(),
    embeds: z.array(EmbedSchema).optional(),
    forwarded: z.array(ForwardedMessageSchema).optional(),
    /**
     * Accounts other than her that the text @-mentions, in order of appearance. Reply pings that
     * are not written in the text are not listed. Together with `reply_to_self` it tells
     * "a reply to her" apart from "a reply to her that talks to someone else".
     */
    mentions_others: z.array(MentionedAccountSchema).optional(),
    /** The text opens with a mention of someone other than her: it is probably said to them. */
    opens_with_other_mention: z.boolean().optional(),
    /** Voice: a model judged the speaker done, so there is no need to wait and see if they go on. */
    turn_complete: z.boolean().optional(),
    /**
     * A card: its text is in components, with no plain content (Discord Components V2). Her own
     * cards are notices, receipts and panels the system posts in her name, not lines she said.
     */
    card: z.boolean().optional(),
  })
  .meta({ id: "WireIncomingMessage" });
export type IncomingMessage = z.output<typeof IncomingMessageSchema>;
