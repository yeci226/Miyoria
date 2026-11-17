// `miyoria` package: the CLI. The library surface is exported for tests and embedding.

export { ClientError } from "@miyoria/api";
export { COMMANDS, type CommandSpec, checkArgs, helpText, main, parseArgs } from "./cli.js";
export { EnvFile, isEnvName, quoteEnvValue } from "./env-file.js";
export {
  CancelledError,
  ClackPrompter,
  DefaultsPrompter,
  isCancelled,
  type Prompter,
  type Reporter,
} from "./prompt.js";
export { display, envRefs, expand, isSecret, mask, maskUrl, singleRef } from "./refs.js";
export {
  formatKey,
  leaves,
  parseKey,
  parseValue,
  serializeValue,
  TomlDocument,
  TomlEditError,
  type TomlValue,
} from "./toml-patch.js";
export { type Change, renderChange, Workspace, WorkspaceError } from "./workspace.js";
