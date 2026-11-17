import { z } from "zod";
import { deviceMemoryFields, WorkersHealthSchema } from "./common.js";

// The answer to `POST /tts` is not JSON: streamed PCM s16le mono, rate in `x-sample-rate`
// (`WORKERS_SAMPLE_RATE_HEADER`), more in the other `WORKERS_TTS_*` headers.

/**
 * The body of `POST /tts`. A field that is left out and one that is `null` mean the same; the
 * TypeScript client leaves it out.
 */
export const WorkersTtsRequestSchema = z
  .object({
    text: z.string(),
    /** A name (`Chinese`) or a code (`zh`): the worker maps it. */
    language: z.string().nullable().optional(),
    /** Picks the reference clip of the voice bank when `TTS_VOICE_BANK=1`; otherwise information. */
    emotion: z.string().nullable().optional(),
    /** How to say it, in words; not honoured for cloned voices. */
    instruct: z.string().nullable().optional(),
    /** A voice registered in the worker; its default when left out. */
    voice: z.string().nullable().optional(),
    /** `now` (default) or `ahead`: `ahead` waits behind `now` for the GPU. Anything else counts as `now`. */
    priority: z.string().nullable().optional(),
  })
  .meta({ id: "WorkersTtsRequest" });
export type WorkersTtsRequest = z.output<typeof WorkersTtsRequestSchema>;

/** The body of `POST /offload` of the TTS worker: as the ASR one, with the wait for running utterances. */
export const WorkersTtsOffloadRequestSchema = z
  .object({
    reason: z.string().nullable().optional(),
    max_s: z.number().nullable().optional(),
    /** How long running utterances may finish before they are cut off; default `TTS_OFFLOAD_DRAIN_S` (15). */
    drain_s: z.number().nullable().optional(),
  })
  .meta({ id: "WorkersTtsOffloadRequest" });
export type WorkersTtsOffloadRequest = z.output<typeof WorkersTtsOffloadRequestSchema>;

/** One registered voice. */
export const WorkersTtsVoiceSchema = z
  .object({
    name: z.string(),
    ref_text: z.string().nullable(),
    /** No reference transcript: the speaker embedding alone is used. */
    x_vector_only: z.boolean(),
    /** Keys of the usable reference clips (`ref`, `ref.ja`, `bank/ja/happy`). */
    references: z.array(z.string()),
  })
  .meta({ id: "WorkersTtsVoice" });
export type WorkersTtsVoice = z.output<typeof WorkersTtsVoiceSchema>;

/** The answer to `GET /voices` (and `POST /voices/reload`). */
export const WorkersTtsVoicesSchema = z
  .object({
    /** `clone`, `custom_voice` or `voice_design`. */
    mode: z.string(),
    /** `TTS_DEFAULT_VOICE`. */
    default: z.string().nullable(),
    clone_mode: z.string(),
    voice_bank: z.boolean(),
    voices: z.array(WorkersTtsVoiceSchema),
  })
  .meta({ id: "WorkersTtsVoices" });
export type WorkersTtsVoices = z.output<typeof WorkersTtsVoicesSchema>;

/**
 * `GET /health` of the TTS worker. With the model in, every engine field is there; given up, only
 * `model`, `loading`, `released_mb`, the lease (`since`, `reason`, `reload_at`) and the memory.
 */
export const WorkersTtsHealthSchema = WorkersHealthSchema.extend({
  offloaded: z.boolean(),
  model: z.string().optional(),
  device: z.string().optional(),
  mode: z.string().optional(),
  /** Which engine: `transformers`, `faster`, ... */
  backend: z.string().optional(),
  sample_rate: z.number().int().optional(),
  /** `true`: audio per chunk inside a sentence; `false`: whole sentences. */
  streaming: z.boolean().optional(),
  /** Codec steps per chunk (the faster backend), else `null`. */
  chunk_size: z.number().int().nullable().optional(),
  stream_probe: z.array(z.string()).optional(),
  voices: z.array(z.string()).optional(),
  instruct_supported: z.boolean().optional(),
  clone_mode: z.string().optional(),
  voice_bank: z.boolean().optional(),
  /** What the device gave back at the last offload, in MB. */
  released_mb: z.number().nullable().optional(),
  /** Process id of the engine when it runs apart from the server. */
  engine_pid: z.number().int().nullable().optional(),
  loading: z.boolean().optional(),
  since: z.number().optional(),
  reason: z.string().optional(),
  reload_at: z.number().nullable().optional(),
  vram_allocated_mb: z.number().nullable().optional(),
  ...deviceMemoryFields,
}).meta({ id: "WorkersTtsHealth" });
export type WorkersTtsHealth = z.output<typeof WorkersTtsHealthSchema>;
