// Her workspace (docs/design/v5-contracts.md §3, K12a): image jobs and the code sandbox's tool
// proposals, runs, workspace checks and sessions. Each type is the bus topic it is published on,
// and its payload is that event's data. None of them carries code, output or a prompt: a proposed
// tool is named by its hash, a run by its exit and its size.
//
// Tiers (v5-data §2.5): all for the owner (`owner`). A tool she proposed and what the owner did
// with it is a permission decision: kept (`keep`). The rest is kept 90 days (`short`).

import { z } from "zod";
import { defineEvent } from "./registry.js";

export const ImageJobStateSchema = z
  .enum(["queued", "running", "done", "failed", "cancelled"])
  .meta({ id: "EventsImageJobState" });

/** An image job changed state: `imagegen.job`. `outputs` are file paths. */
export const ImageJobSchema = z
  .object({
    id: z.string(),
    purpose: z.string(),
    state: ImageJobStateSchema,
    /** 0..1 */
    progress: z.number(),
    error: z.string().nullable(),
    outputs: z.array(z.string()),
  })
  .meta({ id: "EventsImageJob" });
export type ImageJobData = z.output<typeof ImageJobSchema>;

export const SandboxLanguageSchema = z
  .enum(["python", "node"])
  .meta({ id: "EventsSandboxLanguage" });

/** A tool she proposed, or one the owner reviewed: `sandbox.tool.proposed`, `sandbox.tool.reviewed`. */
export const SandboxToolSchema = z
  .object({
    name: z.string(),
    /** Bumped on every (re-)proposal; a review names the version it decided. */
    version: z.number(),
    status: z.enum(["pending", "approved", "rejected"]),
    language: SandboxLanguageSchema,
    /** sha256 of the code (hex). */
    code_sha256: z.string(),
    /** `self`, or a requester id from the gate. */
    proposed_by: z.string().nullable(),
    /** Who approved or rejected it. */
    reviewer: z.string().nullable(),
  })
  .meta({ id: "EventsSandboxTool" });
export type SandboxToolData = z.output<typeof SandboxToolSchema>;

/** A proposed tool was deleted: `sandbox.tool.removed`. */
export const SandboxToolRemovedSchema = z
  .object({ name: z.string(), version: z.number() })
  .meta({ id: "EventsSandboxToolRemoved" });
export type SandboxToolRemovedData = z.output<typeof SandboxToolRemovedSchema>;

/** Why the sandbox (not the program) ended a run. */
export const SandboxKilledReasonSchema = z
  .enum(["timeout", "aborted", "output_limit", "memory"])
  .meta({ id: "EventsSandboxKilledReason" });

/** A run ended, without its code or output: `sandbox.run.finished`. */
export const SandboxRunFinishedSchema = z
  .object({
    run_id: z.string(),
    language: SandboxLanguageSchema,
    /** `null` when the program never ran to an exit (aborted early). */
    exit_code: z.number().nullable(),
    duration_ms: z.number(),
    killed_reason: SandboxKilledReasonSchema.nullable(),
    /** How many output files it left. */
    files_out: z.number(),
    /** The session the run used; `null` for a fresh run. */
    session: z.string().nullable(),
  })
  .meta({ id: "EventsSandboxRunFinished" });
export type SandboxRunFinishedData = z.output<typeof SandboxRunFinishedSchema>;

/** Files removed from the workspace after a run broke a rule: `sandbox.workspace.enforced`. */
export const SandboxWorkspaceEnforcedSchema = z
  .object({ run_id: z.string(), removed: z.number() })
  .meta({ id: "EventsSandboxWorkspaceEnforced" });
export type SandboxWorkspaceEnforcedData = z.output<typeof SandboxWorkspaceEnforcedSchema>;

/** A session started: `sandbox.session.started`. */
export const SandboxSessionStartedSchema = z
  .object({ name: z.string(), language: SandboxLanguageSchema })
  .meta({ id: "EventsSandboxSessionStarted" });
export type SandboxSessionStartedData = z.output<typeof SandboxSessionStartedSchema>;

/** Why a session ended. */
export const SandboxSessionCloseReasonSchema = z
  .enum(["closed", "idle", "lifetime", "disk", "lost", "shutdown"])
  .meta({ id: "EventsSandboxSessionCloseReason" });

/** A session ended: `sandbox.session.closed`. `runs`: how many runs it had. */
export const SandboxSessionClosedSchema = z
  .object({
    name: z.string(),
    reason: SandboxSessionCloseReasonSchema,
    runs: z.number(),
  })
  .meta({ id: "EventsSandboxSessionClosed" });
export type SandboxSessionClosedData = z.output<typeof SandboxSessionClosedSchema>;

export const ImagegenJob = defineEvent({
  type: "imagegen.job",
  v: 1,
  data: ImageJobSchema,
  scope: "owner",
  tier: "short",
});

export const SandboxToolProposed = defineEvent({
  type: "sandbox.tool.proposed",
  v: 1,
  data: SandboxToolSchema,
  scope: "owner",
  tier: "keep",
});

export const SandboxToolReviewed = defineEvent({
  type: "sandbox.tool.reviewed",
  v: 1,
  data: SandboxToolSchema,
  scope: "owner",
  tier: "keep",
});

export const SandboxToolRemoved = defineEvent({
  type: "sandbox.tool.removed",
  v: 1,
  data: SandboxToolRemovedSchema,
  scope: "owner",
  tier: "keep",
});

export const SandboxRunFinished = defineEvent({
  type: "sandbox.run.finished",
  v: 1,
  data: SandboxRunFinishedSchema,
  scope: "owner",
  tier: "short",
});

export const SandboxWorkspaceEnforced = defineEvent({
  type: "sandbox.workspace.enforced",
  v: 1,
  data: SandboxWorkspaceEnforcedSchema,
  scope: "owner",
  tier: "short",
});

export const SandboxSessionStarted = defineEvent({
  type: "sandbox.session.started",
  v: 1,
  data: SandboxSessionStartedSchema,
  scope: "owner",
  tier: "short",
});

export const SandboxSessionClosed = defineEvent({
  type: "sandbox.session.closed",
  v: 1,
  data: SandboxSessionClosedSchema,
  scope: "owner",
  tier: "short",
});

/** Every image job and sandbox type. */
export const WORKSPACE_EVENTS = [
  ImagegenJob,
  SandboxToolProposed,
  SandboxToolReviewed,
  SandboxToolRemoved,
  SandboxRunFinished,
  SandboxWorkspaceEnforced,
  SandboxSessionStarted,
  SandboxSessionClosed,
] as const;
