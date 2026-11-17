// `[modules.cluster]` (docs/design/v5-hostd.md §6): where the control link listens, the order in
// which hosts are tried per capability, and the services no hostd manages.

import { z } from "zod";

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
});
export type ClusterConfig = z.output<typeof ClusterConfigSchema>;
