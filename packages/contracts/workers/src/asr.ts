import { z } from "zod";
import { deviceMemoryFields, WorkersHealthSchema } from "./common.js";

// `POST /asr` takes a multipart body: see `WORKERS_ASR_FORM_FIELDS`.

/**
 * The answer to `POST /asr`. The worker leaves a key out when the model does not know it
 * (SenseVoice reports `language`, `emotion` and `audio_events`, Qwen3-ASR none of them); a reader
 * takes a missing key and `null` alike.
 */
export const WorkersAsrReplySchema = z
  .object({
    text: z.string(),
    language: z.string().nullable().default(null),
    emotion: z.string().nullable().default(null),
    /** Non-speech events heard (laughter, applause, ...). */
    audio_events: z.array(z.string()).default([]),
    /** Length of the audio, in ms. Always sent; a reader that does not use it never fails on it. */
    duration_ms: z.number().optional().catch(undefined),
  })
  .meta({ id: "WorkersAsrReply" });
export type WorkersAsrReply = z.output<typeof WorkersAsrReplySchema>;

/** `GET /health` of the ASR worker. The model's own fields are there once it has loaded, and stay while it is given up. */
export const WorkersAsrHealthSchema = WorkersHealthSchema.extend({
  model: z.string().optional(),
  device: z.string().optional(),
  /** Which model family runs: `sensevoice` or `qwen3`. */
  backend: z.string().optional(),
  /** The model is given up (`POST /offload`). */
  offloaded: z.boolean(),
  /** A reload is under way. */
  loading: z.boolean(),
  /** What the device gave back at the last offload, in MB. */
  released_mb: z.number().nullable(),
  since: z.number().optional(),
  reason: z.string().optional(),
  reload_at: z.number().nullable().optional(),
  /** Allocated by the process (torch), in MB; left out without CUDA. */
  vram_allocated_mb: z.number().optional(),
  ...deviceMemoryFields,
}).meta({ id: "WorkersAsrHealth" });
export type WorkersAsrHealth = z.output<typeof WorkersAsrHealthSchema>;
