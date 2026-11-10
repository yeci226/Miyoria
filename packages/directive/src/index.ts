// @miyoria/directive: the owner's rules (docs/design/v3-architecture.md §9).
//
// * `DirectiveService` (`DirectivesKey`): the rules, who may change them and the three layers:
//   `inject` for the system block, `filterTools` for the tool list, `check` for the action path.
//   The app provides it with the store, so the rules hold whatever any module's state is.
// * `directive_add` / `directive_remove`: how the main line writes down what someone said.
// * `admin directive list | add | remove`: the commands behind `/miyo` and `/admin`.
// * Module `directive`: applies `[modules.directive]`, serves the tools and the commands, and
//   puts every background proposal through the rules.

export { NODE_ADD, NODE_REMOVE, NODE_VIEW, PATHS as COMMAND_PATHS } from "./commands.js";
export {
  type DirectiveConfig,
  DirectiveConfigSchema,
  defaultDirectiveConfig,
} from "./config.js";
export { covers, isStopping, normalizeTerm, type RuleAction, subjectsOf } from "./match.js";
export { DirectiveModule } from "./module.js";
export {
  DirectiveService,
  type DirectiveServiceOptions,
  NODE_MODERATE,
  NODE_OWNER,
  RULE_TOOLS,
  RULES_UNREADABLE,
} from "./service.js";
export { directiveTools } from "./tools.js";
