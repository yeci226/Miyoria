// Installing services into a host (docs/design/v5-hostd.md §9).
export {
  DOWNLOAD_HOSTS,
  DownloadError,
  type DownloadOptions,
  downloadFile,
  type Fetch,
  fileSha256,
} from "./download.js";
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
  type RemoveResult,
  removeService,
  userEnvDir,
} from "./service.js";
export { onPath, systemHint, uvEnv, uvInstallHint, uvSyncArgs } from "./uv.js";
