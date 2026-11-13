// The image generation service (`ImageGen`): checks and resolves requests, keeps the job queue,
// and runs one job at a time on ComfyUI (docs/design/imagegen.md).
//
// * Order: `interactive` jobs first, then `batch`, oldest first within each. Batch jobs only run
//   inside `batch_hours`; nothing runs while she sings or a song is prepared (when
//   `pause_while_singing`), and a batch job running when a song starts is interrupted and put
//   back (the attempt is not counted).
// * A job is queued on ComfyUI with a prompt id of our own and the id is saved before the run is
//   followed, so after a restart a job is picked up where ComfyUI is (finished, still running, or
//   lost and queued again) instead of being run twice.
// * ComfyUI unreachable: the job goes back to the queue and the queue waits (10 s, 20 s, ...)
//   until `max_attempts`; a graph ComfyUI refuses or a run that fails is not retried.
// * Pictures are copied from ComfyUI into `<output_dir>/<YYYY-MM>/<purpose>/<job>-<n>.png` with a
//   `<job>.json` sidecar holding the request and the exact graph, so any picture can be made
//   again.

import { randomInt, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { errorMessage, isAbortError, type Logger, sleep } from "@miyoria/kernel";
import {
  type Clock,
  customEvent,
  type Event,
  IMAGEGEN_TOPIC,
  type ImageGen,
  type ImageGenStatus,
  type ImageJob,
  type ImageJobEvent,
  type ImageJobFilter,
  type ImageModelInfo,
  type ImageOutput,
  type ImageRequest,
  type ImageRequestInput,
  type ImageSubmitOptions,
  type ImageWorkflowInfo,
  type JsonValue,
  newId,
  type SongCue,
  type SongPrepare,
  toTimestamp,
} from "@miyoria/types";
import { type ComfyClient, ComfyError, type ComfyGraph, type ComfyProgress } from "./comfy.js";
import { type ImageGenConfig, insideHours, type ModelOverride, parseHours } from "./config.js";
import {
  BUILTIN_MODELS,
  buildModelGraph,
  type ModelAdapter,
  snap,
  variantFiles,
} from "./models.js";
import { JobStore } from "./store.js";
import { fillWorkflow, parseWorkflow, type Workflow, WorkflowError } from "./workflow.js";

/** A request or a call the service refuses; `status` follows HTTP for callers that answer one. */
export class ImageGenError extends Error {
  override readonly name = "ImageGenError";
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429 | 503 = 400,
  ) {
    super(message);
  }
}

const PURPOSE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const WORKFLOW_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_PROMPT = 4000;
const SEED_LIMIT = 2 ** 48;
const IDLE_TICK_MS = 5_000;
const RETRY_BASE_MS = 10_000;
const FILES_TTL_MS = 60_000;
const SWEEP_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FINAL: readonly ImageJob["state"][] = ["done", "failed", "cancelled"];

/** Why a running job is being stopped. */
type StopReason = "cancel" | "yield" | "shutdown";

export interface ImageGenServiceOptions {
  config: ImageGenConfig;
  /** Relative directories in the config resolve against this. */
  baseDir: string;
  client: ComfyClient;
  clock: Clock;
  log: Logger;
  publish?: (event: Event) => void;
  /** Seeds; `randomInt` unless a test pins it. */
  random?: () => number;
}

/** An adapter with `[modules.imagegen.models.<id>]` applied. */
function applyOverride(base: ModelAdapter, o: ModelOverride | undefined): ModelAdapter {
  if (o === undefined) return base;
  const variants: ModelAdapter["variants"] = {};
  for (const [name, v] of Object.entries(base.variants)) variants[name] = structuredClone(v);
  for (const [name, v] of Object.entries(o.variants)) {
    const at = variants[name] ?? structuredClone(base.variants[base.default_variant]);
    if (at === undefined) continue;
    variants[name] = {
      files: { ...at.files, ...(v.files ?? {}) },
      steps: v.steps ?? at.steps,
      cfg: v.cfg ?? at.cfg,
      sampler: v.sampler ?? at.sampler,
      scheduler: v.scheduler ?? at.scheduler,
      loras: v.loras ?? at.loras,
    };
  }
  return {
    ...base,
    files: { ...base.files, ...o.files },
    variants,
    default_variant:
      o.default_variant !== undefined && variants[o.default_variant] !== undefined
        ? o.default_variant
        : base.default_variant,
    width: o.width ?? base.width,
    height: o.height ?? base.height,
    default_negative: o.default_negative ?? base.default_negative,
    prompt_prefix: o.prompt_prefix ?? base.prompt_prefix,
    slg:
      o.slg === undefined
        ? base.slg
        : o.slg
          ? { single_layers: "22", double_layers: "", start: 0, end: 0.5 }
          : null,
  };
}

