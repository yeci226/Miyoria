// The live page's feed and head-pats (module `live`, docs/design/v4-plan.md §9.2).

export {
  type LiveConfig,
  LiveConfigSchema,
  type LiveVideoConfig,
  LiveVideoConfigSchema,
} from "./config.js";
export { LIVE_TOPICS, LiveState, type LiveStateOptions, MAX_LINE_CHARS, placeOf } from "./feed.js";
export { LiveModule, type LiveModuleOptions, whoPats } from "./module.js";
export {
  PAT_BUCKET,
  PAT_KEY,
  PAT_SOURCE,
  PAT_WRITER,
  PatDesk,
  type PatDeskOptions,
  type PatObservation,
  type PatWho,
  Window,
} from "./pats.js";
export { isPublicPlace, mayShow, payloadContext, payloadTurn, type Screen } from "./privacy.js";
export { classify, VIDEO_SRC, VideoWatch, type VideoWatchOptions } from "./video.js";
