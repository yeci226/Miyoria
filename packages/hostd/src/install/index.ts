// Installing services into a host (docs/design/v5-hostd.md §9).
export {
  checkDownloadUrl,
  DOWNLOAD_HOSTS,
  DownloadError,
  type DownloadOptions,
  type DownloadOutcome,
  downloadFile,
  type Fetch,
  fileSha256,
  formatBytes,
  hostAllowed,
  IDLE_TIMEOUT_MS,
  MAX_REDIRECTS,
  RETRY_DELAYS_MS,
} from "./download.js";
export {
  adoptFile,
  adoptSource,
  bytesToFetch,
  type CheckMode,
  checkFiles,
  checkFilesQuick,
  type FileState,
  type FileStatus,
  fileDestIn,
  freeBytes,
  missingRequiredFiles,
  SPACE_MARGIN_BYTES,
  spaceProblem,
  VerifiedCache,
  verifiedCacheFile,
} from "./files.js";
export { hfCacheHas, hfCacheName, hfDir, hfRepoOf, hfRevisions } from "./hf.js";
export {
  type GcResult,
  gcModels,
  listModels,
  type ModelEntry,
  type ModelPullResult,
  type PullDeps,
  pullModels,
  sizeOf,
} from "./models.js";
export {
  type EnvironmentState,
  environmentState,
  INSTALL_RECORD_FILE,
  type InstallRecord,
  installSectionHash,
  lockHash,
  readInstallRecord,
} from "./record.js";
export {
  type CommandRunner,
  execaRunner,
  type RunHooks,
  type RunOutcome,
  type RunSpec,
} from "./run.js";
export {
  checkServiceFiles,
  envDirOf,
  extrasOf,
  fileDest,
  type Inspection,
  type InstallDeps,
  type InstallOptions,
  inspectService,
  installService,
  managedEnvDir,
  manualPath,
  type PresentFile,
  presentFileHashes,
  type RemoveResult,
  removeService,
  userEnvDir,
} from "./service.js";
export { onPath, systemHint, uvEnv, uvInstallHint, uvSyncArgs } from "./uv.js";
