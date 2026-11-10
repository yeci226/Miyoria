import { z } from "zod";

/**
 * An image reference the Docker CLI can never mistake for a flag: starts with a letter or digit,
 * then the characters of `name[:tag][@sha256:digest]`.
 */
export const IMAGE_REF = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/;

const image = z.string().regex(IMAGE_REF, "not a Docker image reference");

/** Image per language. Pin a digest (`python:3.12-slim@sha256:...`) for reproducible runs. */
export const SandboxImagesSchema = z.object({
  python: image.default("python:3.12-slim"),
  node: image.default("node:24-slim"),
});
export type SandboxImages = z.output<typeof SandboxImagesSchema>;

/** Resource limits of one container. */
export const SandboxLimitsSchema = z.object({
  /** `--memory` (and `--memory-swap`, so no swap), in MiB. */
  memory_mb: z.number().int().min(16).default(256),
  /** `--cpus`. */
  cpus: z.number().positive().default(1),
  /** `--pids-limit`: processes and threads inside the container. */
  pids_limit: z.number().int().min(8).default(128),
  /** Size of the `/tmp` tmpfs, in MiB. */
  tmpfs_mb: z.number().int().min(1).default(64),
  /** `--ulimit fsize`: largest file a process may write, in bytes. */
  max_file_size_bytes: z
    .number()
    .int()
    .min(1024)
    .default(16 * 1024 * 1024),
  /** `--ulimit nofile`: open files per process. */
  nofile: z.number().int().min(16).default(256),
});
export type SandboxLimits = z.output<typeof SandboxLimitsSchema>;

/** Size caps of what goes in and comes out of a run. */
export const SandboxCapsSchema = z.object({
  /** Longest program, in bytes (UTF-8). */
  max_code_bytes: z
    .number()
    .int()
    .min(1)
    .default(256 * 1024),
  /** Longest stdin, in bytes. */
  max_stdin_bytes: z
    .number()
    .int()
    .min(0)
    .default(1024 * 1024),
  /** Input files per run. */
  max_files_in: z.number().int().min(0).default(32),
  /** All input files together, in bytes. */
  max_files_in_bytes: z
    .number()
    .int()
    .min(0)
    .default(4 * 1024 * 1024),
  /** stdout and stderr kept, each, in bytes; the rest is dropped and marked truncated. */
  max_output_bytes: z
    .number()
    .int()
    .min(256)
    .default(64 * 1024),
  /**
   * The container is killed (`output_limit`) once stdout + stderr pass this many bytes, so a
   * print loop cannot keep the CPU and the pipe busy until the timeout.
   */
  kill_output_bytes: z
    .number()
    .int()
    .min(256)
    .default(8 * 1024 * 1024),
  /** Output files returned per run. */
  max_files_out: z.number().int().min(0).default(32),
  /** All returned output files together, in bytes. */
  max_files_out_bytes: z
    .number()
    .int()
    .min(0)
    .default(1024 * 1024),
});
export type SandboxCaps = z.output<typeof SandboxCapsSchema>;

/** Her named sessions: long-lived containers whose `/work` carries over between runs. */
export const SandboxSessionsSchema = z.object({
  /** Sessions open at once (per profile). 0 = no sessions. */
  max: z.number().int().min(0).default(3),
  /** A session closes after this many minutes without a run. */
  idle_minutes: z.number().positive().default(15),
  /** A session closes this many minutes after it started, however busy. */
  lifetime_minutes: z.number().positive().default(120),
  /** Largest `/work` of a session, in MiB; a run that leaves more closes the session. */
  disk_mb: z.number().int().min(1).default(256),
});
export type SandboxSessions = z.output<typeof SandboxSessionsSchema>;

/**
 * `[modules.sandbox.files]`: files people send her. The bytes are downloaded by Core (bounded,
 * allowlisted hosts) and only ever opened by the extractor inside a container.
 */
