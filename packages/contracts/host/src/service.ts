import { z } from "zod";
import { HostRoutingSchema } from "./routing.js";

/** Cluster states in which a voluntary restart of a service waits (`run.guard`). */
export const HostGuardStateSchema = z.enum(["singing", "live"]).meta({ id: "HostGuardState" });
export type HostGuardState = z.output<typeof HostGuardStateSchema>;

/** The port a service prefers: a number, or `"auto"` for any free one. */
export const HostPortSchema = z
  .union([z.number().int().min(1).max(65535), z.literal("auto")])
  .meta({ id: "HostPort" });
export type HostPort = z.output<typeof HostPortSchema>;

/** A Hugging Face repository `models pull` fetches. */
export const HostInstallModelSchema = z
  .object({
    repo: z.string().min(1),
    // Optional for now; a later step pins every model to a commit.
    revision: z.string().optional(),
  })
  .strict()
  .meta({ id: "HostInstallModel" });
export type HostInstallModel = z.output<typeof HostInstallModelSchema>;

/** A single file fetched from a URL into the host's model folder. */
export const HostInstallFileSchema = z
  .object({
    url: z.string().min(1),
    // Optional for now; a later step pins every file to a checksum.
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional(),
    path: z.string().min(1),
  })
  .strict()
  .meta({ id: "HostInstallFile" });
export type HostInstallFile = z.output<typeof HostInstallFileSchema>;

/** Something a person puts in place: checked, never fetched. */
export const HostInstallManualSchema = z
  .object({
    path: z.string().min(1),
    what: z.string().min(1),
  })
  .strict()
  .meta({ id: "HostInstallManual" });
export type HostInstallManual = z.output<typeof HostInstallManualSchema>;

