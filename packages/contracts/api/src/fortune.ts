// The fortune slip on the member page: one per local day, written by her for the person logged in.
// Only a person she knows and has not blocked may draw (403, as everywhere).

import { z } from "zod";
import { EmptyRequestSchema } from "./member.js";
import { IdempotencyHeaders, route } from "./route.js";

/** A field on a fortune slip: its name and what she wrote. */
export const FortuneFieldSchema = z
  .object({ label: z.string(), text: z.string() })
  .meta({ id: "ApiFortuneField" });
export type FortuneField = z.output<typeof FortuneFieldSchema>;

/** A fortune slip she wrote for them, one per local day. */
export const IssuedFortuneSchema = z
  .object({
    id: z.string(),
    /** The local day it is for, `YYYY-MM-DD`. */
    date: z.string(),
    issued_at: z.string(),
    rank: z.enum(["大吉", "吉", "中吉", "小吉", "末吉", "凶"]),
    /** At most 8 characters. */
    title: z.string(),
    /** Four lines of at most 7 characters. */
    poem: z.array(z.string()),
    /** At most three. */
    fields: z.array(FortuneFieldSchema),
    /** A personal line, at most 30 characters. */
    line: z.string().nullable(),
  })
  .meta({ id: "ApiIssuedFortune" });
export type IssuedFortune = z.output<typeof IssuedFortuneSchema>;

/** `GET /api/member/fortune`: today's slip or `null`, and the price of one. */
export const FortuneTodaySchema = z
  .object({ fortune: IssuedFortuneSchema.nullable(), price: z.number() })
  .meta({ id: "ApiFortuneToday" });
export type FortuneToday = z.output<typeof FortuneTodaySchema>;

/** `POST /api/member/fortune`: the slip (today's own when one existed: nothing charged then). */
export const FortuneDrawSchema = z
  .object({ fortune: IssuedFortuneSchema, charged: z.number(), balance: z.number() })
  .meta({ id: "ApiFortuneDraw" });
export type FortuneDraw = z.output<typeof FortuneDrawSchema>;

export const fortune = {
  today: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "GET", path: "/api/member/fortune" })
    .output(FortuneTodaySchema),
  /**
   * Pays for today's slip, she writes it and it is kept. She cannot write now and the payment is
   * given back (`503`); a retry with the key of an attempt that did not finish is `409`.
   */
  draw: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "POST", path: "/api/member/fortune" })
    .input(z.object({ headers: IdempotencyHeaders, body: EmptyRequestSchema }))
    .output(FortuneDrawSchema),
};
