import { serviceKey } from "@miyoria/types";
import { z } from "zod";
import type { Removed, WorkspaceApi } from "./workspace-store.js";

/** Languages the sandbox runs. */
export const LANGUAGES = ["python", "node"] as const;
export type Language = (typeof LANGUAGES)[number];
export const LanguageSchema = z.enum(LANGUAGES);

/**
 * Network policy of a run: `"none"` (`--network none`: no interfaces but loopback) or an
 * allowlist, which only works when the owner listed hosts in `[modules.sandbox.network]`
 * (otherwise `run` refuses it with `network_unsupported`) and goes through the egress proxy
 * (see `egress.ts`).
 */
export type NetworkPolicy = "none" | { allow: string[] };
export const NetworkPolicySchema = z.union([
  z.literal("none"),
  z.object({ allow: z.array(z.string().min(1).max(253)).max(32) }),
]);

/** `RunRequest.session` for a throwaway container (the default). */
export const FRESH = "fresh";

/** Session names (same rule as script and tool names; `fresh` means no session). */
export const SESSION_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
export const SessionChoiceSchema = z.union([
  z.literal(FRESH),
  z.string().regex(SESSION_NAME, "`fresh` or a session name (a-z, 0-9, `_`, `-`)"),
]);

/** A file written into `/work` before the run. */
export interface FileIn {
  /** Relative POSIX path inside `/work` (`data/input.csv`). See `normalizeRelativePath`. */
  path: string;
  content: string;
  /** How `content` is encoded. Default `utf8`. */
  encoding?: "utf8" | "base64";
}

