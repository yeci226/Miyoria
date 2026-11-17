// GPU leases between the services of one machine and its hostd (docs/design/v5-gpu.md §12).
//
// The song worker is the one holder today. It asks before every GPU stage (`gpu.acquire`), checks
// in before every step of it (`gpu.renew` with `step`), reports how the stage ended (`gpu.renew`
// with `end`), asks whether speech is busy (`gpu.busy`), and gives the card back (`gpu.release`).
// hostd decides, reads the card, takes the speech services offline and back. Durations are seconds,
// as the recorded decisions count them (workers/sing/gpu_decisions.json). Core tells hostd who
// listens with the `cluster.context` notification.

import { z } from "zod";

/**
 * A value the holder learned per card, by the card's name and size (`<name>/<total_mb>`, as
 * `gpu.state` shows it in `learned.device`). Only hostd reads the card, so the holder sends what it
 * knows for each card and hostd takes the entry of the card it reads; a card it has none for gets
 * hostd's prior.
 */
export const HostGpuByCardSchema = z.record(z.string(), z.number()).meta({ id: "HostGpuByCard" });
export type HostGpuByCard = z.output<typeof HostGpuByCardSchema>;

/** How hostd shares the card between speech and a song (`host.toml [gpu] policy`). */
export const HostGpuArbitrationSchema = z
  .enum(["yield", "auto", "share", "offload", "wait"])
  .meta({ id: "HostGpuArbitration" });
export type HostGpuArbitration = z.output<typeof HostGpuArbitrationSchema>;

/** `gpu.acquire`: may this stage run on the card now? Asked again every `check_s` while told to wait. */
export const HostGpuAcquireSchema = z
  .object({
    /** The holder's job: hostd counts its waits and keeps its window under this id; also the lease id. */
    job: z.string().min(1),
    stage: z.string().min(1),
    /** `share` never takes speech offline (a tenant that must not, like image generation). */
    mode: z.enum(["share", "exclusive"]).default("exclusive"),
    /** The lease: without a call for this long, hostd treats the holder as gone. */
    max_s: z.number().positive().default(60),
    reason: z.string().default(""),
    /** The stage is set to use the card. */
    on_gpu: z.boolean().default(true),
    /** The stage stops between steps while she speaks (not her RVC model). */
    pauses: z.boolean().default(true),
    /** What the stage needs, as the holder measured it on each card (hostd's prior on another). */
    need_mb: HostGpuByCardSchema.default({}),
    /** What the holder's process already holds of the card: counted as room. */
    own_mb: z.number().nonnegative().default(0),
    /**
     * The holder's estimate of the work left, without the reload, with the rates it starts from;
     * null without the audio's length.
     */
    est_work_s: z.number().nonnegative().nullable().default(null),
    /** The same with the rates it learned on each card. */
    est_work_by_card: HostGpuByCardSchema.default({}),
    /** Under `yield`, the stage goes to the CPU when there is no room (a Demucs separation). */
    cpu_fallback: z.boolean().default(false),
    /** Jobs queued behind this one: urgent when one of them is in Core's urgent list. */
    queued: z.array(z.string()).max(200).default([]),
    /** Core will be asked before speech goes offline (the job's `exclusive_ack`). */
    ack: z.boolean().default(false),
    /** The stage goes on from where it was let go of. */
    resumed: z.boolean().default(false),
    /** After `wait` with `announce`: she told everyone (or the holder stopped waiting); go ahead. */
    announced: z.boolean().default(false),
  })
  .meta({ id: "HostGpuAcquire" });
export type HostGpuAcquire = z.output<typeof HostGpuAcquireSchema>;

