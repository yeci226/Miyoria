// Tools that are never offered to chat turns (v2 §1.4, stage 0 item 9).
//
// A game adapter's raw tools (`game_minecraft_observe`, `game_minecraft_act`, ...) can launch or
// quit the game and type in game chat. In the app's `ToolRegistry` every chat turn was offered
// them, past the gate, the autonomy pause, the rate limits and `sanitizeGameChat`. The extension
// host registers them here instead; only capabilities (behind the gate: `game.act`, the game
// director's observe step) look them up.

import type { ToolRegistry } from "@miyoria/tools";
import { serviceKey } from "@miyoria/types";

/** Provided by the extension host (`extensions` module) while it runs. */
export const GatedToolsKey = serviceKey<ToolRegistry>("GatedTools");

/** Registry tool names that are gated (a game adapter's `game_<id>_*`). */
export function isGatedToolName(name: string): boolean {
  return name.startsWith("game_");
}
