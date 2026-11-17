import { z } from "zod";

/** The body of every 4xx and 5xx a worker answers: HTTP status for the kind, this for the reason. */
export const WorkersErrorSchema = z.object({ error: z.string() }).meta({ id: "WorkersError" });
export type WorkersError = z.output<typeof WorkersErrorSchema>;

/**
 * What every `GET /health` has in common. `status` is `ok` whenever the worker answers (a worker
 * that has given its model up, or runs without one, is still `ok`); each worker adds its own
 * fields. The lyrics worker is the exception, see `WorkersLyricsHealthSchema`.
 */
export const WorkersHealthSchema = z.object({ status: z.string() }).meta({ id: "WorkersHealth" });
export type WorkersHealth = z.output<typeof WorkersHealthSchema>;

/** `GET /busy` (ASR, TTS): requests being handled now; the song worker uses it to make way. */
export const WorkersBusySchema = z
  .object({ busy: z.number().int().nonnegative() })
  .meta({ id: "WorkersBusy" });
export type WorkersBusy = z.output<typeof WorkersBusySchema>;

/** What the device reports, when the worker can read it (`workers/device_memory.py`). */
export const deviceMemoryFields = {
  device_total_mb: z.number().optional(),
  device_used_mb: z.number().optional(),
  device_free_mb: z.number().optional(),
};

/**
 * `POST /offload` (ASR, TTS): the model is given up so the song worker has the card. `drain_s`
 * only exists on TTS (`WorkersTtsOffloadRequestSchema`).
 */
export const WorkersOffloadRequestSchema = z
  .object({
    /** For the log and `/health`, cut to 80 characters. */
    reason: z.string().nullable().optional(),
    /** Lease: with nobody asking again, the worker loads itself back after this many seconds; 0 = never. Default from `ASR_OFFLOAD_MAX_S` / `TTS_OFFLOAD_MAX_S` (900). */
    max_s: z.number().nullable().optional(),
  })
  .meta({ id: "WorkersOffloadRequest" });
export type WorkersOffloadRequest = z.output<typeof WorkersOffloadRequestSchema>;

/** The answer to `POST /offload`. */
export const WorkersOffloadReplySchema = z
  .object({
    /** `offloaded`; `reloading` when a reload was under way that could not be stopped. */
    state: z.enum(["offloaded", "reloading"]),
    offload_ms: z.number(),
    /** The model was already gone: only the lease was renewed. */
    already: z.boolean().optional(),
    /** A reload under way was stopped. */
    cancelled_reload: z.boolean().optional(),
    /** TTS: the running utterances finished within `drain_s`. */
    drained: z.boolean().optional(),
    /** Allocated by the process (torch), in MB. */
    vram_before_mb: z.number().nullable().optional(),
    vram_after_mb: z.number().nullable().optional(),
    /** Measured on the device, so other programs moving in show up too; `null` when it cannot be read. */
    device_used_before_mb: z.number().nullable().optional(),
    device_used_after_mb: z.number().nullable().optional(),
    released_mb: z.number().nullable().optional(),
    /** With `already`: when, why and until when it was given up (epoch seconds). */
    since: z.number().optional(),
    reason: z.string().optional(),
    reload_at: z.number().nullable().optional(),
  })
  .meta({ id: "WorkersOffloadReply" });
export type WorkersOffloadReply = z.output<typeof WorkersOffloadReplySchema>;

/** The answer to `POST /reload` (ASR, TTS, no body). */
export const WorkersReloadReplySchema = z
  .object({
    /** `ready`; `offloaded` when an offload stopped the reload. */
    state: z.enum(["ready", "offloaded"]),
    reload_ms: z.number().optional(),
    /** The model was already there. */
    already: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    vram_mb: z.number().nullable().optional(),
    ...deviceMemoryFields,
  })
  .meta({ id: "WorkersReloadReply" });
export type WorkersReloadReply = z.output<typeof WorkersReloadReplySchema>;
