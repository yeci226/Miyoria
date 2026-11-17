import { z } from "zod";
import { WorkersHealthSchema } from "./common.js";

// `POST /turn` takes raw PCM s16le mono at `WORKERS_TURN_SAMPLE_RATE`, rate in `x-sample-rate`
// (`WORKERS_SAMPLE_RATE_HEADER`). `WS /vad` is text frames: see `WORKERS_VAD_FRAME_SAMPLES`.

/** The answer to `POST /turn`: whether the speaker is done. */
export const WorkersTurnReplySchema = z
  .object({
    complete: z.boolean(),
    /** The model's probability that the turn is over, 0..1. */
    probability: z.number(),
    /** Inference time in ms. Always sent; a reader that does not use it never fails on it. */
    inference_ms: z.number().optional().catch(undefined),
  })
  .meta({ id: "WorkersTurnReply" });
export type WorkersTurnReply = z.output<typeof WorkersTurnReplySchema>;

/** `GET /health` of the end-of-turn worker. It answers `ok` without its models, and says which are missing. */
export const WorkersTurnHealthSchema = WorkersHealthSchema.extend({
  smart_turn: z.boolean(),
  silero: z.boolean(),
  /** `TURN_THRESHOLD`: from this probability on, `complete` is true. */
  threshold: z.number(),
  /** Why a model is not loaded, by name (`smart_turn`, `silero`). */
  errors: z.record(z.string(), z.string()),
}).meta({ id: "WorkersTurnHealth" });
export type WorkersTurnHealth = z.output<typeof WorkersTurnHealthSchema>;
