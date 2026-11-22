// Updating a host from Core (docs/design/v5-hostd.md §14): what a host says about its checkout,
// whether it takes updates from Core, and the one update job it runs at a time.
//
// Core never sends a command. `host.upgrade` names a commit; the host runs its own fixed sequence
// (fetch its tracked remote, fast-forward, install, restart) and reports each step in
// `host.report`. Every field here is optional in the report, so an older daemon simply has none.

import { z } from "zod";

/** A full commit id: 40 lower-case hex digits. */
export const HostCommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/u, "a full 40-character commit id")
  .meta({ id: "HostCommit" });

/** The git checkout the host runs from, read from the local repository only (no network). */
export const HostCheckoutSchema = z
  .object({
    /** `HEAD`. */
    commit: HostCommitSchema,
    /** The branch `HEAD` is on; `null` when it is detached. */
    branch: z.string().nullable(),
    /** The branch's upstream (`origin/main`); `null` when it tracks none. */
    upstream: z.string().nullable(),
    /** Commits on the upstream ref that `HEAD` lacks, as of the last fetch; `null` without one. */
    behind: z.number().int().nonnegative().nullable(),
    /** Commits on `HEAD` that the upstream ref lacks. */
    ahead: z.number().int().nonnegative().nullable(),
    /** Tracked files have changes that are not committed. */
    dirty: z.boolean(),
    /** Epoch ms of the last fetch (`FETCH_HEAD`); `null` when it never fetched. */
    fetched_at: z.number().nullable(),
    /** Epoch ms of this reading. */
    read_at: z.number(),
  })
  .meta({ id: "HostCheckout" });
export type HostCheckout = z.output<typeof HostCheckoutSchema>;

/**
 * Whether this host takes `host.upgrade` from Core: `host.toml [update] allow_remote` (default
 * `true`), and only
 * on a git checkout that is not Core's own machine. `reason` says why not, in words for the panel.
 */
export const HostRemoteUpdateSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.string().optional(),
  })
  .meta({ id: "HostRemoteUpdate" });
export type HostRemoteUpdate = z.output<typeof HostRemoteUpdateSchema>;

/** `host.upgrade` params. */
export const HostUpgradeSchema = z
  .object({
    /** The commit to end on. It must be on the host's own tracked upstream branch. */
    commit: HostCommitSchema,
    /** How long the host may wait for a running job (a song being made) to end. Default 1800. */
    wait_s: z.number().int().min(0).max(21_600).optional(),
    /** Who asked, for the host's log. */
    by: z.string().max(200).optional(),
  })
  .meta({ id: "HostUpgrade" });
export type HostUpgrade = z.output<typeof HostUpgradeSchema>;

/** The steps of an update, in the order they run. */
export const HostUpgradeStepNameSchema = z
  .enum([
    /** Not opted out, git checkout, branch, upstream, clean tree. No network. */
    "check",
    /** `git fetch` of the tracked remote, then the commit is looked at. */
    "fetch",
    /** Waits while a job runs (a song being made, singing, live). */
    "wait",
    /** `git merge --ff-only <commit>`. */
    "merge",
    /** `pnpm install --frozen-lockfile`, when the lockfile or a package.json changed. */
    "install",
    /** `uv sync` of the Python environments whose lock or extras changed. */
    "sync",
    /** Restarts the services that changed. */
    "restart",
    /** Waits for the restarted services to be healthy, and checks the model files. */
    "verify",
    /** A step failed after the merge: back to the commit before. */
    "rollback",
  ])
  .meta({ id: "HostUpgradeStepName" });
export type HostUpgradeStepName = z.output<typeof HostUpgradeStepNameSchema>;

export const HostUpgradeStepSchema = z
  .object({
    step: HostUpgradeStepNameSchema,
    state: z.enum(["running", "done", "failed", "skipped"]),
    /** What happened, in words. */
    detail: z.string().optional(),
    /** Epoch ms. */
    at: z.number(),
  })
  .meta({ id: "HostUpgradeStep" });
export type HostUpgradeStep = z.output<typeof HostUpgradeStepSchema>;

/** Something a service of the host needs that an update never downloads. */
export const HostUpgradeMissingSchema = z
  .object({
    service: z.string(),
    kind: z.enum(["file", "model", "manual"]),
    /** The path, the model repo, or what to place. */
    what: z.string(),
  })
  .meta({ id: "HostUpgradeMissing" });
export type HostUpgradeMissing = z.output<typeof HostUpgradeMissingSchema>;

/** One update job: the last one stays in the report after it ended. */
export const HostUpgradeJobSchema = z
  .object({
    id: z.string(),
    /** The commit asked for. */
    target: HostCommitSchema,
    /** `HEAD` when the job started; `null` when it could not be read. */
    from: HostCommitSchema.nullable(),
    state: z.enum(["waiting", "running", "done", "failed", "refused", "cancelled"]),
    /** The step running now, or the last one. */
    step: HostUpgradeStepNameSchema,
    steps: z.array(HostUpgradeStepSchema),
    /** While `waiting`: what it waits for. */
    waiting_for: z.string().optional(),
    by: z.string().optional(),
    /** Epoch ms. */
    started_at: z.number(),
    finished_at: z.number().optional(),
    /** Why it failed or was refused. */
    error: z.string().optional(),
    /** `HEAD` when the job ended. */
    commit: HostCommitSchema.nullable().optional(),
    /** It went back to `from` after a failure. */
    rolled_back: z.boolean().optional(),
    restarted: z.array(z.string()).optional(),
    /** Services that run the old code still, with why. */
    not_restarted: z.array(z.object({ service: z.string(), reason: z.string() })).optional(),
    /** Services that did not come back healthy. */
    failed: z.array(z.object({ service: z.string(), reason: z.string() })).optional(),
    missing: z.array(HostUpgradeMissingSchema).optional(),
    /** What the host's owner should know (hostd itself runs the old code until it restarts). */
    notes: z.array(z.string()).optional(),
  })
  .meta({ id: "HostUpgradeJob" });
export type HostUpgradeJob = z.output<typeof HostUpgradeJobSchema>;

/** `host.upgrade_cancel` result: the job, cancelled when it had not changed anything yet. */
export const HostUpgradeCancelResultSchema = z
  .object({ cancelled: z.boolean(), job: HostUpgradeJobSchema.nullable() })
  .meta({ id: "HostUpgradeCancelResult" });
export type HostUpgradeCancelResult = z.output<typeof HostUpgradeCancelResultSchema>;
