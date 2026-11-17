// @miyoria/gate/moderation: content safety (docs/design/v3-architecture.md §16).

export {
  type InputConfig,
  InputConfigSchema,
  type ModerationConfig,
  ModerationConfigSchema,
} from "./config.js";
export { DEFAULT_RULES } from "./default-rules.js";
export { InputGuard } from "./input.js";
export { ModerationModule, secretsFromEnv } from "./module.js";
export { type RuleDef, RuleSchema } from "./rules.js";
export { Moderation, type ModerationOptions } from "./service.js";
