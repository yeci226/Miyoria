// `[modules.cluster]` (docs/design/v5-hostd.md §6): where the control link listens, the order in
// which hosts are tried per capability, and the services no hostd manages.

import { z } from "zod";
import { RoutesConfigSchema } from "./routes.js";

/** Where Core serves the control link when `bind` is not set. */
export const DEFAULT_CLUSTER_BIND = "127.0.0.1:7880";

/** A service no hostd manages, called directly at `url`. */
export const StaticEndpointConfigSchema = z.object({
  /** The capabilities it serves (`asr`, `sing`, ...). */
  provides: z.array(z.string().min(1)).min(1),
  /** Its base URL. */
  url: z.string().min(1),
  /** Sent as `authorization: Bearer <token>` when set (`"${FRIEND_SING_TOKEN}"`). */
  token: z.string().optional(),
});
export type StaticEndpointConfig = z.output<typeof StaticEndpointConfigSchema>;

/**
 * Whether a `job` whose service `yields_to` her voice's services may go to a host whose such
 * services carry her voice (Core's speech host): `never`; `when_idle`, only while she is not in
 * voice, not live and nobody spoke for `idle_minutes`; `always` (with `speech_penalty_secs` while
 * she is active).
 */
export const SPEECH_HOST_MODES = ["never", "when_idle", "always"] as const;
export type SpeechHostMode = (typeof SPEECH_HOST_MODES)[number];

/** `[modules.cluster.routing.capabilities.<capability>]`. */
export const RoutingCapabilityConfigSchema = z.object({
  /** Overrides `allow_on_speech_host` for this capability. */
  allow_on_speech_host: z.enum(SPEECH_HOST_MODES).optional(),
  /** Only this host takes its new work. */
  pin: z.string().min(1).optional(),
  /** These hosts take none of its new work. */
  exclude: z.array(z.string().min(1)).default([]),
  /** The variant every instance must have; default the one most instances report. */
  variant: z.string().min(1).optional(),
  /** A unit's time before one was measured on a host, in seconds (over the descriptor's `unit_s`). */
  unit_secs: z.number().positive().optional(),
  /** A unit's results, in MB, for the transfer estimate (over the descriptor's `result_mb`). */
  result_mb: z.number().nonnegative().optional(),
});
export type RoutingCapabilityConfig = z.output<typeof RoutingCapabilityConfigSchema>;

/** `[modules.cluster.routing]`: how `job` work is spread (v5-hostd §15). */
export const RoutingConfigSchema = z.object({
  allow_on_speech_host: z.enum(SPEECH_HOST_MODES).default("never"),
  /** `when_idle`: how long nobody may have spoken, in minutes. */
  idle_minutes: z.number().nonnegative().default(10),
  /** Added to a speech host's score while she is in voice or live, with `always`. */
  speech_penalty_secs: z.number().nonnegative().default(900),
  /** Added to a host that failed a moment ago (it rests for `retry_secs`). */
  resting_penalty_secs: z.number().nonnegative().default(3600),
  /** Added to a host whose card is lent to another of its services now. */
  outside_busy_penalty_secs: z.number().nonnegative().default(120),
  /** A host that reports no load counts as this many units ahead of a new one. */
  unknown_load_units: z.number().nonnegative().default(1),
  /** Each place further down `order` adds this much; hosts `order` does not name come last. */
  order_step_secs: z.number().nonnegative().default(30),
  /** A unit Core sent counts against its host until a report shows it, at most this long. */
  reserve_secs: z.number().positive().default(60),
  /** At most this long for a host that reports no load (until the unit is done). */
  max_unit_secs: z.number().positive().default(3600),
  /** A unit's time when neither a measurement, the config nor the descriptor says. */
  default_unit_secs: z.number().positive().default(120),
  /** Transfer rate before one was measured, MB/s: Core's own machine, direct, through the link. */
  transfer_mb_s: z
    .object({
      local: z.number().positive().default(500),
      direct: z.number().positive().default(20),
      link: z.number().positive().default(8),
    })
    .prefault({}),
  /** Per host: its score is divided by this (2: it takes about twice the work). Default 1. */
  weights: z.record(z.string(), z.number().positive()).default({}),
  /** Hosts that finish what they have and take nothing new. */
  drain: z.array(z.string().min(1)).default([]),
  capabilities: z.record(z.string(), RoutingCapabilityConfigSchema).default({}),
});
export type RoutingConfig = z.output<typeof RoutingConfigSchema>;

export const ClusterConfigSchema = z.object({
  /** Listen address of the control link. */
  bind: z.string().default(DEFAULT_CLUSTER_BIND),
  /**
   * The link address `POST /api/cluster/join` gives a joining machine, for a Core behind a proxy
   * (`wss://core.example/cluster-link`). Without it the address is built from the request's host
   * and `bind`'s port.
   */
  public_url: z
    .string()
    .regex(/^wss?:\/\/\S+$/u, "must be a ws:// or wss:// address")
    .optional(),
  /** Per capability, the hosts (or static entries) to try first, in order. */
  order: z.record(z.string(), z.array(z.string())).default({}),
  /** Services no hostd manages, by a name of their own. */
  static: z.record(z.string(), StaticEndpointConfigSchema).default({}),
  /** How long an endpoint that failed is passed over, in seconds. */
  retry_secs: z.number().nonnegative().default(30),
  /** Time allowed between connecting and `hello`. */
  hello_timeout_ms: z.number().int().positive().default(5_000),
  /** Core → host ping interval, in seconds. */
  ping_secs: z.number().positive().default(15),
  /** A host that sends nothing (not even a pong) for this long is disconnected, in seconds. */
  peer_timeout_secs: z.number().positive().default(45),
  /** How `job` work is spread over the hosts, and the owner's pins, exclusions and drains. */
  routing: RoutingConfigSchema.prefault({}),
  /** How the hosts' routes are probed and rested (v5-hostd §16). */
  routes: RoutesConfigSchema.prefault({}),
});
export type ClusterConfig = z.output<typeof ClusterConfigSchema>;
