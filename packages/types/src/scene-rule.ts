// The scene rule (docs/design/v2-architecture.md §3.2): `scene = f(presence, broadcast, activity,
// her override)`. The stage owns the mapping from situations to OBS scenes (scene roles, the
// starting / ending windows); it provides the rule so the ActivityManager can put the scene it
// picks into `ActivitySnapshot.scene`, and the stage's scene director switches OBS to the same
// answer. Nobody else decides scenes.

import type { ActivitySnapshot } from "./activity.js";
import { serviceKey } from "./service-key.js";

/** The parts of the snapshot the rule reads (everything but its own answer). */
export type SceneRuleInput = Omit<ActivitySnapshot, "scene">;

export interface SceneRule {
  /** The scene for `input` at `now` (epoch ms); `null`: no OBS, or no rule for the situation. */
  scene(input: SceneRuleInput, now: number): string | null;
}

/** Provided by `stage.link` while it runs. */
export const SceneRuleKey = serviceKey<SceneRule>("SceneRule");
