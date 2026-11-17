// @miyoria/llm/tools: tools the model may call during a turn.
//
// The app creates one `ToolRegistry` at boot and provides it as `ToolRegistryKey`; any module
// (memory, extensions, MCP, ...) may register and unregister tools at any time, and the gate
// registers each capability's tool in it. Every tool says what it does to the world (`ToolMeta`:
// effect, speed, risk, group). The agent offers the registered tools to the model and checks
// permissions against the user who triggered the turn, never against the model.

export type { ToolSpec } from "../../llm/src/index.js";
export {
  FIND_TOOLS,
  FIND_TOOLS_LIMIT,
  type FoundTool,
  findTools,
  firstSentence,
  searchTerms,
  searchTools,
  type ToolCatalog,
  type ToolListing,
  toolSession,
} from "./find.js";
export { LoadedTools, type LoadedToolsJson, LoadedToolsSchema } from "./loaded.js";
export {
  InvalidToolNameError,
  isValidToolName,
  type ToolEntry,
  ToolRegistry,
  ToolRegistryKey,
} from "./registry.js";
export {
  DEFAULT_TOOL_META,
  defineTool,
  TOOL_EFFECTS,
  TOOL_RISKS,
  TOOL_SPEEDS,
  type Tool,
  type ToolContext,
  type ToolDefinition,
  type ToolEffect,
  type ToolMeta,
  type ToolRefusalCode,
  type ToolResult,
  type ToolRisk,
  type ToolSpeed,
  toolParameters,
  toolSpec,
} from "./tool.js";
