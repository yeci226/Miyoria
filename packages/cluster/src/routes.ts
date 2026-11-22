// The route table (docs/design/v5-hostd.md §16): per connected host, the routes Core may reach its
// services by, what Core measured of each, and which one fits a piece of work. Memory only: it is
// rebuilt from the next report after a Core restart, and measured again.
//
// A host whose report has no `routes` (no `routes.toml`, or an older hostd) is "legacy": the
// table only shows what it has (its advertised address, the relay) and the registry routes it
// exactly as before, one attempt, no fallback. A host with routes is routed here: every request
// picks the best route for its kind of work, a route that fails rests and the next one is tried.
//
// Core checks every route again, whatever the host says: `direct` and `tunnel` need `https:`
// (plain `http:` only to this machine), a service's URL must lie under its route's URL, and a URL
// with credentials is never used.

import {
  HOST_ROUTE,
  type HostReport,
  type HostRouteKind,
  isLoopbackHost,
  routeUrlProblem,
} from "@miyoria/contracts/host";
import { z } from "zod";

/** `[modules.cluster.routes]`: how routes are probed and when a failed one is tried again. */
export const RoutesConfigSchema = z.object({
  /** How often each route of a host is probed (latency and reachability), in seconds. */
  probe_secs: z.number().positive().default(300),
  /** How often a gateway route sends a throughput sample, in seconds; 0: never. */
  sample_secs: z.number().nonnegative().default(1800),
  /** The sample's size, in KiB (at most 1024). */
  sample_kib: z.number().int().positive().max(1024).default(256),
  /** A probe without an answer for this long failed, in ms. */
  timeout_ms: z.number().int().positive().default(5000),
  /** How long a failed route rests, by failures in a row, in seconds; the last repeats. */
  rest_secs: z.array(z.number().positive()).min(1).default([30, 120, 600]),
  /** A download over a route with a body limit travels in ranges of at most this many MB. */
  chunk_mb: z.number().positive().default(64),
});
export type RoutesConfig = z.output<typeof RoutesConfigSchema>;

/** What a piece of work needs of a route. */
export type RouteWork =
  /** Real-time speech and WebSockets: only `tailnet` and `direct`, lowest latency first. */
  | "realtime"
  /** An answer someone waits for: lowest latency first, the relay last. */
  | "interactive"
  /** Large files, `job` work: highest throughput first. */
  | "bulk";

export type RouteHealth = "unknown" | "up" | "down";

/** One route of one host, with what Core measured of it. */
export interface RouteState {
  name: string;
  kind: HostRouteKind;
  /** The route's base (`direct`, `tunnel`: the gateway's URL; `tailnet`: the address). */
  url: string | null;
  maxBodyBytes: number | null;
  /** The owner did not declare it (`advertise`, `local`, the relay). */
  implicit: boolean;
  /** Why it is never used: the host's reason, or Core's check. */
  problem: string | null;
  health: RouteHealth;
  /** The last measured round trip (probe head, or the link's ping for the relay), ms. */
  rttMs: number | null;
  /** Measured throughput, bytes per second (decayed average). */
  bps: number | null;
  /** Throughput samples behind `bps`. */
  samples: number;
  probedAt: number | null;
  sampledAt: number | null;
  /** The last success (probe or real request). */
  okAt: number | null;
  /** Failures in a row. */
  failures: number;
  /** It rests until then after a failure (epoch ms). */
  badUntil: number;
  /** Why it failed last. */
  reason: string | null;
}

/** A route chosen for a service: its URL there, `null` for the relay. */
export interface RouteChoice {
  route: RouteState;
  url: string | null;
}

/** One route as the machines page shows it. */
export interface RouteView {
  name: string;
  kind: HostRouteKind;
  url: string | null;
  implicit: boolean;
  /** `invalid`: it has a problem and is never used. `resting`: it failed and rests. */
  state: "unknown" | "up" | "down" | "resting" | "invalid";
  /** The kinds of work it is the first choice for now. */
  in_use: RouteWork[];
  rtt_ms: number | null;
  mb_s: number | null;
  samples: number;
  max_body_mb: number | null;
  probed_at: number | null;
  ok_at: number | null;
  reason: string | null;
}