/** Run on the card: next to speech (`share`) or with speech offline (`exclusive`). */
export const HostGpuGrantedSchema = z
  .object({
    type: z.literal("granted"),
    lease: z.string(),
    mode: z.enum(["share", "exclusive"]),
    code: z.string(),
    reason: z.string(),
    /** The free VRAM the decision saw. */
    free_mb: z.number().nullable(),
    /** The speech services offloaded for this window, by base URL. */
    evicted: z.array(z.string()),
    /** Offloads that failed: the window opened without them. */
    errors: z.array(z.string()),
    /** What the offloads gave back, as the services measured it. */
    released_mb: z.number().nullable(),
    offload_s: z.number().nullable(),
  })
  .meta({ id: "HostGpuGranted" });
export type HostGpuGranted = z.output<typeof HostGpuGrantedSchema>;

/**
 * Not now. With `announce`, hostd has decided to take speech offline for this job: the holder
 * shows `exclusive: "waiting"`, lets Core announce it (or waits its own limit), then asks again
 * with `announced`; without it, the holder waits `check_s` and asks again.
 */
export const HostGpuWaitSchema = z
  .object({
    type: z.literal("wait"),
    code: z.string(),
    reason: z.string(),
    announce: z.boolean(),
    /** With `announce`: the services that will go offline, by base URL. */
    evict: z.array(z.string()),
  })
  .meta({ id: "HostGpuWait" });
export type HostGpuWait = z.output<typeof HostGpuWaitSchema>;

/** Run the stage on the CPU. */
export const HostGpuCpuSchema = z
  .object({ type: z.literal("cpu"), code: z.string(), reason: z.string() })
  .meta({ id: "HostGpuCpu" });
export type HostGpuCpu = z.output<typeof HostGpuCpuSchema>;

/** Never: the job fails with the reason. */
export const HostGpuRefusedSchema = z
  .object({ type: z.literal("refused"), code: z.string(), reason: z.string() })
  .meta({ id: "HostGpuRefused" });
export type HostGpuRefused = z.output<typeof HostGpuRefusedSchema>;

export const HostGpuAcquireResultSchema = z
  .discriminatedUnion("type", [
    HostGpuGrantedSchema,
    HostGpuWaitSchema,
    HostGpuCpuSchema,
    HostGpuRefusedSchema,
  ])
  .meta({ id: "HostGpuAcquireResult" });
export type HostGpuAcquireResult = z.output<typeof HostGpuAcquireResultSchema>;

/** How a stage run ended. */
export const HostGpuStageEndSchema = z
  .object({
    how: z.enum(["finished", "suspended", "oom"]),
    /** The median step time of the run. */
    step_s: z.number().nullable().default(null),
    /** The stage's normal step time on each card, as the holder knew it before this run. */
    normal_s: HostGpuByCardSchema.default({}),
  })
  .meta({ id: "HostGpuStageEnd" });
export type HostGpuStageEnd = z.output<typeof HostGpuStageEndSchema>;

/** Before a step: the last step times (at most three) and the stage's normal one. */
export const HostGpuStepSchema = z
  .object({
    recent_s: z.array(z.number()).max(3),
    /** The stage's normal step time on each card it has one for. */
    normal_s: HostGpuByCardSchema.default({}),
  })
  .meta({ id: "HostGpuStep" });
export type HostGpuStep = z.output<typeof HostGpuStepSchema>;

/**
 * `gpu.renew`: keeps the lease. With `step`, before every step of a stage on the card (hostd
 * checks the window's silence limit and the spill rules); with `end`, once when the stage run
 * ended. Without either, a plain keep-alive.
 */
export const HostGpuRenewSchema = z
  .object({
    lease: z.string().min(1),
    own_mb: z.number().nonnegative().default(0),
    queued: z.array(z.string()).max(200).default([]),
    step: HostGpuStepSchema.nullable().default(null),
    end: HostGpuStageEndSchema.nullable().default(null),
  })
  .meta({ id: "HostGpuRenew" });
export type HostGpuRenew = z.output<typeof HostGpuRenewSchema>;

/**
 * What to do before the next step: free the process's cache (`trim`), go on with fewer diffusion
 * steps (`reduce`, `steps`), open a window now (`offload`: as after a `wait` with `announce`), or
 * stop the stage, let go of the card and acquire again (`suspend`).
 */
