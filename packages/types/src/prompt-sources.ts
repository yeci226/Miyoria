// What the main line's prompt reads from modules it does not depend on (docs/design/v4-plan.md
// §4.1): the index of her skills and whether a party game is running where she talks. Each module
// provides its key next to its own service, so the agent never imports the package.

import type { ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";

/** Her skills as the prompt shows them. Provided by the `skills` module (its `SkillStore`). */
export interface SkillIndex {
  /**
   * Names and one-line descriptions, never the bodies, at most about `maxChars` characters and
   * already inside a data block (she wrote them, but they may echo what others said); `""` when
   * she has none.
   */
  index(maxChars?: number): Promise<string>;
}

export const SkillIndexKey = serviceKey<SkillIndex>("SkillIndex");

/** A party game running in one voice channel. */
export interface PartyGameStatus {
  /** The game's id (`quiz`, `song`, `chain`, `soup`). */
  game: string;
  /** Its name as people know it (`問答`). */
  title: string;
}

/** Provided by the `party` module. */
export interface PartyStatus {
  /** The game in `context` (a voice channel, or its text chat), `null` when none runs. */
  running(context: ContextKey): PartyGameStatus | null;
}

export const PartyStatusKey = serviceKey<PartyStatus>("PartyStatus");
