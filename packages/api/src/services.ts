// Services the admin API looks up per request that other modules own. Their keys come from the
// owning packages (`PersonaHandleKey` from `@miyoria/brain/agent`, `PeopleDirectoryKey` from
// `@miyoria/heart/person`, `MemoryEngineKey` from `@miyoria/memory/memory`, `AuthServiceKey` from
// `@miyoria/auth`, `ExtensionCatalogKey` from `@miyoria/plugin-host/ext-host`, `McpStatusKey` from
// `@miyoria/plugin-host/mcp`, `RequestQueueKey` from `@miyoria/play/queue`, `StageLinkKey` from
// `@miyoria/stage`, `ProfileIdKey` from `@miyoria/types`).

import { ProfileIdKey } from "@miyoria/types";

/** Service: the active profile id (alias of `ProfileIdKey`). */
export const ActiveProfileKey = ProfileIdKey;

/** Module id of the MCP module (`McpModule.ID`). */
export const MCP_MODULE_ID = "mcp";

/** Whether a `@miyoria/play/queue` error is `QueueError::NotFound`. */
export function isQueueNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { kind?: unknown }).kind === "not_found") return true;
  return error instanceof Error && error.message.startsWith("no item #");
}