export const HostGpuActionSchema = z
  .object({
    type: z.enum(["trim", "reduce", "offload", "suspend"]),
    code: z.string(),
    reason: z.string(),
    steps: z.number().int().nullable(),
  })
  .meta({ id: "HostGpuAction" });
export type HostGpuAction = z.output<typeof HostGpuActionSchema>;

export const HostGpuRenewResultSchema = z
  .object({
    /** False: hostd knows no such lease (it expired, or hostd restarted). */
    ok: z.boolean(),
    action: HostGpuActionSchema.nullable(),
    /** The holder starts its window of step times again. */
    clear_steps: z.boolean(),
    /**
     * After `end: finished`: the card the run was on (where the holder learns), how far its free
     * memory fell (a peak no torch counter sees), and whether the run's step time and rate count.
     */
    learned: z
      .object({
        card: z.string(),
        drop_mb: z.number(),
        note_step: z.boolean(),
        note_rate: z.boolean(),
      })
      .meta({ id: "HostGpuLearnedRun" })
      .nullable(),
    /** With an `offload` action: the services that will go offline. */
    evict: z.array(z.string()),
  })
  .meta({ id: "HostGpuRenewResult" });
export type HostGpuRenewResult = z.output<typeof HostGpuRenewResultSchema>;

/**
 * `gpu.release`: brings the speech this job took offline back and waits for it. `close` ends the
 * job's window, which starts the gap before the next one; `window: "keep"` leaves it open (the
 * song worker sent it after the conversion until 2026-11-16, and sends `close` since). `done`:
 * the job is over.
 */
export const HostGpuReleaseSchema = z
  .object({
    lease: z.string().min(1),
    window: z.enum(["keep", "close"]).default("close"),
    done: z.boolean().default(false),
  })
  .meta({ id: "HostGpuRelease" });
export type HostGpuRelease = z.output<typeof HostGpuReleaseSchema>;

/** One decision of a job, when its `mode`/`code` changed. */
export const HostGpuDecisionSchema = z
  .object({
    stage: z.string(),
    mode: z.string(),
    code: z.string(),
    reason: z.string(),
    free_mb: z.number().nullable(),
    need_mb: z.number().nullable(),
    people: z.boolean().nullable(),
    urgent: z.boolean().nullable(),
    step_s: z.number().nullable(),
    t: z.number(),
  })
  .meta({ id: "HostGpuDecision" });
export type HostGpuDecision = z.output<typeof HostGpuDecisionSchema>;

/**
 * One window of a job, once her voice is back: how long she was really silent (from the first
 * offload asked to the last reload done) next to the work time that `SING_SILENCE_MAX_S` bounds.
 * The limit does not count the offload and the reload, so the real silence is longer.
 */
export const HostGpuWindowSchema = z
  .object({
    offload_s: z.number(),
    /** From the window's opening to her voice being asked back: what the limit bounds. */
    work_s: z.number(),
    reload_s: z.number(),
    silence_s: z.number(),
    /** The limit, when it applied (people could hear); null when nobody listened. */
    limit_s: z.number().nullable(),
  })
  .meta({ id: "HostGpuWindow" });
export type HostGpuWindow = z.output<typeof HostGpuWindowSchema>;

/** What stays with the song: the job's decisions and what it cost. */
export const HostGpuJobSummarySchema = z
  .object({
    policy: HostGpuArbitrationSchema,
    policy_source: z.string(),
    decisions: z.array(HostGpuDecisionSchema),
    spills: z.number().int(),
    /** Diffusion steps it was cut down to, if any. */
    steps: z.number().int().nullable(),
    waited_s: z.number(),
    silenced_s: z.number(),
    /** Each window, in order (added 2026-11-16). */
    windows: z.array(HostGpuWindowSchema).default([]),
  })
  .meta({ id: "HostGpuJobSummary" });
