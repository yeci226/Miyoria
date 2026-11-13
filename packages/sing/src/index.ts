// @miyoria/sing: module `sing`, song requests sung in her voice (AI covers from the song
// worker `workers/sing`): set list, the gate's `sing.*` capabilities, `/queue song ...`, the
// prompt section, and playback through the voice node with lyrics and lip sync.

export { singCapabilities } from "./actions.js";
export {
  type GpuContext,
  type GpuStatus,
  HttpSingWorker,
  type LyricLine,
  type SingWorker,
  SingWorkerError,
  type SongMeta,
  SongMetaSchema,
  type SongQuery,
  type SongTrack,
  type WorkerJob,
  WorkerJobSchema,
} from "./client.js";
export { type ClipDeps, clipStartOf, SingClips, sliceClip } from "./clips.js";
export { backingOf, listCard, registerCommands } from "./commands.js";
export {
  defaultSingConfig,
  type SingConfig,
  SingConfigSchema,
  type SingPermissions,
  SingPermissionsSchema,
} from "./config.js";
export { type FailoverOptions, FailoverSingWorker } from "./failover.js";
export {
  type CardView,
  LyricsCard,
  type LyricsCardDeps,
  MIN_EDIT_MS,
  PROGRESS_MS,
  renderCard,
} from "./lyrics-card.js";
export { SingerKey, SingModule } from "./module.js";
export {
  dedicationProblem,
  MAX_DEDICATION_CHARS,
  type SongCharge,
  type SongPaidItem,
  type SongPayments,
  SongPaymentsKey,
} from "./payments.js";
export { paced, singSong, sleep, songBeats, songVideoPath } from "./player.js";
export { PROMPT_KEY, SingPrompt } from "./prompt.js";
export {
  BACKING_LABELS,
  BACKING_MODES,
  type BackingMode,
  dedicationNote,
  type NewSong,
  SetList,
  SetListError,
  type SongEntry,
  type SongNo,
  type SongState,
  songLabel,
} from "./setlist.js";
export {
  REASONS,
  SETLIST_KEY,
  SingError,
  Singer,
  type SkipVote,
  type SongRequest,
  skipVotesNeeded,
  workerQuery,
} from "./singer.js";
export { KEY_RANGE, parseSongPatch, type SongPatch, songNo, songTask } from "./steer.js";
