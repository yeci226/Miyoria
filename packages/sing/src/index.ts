// @miyoria/sing: module `sing`, song requests sung in her voice (AI covers from the song
// worker `workers/sing`): set list, the gate's `sing.*` capabilities, `/queue song ...`, the
// prompt section, and playback through the voice node with lyrics and lip sync.

export { singCapabilities } from "./actions.js";
export {
  audioKey,
  DiskSongAudio,
  type DiskSongAudioOptions,
  MemorySongAudio,
  SONG_ID,
  type SongAudio,
  SongAudioMissingError,
} from "./audio.js";
export {
  DEFAULT_STALL_MS,
  type GpuContext,
  HttpSingWorker,
  type HttpSingWorkerOptions,
  pcmOf,
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
  type SingConfig,
  SingConfigSchema,
  type SingPermissions,
  SingPermissionsSchema,
} from "./config.js";
export type { Endpoint, EndpointQuery, EndpointSource, EndpointsOption } from "./endpoints.js";
export { type FailoverEntry, type FailoverOptions, FailoverSingWorker } from "./failover.js";
export {
  downloadVideo,
  LOCAL_VIDEO_TIMEOUT_MS,
  type LocalVideoFetcher,
  type LocalVideoOptions,
  localVideoFetcher,
  songSourceUrl,
  spawnVideoProcess,
  type VideoProcess,
  type VideoSpawner,
  ytdlpArgs,
} from "./local-video.js";
export {
  type GpuContextSink,
  karaokeWorker,
  SingerKey,
  SingModule,
  type SingWorkerFactory,
  type SongAudioFactory,
  workerUrls,
} from "./module.js";
export { ensureVideo, paced, singSong, sleep, songBeats, songVideoPath } from "./player.js";
export { PROMPT_KEY, SingPrompt } from "./prompt.js";
export {
  BACKING_LABELS,
  BACKING_MODES,
  type BackingMode,
  type NewSong,
  SetList,
  SetListError,
  type SongEntry,
  type SongNo,
  type SongState,
  songGuild,
  songLabel,
} from "./setlist.js";
export {
  FETCH_ATTEMPTS,
  FETCH_STAGE,
  REASONS,
  REFUND_RETRY_MS,
  SETLIST_KEY,
  SingError,
  Singer,
  type SkipVote,
  SongPriorityError,
  type SongRequest,
  skipVotesNeeded,
  workerQuery,
} from "./singer.js";
export { KEY_RANGE, parseSongPatch, type SongPatch, songNo } from "./steer.js";