export type HostGpuJobSummary = z.output<typeof HostGpuJobSummarySchema>;

export const HostGpuReleaseResultSchema = z
  .object({
    reloaded: z.array(z.string()),
    errors: z.array(z.string()),
    reload_s: z.number().nullable(),
    /** The window was open and is closed now. */
    closed: z.boolean(),
    /** With `done`: the job's summary. */
    summary: HostGpuJobSummarySchema.nullable(),
    /** The window this call closed (added 2026-11-16). */
    window: HostGpuWindowSchema.nullable().default(null),
  })
  .meta({ id: "HostGpuReleaseResult" });
export type HostGpuReleaseResult = z.output<typeof HostGpuReleaseResultSchema>;

/** `gpu.busy`: is speech busy now (cached, polled every 100 ms while a job holds a lease)? */
export const HostGpuBusySchema = z.object({ lease: z.string().min(1) }).meta({ id: "HostGpuBusy" });
export type HostGpuBusy = z.output<typeof HostGpuBusySchema>;

export const HostGpuBusyResultSchema = z
  .object({
    busy: z.boolean(),
    /** How long in total the job may give way to her. */
    allowance_s: z.number(),
  })
  .meta({ id: "HostGpuBusyResult" });
export type HostGpuBusyResult = z.output<typeof HostGpuBusyResultSchema>;

/** One job holding a lease, for `gpu.state`. */
export const HostGpuJobStateSchema = z
  .object({
    lease: z.string(),
    holder: z.string(),
    stage: z.string(),
    mode: z.string().nullable(),
    code: z.string().nullable(),
    reason: z.string().nullable(),
    window: z.boolean(),
    /** The speech services' state for this job: offloading · active · reloading · done, or null. */
    eviction: z.enum(["offloading", "active", "reloading", "done"]).nullable(),
    spills: z.number().int(),
    steps: z.number().int().nullable(),
    waited_s: z.number(),
    silenced_s: z.number(),
  })
  .meta({ id: "HostGpuJobState" });
export type HostGpuJobState = z.output<typeof HostGpuJobStateSchema>;

/** `gpu.state` takes no params. */
export const HostGpuStateParamsSchema = z.object({}).meta({ id: "HostGpuStateParams" });
export type HostGpuStateParams = z.output<typeof HostGpuStateParamsSchema>;

export const HostGpuStateSchema = z
  .object({
    policy: HostGpuArbitrationSchema,
    policy_source: z.string(),
    cuda: z.boolean().nullable(),
    total_mb: z.number().nullable(),
    free_mb: z.number().nullable(),
    headroom_mb: z.number(),
    /** Until a window may open again. */
    gap_s: z.number(),
    busy: z.boolean(),
    audience: z
      .object({
        in_voice: z.boolean(),
        listeners: z.number().int(),
        live: z.boolean(),
        age_s: z.number().nullable(),
        fresh: z.boolean(),
      })
      .meta({ id: "HostGpuAudience" }),
    learned: z
      .object({
        device: z.string(),
        headroom_mb: z.number().nullable(),
        freed_mb: z.number().nullable(),
        reload_s: z.number().nullable(),
        spills: z.number().int(),
      })
      .meta({ id: "HostGpuLearned" }),
    jobs: z.array(HostGpuJobStateSchema),
  })
  .meta({ id: "HostGpuState" });
export type HostGpuState = z.output<typeof HostGpuStateSchema>;

/** `cluster.context`, Core → hostd: who would notice her voice going, which songs are needed now. */
export const HostClusterContextSchema = z
  .object({
    in_voice: z.boolean().default(false),
    listeners: z.number().int().nonnegative().default(0),
    live: z.boolean().default(false),
    /** Jobs of songs that are needed now (asked by command or the queue). */
    urgent: z.array(z.string()).max(200).default([]),
  })
  .meta({ id: "HostClusterContext" });
export type HostClusterContext = z.output<typeof HostClusterContextSchema>;
