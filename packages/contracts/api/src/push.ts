// Server push (v5-architecture §11.4): the few views that should feel live, as Server-Sent Events.
// One stream per audience carries several topics; each topic's value is exactly the answer of the
// polled route it stands in for (the same schema, the same rules on the server), so a client
// writes it where the polled answer would have gone and keeps polling whenever the stream is not
// there.
//
// The protocol, per stream: a `value` for every topic asked for (or `refused`, with the status the
// polled route would have answered), then `ready`; after that a `value` whenever a topic's answer
// changes. A reconnect that sends `Last-Event-ID` gets only what changed since that id, or every
// value again when the id is from another run of the Core, names other topics, or is too old. A
// `ping` event comes after 15 s without any other (a comment would be invisible to the client).

import { eventIterator } from "@orpc/contract";
import { z } from "zod";
import { ExchangeListSchema, ExchangeTickerSchema } from "./exchange.js";
import { KaraokeRoomsSchema } from "./karaoke-rooms.js";
import { PublicSongsSchema, PublicStatusSchema } from "./public.js";
import { route } from "./route.js";
import { DanmakuViewSchema } from "./wallet.js";

/** The topics a public stream may carry: what anyone may see. */
export const PUBLIC_PUSH_TOPICS = ["status", "songs"] as const;
/** The topics only a member stream carries: about the logged-in person. */
export const MEMBER_PUSH_TOPICS = ["rooms", "danmaku", "exchange_list", "exchange_ticker"] as const;

export const PushTopicSchema = z
  .enum([...PUBLIC_PUSH_TOPICS, ...MEMBER_PUSH_TOPICS])
  .meta({ id: "ApiPushTopic" });
export type PushTopic = z.output<typeof PushTopicSchema>;

/** Most topics one stream may carry. */
export const PUSH_MAX_TOPICS = 8;
/** What a topic's parameter may be (a Space id, a list, a ticker's code): the characters of an id. */
export const PUSH_PARAM = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * `?topics=`: comma-separated, each a topic name or `name~param` (`songs~<space>`: that server's;
 * the parameter is what the polled route takes as `?space=`, or in its path: `exchange_list~tw`,
 * `exchange_ticker~2330.TW`). At most `PUSH_MAX_TOPICS`.
 */
export const PushQuerySchema = z
  .object({ topics: z.string().min(1).max(600) })
  .meta({ id: "ApiPushQuery" });

/** A topic's value: `topic` and `param` say which subscription it answers, as asked. */
function value<T extends PushTopic, S extends z.ZodType>(topic: T, data: S) {
  return z.object({
    kind: z.literal("value"),
    topic: z.literal(topic),
    param: z.string().nullable(),
    data,
  });
}

/** One event of a push stream. */
export const PushEventSchema = z
  .union([
    value("status", PublicStatusSchema),
    value("songs", PublicSongsSchema),
    value("rooms", KaraokeRoomsSchema),
    value("danmaku", DanmakuViewSchema),
    value("exchange_list", ExchangeListSchema),
    value("exchange_ticker", ExchangeTickerSchema),
    /**
     * The topic cannot be followed now: what its polled route would answer (`status`, the
     * sentence). The client keeps polling that one; a later `value` means it is followed again.
     */
    z.object({
      kind: z.literal("refused"),
      topic: PushTopicSchema,
      param: z.string().nullable(),
      status: z.number().int(),
      message: z.string(),
    }),
    /** Every topic asked for has its value (or its refusal): from here on, only changes. */
    z.object({ kind: z.literal("ready") }),
    /**
     * Nothing changed for 15 s: the stream is alive. A client that hears nothing at all (no value,
     * no `ready`, no `ping`) for much longer treats the stream as dead, whatever the socket says.
     */
    z.object({ kind: z.literal("ping") }),
  ])
  .meta({ id: "ApiPushEvent" });
export type PushEvent = z.output<typeof PushEventSchema>;

export const push = {
  /**
   * `GET /api/public/stream?topics=status,songs`: the public topics, for anyone, on the public
   * side's listeners. Limited per client like the public views (`429`), and in how many streams
   * one client and everyone together hold open (`429`, `503`).
   */
  public: route
    .meta({ audience: "public", permission: null })
    .route({ method: "GET", path: "/api/public/stream" })
    .input(z.object({ query: PushQuerySchema }))
    .output(eventIterator(PushEventSchema)),
  /**
   * `GET /api/member/stream?topics=status,rooms~<space>,danmaku`: the public topics and the
   * logged-in person's own, by session. Each topic is checked the way its polled route checks it
   * (a server they are not in is refused), again every half minute; the stream ends when the
   * session does.
   */
  member: route
    .meta({ audience: "member", permission: null })
    .route({ method: "GET", path: "/api/member/stream" })
    .input(z.object({ query: PushQuerySchema }))
    .output(eventIterator(PushEventSchema)),
};