interface ServiceRoutes {
  /** Route name → this service's base URL there (checked). */
  reach: Map<string, string>;
  token: string | null;
  serving: boolean;
}

interface HostRoutes {
  /** The report carried `routes`: the registry routes this host through the table. */
  declared: boolean;
  routes: RouteState[];
  services: Map<string, ServiceRoutes>;
  /** The route token of the last report. Never shown. */
  token: string | null;
}

/** Newest sample's weight in the throughput average (the same as the dispatch estimates). */
const ALPHA = 0.3;
const MB = 1024 * 1024;

/** Before anything was measured: round trip in ms and throughput in MB/s, per kind. */
const DEFAULT_RTT_MS: Record<HostRouteKind, number> = {
  tailnet: 40,
  direct: 40,
  tunnel: 150,
  relay: 300,
};
const DEFAULT_MB_S: Record<HostRouteKind, number> = {
  tailnet: 20,
  direct: 20,
  tunnel: 10,
  relay: 8,
};
/** Ties, by work: which kind goes first. */
const RANK_LATENCY: Record<HostRouteKind, number> = { tailnet: 0, direct: 1, tunnel: 2, relay: 3 };
const RANK_BULK: Record<HostRouteKind, number> = { direct: 0, tailnet: 1, tunnel: 2, relay: 3 };

/** Kinds fit for real-time work. */
export const REALTIME_KINDS: ReadonlySet<HostRouteKind> = new Set(["tailnet", "direct"]);
/** Kinds whose services are behind hostd's gateway. */
export const GATEWAY_KINDS: ReadonlySet<HostRouteKind> = new Set(["direct", "tunnel"]);

const SERVING = new Set(["running", "foreign", "external"]);

function fresh(
  name: string,
  kind: HostRouteKind,
  url: string | null,
  extra: Partial<RouteState> = {},
): RouteState {
  return {
    name,
    kind,
    url,
    maxBodyBytes: null,
    implicit: false,
    problem: null,
    health: "unknown",
    rttMs: null,
    bps: null,
    samples: 0,
    probedAt: null,
    sampledAt: null,
    okAt: null,
    failures: 0,
    badUntil: 0,
    reason: null,
    ...extra,
  };
}

function loopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Whether `url` is `base` or lies under it (same origin, path prefix). */
function under(url: string, base: string): boolean {
  try {
    const u = new URL(url);
    const b = new URL(base);
    if (u.origin !== b.origin) return false;
    const prefix = b.pathname.replace(/\/+$/u, "");
    return u.pathname === prefix || u.pathname.startsWith(`${prefix}/`);
  } catch {
    return false;
  }
}

export class RouteTable {
  readonly #hosts = new Map<string, HostRoutes>();
  readonly #config: RoutesConfig;
  readonly #now: () => number;

  constructor(options: { config?: RoutesConfig; now: () => number }) {
    this.#config = options.config ?? RoutesConfigSchema.parse({});
    this.#now = options.now;
  }

  get config(): RoutesConfig {
    return this.#config;
  }

  // ---- what the registry feeds in -----------------------------------------------------------

