// Module `cluster` (docs/design/v5-hostd.md §6): serves the control link hosts dial, keeps the
// hosts that joined, and offers the registry of service endpoints, the hosts and the guard
// sources to other modules (`ClusterKey`).
//
// ```toml
// [modules.cluster]
// bind = "127.0.0.1:7880"
// [modules.cluster.order]
// sing = ["friend-pc", "main-pc"]
// ```
//
// Not required: when the bind fails (the port is taken) the module fails, as the voice link does,
// and Core keeps running.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  HOST_LINK_CLOSE,
  HOST_LINK_PATH,
  type HostClusterContext,
  type HostLinks,
} from "@miyoria/contracts/host";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  type ServiceLookup,
} from "@miyoria/runtime/kernel";
import { StoreKey } from "@miyoria/store";
import { Events, type Publish, serviceKey } from "@miyoria/types";
import { WebSocketServer } from "ws";
import { ACTIVITY_EVENTS, ActivityTracker } from "./activity.js";
import {
  ClusterCalls,
  type ClusterCompletion,
  type ClusterRateLimit,
  type ClusterUses,
} from "./calls.js";
import type { CheckoutSource } from "./checkout.js";
import { ClusterConfigSchema, type RoutingConfig } from "./config.js";
import type { EstimateRow } from "./estimates.js";
import { GuardRegistry, type GuardSourceFn } from "./guards.js";
import { ClusterLink, type HostConnection } from "./link.js";
import { type CapabilityRouting, type ClusterActivity, EndpointRegistry } from "./registry.js";
import { ClusterRelay, type RelayOptions } from "./relay.js";
import { RouteProber } from "./route-probe.js";
import {
  ClusterError,
  type ClusterTables,
  type ControlRecord,
  clusterTables,
  type HostRecord,
  type NewHost,
  type NewInvite,
} from "./tables.js";

/** Largest control-link message: the same cap as an extension frame. */
const MAX_MESSAGE = 16 * 1024 * 1024;

