import { z } from "zod";
import { HostGpuPolicySchema } from "./service.js";

/** `[services.<name>]` of `host.toml`: what this machine says about one installed service. */
export const HostServiceConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** An existing Python environment to use; hostd does not manage it. */
    python: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    env: z.record(z.string(), z.string()).default({}),
    extras: z.array(z.string()).optional(),
    /** Overrides the descriptor's `[gpu] policy`. */
    gpu: z.object({ policy: HostGpuPolicySchema }).strict().optional(),
    /**
     * `false`: the service runs here, but Core sends it no work (v5-hostd §15.6). The host's
     * owner decides; Core cannot change it. An older hostd rejects this key: update it first.
     */
    accept: z.boolean().optional(),
    /** At most this many units at once from Core, below the descriptor's `[routing] concurrency`. */
    concurrency: z.number().int().positive().optional(),
  })
  .strict()
  .meta({ id: "HostServiceConfig" });
export type HostServiceConfig = z.output<typeof HostServiceConfigSchema>;

/** The shape of `host.toml`. */
export const HostConfigSchema = z
  .object({
    name: z.string().min(1),
    /** Absent on a machine that runs without a cluster. */
    cluster: z
      .object({ url: z.string().min(1) })
      .strict()
      .optional(),
    paths: z
      .object({
        /** envs/, models/, logs/, run/ live here. */
        state: z.string().default("data/host"),
        /** Passed to services as `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE`. */
        ca_bundle: z.string().optional(),
      })
      .strict()
      .default({ state: "data/host" }),
    network: z
      .object({
        /** The address services listen on. */
        bind: z.string().default("127.0.0.1"),
        /**
         * The name or address other machines reach this one by. Without it nothing here is
         * called directly: Core reaches the services through the control link.
         */
        advertise: z.string().optional(),
      })
      .strict()
      .default({ bind: "127.0.0.1" }),
    gpu: z
      .object({
        /** Memory left for OBS, VTube Studio and the desktop. */
        reserve_mb: z.number().nonnegative().default(0),
        /**
         * Who shares the card between speech and a song. `worker`: the song worker decides by
         * itself and calls its neighbours (`{offload_urls}`), as before hostd. `hostd`: hostd
         * decides (`gpu.*`) and the song worker is started with `SING_GPU_ARBITER=hostd`. A
         * machine is switched over deliberately; `worker` goes once the new path was heard live.
         */
        arbiter: z.enum(["worker", "hostd"]).default("worker"),
      })
      .strict()
      .default({ reserve_mb: 0, arbiter: "worker" }),
    update: z
      .object({
        /**
         * Core may ask this host to update itself (`host.upgrade`): fast-forward its checkout to a
         * commit of the branch it tracks, install, restart. On by default, also when the table is
         * not there; `false` opts out, and a host that opted out still reports its version.
         */
        allow_remote: z.boolean().default(true),
      })
      .strict()
      .default({ allow_remote: true }),
    services: z.record(z.string(), HostServiceConfigSchema).default({}),
  })
  .strict()
  .meta({ id: "HostConfig" });
export type HostConfig = z.output<typeof HostConfigSchema>;
export type HostConfigIn = z.input<typeof HostConfigSchema>;
