// Module `moderation`: provides `ModerationKey`. Blocks and non-plain input verdicts are
// published on the bus and logged without the text, so the log can be shown publicly.

import { defineManifest, type Module, type ModuleContext } from "@miyoria/kernel";
import {
  customEvent,
  type JsonValue,
  MODERATION_BLOCK_TOPIC,
  MODERATION_INPUT_TOPIC,
  ModerationKey,
} from "@miyoria/types";
import { type ModerationConfig, ModerationConfigSchema } from "./config.js";
import { Moderation } from "./service.js";

/** Environment variables whose values she must never say. */
const SECRET_ENV = /(?:^|_)(?:TOKEN|SECRET|API_?KEY|PASSWORD|PASSWD)$/i;

/** Values of secret-looking environment variables (long enough to protect). */
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= 12 && SECRET_ENV.test(name)) out.push(value);
  }
  return out;
}

export class ModerationModule implements Module {
  static readonly ID = "moderation";
  readonly manifest = defineManifest(ModerationModule.ID, "Moderation", {
    description: "Content safety: output review that does not depend on the model, input defence",
    configSchema: ModerationConfigSchema,
  });

  async start(ctx: ModuleContext): Promise<void> {
    const config: ModerationConfig = ctx.config(ModerationConfigSchema);
    const moderation = new Moderation({
      config,
      clock: ctx.clock,
      onBlock: (record) => {
        // The record names the rule and a keyed fingerprint, never the text.
        ctx.log.warn(
          {
            path: record.path,
            field: record.field,
            category: record.category,
            rule: record.rule,
            layer: record.layer,
            chars: record.chars,
            fingerprint: record.fingerprint,
          },
          "output blocked",
        );
        ctx.publish(customEvent(MODERATION_BLOCK_TOPIC, record as unknown as JsonValue), {
          turn: record.turn,
        });
      },
      onInput: (record) => {
        ctx.log.info(
          {
            source: record.source,
            author: record.author,
            action: record.action,
            flags: record.flags,
          },
          "input flagged",
        );
        ctx.publish(customEvent(MODERATION_INPUT_TOPIC, record as unknown as JsonValue));
      },
      onProviderFailure: (provider, reason) =>
        ctx.log.warn({ provider, reason }, "moderation provider failed"),
    });
    for (const problem of moderation.problems) ctx.log.warn(problem);
    if (config.protect_env) for (const value of secretsFromEnv()) moderation.protect(value);
    ctx.provide(ModerationKey, moderation);
    ctx.log.info({ rules: moderation.ruleCount }, "moderation running");
  }
}