/** The hosts that joined, and the ones connected now. */
export interface ClusterHosts {
  /** Adds a host and returns its key, once (`cluster.host.joined`). */
  create(options: { name: string; approved?: boolean; capabilities?: readonly string[] }): NewHost;
  /** Approves a host for exactly these capabilities (`cluster.host.approved`). */
  approve(name: string, capabilities: readonly string[]): HostRecord;
  /** Revokes its key and closes its link (`cluster.host.removed`). `null`: no such host. */
  revoke(name: string): HostRecord | null;
  /** Deletes its row and closes its link (`cluster.host.removed`). `null`: no such host. */
  remove(name: string): HostRecord | null;
  /** Makes a one-time join code. */
  invite(options: { name?: string | null; ttl_s?: number; by: string }): NewInvite;
  /** Uses a join code: a new pending host, with its key (`cluster.host.joined`). */
  redeem(code: string, name: string): NewHost;
  list(): HostRecord[];
  /** The hosts whose link is up now. */
  connected(): HostConnection[];
  /** Sends a request to a connected host (`host.info`, `service.list`, ...). */
  call(name: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** A routing control the owner sets from the panel (v5-hostd §15.6). */
export type RoutingControlInput =
  | { kind: "pin" | "exclude"; capability: string; host: string }
  | { kind: "weight"; host: string; value: number }
  | { kind: "drain"; host: string };

/** Everything the machines page shows of routing (v5-hostd §15.7). */
export interface RoutingSnapshot {
  capabilities: CapabilityRouting[];
  hosts: ReturnType<EndpointRegistry["hostRouting"]>;
  estimates: EstimateRow[];
  activity: ClusterActivity & { idle: boolean };
  /** `[modules.cluster.routing]` as Core read it. */
  config: RoutingConfig;
  /** The owner's controls from the panel. */
  panel: ControlRecord[];
}

/** Job dispatch as the owner sees and steers it. */
export interface ClusterRouting {
  view(): RoutingSnapshot;
  /** Sets a pin, an exclusion, a weight or a drain; throws `ClusterError` for a bad one. */
  set(control: RoutingControlInput, by: string): ControlRecord;
  /** Takes one away (`capability` for a pin or an exclusion); whether it was there. */
  clear(control: { kind: RoutingControlInput["kind"]; host: string; capability?: string }): boolean;
}

/** What `cluster` offers other modules (`ClusterKey`). */
export interface ClusterService {
  /** Where each capability can be used now. */
  readonly registry: EndpointRegistry;
  readonly hosts: ClusterHosts;
  /** Sources of the guarded states (`cluster.guard`). */
  readonly guards: GuardRegistry;
  /** The address the control link listens on. */
  readonly address: AddressInfo;
  /** `[modules.cluster] public_url`: the link address to give a joining machine, when set. */
  readonly publicUrl: string | null;
  /**
   * Who listens to her and which songs are needed now, for the GPU arbiters of the hosts
   * (`cluster.context`, to every approved host with a `sing`, `tts` or `asr` service). The
   * `sing` module calls it on every poll while a song is prepared. Optional: stand-ins made
   * before H7 leave it out.
   */
  context?(context: HostClusterContext): void;
  /**
   * Core's own checkout: the commit a remote update names, and how a host's commit stands to it
   * (v5-hostd §14). `null` or absent when Core does not run from a git checkout.
   */
  readonly checkout?: CheckoutSource | null;
  /** Job dispatch: the routing of each capability and the owner's controls. Absent in stand-ins. */
  readonly routing?: ClusterRouting;
}

export const ClusterKey = serviceKey<ClusterService>("Cluster");

/** A guard source Core's wiring adds: it reads other modules through their service keys. */
export type ClusterGuard = (services: ServiceLookup) => ReturnType<GuardSourceFn>;

/**
 * Runs a completion for a service of a host (`cluster.llm`) through Core's LLM. Core's wiring
 * gives one that looks its LLM up through its service key, so this package needs no LLM package.
 */
export type ClusterComplete = (
  services: ServiceLookup,
  request: ClusterCompletion,
  signal: AbortSignal,
) => Promise<string>;

/** Core's wiring: the node links (`voice.link`, `stage.link`) that are on, with their tokens. */
export type ClusterLinksSource = (services: ServiceLookup) => HostLinks["links"];

export interface ClusterModuleOptions {
  /** Guard sources that stay for the module's whole life (Core's `singing` and `live`). */
  guards?: readonly ClusterGuard[];
  /** What `welcome` says Core's version is. */
  version?: string;
  /** Limits of the relay over the control link (v5-hostd §7.1). */
  relay?: RelayOptions;
  /** Runs `cluster.llm` completions; without it they fail with `Unavailable`. */
  complete?: ClusterComplete;
  /**
   * By the capability a service provides: what it may use through `cluster.llm`,
   * `cluster.fetch` and `cluster.resolve`. Default `DEFAULT_CLUSTER_USES` (`sing` and `lyrics`:
   * LLM `fast`, fetch `asr`; nothing may resolve).
   */
  uses?: ClusterUses;
  /** The LLM purposes any service may ask for at all. Default `["fast"]`. */
  llmPurposes?: readonly string[];
  /** Completions per host and time window. Default 30 a minute. */
  llmRate?: ClusterRateLimit;
  /**
   * Where Core's node links listen and their tokens, for `cluster.links`. Read when a host
   * connects or is approved, and on `refreshLinks`. Without it hosts are told nothing.
   */
  links?: ClusterLinksSource;
  /** Core's own checkout, for remote updates of the hosts. Without it hosts cannot be updated. */
  checkout?: CheckoutSource | null;
  /**
   * The machines' tables (the hosts, their keys' hashes, invites, estimates, routing controls):
   * Core's wiring gives the install's machine database's (docs/design/v5-profiles.md §7), which
   * stays open across restarts of the module. Default: the store's (`store.plugin(clusterTables)`).
   */
  machines?: ClusterTables;
}

/** How often the `live` guard state is read for the speech-host rule. */
const LIVE_POLL_MS = 5_000;
/** How often the route prober looks for probes that are due (each route has its own interval). */
const ROUTE_TICK_MS = 5_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve();
    }, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The routing service over the registry and the controls table (stand-ins use it too). */
export function clusterRouting(
  registry: EndpointRegistry,
  tables: ClusterTables,
  config: RoutingConfig,
): ClusterRouting {
  const refresh = () => registry.setPanelControls(tables.controls.view());
  return {
    view: () => ({
      capabilities: registry.routingView(),
      hosts: registry.hostRouting(),
      estimates: registry.estimates(),
      activity: registry.activity(),
      config,
      panel: tables.controls.list(),
    }),
    set: (control, by) => {
      const row = tables.controls.set({
        kind: control.kind,
        host: control.host,
        ...("capability" in control ? { capability: control.capability } : {}),
        ...("value" in control ? { value: control.value } : {}),
        by,
      });
      refresh();
      return row;
    },
    clear: (control) => {
      const removed = tables.controls.clear({
        kind: control.kind,
        host: control.host,
        ...(control.capability !== undefined ? { capability: control.capability } : {}),
      });
      refresh();
      return removed;
    },
  };
}

/** `host:port` / `[v6]:port`. */
function parseBind(bind: string): { host: string; port: number } | null {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(bind.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (port > 65_535) return null;
  return { host: (m[1] ?? m[2]) as string, port };
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** The hosts functions over the tables, with their events and their effect on live links. */
function clusterHosts(tables: ClusterTables, link: ClusterLink, publish: Publish): ClusterHosts {
  const removed = (host: HostRecord, how: "revoked" | "deleted") => {
    link.disconnect(host.name, HOST_LINK_CLOSE.UNAUTHORIZED, `host ${how}`);
    publish(Events.ClusterHostRemoved, { host: host.name, how });
  };
  return {
    create: (options) => {
      const made = tables.hosts.create(options);
      publish(Events.ClusterHostJoined, {
        id: made.host.id,
        host: made.host.name,
        status: made.host.status === "approved" ? "approved" : "pending",
      });
      return made;
    },
    approve: (name, capabilities) => {
      const host = tables.hosts.approve(name, capabilities);
      link.approvalChanged(host);
      publish(Events.ClusterHostApproved, { host: host.name, capabilities: host.capabilities });
      return host;
    },
    revoke: (name) => {
      const host = tables.hosts.revoke(name);
      if (host !== null) removed(host, "revoked");
      return host;
    },
    remove: (name) => {
      const host = tables.hosts.remove(name);
      if (host !== null) removed(host, "deleted");
      return host;
    },
    invite: (options) => tables.invites.invite(options),
    redeem: (code, name) => {
      const made = tables.invites.redeem(code, name);
      publish(Events.ClusterHostJoined, {
        id: made.host.id,
        host: made.host.name,
        status: "pending",
      });
      return made;
    },
    list: () => tables.hosts.list(),
    connected: () => link.connected(),
    call: (name, method, params, signal) => link.call(name, method, params, signal),
  };
}

export class ClusterModule implements Module {
  static readonly ID = "cluster";
  readonly manifest = defineManifest(ClusterModule.ID, "Cluster", {
    icon: "network",
    category: "system",
    description: "The control link hosts dial, the hosts that joined, and the service registry",
    configSchema: ClusterConfigSchema,
  });
  /** Outlives restarts of the module: Core's sources are added once. */
  readonly guards = new GuardRegistry();
  readonly #version: string;
  readonly #relay: RelayOptions;
  readonly #options: ClusterModuleOptions;
  #registry: EndpointRegistry | null = null;
  #services: ServiceLookup | null = null;
  #addr: AddressInfo | null = null;
  #link: ClusterLink | null = null;

  constructor(options: ClusterModuleOptions = {}) {
    this.#version = options.version ?? "0.0.0";
    this.#relay = options.relay ?? {};
    this.#options = options;
    for (const guard of options.guards ?? []) {
      this.guards.add(() => (this.#services === null ? null : guard(this.#services)));
    }
  }

  /** The address the server is bound to while running (useful with port 0). */
  localAddr(): AddressInfo | null {
    return this.#addr;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ClusterConfigSchema);
    const bind = parseBind(config.bind);
    if (!bind) throw new ClusterError(`cannot bind the cluster link to \`${config.bind}\``);
    const tables = this.#machines(ctx).withClock(ctx.clock);
    this.#services = ctx.services;

    const activity = new ActivityTracker();
    const registry = new EndpointRegistry({
      order: config.order,
      static: config.static,
      retrySecs: config.retry_secs,
      clock: ctx.clock,
      routing: config.routing,
      estimates: tables.estimates,
      activity: () => activity.snapshot(),
      log: ctx.log,
      routes: config.routes,
    });
    try {
      registry.setPanelControls(tables.controls.view());
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error) }, "cannot read the routing controls");
    }
    const link = new ClusterLink({
      config,
      tables,
      registry,
      guards: this.guards,
      publish: ctx.publisher,
      signal: ctx.signal,
      log: ctx.log,
      coreVersion: this.#version,
      now: () => ctx.clock.now(),
      relay: this.#relay,
      calls: this.#calls(ctx, registry),
      ...(this.#options.links === undefined
        ? {}
        : { links: () => (this.#options.links as ClusterLinksSource)(ctx.services) }),
    });
    // `request` for an endpoint only a host's link reaches goes through that link.
    registry.setRelay(new ClusterRelay((name) => link.relayHost(name)));
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE,
      perMessageDeflate: false,
    });
    const server = createServer((_req, res) => {
      res.writeHead(426, { "content-type": "text/plain" }).end("upgrade required");
    });
    server.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== HOST_LINK_PATH) {
        socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        link.serve(ws, { remote: req.socket.remoteAddress }),
      );
    });
    try {
      await listen(server, bind.host, bind.port);
    } catch (error) {
      throw new ClusterError(
        `cannot bind the cluster link to \`${config.bind}\`: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const addr = server.address() as AddressInfo;
    if (!isLoopback(addr.address)) {
      ctx.log.warn(
        { addr: `${addr.address}:${addr.port}` },
        "the cluster link is reachable from the network over plain WebSocket",
      );
    }
    ctx.log.info({ addr: `${addr.address}:${addr.port}` }, "cluster link listening");
    this.#addr = addr;
    this.#link = link;
    this.#registry = registry;
    ctx.provide(ClusterKey, {
      registry,
      hosts: clusterHosts(tables, link, ctx.publisher),
      guards: this.guards,
      address: addr,
      publicUrl: config.public_url ?? null,
      context: (context) => link.sendContext(context),
      checkout: this.#options.checkout ?? null,
      routing: clusterRouting(registry, tables, config.routing),
    });

    // Where her voice is, for the speech-host rule (v5-hostd §15.5).
    const voice = ctx.subscribe([...ACTIVITY_EVENTS]);
    ctx.spawn("activity", async () => {
      for await (const env of voice) activity.onEvent(env, ctx.clock.now());
    });
    ctx.spawn("live", async (signal) => {
      while (!signal.aborted) {
        try {
          const states = await this.guards.active(() => undefined);
          activity.setLive(states.includes("live"));
        } catch {
          // Unknown: what was read last stays.
        }
        await sleep(LIVE_POLL_MS, signal);
      }
    });

    // The hosts' routes (v5-hostd §16): only hosts with `routes.toml` are probed.
    const prober = new RouteProber({ table: registry.routes, clock: ctx.clock, log: ctx.log });
    ctx.spawn("routes", async (signal) => {
      while (!signal.aborted) {
        await prober
          .tick()
          .catch((error) => ctx.log.warn({ err: errorMessage(error) }, "route probing failed"));
        await sleep(ROUTE_TICK_MS, signal);
      }
    });

    ctx.spawn("server", async (signal) => {
      const failed = new Promise<never>((_, reject) => {
        server.on("error", (error) =>
          reject(new ClusterError("the cluster link server failed", { cause: error })),
        );
      });
      try {
        await Promise.race([aborted(signal), failed]);
      } finally {
        registry.setRelay(null);
        link.closeAll();
        wss.close();
        server.close();
        server.closeAllConnections();
      }
    });
  }

  /**
   * The node links' values (option `links`) may have changed: every connected host whose share
   * changed is told (`cluster.links`). Does nothing while the module is not running.
   */
  refreshLinks(): void {
    this.#link?.refreshLinks();
  }

  /** The machines' tables: the option's, else the store's. */
  #machines(ctx: ModuleContext): ClusterTables {
    if (this.#options.machines !== undefined) return this.#options.machines;
    const store = ctx.services.get(StoreKey);
    if (store === undefined) throw new ClusterError("the cluster module needs the store");
    return store.plugin(clusterTables);
  }

  /** What serves `cluster.resolve`, `cluster.llm` and `cluster.fetch` for this run of the module. */
  #calls(ctx: ModuleContext, registry: EndpointRegistry): ClusterCalls {
    const o = this.#options;
    const complete = o.complete;
    return new ClusterCalls({
      registry,
      complete:
        complete === undefined
          ? null
          : (request, signal) => complete(ctx.services, request, signal),
      clock: ctx.clock,
      ...(o.uses === undefined ? {} : { uses: o.uses }),
      ...(o.llmPurposes === undefined ? {} : { purposes: o.llmPurposes }),
      ...(o.llmRate === undefined ? {} : { llmRate: o.llmRate }),
    });
  }

  async stop(): Promise<void> {
    this.#registry?.setRelay(null);
    this.#registry = null;
    this.#link?.closeAll();
    this.#link = null;
    this.#addr = null;
    this.#services = null;
  }

  async health(): Promise<Health> {
    if (this.#addr === null) return { status: "unhealthy", reason: "not listening" };
    return HEALTHY;
  }
}
