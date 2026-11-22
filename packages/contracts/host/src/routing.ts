// How a service may be routed across hosts (docs/design/v5-hostd.md §15): the `[routing]` table
// of a service descriptor, and what a host reports of it for each service (its readiness, its
// variant, its load). Every reported field is optional, so an older daemon simply sends none and
// Core keeps routing that service the way it did before (first healthy endpoint in order).
//
// Classes:
// - `single`: one instance in the whole cluster. A second one is a conflict: reported, never used.
// - `session`: several hosts may serve it, but a session or stream stays on the host it started
//   on; another host is only a failover between sessions.
// - `job`: independent units of work, each may go to any capable host (scored, §15.3).

import { z } from "zod";

export const HostRoutingClassSchema = z
  .enum(["single", "session", "job"])
  .meta({ id: "HostRoutingClass" });
export type HostRoutingClass = z.output<typeof HostRoutingClassSchema>;

/**
 * How long the person waiting can wait. `realtime` prefers the host nearest Core (the same
 * machine, then the lowest measured round trip) and is never placed by queue length alone.
 */
export const HostRoutingLatencySchema = z
  .enum(["realtime", "interactive", "batch"])
  .meta({ id: "HostRoutingLatency" });
export type HostRoutingLatency = z.output<typeof HostRoutingLatencySchema>;

/**
 * What a host must have for this service to count there. The host checks it and reports ready or
 * not with the reason; Core never sends work to a host that is not ready.
 */
export const HostRoutingNeedsSchema = z
  .object({
    /**
     * Files or folders that must be there, as `install.manual` paths: relative to the checkout,
     * with `{voice}`, `{state}`, `{models}`, `{workspace}` and `{service}`.
     */
    files: z.array(z.string().min(1)).default([]),
    /** The card's total memory, at least this many GB. */
    vram_gb: z.number().positive().optional(),
  })
  .strict()
  .meta({ id: "HostRoutingNeeds" });
export type HostRoutingNeeds = z.output<typeof HostRoutingNeedsSchema>;

/**
 * What makes results differ between hosts (her voice model, an image model): the host reports a
 * short hash of these, and Core treats only instances with the same hash as interchangeable.
 */
export const HostRoutingVariantSchema = z
  .object({
    /** Files or folders, as in `needs.files`: their names, sizes and a sample of their bytes. */
    files: z.array(z.string().min(1)).default([]),
    /** Environment variables of the service whose values matter (`TTS_DEFAULT_VOICE`). */
    env: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .meta({ id: "HostRoutingVariant" });
export type HostRoutingVariant = z.output<typeof HostRoutingVariantSchema>;

/** `[routing]` of a service descriptor (or its `routing.toml`). */
export const HostRoutingSchema = z
  .object({
    class: HostRoutingClassSchema,
    latency: HostRoutingLatencySchema.default("interactive"),
    /** Units one instance takes at once. */
    concurrency: z.number().int().positive().default(1),
    /**
     * Its `[run.health]` answer reports its load: `running` (or `busy: true`) and `queued`. hostd
     * reads them from every probe and reports them.
     */
    queue: z.boolean().default(false),
    needs: HostRoutingNeedsSchema.default({ files: [] }),
    variant: HostRoutingVariantSchema.optional(),
    /**
     * Services of the same host its work disturbs (the song worker takes the card from `tts` and
     * `asr`). A dispatcher avoids a host whose such services carry her voice right now.
     */
    yields_to: z.array(z.string().min(1)).default([]),
    /** A unit's usual time in seconds, until Core has measured it on a host. */
    unit_s: z.number().positive().optional(),
    /** How many MB a unit's results usually are, for the transfer back to Core. */
    result_mb: z.number().nonnegative().optional(),
  })
  .strict()
  .meta({ id: "HostRouting" });
export type HostRouting = z.output<typeof HostRoutingSchema>;
export type HostRoutingIn = z.input<typeof HostRoutingSchema>;

/** What a host reports of one service's `[routing]`, as it applies on that host. */
export const HostServiceRoutingSchema = z
  .object({
    class: HostRoutingClassSchema,
    latency: HostRoutingLatencySchema,
    /** Units it takes at once here: the descriptor's, lowered by `host.toml` when that says so. */
    concurrency: z.number().int().positive(),
    /** Its load is reported (`load`). */
    queue: z.boolean(),
    yields_to: z.array(z.string()),
    /** `needs` holds here. */
    ready: z.boolean(),
    /** Why not, in words. */
    reason: z.string().optional(),
    /** The hash of `variant`, when the descriptor has one. */
    variant: z.string().optional(),
    /**
     * `false`: the host's owner set `accept = false` in `host.toml`; Core sends it no new work.
     * Core cannot change it.
     */
    accept: z.boolean(),
    /** The limit the host's owner set in `host.toml`, when there is one. */
    owner_concurrency: z.number().int().positive().optional(),
    unit_s: z.number().positive().optional(),
    result_mb: z.number().nonnegative().optional(),
  })
  .meta({ id: "HostServiceRouting" });
export type HostServiceRouting = z.output<typeof HostServiceRoutingSchema>;

/** The last load reading of a service whose `[routing] queue` is on. */
export const HostServiceLoadSchema = z
  .object({
    /** Units running now. */
    running: z.number().int().nonnegative(),
    /** Units waiting behind them. */
    queued: z.number().int().nonnegative(),
    /** How old the reading is, in ms, when the report was made (hosts' clocks differ). */
    age_ms: z.number().nonnegative(),
    /**
     * Busy for a reason outside the service, in words (the card is lent to another service of the
     * host). Absent when nothing outside holds it up.
     */
    outside: z.string().optional(),
  })
  .meta({ id: "HostServiceLoad" });
export type HostServiceLoad = z.output<typeof HostServiceLoadSchema>;
