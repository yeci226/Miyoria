import type { ModerationBlockRecord } from "@miyoria/types";
import { Moderation, type ModerationConfig, ModerationConfigSchema } from "../src/index.js";

/** A service with the default config (plus overrides) that collects its block records. */
export function make(config: Record<string, unknown> = {}) {
  const blocks: ModerationBlockRecord[] = [];
  const failures: { provider: string; reason: string }[] = [];
  const parsed: ModerationConfig = ModerationConfigSchema.parse(config);
  const moderation = new Moderation({
    config: parsed,
    onBlock: (record) => blocks.push(record),
    onProviderFailure: (provider, reason) => failures.push({ provider, reason }),
  });
  return { moderation, blocks, failures, config: parsed };
}

/** Secret-looking strings are built here, so no realistic key sits in the source. */
export const fake = {
  openai: () => `sk-${"aB3dE6gH9jK2mN5pQ8".repeat(2)}`,
  github: () => `ghp_${"A1b2C3d4E5".repeat(4)}`,
  slack: () => `xoxb-${"1234567890"}-${"abcdefghij"}`,
  aws: () => `AKIA${"ABCDEFGHIJKLMNOP"}`,
  jwt: () => `eyJ${"hbGciOiJIUzI1"}.eyJ${"zdWIiOiIxMjM0"}.${"SflKxwRJSMeKKF2QT4"}`,
  discord: () => `${"MTA1MjU5NzQ1NzY5NjEyMTU3"}.${"GabcDE"}.${"abcdefghijklmnopqrstuvwxyz0"}`,
  admin: () => "9f3c1a7d5b2e4f60a8c1d3e5f7091b2c4d6e8f0a1b3c5d7e9f",
};
