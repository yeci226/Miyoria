// The admin routes for what V4 added: her life, economy 2.0, her workspace and skills, and the
// memory additions. One group, so the server registers one line.

import type { Route } from "./route.js";
import type { ApiState } from "./state.js";
import { economy2Routes } from "./v4-economy.js";
import { lifeRoutes } from "./v4-life.js";
import { memoryV4Routes } from "./v4-memory.js";
import { partyRoutes } from "./v4-party.js";
import { workspaceRoutes } from "./v4-workspace.js";

export function v4Routes(state: ApiState): Route[] {
  return [
    ...lifeRoutes(state),
    ...economy2Routes(state),
    ...workspaceRoutes(state),
    ...memoryV4Routes(state),
    ...partyRoutes(state),
  ];
}