  /** A host's latest report. Measurements of a route that stays the same are kept. */
  update(host: string, report: HostReport): void {
    const before = this.#hosts.get(host);
    const keep = (next: RouteState): RouteState => {
      const old = before?.routes.find(
        (r) => r.name === next.name && r.kind === next.kind && r.url === next.url,
      );
      if (old === undefined) return next;
      return {
        ...old,
        maxBodyBytes: next.maxBodyBytes,
        implicit: next.implicit,
        problem: next.problem,
      };
    };
    const services = new Map<string, ServiceRoutes>();
    if (report.routes === undefined) {
      // Legacy: what the host has, for the page; the registry routes it as before.
      const routes: RouteState[] = [];
      const advertised = report.services.find((s) => s.advertised !== undefined)?.advertised;
      if (advertised !== undefined) {
        let address: string | null = null;
        try {
          address = new URL(advertised).hostname;
        } catch {
          address = null;
        }
        routes.push(keep(fresh("advertised", "tailnet", address, { implicit: true })));
      }
      routes.push(keep(fresh("relay", "relay", null, { implicit: true })));
      for (const s of report.services) {
        const reach = new Map<string, string>();
        if (s.advertised !== undefined) reach.set("advertised", s.advertised);
        services.set(s.name, { reach, token: s.token ?? null, serving: SERVING.has(s.state) });
      }
      this.#hosts.set(host, { declared: false, routes, services, token: null });
      return;
    }
    const routes: RouteState[] = report.routes.map((r) => {
      const url = r.url ?? null;
      let problem = r.problem ?? null;
      if (problem === null && GATEWAY_KINDS.has(r.kind)) {
        problem = url === null ? `${r.kind} 路線沒有位址` : routeUrlProblem(r.kind, url);
      }
      return keep(
        fresh(r.name, r.kind, url, {
          maxBodyBytes: r.max_body_bytes ?? null,
          implicit: r.implicit === true,
          problem,
        }),
      );
    });
    for (const s of report.services) {
      const reach = new Map<string, string>();
      for (const [name, url] of Object.entries(s.reach ?? {})) {
        const route = routes.find((r) => r.name === name);
        if (route === undefined || route.problem !== null || route.kind === "relay") continue;
        if (routeUrlProblem(route.kind, url) !== null) continue;
        if (GATEWAY_KINDS.has(route.kind) && !under(url, route.url as string)) continue;
        reach.set(name, url);
      }
      services.set(s.name, { reach, token: s.token ?? null, serving: SERVING.has(s.state) });
    }
    this.#hosts.set(host, {
      declared: true,
      routes,
      services,
      token: report.route_token ?? null,
    });
  }

  remove(host: string): void {
    this.#hosts.delete(host);
  }

  /** The control link's ping: the relay's round trip. */
  linkRtt(host: string, ms: number): void {
    const relay = this.#hosts.get(host)?.routes.find((r) => r.kind === "relay");
    if (relay === undefined) return;
    relay.rttMs = ms;
    if (relay.health !== "down") relay.health = "up";
  }

  /** The host's routes are in the table: the registry routes it here. */
  declared(host: string): boolean {
    return this.#hosts.get(host)?.declared === true;
  }

  // ---- outcomes -----------------------------------------------------------------------------

  #route(host: string, name: string): RouteState | undefined {
    return this.#hosts.get(host)?.routes.find((r) => r.name === name);
  }

  /** The route answered (a probe, a request). `rttMs` when it was measured. */
  ok(host: string, name: string, rttMs?: number): void {
    const route = this.#route(host, name);
    if (route === undefined) return;
    route.health = "up";
    route.failures = 0;
    route.badUntil = 0;
    route.reason = null;
    route.okAt = this.#now();
    if (rttMs !== undefined) route.rttMs = rttMs;
  }

  /** The route failed: it rests by `rest_secs` and goes after the others. */
  failed(host: string, name: string, reason: string): void {
    const route = this.#route(host, name);
    if (route === undefined) return;
    const rest = this.#config.rest_secs;
    const secs = rest[Math.min(route.failures, rest.length - 1)] as number;
    route.failures += 1;
    route.health = "down";
    route.badUntil = this.#now() + secs * 1000;
    route.reason = reason;
  }

  /** A transfer of `bytes` took `ms`: a throughput sample of the route. */
  sample(host: string, name: string, bytes: number, ms: number): void {
    const route = this.#route(host, name);
    if (route === undefined || bytes <= 0) return;
    const bps = (bytes / Math.max(1, ms)) * 1000;
    route.bps = route.bps === null ? bps : route.bps * (1 - ALPHA) + bps * ALPHA;
    route.samples += 1;
    route.sampledAt = this.#now();
  }

  /** A probe went out now (whatever it found). */
  probed(host: string, name: string): void {
    const route = this.#route(host, name);
    if (route !== undefined) route.probedAt = this.#now();
  }

  // ---- choosing -----------------------------------------------------------------------------

  /** 0 up, 1 unknown, 2 down but its rest is over, 3 resting. */
  #bucket(r: RouteState, now: number): number {
    if (r.health === "up") return 0;
    if (r.health === "unknown") return 1;
    return r.badUntil <= now ? 2 : 3;
  }

  #rtt(r: RouteState, url: string | null): number {
    if (r.rttMs !== null) return r.rttMs;
    if (url !== null && loopbackUrl(url)) return 1;
    return DEFAULT_RTT_MS[r.kind];
  }

  #bps(r: RouteState, url: string | null): number {
    if (r.bps !== null) return r.bps;
    if (url !== null && loopbackUrl(url)) return 500 * MB;
    return DEFAULT_MB_S[r.kind] * MB;
  }

  /**
   * The routes a request of `service` may take now, best first: the usable routes the service is
   * reached by (and the relay, but not for real-time work), without the ones whose body limit
   * `bodyBytes` exceeds (`null`: unknown size, so not over a limited route). Resting routes go
   * last; they are still tried when nothing else is left.
   */
  plan(
    host: string,
    service: string,
    work: RouteWork,
    body: { bytes: number | null } = { bytes: 0 },
  ): RouteChoice[] {
    const entry = this.#hosts.get(host);
    if (entry === undefined) return [];
    const reach = entry.services.get(service)?.reach ?? new Map<string, string>();
    const now = this.#now();
    const choices: RouteChoice[] = [];
    for (const route of entry.routes) {
      if (route.problem !== null) continue;
      if (work === "realtime" && !REALTIME_KINDS.has(route.kind)) continue;
      if (route.maxBodyBytes !== null && (body.bytes === null || body.bytes > route.maxBodyBytes)) {
        continue;
      }
      if (route.kind === "relay") choices.push({ route, url: null });
      else {
        const url = reach.get(route.name);
        if (url !== undefined) choices.push({ route, url });
      }
    }
    return choices.sort((a, b) => {
      const bucket = this.#bucket(a.route, now) - this.#bucket(b.route, now);
      if (bucket !== 0) return bucket;
      if (work === "bulk") {
        return (
          this.#bps(b.route, b.url) - this.#bps(a.route, a.url) ||
          RANK_BULK[a.route.kind] - RANK_BULK[b.route.kind]
        );
      }
      const relay = Number(a.route.kind === "relay") - Number(b.route.kind === "relay");
      return (
        (work === "interactive" ? relay : 0) ||
        this.#rtt(a.route, a.url) - this.#rtt(b.route, b.url) ||
        RANK_LATENCY[a.route.kind] - RANK_LATENCY[b.route.kind]
      );
    });
  }

  /** The measured (else assumed) throughput of the route bulk work of `service` would take. */
  bulkRate(host: string, service: string): number | null {
    const first = this.plan(host, service, "bulk")[0];
    return first === undefined ? null : this.#bps(first.route, first.url);
  }

  // ---- probing ------------------------------------------------------------------------------

  /** The probes due now: per route its ping, and a throughput sample on gateway routes. */
  due(): ProbeTask[] {
    const now = this.#now();
    const cfg = this.#config;
    const tasks: ProbeTask[] = [];
    for (const [host, entry] of this.#hosts) {
      if (!entry.declared) continue;
      for (const route of entry.routes) {
        if (route.problem !== null || route.kind === "relay") continue;
        const restOver =
          route.health === "down" &&
          route.badUntil <= now &&
          (route.probedAt === null || route.probedAt < route.badUntil);
        const pingDue =
          route.probedAt === null || now - route.probedAt >= cfg.probe_secs * 1000 || restOver;
        if (route.health === "down" && route.badUntil > now) continue;
        if (GATEWAY_KINDS.has(route.kind)) {
          if (entry.token === null || route.url === null) continue;
          const headers = { authorization: `Bearer ${entry.token}` };
          const base = `${route.url.replace(/\/+$/u, "")}${HOST_ROUTE.PROBE_PATH}`;
          if (pingDue) tasks.push({ host, route: route.name, kind: "ping", url: base, headers });
          const sampleDue =
            cfg.sample_secs > 0 &&
            route.health === "up" &&
            !pingDue &&
            (route.sampledAt === null || now - route.sampledAt >= cfg.sample_secs * 1000);
          if (sampleDue) {
            const bytes = cfg.sample_kib * 1024;
            tasks.push({
              host,
              route: route.name,
              kind: "sample",
              url: `${base}?bytes=${bytes}`,
              headers,
              bytes,
            });
          }
          continue;
        }
        if (!pingDue) continue;
        // `tailnet`: a running service's `/health` over that route, with its token.
        const target = [...entry.services.values()].find(
          (s) => s.serving && s.reach.has(route.name),
        );
        if (target === undefined) continue;
        tasks.push({
          host,
          route: route.name,
          kind: "ping",
          url: `${(target.reach.get(route.name) as string).replace(/\/+$/u, "")}/health`,
          headers: target.token === null ? {} : { authorization: `Bearer ${target.token}` },
        });
      }
    }
    return tasks;
  }

  // ---- what the machines page reads ---------------------------------------------------------

  /** A host's routes, never a token. */
  view(host: string): RouteView[] {
    const entry = this.#hosts.get(host);
    if (entry === undefined) return [];
    const now = this.#now();
    const firsts = new Map<string, RouteWork[]>();
    // The first choice per kind of work, over the services that have routes at all.
    const service = [...entry.services.entries()].find(([, s]) => s.serving && s.reach.size > 0);
    for (const work of ["realtime", "interactive", "bulk"] as const) {
      const first = entry.declared
        ? service === undefined
          ? this.#firstWithout(entry, work)
          : this.plan(host, service[0], work)[0]
        : this.#legacyFirst(entry, work);
      if (first === undefined) continue;
      firsts.set(first.route.name, [...(firsts.get(first.route.name) ?? []), work]);
    }
    return entry.routes.map((r) => ({
      name: r.name,
      kind: r.kind,
      url: r.url,
      implicit: r.implicit,
      state:
        r.problem !== null
          ? "invalid"
          : r.health === "down"
            ? r.badUntil > now
              ? "resting"
              : "down"
            : r.health,
      in_use: firsts.get(r.name) ?? [],
      rtt_ms: r.rttMs === null ? null : Math.round(r.rttMs * 10) / 10,
      mb_s: r.bps === null ? null : Math.round((r.bps / MB) * 10) / 10,
      samples: r.samples,
      max_body_mb: r.maxBodyBytes === null ? null : Math.round(r.maxBodyBytes / MB),
      probed_at: r.probedAt,
      ok_at: r.okAt,
      reason: r.problem ?? r.reason,
    }));
  }

  /** No running service to ask for: the relay for everything but real-time work. */
  #firstWithout(entry: HostRoutes, work: RouteWork): RouteChoice | undefined {
    if (work === "realtime") return undefined;
    const relay = entry.routes.find((r) => r.kind === "relay" && r.problem === null);
    return relay === undefined ? undefined : { route: relay, url: null };
  }

  /** Legacy: the advertised address when there is one (real-time work: only it), else the relay. */
  #legacyFirst(entry: HostRoutes, work: RouteWork): RouteChoice | undefined {
    const advertised = entry.routes.find((r) => r.name === "advertised");
    if (advertised !== undefined) return { route: advertised, url: advertised.url };
    return this.#firstWithout(entry, work);
  }
}

/** One probe to send. */
export interface ProbeTask {
  host: string;
  route: string;
  kind: "ping" | "sample";
  url: string;
  headers: Record<string, string>;
  /** For a sample: the bytes it must bring. */
  bytes?: number;
}
