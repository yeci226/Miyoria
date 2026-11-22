// Pieces more than one group's routes are made of.

import { z } from "zod";
import { ContextKeySchema } from "../../wire/src/index.js";

/** A context in a request body: a client may leave `scope` out, which means a DM (`null`). */
export const ContextKeyInSchema = z
  .object({
    ...ContextKeySchema.shape,
    scope: z.string().nullable().default(null),
  })
  .meta({ id: "ApiContextKeyIn" });
export type ContextKeyIn = z.input<typeof ContextKeyInSchema>;

/** A count in a query string: the digits, as a number (`limit=50`). */
export const UsizeQuery = z.coerce.number<number | string>().int().min(0);

/**
 * A number in a query string that a handler reads itself, because today's answer to one that is
 * not a number is not a 400 but a default (or a message of its own). Always a string on the wire;
 * a number is accepted so that a caller can pass `limit: 50`.
 */
export const LooseCount = z.union([z.string(), z.number()]);

/**
 * A count in a query string, as the digits and nothing else (`limit=50`; `+5` is fine, an empty
 * value or `5.5` is not). Always a string on the wire: the handler reads it with `Number.parseInt`.
 * The message is the one the server has always given.
 */
export const DigitsQuery = z.string().regex(/^\+?\d+$/, "invalid digit found in string");

/** A flag in a query string: exactly `true` or `false` (a handler reads it as `=== "true"`). */
export const FlagQuery = z.enum(["true", "false"], {
  error: "provided string was not `true` or `false`",
});

/**
 * Which Space a route is about, as a query (`?space=<id>`, identity's `spaces.id`): absent means
 * the route's default (a member's own Space, preferring the primary; on the admin side the
 * primary). The server checks it (`packages/api/src/space-param.ts`: 404 for an unknown Space, 403
 * for one the member is not in). A route spreads it into its own query:
 * `query: z.object({ ...SpaceQuery.shape, limit: DigitsQuery.optional() })`, or `query: SpaceQuery`.
 */
export const SpaceQuery = z
  .object({ space: z.string().min(1).max(64).optional() })
  .meta({ id: "ApiSpaceQuery" });
export type SpaceQueryIn = z.input<typeof SpaceQuery>;
