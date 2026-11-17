// @miyoria/memory/world: what she perceives (docs/design/autonomy.md §3).
//
// Module `WorldModule` (`world`) keeps a snapshot of the world from the bus: presence, voice
// states and members published by platform modules (`platform.presence`,
// `platform.voice_state`, `platform.member`), channel activity from messages, her own voice /
// Stage / Go Live / game status and the local time. It provides `WorldStateKey` (snapshot,
// per-person lookups, a prompt summary) and `PresencePrivacyKey` (`/me privacy`), adds the
// `world` prompt section and publishes `world.salient` for changes picked by cheap rules,
// coalesced and rate limited.

export { type WorldConfig, WorldConfigSchema, worldConfig } from "./config.js";
export { NO_SIGNALS, oneLine, type Signals, WorldEngine } from "./engine.js";
export { handle, WorldModule, type WorldModuleOptions, WorldView } from "./module.js";
export {
  parseGolive,
  parseMember,
  parsePresence,
  parseStageStatus,
  parseVoiceState,
} from "./parse.js";
export { PrivacyBook } from "./privacy.js";
export { WORLD_NOTE, WorldPrompt } from "./prompt.js";
export { type Candidate, Salience, type SalienceOptions } from "./salience.js";
export { durationText, partOfDay, timeContext, weekdayName } from "./time.js";
export { topicWords } from "./topic.js";
