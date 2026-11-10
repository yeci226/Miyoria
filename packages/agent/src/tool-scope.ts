// Which tools a chat turn is offered, by what she is doing now (v2 §3.4 Converse): no game tools
// while she is just chatting, the running game's goal capability while a game runs, nothing to
// stop that is not running. The one source is the ActivityManager snapshot; without it, world's
// `her` status (or nothing: every tool stays, the behaviour before the ActivityManager).
//
// A game adapter's raw tools (`game_<id>_observe` / `_act`) are never offered, whatever the
// state: they live behind the gate (`GatedToolsKey`, W3) and only reach a turn through the
// gated `game.*` capabilities. A registry that still holds one (an old extension host) does not
// get it past this filter.

import { CapabilityTool, isGatedToolName } from "@miyoria/actions";
import type { Tool } from "@miyoria/tools";
import type { ActivitySnapshot, HerStatus } from "@miyoria/types";

/** What the scoping rules read of her state. */
export interface ToolScope {
  /** The game she is playing or starting (`null`: none). */
  game: string | null;
  singing: boolean;
  /** She is in (or joining) a voice channel. */
  inVoice: boolean;
  /** She is live (or going live). */
  live: boolean;
  /** Her game was closed and nobody here asked her to start one (`ArbiterKey.held`). */
  gameHeld?: boolean;
}

/** The scope from the ActivityManager snapshot. */
export function scopeOfSnapshot(snapshot: ActivitySnapshot): ToolScope {
  const a = snapshot.activity;
  const busy = a.type !== "idle" && (a.phase === "starting" || a.phase === "running");
  return {
    game: busy && a.type === "game" ? (a.target ?? "") : null,
    singing: busy && a.type === "singing",
    inVoice: snapshot.presence.type === "in" || snapshot.presence.type === "joining",
    live: snapshot.broadcast.type === "starting" || snapshot.broadcast.type === "live",
  };
}

/** The scope from world's `her` (no ActivityManager). */
export function scopeOfHer(her: HerStatus): ToolScope {
  return {
    game: her.game,
    singing: (her.singing ?? null) !== null,
    inVoice: her.voice !== null,
    live: her.golive === "live" || her.golive === "starting" || her.streaming,
  };
}

/**
 * Tools that only make sense in one state, by name: the game's goal and stop while a game runs,
 * stopping a song / the broadcast / leaving voice or setting its channel status while that is so. Tools not listed are offered
 * in every state (starting things, memory, code, ...).
 */
const NEEDS: Readonly<Record<string, (scope: ToolScope) => boolean>> = {
  game_goal: (s) => s.game !== null,
  game_start: (s) => s.gameHeld !== true,
  game_stop: (s) => s.game !== null,
  sing_stop: (s) => s.singing,
  stream_stop: (s) => s.live,
  voice_leave: (s) => s.inVoice,
  voice_status: (s) => s.inVoice,
};

/** A game adapter's raw tool that slipped into the registry (never a capability tool). */
export function isRawGameTool(tool: Tool): boolean {
  return isGatedToolName(tool.spec.name) && !(tool instanceof CapabilityTool);
}

/** Whether `tool` is offered in `scope` (`null`: her state is unknown, every tool is). */
export function offeredIn(tool: Tool, scope: ToolScope | null): boolean {
  if (isRawGameTool(tool)) return false;
  if (scope === null) return true;
  const needs = NEEDS[tool.spec.name];
  return needs === undefined || needs(scope);
}
