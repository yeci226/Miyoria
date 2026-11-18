// The registry of bus topics: every event type that is published on the in-process bus today,
// named after its dotted topic, with the schema of the payload it is published with. The store's
// registry (`coreEventRegistry` in @miyoria/store) is a different list: what the event log
// records, some of it under other names (`facts.*`).
//
// Tests check every published event against it (`bus-check.ts`). Topics are added area by area
// (K12a in docs/design/v5-contracts.md); a topic missing here is reported as unregistered.

import { ACTIVITY_EVENTS } from "./activity.js";
import { AGENT_EVENTS } from "./agent.js";
import { ARBITER_EVENTS } from "./arbiter.js";
import { ArtifactShared } from "./artifact.js";
import { CHAT_EVENTS } from "./chat.js";
import { CLUSTER_EVENTS } from "./cluster.js";
import { DIRECTIVE_EVENTS } from "./directive.js";
import { ECONOMY_BUS_EVENTS } from "./economy-topics.js";
import { EVAL_EVENTS } from "./eval.js";
import { EXTENSION_EVENTS } from "./extension.js";
import { GATE_EVENTS } from "./gate.js";
import { HEART_EVENTS } from "./heart.js";
import { KARAOKE_BUS_EVENTS } from "./karaoke.js";
import { LlmBudget, LlmCall } from "./llm.js";
import { MEMORY_EVENTS } from "./memory.js";
import { PLATFORM_EVENTS } from "./platform.js";
import { PLAY_EVENTS } from "./play.js";
import { type AnyEventDefinition, EventRegistry } from "./registry.js";
import { SING_EVENTS } from "./sing.js";
import { STAGE_EVENTS } from "./stage.js";
import { SYSTEM_EVENTS } from "./system.js";
import { TASK_EVENTS } from "./task.js";
import { TURN_EVENTS } from "./turn.js";
import { VOICE_EVENTS } from "./voice.js";
import { WORKSPACE_EVENTS } from "./workspace.js";

/** Every bus topic with a payload schema, families included. */
export const BUS_EVENTS: readonly AnyEventDefinition[] = [
  // Platforms, voice and the kernel.
  ...CHAT_EVENTS,
  ...PLATFORM_EVENTS,
  ...VOICE_EVENTS,
  ...SYSTEM_EVENTS,
  // The brain.
  ...TURN_EVENTS,
  ...AGENT_EVENTS,
  ...TASK_EVENTS,
  ...ACTIVITY_EVENTS,
  ...ARBITER_EVENTS,
  ...DIRECTIVE_EVENTS,
  // Heart, memory, llm and gate.
  ...HEART_EVENTS,
  ...MEMORY_EVENTS,
  LlmCall,
  LlmBudget,
  ...GATE_EVENTS,
  ...ECONOMY_BUS_EVENTS,
  ...EXTENSION_EVENTS,
  ...WORKSPACE_EVENTS,
  ...SING_EVENTS,
  ...PLAY_EVENTS,
  ...KARAOKE_BUS_EVENTS,
  ...STAGE_EVENTS,
  ...CLUSTER_EVENTS,
  ...EVAL_EVENTS,
  // The artifact store writes its own lifecycle events to the log; only a hand-over is a topic.
  ArtifactShared,
];

/** A new registry holding `BUS_EVENTS`. */
export function busEventRegistry(): EventRegistry {
  return new EventRegistry().register(...BUS_EVENTS);
}