/** `[install]`: what a host needs to have before the service can run. */
export const HostInstallSchema = z
  .object({
    runtime: z.enum(["python", "node", "binary", "none"]).default("none"),
    /** A version range for the interpreter, e.g. `">=3.11,<3.14"`. */
    python: z.string().optional(),
    /** The folder that holds `pyproject.toml` and `uv.lock`, relative to the service folder. */
    project: z.string().optional(),
    /** Optional-dependency groups to sync. */
    extras: z.array(z.string()).default([]),
    /** Programs that must be on PATH: checked, installed only when asked. */
    system: z.array(z.string()).default([]),
    models: z.array(HostInstallModelSchema).default([]),
    files: z.array(HostInstallFileSchema).default([]),
    manual: z.array(HostInstallManualSchema).default([]),
    /** Modules `miyoria doctor --deep` imports with the environment's Python: the smoke test. */
    check_imports: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .meta({ id: "HostInstall" });
export type HostInstall = z.output<typeof HostInstallSchema>;

/**
 * `[run.health]`: at most one of `http` (a path that answers 200), `tcp` or `process` is
 * meaningful. With none of them the probe is "the process is alive".
 */
export const HostHealthSchema = z
  .object({
    http: z.string().optional(),
    tcp: z.boolean().optional(),
    process: z.boolean().optional(),
    startup_s: z.number().positive().default(180),
    interval_s: z.number().positive().default(10),
    timeout_s: z.number().positive().default(3),
  })
  .strict()
  .meta({ id: "HostHealth" });
export type HostHealth = z.output<typeof HostHealthSchema>;

export const HostRestartPolicySchema = z
  .enum(["always", "on-failure", "never"])
  .meta({ id: "HostRestartPolicy" });
export type HostRestartPolicy = z.output<typeof HostRestartPolicySchema>;

/** `[run.restart]`. */
export const HostRestartSchema = z
  .object({
    policy: HostRestartPolicySchema.default("on-failure"),
    /** Seconds before each retry; the last value repeats. */
    backoff_s: z.array(z.number().nonnegative()).min(1).default([1, 5, 30]),
    /** A service that fails this many times within the window stops being restarted. */
    give_up: z
      .object({
        failures: z.number().int().positive(),
        window_s: z.number().positive(),
      })
      .strict()
      .default({ failures: 5, window_s: 600 }),
  })
  .strict()
  .meta({ id: "HostRestart" });
export type HostRestart = z.output<typeof HostRestartSchema>;

/** `[run.stop]`. */
export const HostStopSchema = z
  .object({
    /** Seconds after the polite stop before the whole process tree is killed. */
    grace_s: z.number().nonnegative().default(10),
  })
  .strict()
  .meta({ id: "HostStop" });
export type HostStop = z.output<typeof HostStopSchema>;

/** `[run]`: how a worker or node is started and watched. */
export const HostRunSchema = z
  .object({
    /** An argument list, never a shell string. May hold placeholders such as `{python}`. */
    command: z.array(z.string()).min(1),
    /** Relative to the service folder. */
    cwd: z.string().default("."),
    /** The preferred port; omitted for a service that listens on none. */
    port: HostPortSchema.optional(),
    /** The environment variable that receives the bind address. */
    host_env: z.string().optional(),
    /** The environment variable that receives the port. */
    port_env: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    /** Names (a trailing `*` matches a prefix) of the daemon's variables passed on. */
    pass_env: z.array(z.string()).default([]),
    /** Started after these services, when they are installed on the same host. */
    after: z.array(z.string()).default([]),
    guard: z.array(HostGuardStateSchema).default([]),
    health: HostHealthSchema.default({ startup_s: 180, interval_s: 10, timeout_s: 3 }),
    restart: HostRestartSchema.default({
      policy: "on-failure",
      backoff_s: [1, 5, 30],
      give_up: { failures: 5, window_s: 600 },
    }),
    stop: HostStopSchema.default({ grace_s: 10 }),
  })
  .strict()
  .meta({ id: "HostRun" });
export type HostRun = z.output<typeof HostRunSchema>;

export const HostGpuPolicySchema = z
  .enum(["pinned", "evictable", "on_demand", "reserve"])
  .meta({ id: "HostGpuPolicy" });
export type HostGpuPolicy = z.output<typeof HostGpuPolicySchema>;

/** `[gpu]`: how the service uses the graphics card. */
export const HostGpuSchema = z
  .object({
    policy: HostGpuPolicySchema,
    vram_mb: z
      .object({
        resident: z.number().nonnegative(),
        peak: z.number().nonnegative(),
      })
      .strict()
      .optional(),
    /** `POST` path that makes the service give its memory up (evictable and on_demand). */
    offload: z.string().optional(),
    /** `POST` path that makes it load again. */
    reload: z.string().optional(),
    /** `GET` path that reports requests in flight. */
    busy: z.string().optional(),
  })
  .strict()
  .meta({ id: "HostGpu" });
export type HostGpu = z.output<typeof HostGpuSchema>;

/** `[probe]` of an external service: an HTTP address, or a process name. */
export const HostProbeSchema = z
  .object({
    http: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    process: z.string().optional(),
  })
  .strict()
  .meta({ id: "HostProbe" });
export type HostProbe = z.output<typeof HostProbeSchema>;

/** `[launch]` of an external service: used only when somebody asks for it. */
export const HostLaunchSchema = z
  .object({
    command: z.array(z.string()).min(1),
    cwd: z.string().default("."),
  })
  .strict()
  .meta({ id: "HostLaunch" });
export type HostLaunch = z.output<typeof HostLaunchSchema>;

/**
 * The shape of one `service.toml`. A `worker` or `node` has `run`; an `external` has `probe` and
 * maybe `launch`. The loader reports a descriptor that lacks what its kind needs.
 */
export const HostServiceSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    kind: z.enum(["worker", "node", "external"]),
    /** Capability names (`HOST_CAPABILITIES`); a string so an extension can add its own. */
    provides: z.array(z.string()).default([]),
    platforms: z.array(z.string()).default(["win32", "linux"]),
    summary: z.string().default(""),
    install: HostInstallSchema.default({
      runtime: "none",
      extras: [],
      system: [],
      models: [],
      files: [],
      manual: [],
      check_imports: [],
    }),
    run: HostRunSchema.optional(),
    gpu: HostGpuSchema.optional(),
    probe: HostProbeSchema.optional(),
    launch: HostLaunchSchema.optional(),
    /**
     * How Core may route its work across hosts (v5-hostd §15). Without it Core routes the service
     * as before: the first healthy endpoint in order. An older daemon rejects this table (its
     * schema is strict), so the repository keeps it in `routing.toml` beside `service.toml`.
     */
    routing: HostRoutingSchema.optional(),
  })
  .strict()
  .meta({ id: "HostService" });
export type HostService = z.output<typeof HostServiceSchema>;
export type HostServiceIn = z.input<typeof HostServiceSchema>;
