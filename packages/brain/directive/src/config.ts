// `[modules.directive]`: how far the rules of people below the owner reach. What the rules are is
// not configured here: they live in the store and change through the main line, `/miyo`, `/admin`
// and the panel.

import { z } from "zod";

const minutes = () => z.number().int().positive();

/**
 * ```toml
 * [modules.directive]
 * viewer_ttl_mins = 10
 * moderator_max_mins = 1440
 * ```
 */
export const DirectiveConfigSchema = z.object({
  /** How long what a viewer asked for lasts, whatever they said. */
  viewer_ttl_mins: minutes().default(10),
  /** The longest rule a moderator can make; a longer one is cut to this. */
  moderator_max_mins: minutes().default(1440),
  /** How many viewer requests may be open at once (one each). */
  max_viewer_wishes: z.number().int().nonnegative().default(5),
  /** How often the rules are read again, so a broken store shows in `inject` and `filterTools`. */
  refresh_secs: z.number().int().positive().default(30),
  /** How long a rule that ended stays visible in the panel. */
  history_days: z.number().int().positive().default(30),
});
export type DirectiveConfig = z.output<typeof DirectiveConfigSchema>;

export function defaultDirectiveConfig(): DirectiveConfig {
  return DirectiveConfigSchema.parse({});
}