export const FileInSchema = z.object({
  path: z.string().min(1).max(255),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

/** What `Sandbox.run` takes (an in-process option bag; validated with `RunRequestSchema`). */
export interface RunRequest {
  language: Language;
  /** The program: `/code/main.py` or `/code/main.mjs`, mounted read-only. */
  code: string;
  files?: FileIn[];
  stdin?: string;
  /** Wall-clock limit; default and maximum come from the config. */
  timeout_ms?: number;
  /**
   * Default `"none"`. `{ allow }` needs `[modules.sandbox.network] allow` to list every host
   * named; the run then gets the egress proxy as its only way out, which lets through all the
   * configured hosts (not only the ones named). Fresh runs only.
   */
  network?: NetworkPolicy;
  /** Mount the profile's tools workspace read-only at `/tools`. Default `false`. */
  mount_tools?: boolean;
  /**
   * Mount her persistent workspace read-write at `/workspace`. Default `false`. Fresh runs
   * only; what the program leaves there is checked against the quotas afterwards.
   */
  mount_workspace?: boolean;
  /**
   * `"fresh"` (default): a throwaway container. A name (`weather-tool`): the long-lived session
   * of that name, created by its first run; `/work` and `/tmp` carry over between its runs.
   * Sessions never mount `/tools`.
   */
  session?: string;
}

export const RunRequestSchema = z.object({
  language: LanguageSchema,
  code: z.string(),
  files: z.array(FileInSchema).optional(),
  stdin: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  network: NetworkPolicySchema.optional(),
  mount_tools: z.boolean().optional(),
  mount_workspace: z.boolean().optional(),
  session: SessionChoiceSchema.optional(),
});

/** Why the sandbox (not the program) ended a run. */
export type KilledReason =
  /** The wall-clock timeout passed; the container was killed. */
  | "timeout"
  /** The caller's signal aborted, or the sandbox shut down. */
  | "aborted"
  /** stdout + stderr passed `caps.kill_output_bytes`. */
  | "output_limit"
  /** Exit 137 without the sandbox killing it: almost always the memory limit (OOM killer). */
  | "memory";

/** A file the program left in `/work` (new, or changed from the input). */
export interface FileOut {
  path: string;
  size: number;
  /** `utf8` when the bytes are valid UTF-8, else `base64`. */
  encoding: "utf8" | "base64";
  content: string;
}

/** Why a session ended. */
export type SessionCloseReason =
  /** `closeSession` (she closed it). */
  | "closed"
  /** No run for `sessions.idle_minutes`. */
  | "idle"
  /** Older than `sessions.lifetime_minutes`. */
  | "lifetime"
  /** Its workspace grew over `sessions.disk_mb`. */
  | "disk"
  /** Its container went away (Docker restarted, or it died). */
  | "lost"
  /** The sandbox shut down. */
  | "shutdown";

/** What a run in a session says about the session. */
export interface SessionRun {
  name: string;
  /** This run started the session. */
  created: boolean;
  /** The session ended with this run (e.g. `disk`); its files are gone. */
  closed: SessionCloseReason | null;
}

/** A live session (`listSessions`). */
export interface SessionInfo {
  name: string;
  language: Language;
  /** Epoch ms. */
  created_at: number;
  last_used_at: number;
  runs: number;
  /** Bytes in its `/work` after the last run. */
  disk_bytes: number;
  /** Epoch ms when it closes unless used again (idle), or at the latest (lifetime). */
  expires_at: number;
  /** A run is in progress. */
  busy: boolean;
}

/** Result of one run (JSON shape: snake_case, every key present). */
export interface RunResult {
  run_id: string;
  language: Language;
  /** Exit code of the program; `null` when it never ran to an exit (e.g. aborted early). */
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  files_out: FileOut[];
  /** Some output files were left out (count or size caps, or unreadable entries). */
  files_out_truncated: boolean;
  /** Wall-clock time of the container run (image checks and pulls excluded). */
  duration_ms: number;
  killed_reason: KilledReason | null;
  /** The session the run used; `null` for a fresh run. */
  session: SessionRun | null;
  /**
   * Only on runs that mounted the workspace: what was removed from it afterwards because the
   * program broke a rule (a link) or a quota. Empty when everything stayed.
   */
  workspace_removed?: Removed[];
}

/** Whether Docker can be used. */
export interface SandboxHealth {
  available: boolean;
  /** Docker server (daemon) version when available. */
  server_version: string | null;
  /** Why it is not available. */
  error: string | null;
  /** Epoch ms of the check; `null` before the first one. */
  checked_at: number | null;
}

/** A script in the profile's tools workspace. */
export interface ScriptInfo {
  name: string;
  language: Language;
  /** File name inside the workspace (and inside `/tools` when mounted). */
  file: string;
  size: number;
}

export type SandboxErrorKind =
  /** Docker is not installed or not running. */
  | "unavailable"
  /** The sandbox was shut down. */
  | "closed"
  /** Too many runs waiting. */
  | "busy"
  /** The request is malformed or over a cap. */
  | "invalid_request"
  /** A file or script name is not a safe relative path. */
  | "invalid_path"
  /** Network allowlists are not implemented yet. */
  | "network_unsupported"
  /** The image is missing and could not be pulled. */
  | "image_unavailable"
  /** The Docker CLI failed before the program ran. */
  | "docker_failed"
  | "not_found"
  /** A proposed tool is not in the state the operation needs. */
  | "wrong_state"
  /** Too many scripts / proposed tools / sessions. */
  | "limit"
  /** The named session closed on its own (idle, lifetime, lost); the next run starts it anew. */
  | "session_closed";

/** Why a sandbox operation was refused. */
export class SandboxError extends Error {
  override readonly name = "SandboxError";

  constructor(
    readonly kind: SandboxErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const CLOSED_BECAUSE: Record<SessionCloseReason, string> = {
  closed: "it was closed",
  idle: "it was idle for too long",
  lifetime: "it reached its maximum lifetime",
  disk: "its workspace grew over the disk quota",
  lost: "its container went away",
  shutdown: "the sandbox shut down",
};

/** A run named a session that is gone (`session_closed`); the next run starts it anew. */
export class SessionClosedError extends SandboxError {
  constructor(
    readonly session: string,
    readonly reason: SessionCloseReason,
  ) {
    super(
      "session_closed",
      `session \`${session}\` is gone (${CLOSED_BECAUSE[reason]}); its files are gone too. ` +
        "Run again with that name to start a new, empty session.",
    );
  }
}

/**
 * Runs untrusted code in a disposable container, or in one of her named sessions. Provided by
 * module `sandbox`.
 */
export interface Sandbox {
  /** Runs one program. Throws `SandboxError` when it could not be run at all. */
  run(request: RunRequest, options?: { signal?: AbortSignal }): Promise<RunResult>;
  /** Her live sessions, oldest first. */
  listSessions(): Promise<SessionInfo[]>;
  /** Closes a session and deletes its files; `false` when there is none of that name. */
  closeSession(name: string): Promise<boolean>;
  /** Last known Docker availability (re-checked when older than `health_ttl_ms`). */
  health(options?: { signal?: AbortSignal; refresh?: boolean }): Promise<SandboxHealth>;
  /** The profile's persistent tools workspace. */
  readonly tools: ToolsWorkspaceApi;
  /** Her persistent workspace (`mount_workspace`); `null` when `[modules.sandbox.workspace]` is off. */
  readonly workspace: WorkspaceApi | null;
  /** Hosts a run may reach with `network: { allow }` (empty = the network is closed). */
  readonly networkAllow: readonly string[];
}

/** Scripts she keeps between runs (mounted read-only at `/tools` on request). */
export interface ToolsWorkspaceApi {
  list(): Promise<ScriptInfo[]>;
  read(name: string): Promise<{ info: ScriptInfo; code: string } | null>;
  save(name: string, language: Language, code: string): Promise<ScriptInfo>;
  remove(name: string): Promise<boolean>;
}

export const SandboxKey = serviceKey<Sandbox>("Sandbox");