function withinDir(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export class ImageGenService implements ImageGen {
  readonly config: ImageGenConfig;
  readonly outputDir: string;
  readonly workflowsDir: string;
  readonly inputDir: string;
  readonly #client: ComfyClient;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #publish: (event: Event) => void;
  readonly #random: () => number;
  readonly #store: JobStore;
  readonly #models = new Map<string, ModelAdapter>();
  readonly #hours: { from: number; to: number } | null;

  readonly #jobs = new Map<string, ImageJob>();
  readonly #byKey = new Map<string, string>();
  readonly #waiters = new Map<string, Set<(job: ImageJob) => void>>();
  #kick: (() => void) | null = null;
  #kicked = false;
  #running: { id: string; stop: AbortController; reason: StopReason | null } | null = null;
  #retryAt = 0;
  #singing = false;
  #preparing = false;
  #loaded = false;
  #lastActive = 0;
  #lastSweep = 0;
  #files: { at: number; folders: Map<string, Set<string>> } | null = null;

  constructor(options: ImageGenServiceOptions) {
    this.config = options.config;
    this.outputDir = resolve(options.baseDir, options.config.output_dir);
    this.workflowsDir = resolve(options.baseDir, options.config.workflows_dir);
    this.inputDir = resolve(options.baseDir, options.config.input_dir);
    this.#client = options.client;
    this.#clock = options.clock;
    this.#log = options.log;
    this.#publish = options.publish ?? (() => undefined);
    this.#random = options.random ?? (() => randomInt(0, SEED_LIMIT));
    this.#store = new JobStore(this.outputDir);
    for (const base of BUILTIN_MODELS) {
      const o = options.config.models[base.id];
      if (o?.enabled === false) continue;
      this.#models.set(base.id, applyOverride(base, o));
    }
    for (const id of Object.keys(options.config.models)) {
      if (!BUILTIN_MODELS.some((m) => m.id === id)) {
        this.#log.warn({ model: id }, "[modules.imagegen.models] names an unknown model; ignored");
      }
    }
    this.#hours = options.config.batch_hours ? parseHours(options.config.batch_hours) : null;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  /** Reads the job records; a job that was running is picked up again by `run`. */
  async load(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    for (const job of await this.#store.load()) {
      if (job.state === "running") job.state = "queued";
      this.#jobs.set(job.id, job);
      if (job.key !== null) this.#byKey.set(job.key, job.id);
    }
    const waiting = [...this.#jobs.values()].filter((j) => j.state === "queued").length;
    if (waiting > 0) this.#log.info({ waiting }, "image jobs waiting from before the restart");
  }

  /** Runs jobs until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    this.#lastActive = this.#clock.now();
    signal.addEventListener("abort", () => this.#stopRunning("shutdown"), { once: true });
    while (!signal.aborted) {
      const job = this.#next();
      if (job === null) {
        await this.#idle(signal);
        continue;
      }
      await this.#execute(job, signal);
      this.#lastActive = this.#clock.now();
    }
  }

  /** A song cue from the `sing` module. */
  onSongCue(cue: SongCue): void {
    if (cue.state === "started") this.#setSinging(true);
    else if (cue.state === "ended") this.#setSinging(false);
  }

  /** What the song worker is preparing (`no: null`: nothing). */
  onSongPrepare(prepare: SongPrepare): void {
    const was = this.#busy();
    this.#preparing = prepare.no !== null;
    this.#busyChanged(was);
  }

  #setSinging(on: boolean): void {
    const was = this.#busy();
    this.#singing = on;
    this.#busyChanged(was);
  }

  #busy(): boolean {
    return this.#singing || this.#preparing;
  }

  #busyChanged(was: boolean): void {
    const now = this.#busy();
    if (now === was) return;
    if (!now) {
      this.#wake();
      return;
    }
    const running = this.#running;
    if (this.config.pause_while_singing && running !== null) {
      const job = this.#jobs.get(running.id);
      if (job?.priority === "batch") this.#stopRunning("yield");
    }
    if (this.config.free_on_sing && (running === null || this.config.pause_while_singing)) {
      void this.#free("a song needs the GPU");
    }
  }

  #stopRunning(reason: StopReason): void {
    const running = this.#running;
    if (running === null || running.reason !== null) return;
    running.reason = reason;
    running.stop.abort();
  }

  /** Looks at the queue again now (after the clock or the batch hours changed, say). */
  nudge(): void {
    this.#wake();
  }

  #wake(): void {
    const kick = this.#kick;
    this.#kick = null;
    if (kick) kick();
    else this.#kicked = true; // the runner is busy: it looks again before it next waits
  }

  // ---- the queue -----------------------------------------------------------------------------

  /** Why queued jobs of `priority` cannot run now, or `null`. */
  #heldFor(priority: ImageJob["priority"]): string | null {
    if (this.#clock.now() < this.#retryAt) return "unreachable";
    if (this.config.pause_while_singing && this.#busy()) return "singing";
    if (priority === "batch" && this.#hours !== null) {
      const local = new Date(this.#clock.now() + this.config.utc_offset_minutes * 60_000);
      const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
      if (!insideHours(this.#hours, minute)) return "outside_batch_hours";
    }
    return null;
  }

  #queued(): ImageJob[] {
    return [...this.#jobs.values()]
      .filter((j) => j.state === "queued")
      .sort((a, b) =>
        a.priority !== b.priority
          ? a.priority === "interactive"
            ? -1
            : 1
          : a.created_at < b.created_at
            ? -1
            : a.created_at > b.created_at
              ? 1
              : a.id < b.id
                ? -1
                : 1,
      );
  }

  #next(): ImageJob | null {
    for (const job of this.#queued()) {
      if (this.#heldFor(job.priority) === null) return job;
    }
    return null;
  }

  async #idle(signal: AbortSignal): Promise<void> {
    const now = this.#clock.now();
    if (
      this.#loaded &&
      this.config.free_after_idle_s > 0 &&
      now - this.#lastActive >= this.config.free_after_idle_s * 1000
    ) {
      await this.#free("idle");
    }
    if (this.config.keep_days > 0 && now - this.#lastSweep >= SWEEP_EVERY_MS) {
      this.#lastSweep = now;
      await this.sweep().catch((error: unknown) => {
        this.#log.warn({ err: errorMessage(error) }, "image job sweep failed");
      });
    }
    if (this.#kicked) {
      this.#kicked = false;
      return;
    }
    const woken = new Promise<void>((resolve) => {
      this.#kick = resolve;
    });
    const wait = this.#retryAt > now ? Math.min(this.#retryAt - now, IDLE_TICK_MS) : IDLE_TICK_MS;
    const tick = new AbortController();
    const both = AbortSignal.any([signal, tick.signal]);
    await Promise.race([woken, sleep(wait, both).catch(() => undefined)]);
    tick.abort();
  }

  async #free(why: string): Promise<void> {
    try {
      await this.#client.free();
      this.#loaded = false;
      this.#log.info({ why }, "asked ComfyUI to unload its models");
    } catch (error) {
      this.#log.debug({ err: errorMessage(error) }, "ComfyUI did not unload its models");
    }
  }

  // ---- requests -------------------------------------------------------------------------------

  #localDay(at: number): number {
    return Math.floor((at + this.config.utc_offset_minutes * 60_000) / DAY_MS);
  }

  async #workflow(id: string): Promise<Workflow> {
    if (!WORKFLOW_ID.test(id)) throw new ImageGenError(`bad workflow id \`${id}\``);
    let text: string;
    try {
      text = await readFile(join(this.workflowsDir, `${id}.json`), "utf8");
    } catch {
      throw new ImageGenError(`no workflow \`${id}\` in ${this.workflowsDir}`, 404);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ImageGenError(`workflow \`${id}\` is not JSON`);
    }
    try {
      return parseWorkflow(id, raw);
    } catch (error) {
      throw new ImageGenError(errorMessage(error));
    }
  }

  /** Checks `input` and fills in the defaults: what the job will run with. */
  async resolveRequest(input: ImageRequestInput): Promise<ImageRequest> {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (prompt.length > MAX_PROMPT)
      throw new ImageGenError(`the prompt is over ${MAX_PROMPT} characters`);
    const batch = input.batch ?? 1;
    if (!Number.isInteger(batch) || batch < 1 || batch > this.config.max_batch) {
      throw new ImageGenError(`batch must be 1 to ${this.config.max_batch}`);
    }
    const seed = input.seed ?? this.#random();
    if (!Number.isInteger(seed) || seed < 0 || seed > Number.MAX_SAFE_INTEGER) {
      throw new ImageGenError("seed must be a whole number from 0");
    }
    for (const lora of input.loras ?? []) {
      if (typeof lora.name !== "string" || lora.name === "" || !Number.isFinite(lora.strength)) {
        throw new ImageGenError("a LoRA needs a name and a strength");
      }
    }
    if (input.denoise != null && !(input.denoise > 0 && input.denoise <= 1)) {
      throw new ImageGenError("denoise must be above 0 and at most 1");
    }
    const initImage = input.init_image ?? null;
    if (initImage !== null) this.#initImageSource(initImage);
    const common = {
      negative: input.negative ?? null,
      seed,
      batch,
      loras: input.loras ?? [],
      init_image: initImage,
      denoise: initImage === null ? null : (input.denoise ?? 0.6),
      params: input.params ?? {},
    };

    if (input.workflow != null) {
      const wf = await this.#workflow(input.workflow);
      if (common.loras.length > 0) {
        throw new ImageGenError("a workflow sets its own LoRAs; pass them as workflow params");
      }
      for (const name of Object.keys(common.params)) {
        if (wf.params[name] === undefined) {
          throw new ImageGenError(`workflow \`${wf.id}\` has no parameter \`${name}\``);
        }
      }
      if (prompt === "" && wf.params.prompt?.required)
        throw new ImageGenError("the prompt is empty");
      return {
        ...common,
        model: null,
        variant: null,
        workflow: wf.id,
        prompt,
        width: input.width ?? null,
        height: input.height ?? null,
        steps: input.steps ?? null,
        cfg: input.cfg ?? null,
        sampler: input.sampler ?? null,
        scheduler: input.scheduler ?? null,
      };
    }

    if (prompt === "") throw new ImageGenError("the prompt is empty");
    if (Object.keys(common.params).length > 0) {
      throw new ImageGenError("params are for workflow files; a built-in model takes none");
    }
    const modelId = input.model ?? this.config.default_model;
    const model = this.#models.get(modelId);
    if (model === undefined) throw new ImageGenError(`no image model \`${modelId}\``, 404);
    const variantName = input.variant ?? model.default_variant;
    const variant = model.variants[variantName];
    if (variant === undefined) {
      throw new ImageGenError(
        `${model.label} has no variant \`${variantName}\` (${Object.keys(model.variants).join(", ")})`,
      );
    }
    const side = (n: number | null | undefined, fallback: number) =>
      snap(n ?? fallback, model.size_step, model.min_side, model.max_side);
    const steps = input.steps ?? variant.steps;
    if (!Number.isInteger(steps) || steps < 1 || steps > 200)
      throw new ImageGenError("steps must be 1 to 200");
    const cfg = input.cfg ?? variant.cfg;
    if (!Number.isFinite(cfg) || cfg < 0 || cfg > 30)
      throw new ImageGenError("cfg must be 0 to 30");
    return {
      ...common,
      negative: model.uses_negative ? common.negative : null,
      model: model.id,
      variant: variantName,
      workflow: null,
      prompt,
      width: side(input.width, model.width),
      height: side(input.height, model.height),
      steps,
      cfg,
      sampler: input.sampler ?? variant.sampler,
      scheduler: input.scheduler ?? variant.scheduler,
    };
  }

  /**
   * Where a start picture comes from: a file inside `input_dir` (uploaded when the job runs), or
   * a name ComfyUI already has in its input folder.
   */
  #initImageSource(name: string): { local: string } | { comfy: string } {
    if (name === "" || name.includes("\0")) throw new ImageGenError("init_image is empty");
    const path = resolve(this.inputDir, name);
    if (existsSync(path)) {
      const real = realpathSync(path);
      const root = existsSync(this.inputDir) ? realpathSync(this.inputDir) : this.inputDir;
      if (!withinDir(root, real)) throw new ImageGenError("init_image must be inside input_dir");
      return { local: real };
    }
    if (isAbsolute(name) || name.split(/[\\/]/).includes("..")) {
      throw new ImageGenError("init_image must be inside input_dir");
    }
    return { comfy: name.replaceAll("\\", "/") };
  }

  async submit(input: ImageRequestInput, options: ImageSubmitOptions): Promise<ImageJob> {
    if (!PURPOSE.test(options.purpose)) {
      throw new ImageGenError("purpose must be a lowercase slug (a-z, 0-9, _ and -)");
    }
    const key = options.key ?? null;
    if (key !== null) {
      const existing = this.#byKey.get(key);
      const job = existing === undefined ? undefined : this.#jobs.get(existing);
      if (job !== undefined) return structuredClone(job);
    }
    const queued = [...this.#jobs.values()].filter((j) => j.state === "queued").length;
    if (queued >= this.config.max_queued) {
      throw new ImageGenError(`${queued} image jobs are already waiting`, 429);
    }
    const limit = this.config.daily_limits[options.purpose];
    if (limit !== undefined) {
      const today = this.#localDay(this.#clock.now());
      const used = [...this.#jobs.values()].filter(
        (j) => j.purpose === options.purpose && this.#localDay(Date.parse(j.created_at)) === today,
      ).length;
      if (used >= limit) {
        throw new ImageGenError(
          `today's ${limit} \`${options.purpose}\` pictures are used up`,
          429,
        );
      }
    }
    const request = await this.resolveRequest(input);
    const job: ImageJob = {
      id: newId(),
      key,
      purpose: options.purpose,
      priority: options.priority ?? "batch",
      note: options.note ?? null,
      state: "queued",
      request,
      prompt_id: null,
      progress: 0,
      node: null,
      attempts: 0,
      error: null,
      outputs: [],
      created_at: toTimestamp(this.#clock.now()),
      started_at: null,
      finished_at: null,
    };
    this.#jobs.set(job.id, job);
    if (key !== null) this.#byKey.set(key, job.id);
    await this.#save(job);
    this.#emit(job);
    this.#wake();
    return structuredClone(job);
  }

  async get(id: string): Promise<ImageJob | null> {
    const job = this.#jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  async list(filter: ImageJobFilter = {}): Promise<ImageJob[]> {
    return [...this.#jobs.values()]
      .filter((j) => !filter.states || filter.states.includes(j.state))
      .filter((j) => filter.purpose === undefined || j.purpose === filter.purpose)
      .sort((a, b) =>
        a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1,
      )
      .slice(0, Math.max(filter.limit ?? 100, 0))
      .map((j) => structuredClone(j));
  }

  wait(id: string, signal?: AbortSignal): Promise<ImageJob> {
    const job = this.#jobs.get(id);
    if (job === undefined) return Promise.reject(new ImageGenError(`no image job \`${id}\``, 404));
    if (FINAL.includes(job.state)) return Promise.resolve(structuredClone(job));
    return new Promise((resolve, reject) => {
      const set = this.#waiters.get(id) ?? new Set();
      const done = (j: ImageJob) => {
        signal?.removeEventListener("abort", abort);
        resolve(j);
      };
      const abort = () => {
        set.delete(done);
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      set.add(done);
      this.#waiters.set(id, set);
    });
  }

  async cancel(id: string): Promise<ImageJob | null> {
    const job = this.#jobs.get(id);
    if (job === undefined) return null;
    if (job.state === "queued") {
      await this.#finish(job, "cancelled", "cancelled");
    } else if (job.state === "running" && this.#running?.id === id) {
      this.#stopRunning("cancel");
    }
    return structuredClone(job);
  }

  models(): ImageModelInfo[] {
    return [...this.#models.values()].map((m) => {
      const files = variantFiles(m, m.default_variant);
      return {
        id: m.id,
        label: m.label,
        variants: Object.keys(m.variants),
        default_variant: m.default_variant,
        files: {
          diffusion_models: files.diffusion_model,
          text_encoders: files.text_encoder,
          vae: files.vae,
        },
        uses_negative: m.uses_negative,
        prompt_hint: m.prompt_hint,
        license: m.license,
      };
    });
  }

  async workflows(): Promise<ImageWorkflowInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.workflowsDir);
    } catch {
      return [];
    }
    const out: ImageWorkflowInfo[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      try {
        const wf = await this.#workflow(id);
        out.push({ id, description: wf.description, params: Object.keys(wf.params).sort() });
      } catch (error) {
        this.#log.warn({ workflow: id, err: errorMessage(error) }, "workflow file skipped");
      }
    }
    return out;
  }

  async status(): Promise<ImageGenStatus> {
    const queued = this.#queued();
    const base = {
      queued: queued.length,
      running: this.#running?.id ?? null,
      held:
        this.#running === null && queued.length > 0
          ? queued.every((j) => this.#heldFor(j.priority) !== null)
            ? this.#heldFor(queued[0]?.priority ?? "batch")
            : null
          : null,
    };
    try {
      const stats = await this.#client.stats();
      return { reachable: true, version: stats.version, devices: stats.devices, ...base };
    } catch {
      return { reachable: false, version: null, devices: [], ...base };
    }
  }

  async free(): Promise<void> {
    await this.#client.free();
    this.#loaded = false;
  }

  /** Deletes finished jobs older than `keep_days`, with their pictures. */
  async sweep(): Promise<number> {
    if (this.config.keep_days <= 0) return 0;
    const before = this.#clock.now() - this.config.keep_days * DAY_MS;
    let removed = 0;
    for (const job of [...this.#jobs.values()]) {
      if (!FINAL.includes(job.state) || Date.parse(job.finished_at ?? job.created_at) >= before)
        continue;
      for (const out of job.outputs) await rm(out.path, { force: true });
      if (job.outputs[0]) {
        await rm(join(resolve(job.outputs[0].path, ".."), `${job.id}.json`), { force: true });
      }
      await this.#store.remove(job.id);
      this.#jobs.delete(job.id);
      if (job.key !== null) this.#byKey.delete(job.key);
      removed++;
    }
    return removed;
  }

  // ---- running a job --------------------------------------------------------------------------

  async #save(job: ImageJob): Promise<void> {
    await this.#store.save(job);
  }

  #emit(job: ImageJob): void {
    const payload: ImageJobEvent = {
      id: job.id,
      purpose: job.purpose,
      state: job.state,
      progress: job.progress,
      error: job.error,
      outputs: job.outputs.map((o) => o.path),
    };
    this.#publish(customEvent(IMAGEGEN_TOPIC, payload as unknown as JsonValue));
  }

  async #finish(
    job: ImageJob,
    state: "done" | "failed" | "cancelled",
    error: string | null,
  ): Promise<void> {
    job.state = state;
    job.error = error;
    job.node = null;
    if (state === "done") job.progress = 1;
    job.finished_at = toTimestamp(this.#clock.now());
    await this.#save(job).catch((e: unknown) => {
      this.#log.error({ job: job.id, err: errorMessage(e) }, "cannot write image job record");
    });
    this.#emit(job);
    const waiters = this.#waiters.get(job.id);
    this.#waiters.delete(job.id);
    for (const w of waiters ?? []) w(structuredClone(job));
    if (state === "failed")
      this.#log.warn({ job: job.id, purpose: job.purpose, error }, "image job failed");
  }

  /** The model files ComfyUI has, by folder (cached for a minute). */
  async #comfyFiles(folder: string): Promise<Set<string>> {
    const now = this.#clock.now();
    if (this.#files === null || now - this.#files.at > FILES_TTL_MS) {
      this.#files = { at: now, folders: new Map() };
    }
    let set = this.#files.folders.get(folder);
    if (set === undefined) {
      set = new Set((await this.#client.models(folder)).map((f) => f.replaceAll("\\", "/")));
      this.#files.folders.set(folder, set);
    }
    return set;
  }

  /** Throws `WorkflowError` (not retried) when a file the model needs is not in ComfyUI. */
  async #checkFiles(model: ModelAdapter, request: ImageRequest): Promise<void> {
    if (!this.config.check_files) return;
    const files = variantFiles(model, request.variant ?? model.default_variant);
    const need: [string, string, string][] = [
      ["diffusion_models", files.diffusion_model, "diffusion_model"],
      ["text_encoders", files.text_encoder, "text_encoder"],
      ["vae", files.vae, "vae"],
      ...[
        ...(model.variants[request.variant ?? model.default_variant]?.loras ?? []),
        ...request.loras,
      ].map((l): [string, string, string] => ["loras", l.name, "lora"]),
    ];
    for (const [folder, file, what] of need) {
      const have = await this.#comfyFiles(folder);
      if (!have.has(file.replaceAll("\\", "/"))) {
        this.#files = null;
        throw new WorkflowError(
          `${model.label}: ComfyUI has no ${what} \`${file}\` in models/${folder} ` +
            `(download it, or set it in [modules.imagegen.models.${model.id}])`,
        );
      }
    }
  }

  /** Uploads the start picture when it is a local file; returns the name `LoadImage` takes. */
  async #uploadInit(job: ImageJob, signal: AbortSignal): Promise<string | null> {
    const name = job.request.init_image;
    if (name === null) return null;
    const source = this.#initImageSource(name);
    if ("comfy" in source) return source.comfy;
    const bytes = await readFile(source.local);
    return this.#client.upload(bytes, `${job.id}-${basename(source.local)}`, {
      subfolder: "miyoria",
      signal,
    });
  }

  /** The graph a job runs and the nodes whose pictures are its outputs. */
  async #graph(
    job: ImageJob,
    signal: AbortSignal,
  ): Promise<{ graph: ComfyGraph; outputs: string[] }> {
    const r = job.request;
    const prefix = `miyoria/${job.purpose}/${job.id}`;
    if (r.workflow !== null) {
      const wf = await this.#workflow(r.workflow);
      const values: Record<string, JsonValue> = {};
      const standard: [string, JsonValue | null][] = [
        ["prompt", r.prompt === "" ? null : r.prompt],
        ["negative", r.negative],
        ["seed", r.seed],
        ["width", r.width],
        ["height", r.height],
        ["steps", r.steps],
        ["cfg", r.cfg],
        ["sampler", r.sampler],
        ["scheduler", r.scheduler],
        ["batch", r.batch === 1 ? null : r.batch],
        ["denoise", r.denoise],
      ];
      for (const [name, value] of standard) {
        if (value !== null && wf.params[name] !== undefined) values[name] = value;
      }
      if (r.init_image !== null) {
        const image = Object.entries(wf.params).find(([, p]) => p.type === "image")?.[0];
        if (image === undefined) throw new WorkflowError(`workflow \`${wf.id}\` takes no picture`);
        values[image] = (await this.#uploadInit(job, signal)) as string;
      }
      Object.assign(values, r.params);
      const graph = fillWorkflow(wf, values);
      for (const id of wf.outputs) {
        const node = graph[id];
        if (node?.class_type === "SaveImage") node.inputs.filename_prefix = prefix;
      }
      return { graph, outputs: wf.outputs };
    }
    const model = this.#models.get(r.model ?? "");
    if (model === undefined) throw new WorkflowError(`no image model \`${r.model}\` any more`);
    await this.#checkFiles(model, r);
    const initImage = await this.#uploadInit(job, signal);
    const { graph, save } = buildModelGraph(model, r, { prefix, initImage });
    return { graph, outputs: [save] };
  }

  async #execute(job: ImageJob, outer: AbortSignal): Promise<void> {
    const stop = new AbortController();
    const running = { id: job.id, stop, reason: null as StopReason | null };
    this.#running = running;
    const timeout = AbortSignal.timeout(this.config.timeout_s * 1000);
    const signal = AbortSignal.any([stop.signal, timeout]);
    job.state = "running";
    job.attempts += 1;
    job.error = null;
    job.progress = 0;
    job.started_at = toTimestamp(this.#clock.now());
    await this.#save(job);
    this.#emit(job);
    const clientId = `miyoria-${job.id}`;
    try {
      const { graph, outputs } = await this.#graph(job, signal);
      let promptId = job.prompt_id;
      if (promptId !== null && !(await this.#stillThere(promptId, signal))) promptId = null;
      if (promptId === null) {
        promptId = await this.#client.queue(graph, clientId, { promptId: randomUUID(), signal });
        job.prompt_id = promptId;
        await this.#save(job);
      }
      this.#loaded = true;
      const run = await this.#client.follow(promptId, clientId, {
        signal,
        pollMs: this.config.poll_ms,
        onProgress: (p) => this.#onProgress(job, p),
      });
      if (run.status === "error") {
        await this.#finish(job, "failed", run.error ?? "ComfyUI reported an error");
        return;
      }
      const images = run.images.filter((i) => outputs.includes(i.node));
      const picked = images.length > 0 ? images : run.images;
      if (picked.length === 0) {
        await this.#finish(job, "failed", "the run saved no pictures");
        return;
      }
      job.outputs = await this.#collect(job, graph, picked, signal);
      this.#retryAt = 0;
      await this.#finish(job, "done", null);
    } catch (error) {
      await this.#failed(job, error, running.reason, timeout.aborted, outer);
    } finally {
      this.#running = null;
    }
  }

  /** Whether ComfyUI still has a run we queued before (queued, running or in its history). */
  async #stillThere(promptId: string, signal: AbortSignal): Promise<boolean> {
    const run = await this.#client.run(promptId, signal);
    if (run !== null) return true;
    const q = await this.#client.queueState(signal);
    return q.running.includes(promptId) || q.pending.includes(promptId);
  }

  #onProgress(job: ImageJob, p: ComfyProgress): void {
    if (p.type === "executing") job.node = p.node;
    else if (p.type === "progress" && p.max > 0) {
      const next = Math.min(Math.max(p.value / p.max, 0), 1);
      if (next - job.progress >= 0.1 || next === 1) {
        job.progress = next;
        this.#emit(job);
      }
    }
  }

  async #failed(
    job: ImageJob,
    error: unknown,
    reason: StopReason | null,
    timedOut: boolean,
    outer: AbortSignal,
  ): Promise<void> {
    const promptId = job.prompt_id;
    const stopRun = async () => {
      if (promptId === null) return;
      await this.#client.dequeue([promptId]).catch(() => undefined);
      await this.#client.interrupt(promptId).catch(() => undefined);
    };
    if (reason === "cancel") {
      await stopRun();
      await this.#finish(job, "cancelled", "cancelled");
      return;
    }
    if (reason === "yield" || reason === "shutdown" || outer.aborted) {
      if (reason === "yield") {
        await stopRun();
        job.prompt_id = null;
      }
      // Shutdown leaves a queued run on ComfyUI; the restart picks it up by its prompt id.
      job.state = "queued";
      job.attempts = Math.max(job.attempts - 1, 0);
      job.node = null;
      await this.#save(job).catch(() => undefined);
      this.#emit(job);
      return;
    }
    if (timedOut) {
      await stopRun();
      await this.#finish(job, "failed", `the run took over ${this.config.timeout_s} s`);
      return;
    }
    const message = errorMessage(error);
    const retry =
      error instanceof ComfyError && error.kind === "unreachable" && !isAbortError(error);
    if (retry && job.attempts < this.config.max_attempts) {
      this.#retryAt = this.#clock.now() + RETRY_BASE_MS * job.attempts;
      job.state = "queued";
      job.error = message;
      job.node = null;
      await this.#save(job).catch(() => undefined);
      this.#emit(job);
      this.#log.warn(
        { job: job.id, attempt: job.attempts, err: message },
        "ComfyUI unreachable; image job will be retried",
      );
      return;
    }
    await this.#finish(job, "failed", message);
  }

  /** Copies the run's pictures to the output dir, with a sidecar holding the request and graph. */
  async #collect(
    job: ImageJob,
    graph: ComfyGraph,
    images: { node: string; image: import("./comfy.js").ComfyImageRef }[],
    signal: AbortSignal,
  ): Promise<ImageOutput[]> {
    const month = toTimestamp(this.#clock.now()).slice(0, 7);
    const dir = join(this.outputDir, month, job.purpose);
    await mkdir(dir, { recursive: true });
    const outputs: ImageOutput[] = [];
    for (const [index, { image }] of images.entries()) {
      const bytes = await this.#client.view(image, signal);
      const path = join(dir, `${job.id}-${index}.png`);
      await writeFile(path, bytes);
      const size = (await stat(path)).size;
      outputs.push({
        path,
        file: relative(this.outputDir, path).split(sep).join("/"),
        index,
        bytes: size,
      });
    }
    const model = job.request.model ? this.#models.get(job.request.model) : undefined;
    const sidecar = {
      job: job.id,
      purpose: job.purpose,
      note: job.note,
      request: job.request,
      model_files: model ? variantFiles(model, job.request.variant ?? model.default_variant) : null,
      prompt_id: job.prompt_id,
      comfyui: this.#client.url,
      graph,
      outputs: outputs.map((o) => o.file),
      made_at: toTimestamp(this.#clock.now()),
    };
    await writeFile(join(dir, `${job.id}.json`), `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
    return outputs;
  }
}