export const SandboxFilesSchema = z.object({
  enabled: z.boolean().default(true),
  /** Larger files are declined, from the size the platform reports and again while downloading. */
  max_bytes: z.number().int().min(1).default(2_500_000),
  /** Characters of extracted text she gets (the rest is cut and marked as cut). */
  max_chars: z.number().int().min(200).default(6000),
  /** Wall-clock limit of the extractor run, in milliseconds. */
  timeout_ms: z.number().int().min(1000).default(20_000),
  /** Time limit for downloading one file, in milliseconds. */
  download_timeout_ms: z.number().int().min(500).default(8000),
  /** Files are only downloaded from these hosts (the platform's CDN), over HTTPS. */
  allowed_hosts: z.array(z.string()).default(["cdn.discordapp.com", "media.discordapp.net"]),
  /** Files one person may have her read per `window_s` seconds. */
  per_person: z.number().int().min(0).default(4),
  /** Files everyone together may have her read per `window_s` seconds. */
  global: z.number().int().min(0).default(12),
  window_s: z.number().int().min(1).default(600),
  /** Extracted results kept in memory, by attachment id (a cached read costs no limit). */
  cache_entries: z.number().int().min(0).default(16),
});
export type SandboxFiles = z.output<typeof SandboxFilesSchema>;

/**
 * `[modules.sandbox]` config section. The module is opt-in: it only runs with
 * `enabled = true` (see the core's `OPT_IN_MODULES`).
 *
 * ```toml
 * [modules.sandbox]
 * enabled = true
 * root = "data/sandbox"
 * ```
 */
export const SandboxConfigSchema = z.object({
  /**
   * Directory for per-run workspaces (`runs/<run id>`), the per-profile tools workspace
   * (`profiles/<profile>/tools`) and session workspaces (`profiles/<profile>/sessions`). Relative paths resolve against the directory of
   * `miyoria.toml`.
   */
  root: z.string().min(1).default("data/sandbox"),
  /** Docker CLI executable (run directly, never through a shell). */
  docker: z.string().min(1).default("docker"),
  images: SandboxImagesSchema.prefault({}),
  /**
   * `--user` of the container. `"auto"` = the host uid:gid on Linux / macOS when that is not
   * root (so the host can clean up files the container wrote), `65534:65534` (nobody)
   * otherwise. Never `root` / `0`.
   */
  user: z
    .string()
    .regex(/^(auto|[1-9][0-9]{0,9}(:[1-9][0-9]{0,9})?)$/, "`auto` or a non-root uid[:gid]")
    .default("auto"),
  /** Timeout of a run that does not ask for one, in milliseconds. */
  default_timeout_ms: z.number().int().min(100).default(30_000),
  /** Longest timeout a run may ask for, in milliseconds. */
  max_timeout_ms: z.number().int().min(100).default(120_000),
  /** Runs at the same time. */
  max_concurrent: z.number().int().min(1).default(2),
  /** Runs waiting for a slot; more are refused (`busy`). */
  max_queued: z.number().int().min(0).default(8),
  /** Finished run workspaces kept on disk (their output files), newest first. 0 = none. */
  keep_runs: z.number().int().min(0).default(20),
  /** Longest image pull, in milliseconds (pulls happen before a run's clock starts). */
  pull_timeout_ms: z.number().int().min(1000).default(600_000),
  /** How long a `docker version` result is trusted, in milliseconds. */
  health_ttl_ms: z.number().int().min(0).default(30_000),
  limits: SandboxLimitsSchema.prefault({}),
  caps: SandboxCapsSchema.prefault({}),
  sessions: SandboxSessionsSchema.prefault({}),
  files: SandboxFilesSchema.prefault({}),
  /**
   * Started, idle containers kept ready per language image, so a fresh run skips the container
   * start. Each serves exactly one run, then it is destroyed and replaced. Default 0 (off):
   * no idle containers unless it is turned on.
   */
  pool_size: z.number().int().min(0).max(8).default(0),
  /** Scripts kept in the tools workspace per profile. */
  max_scripts: z.number().int().min(0).default(100),
  /** Proposed tools kept per profile (pending, approved and rejected). */
  max_proposed_tools: z.number().int().min(0).default(50),
  /**
   * Characters of a run's output (stdout + stderr, framed as untrusted data) she gets back from
   * `code.run` and her own tools. Keep it below `[modules.agent] max_tool_result_chars` (1000).
   */
  result_chars: z.number().int().min(200).default(900),
  /**
   * Timeout of one call of an approved tool she wrote, in milliseconds. Such a call is an
   * ordinary tool call, so keep it below `[modules.agent] tool_timeout_ms` (10 000).
   */
  tool_timeout_ms: z.number().int().min(100).default(8000),
  /** How often Docker is re-checked to offer or withdraw the capabilities, in milliseconds. */
  recheck_ms: z.number().int().min(1000).default(60_000),
});
export type SandboxConfig = z.output<typeof SandboxConfigSchema>;

/** Defaults of every field. */
export function defaultSandboxConfig(): SandboxConfig {
  return SandboxConfigSchema.parse({});
}
