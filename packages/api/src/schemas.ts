// Zod schemas of the shared wire types that arrive in request bodies.

import { ContextKeySchema as WireContextKeySchema } from "@miyoria/contracts/wire";
import type { AuthScope } from "@miyoria/store";
import { type ContextKey, contextKeyEquals } from "@miyoria/types";
import { z } from "zod";

export { AccountRefSchema } from "@miyoria/contracts/wire";

/** A context in a request body: a client may leave `scope` out, which means a DM (`null`). */
export const ContextKeySchema = WireContextKeySchema.extend({
  scope: z.string().nullable().default(null),
});

export const AuthScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }),
  z.object({ type: z.literal("guild"), platform: z.string(), guild: z.string() }),
  z.object({ type: z.literal("channel"), context: ContextKeySchema }),
]);

export function scopeEquals(a: AuthScope, b: AuthScope): boolean {
  switch (a.type) {
    case "global":
      return b.type === "global";
    case "guild":
      return b.type === "guild" && a.platform === b.platform && a.guild === b.guild;
    case "channel":
      return b.type === "channel" && contextKeyEquals(a.context, b.context as ContextKey);
  }
}
