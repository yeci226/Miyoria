// The registry of service endpoints (docs/design/v5-hostd.md §6.3, §15): where each capability can
// be used now. Built from the latest `host.report` of every connected host and from the static
// entries of `[modules.cluster.static]`; nothing of it is stored but the estimates of §15.4 and the
// owner's controls, which the cluster module keeps in its tables.
//
// A host contributes only the capabilities the owner approved it for. A host that disconnects
// loses its endpoints at once. An endpoint that failed rests for `retry_secs` and goes last.
// Module clients call `request` and never build a URL themselves, so the relay of §7.1 needs no
// change in them.
//
// Core's wiring also adds static entries at run time (`addStatic`): the addresses the modules'
// own config keys still name (`[modules.sing] url`, ...) while the move to hostd goes on. They
// come after the other endpoints unless `order` names them, in the order they were added. When a
// host reports a service at the same URL as a static entry, for the same capability, only the
// reported endpoint is returned (it carries the token); it takes the static entry's place in the
// order and answers for its name (`entry`).
//
// How a capability is routed follows the `[routing] class` its hosts report (§15):
// - none reported (descriptors without the table, older hostds, static entries only): as before,
//   the first healthy endpoint in order;
// - `single`: only the instance that was there first; any other is a conflict, never returned;
// - `session`: as before, in order; `openSession` chooses by latency and readiness and sticks;
// - `job`: by score, the time until a new unit would be finished and back on Core (§15.3).
// Whatever the class, an endpoint whose host does not accept work, is not ready, has another
// variant, or that the owner's pin, exclusion or drain keeps out is not returned for new work
// (`all: true` still lists it, last, for callers that look for work an endpoint already holds).

import type {
  HostEndpoint,
  HostReport,
  HostRoutingClass,
  HostRoutingLatency,
  HostServiceRouting,
  HostServiceState,
} from "@miyoria/contracts/host";
import { type Clock, systemClock } from "@miyoria/types";
import {
  type RoutingConfig,
  RoutingConfigSchema,
  type SpeechHostMode,
  type StaticEndpointConfig,
} from "./config.js";
import { type EstimateStore, Estimates } from "./estimates.js";
import { routedRequest } from "./routed.js";
import { type RoutesConfig, RouteTable, type RouteView, type RouteWork } from "./routes.js";
import { ClusterError } from "./tables.js";

/** One place a capability can be used (`HostEndpoint` of the host protocol). */
export type Endpoint = HostEndpoint;

export interface PickOptions {
  /** Only endpoints Core can call itself (a WebSocket service, real-time speech). */
  direct?: boolean;
  /**
   * Only the endpoint of this static entry: the entry itself, or the reported endpoint at the
   * same URL that stands for it.
   */
  entry?: string;
  /**
   * An endpoint that failed lately keeps its place instead of going last (for callers with
   * failover rules of their own). Unhealthy endpoints still go last.
   */
  ignoreResting?: boolean;
  /**
   * Also the endpoints that take no new work now (not accepting, not ready, another variant,
   * pinned elsewhere, excluded, drained, Core's speech host), after the others: for a caller that
   * looks for work an endpoint already holds (a song made there).
   */
  all?: boolean;
  /** For a `job` capability: the size of this unit's results, in bytes (else the estimate). */
  sizeBytes?: number;
}

/** A static entry added at run time (`addStatic`). */
export interface StaticEndpointEntry {
  /** The capabilities it serves. */
  provides: readonly string[];
  /** Its base URL. */
  url: string;
  /** Sent as `authorization: Bearer <token>` when set. */
  token?: string;
  /** Sent with every request (a token for a proxy in front of the service). */
  headers?: Readonly<Record<string, string>>;
}

/**
 * Sends an HTTP request through a host's control link (v5-hostd §7.1). The cluster module sets
 * one while it runs (`ClusterRelay`); without one a `link` endpoint cannot be called.
 */
export interface LinkRelay {
  request(endpoint: Endpoint, path: string, init?: RequestInit): Promise<Response>;
}

/** What `request` throws for a `link` endpoint while there is no relay. */
export class RelayUnavailableError extends ClusterError {
  override name = "RelayUnavailableError";
}

/** Where her voice is now and whether she is busy, for the speech-host rule (§15.5). */
export interface ClusterActivity {
  /** She is in a voice call. */
  in_voice: boolean;
  /** Her broadcast is live. */
  live: boolean;
  /** Epoch ms of the last time someone spoke in voice; `null` when unknown. */
  last_spoke_at: number | null;
}

const QUIET: ClusterActivity = { in_voice: false, live: false, last_spoke_at: null };

/** The owner's controls from the panel (`cluster_controls`), over those of the config. */
export interface PanelControls {
  /** Capability → the only host that takes its new work. */
  pins: Readonly<Record<string, string>>;
  /** Capability → hosts that take none of it. */
  excludes: Readonly<Record<string, readonly string[]>>;
  /** Host → its weight. */
  weights: Readonly<Record<string, number>>;
  /** Hosts that take nothing new. */
  drained: readonly string[];
}

export const NO_PANEL_CONTROLS: PanelControls = {
  pins: {},
  excludes: {},
  weights: {},
  drained: [],
};

/** One unit Core handed to an endpoint (`reserve`): counted against it until done. */
export interface DispatchedUnit {
  /** The endpoint took it (its answer came): a report after this moment counts it itself. */
  accepted(): void;
  /**
   * It ended. `run_ms`: how long it ran there (else, when the host was idle when it was sent, the
   * time since it was sent). `bytes`: the size of its results. `ok: false` teaches nothing (it
   * failed, or it was not a usual unit).
   */
  done(outcome?: { ok?: boolean; run_ms?: number; bytes?: number }): void;
}

/** Why an endpoint got the last units, for the machines page. */
export interface DispatchDecision {
  at: number;
  capability: string;
  host: string;
  service: string;
  /** What the caller called the unit (a song's title), when it said. */
  what?: string;
  /** Every endpoint that was weighed, in order, with its score in seconds or why it was out. */
  scores: Array<{ host: string; service: string; score_s: number | null; reason?: string }>;
}

/** What makes up an endpoint's score, in ms. */
export interface ScoreParts {
  wait_ms: number;
  run_ms: number;
  transfer_ms: number;
  penalty_ms: number;
  /** The penalties, in words. */
  penalties: string[];
  weight: number;
}

/** One endpoint of a capability as the machines page shows it. */
export interface EndpointRouting {
  host: string;
  service: string;
  via: "direct" | "link";
  healthy: boolean;
  resting: boolean;
  /** It takes new work. */
  eligible: boolean;
  /** Why not, in words. */
  reason?: string;
  /** Seconds until a new unit would be back on Core (`job`); `null` for the other classes. */
  score_s: number | null;
  parts?: ScoreParts;
  routing: HostServiceRouting | null;
  load: { running: number; queued: number; age_ms: number; outside?: string } | null;
  /** Units Core sent that its report does not show yet. */
  pending: number;
  /** Its host carries her voice now through one of the services this one yields to. */
  speech: boolean;
  estimate: { unit_s: number | null; rate_mb_s: number | null; units: number; transfers: number };
}

/** A capability's routing as the machines page shows it. */
export interface CapabilityRouting {
  capability: string;
  /** `null`: no host declares one (routed as before). */
  class: HostRoutingClass | null;
  latency: HostRoutingLatency | null;
  yields_to: string[];
  /** The variant every instance must have; `null` without one. */
  variant: string | null;
  speech_mode: SpeechHostMode;
  /** For `single`: the instance used and the others that are not. */
  conflict: { used: string; others: string[] } | null;
  /** Hosts disagree about the class; the strictest is used. */
  class_conflict: string[] | null;
  endpoints: EndpointRouting[];
  decisions: DispatchDecision[];
  sessions: Array<{ key: string; host: string; service: string; since: number }>;
  result_mb: number | null;
}

export interface EndpointRegistryOptions {
  /** Per capability, the hosts (or static entries) to try first. */
  order?: Readonly<Record<string, readonly string[]>>;
  /** Services no hostd manages, by name. */
  static?: Readonly<Record<string, StaticEndpointConfig>>;
  /** How long a failed endpoint rests, in seconds. Default 30. */
  retrySecs?: number;
  clock?: Clock;
  /** For `direct` requests. Default the global `fetch`. */
  fetch?: typeof fetch;
  /** `[modules.cluster.routing]`; default its defaults. */
  routing?: RoutingConfig;
  /** Where the estimates are kept; default nowhere (memory only). */
  estimates?: EstimateStore | null;
  /** Where her voice is now (§15.5); default never busy. */
  activity?: () => ClusterActivity;
  /** Conflicts and the like; default nothing. */
  log?: { warn(fields: object, message: string): void };
  /** `[modules.cluster.routes]`: probing and resting of the hosts' routes (§16). */
  routes?: RoutesConfig;
}

/** Service states in which a service can answer. */
const SERVING: ReadonlySet<HostServiceState> = new Set(["running", "foreign", "external"]);

/** The strictest class wins when hosts disagree. */
const CLASS_RANK: Record<HostRoutingClass, number> = { single: 0, session: 1, job: 2 };

/** Decisions kept per capability. */
const MAX_DECISIONS = 10;
/** Sessions kept at most (the oldest go first). */
const MAX_SESSIONS = 256;
/** A transfer this large or larger is a sample of the rate. */
const RATE_SAMPLE_BYTES = 1024 * 1024;
/** The round trip of a host whose link never answered a ping yet. */
const UNKNOWN_RTT_MS = 1000;
const MB = 1024 * 1024;

interface StaticEntry {
  name: string;
  provides: ReadonlySet<string>;
  url: string;
  headers: Record<string, string>;
  /** Order of `addStatic` calls; `null` for an entry of `[modules.cluster.static]`. */
  added: number | null;
}

/** An endpoint with what decides its place. */
interface Ranked {
  endpoint: Endpoint;
  /** Static entries at the same URL it stands for. */
  standsFor: string[];
  /** Every address Core can call it at (a static entry at one of them is this endpoint). */
  urls: string[];
  /** The earliest `added` of itself and the entries it stands for; `null`: none was added. */
  added: number | null;
  /** Its `[routing]` as its host reports it; `null` from a static entry or an older hostd. */
  routing: HostServiceRouting | null;
  /** Its last load reading and when it was taken, in Core's clock. */
  load: { running: number; queued: number; readAt: number; outside?: string } | null;
  /** Its host is Core's own machine; `null` when unknown. */
  local: boolean | null;
  rttMs: number | null;
  /** When Core first saw it serving (for `single`). */
  firstSeen: number;
}

/** An endpoint weighed for new work. */
interface Weighed {
  r: Ranked;
  eligible: boolean;
  reason?: string;
  speech: boolean;
  resting: boolean;
  pending: number;
  score: number | null;
  parts?: ScoreParts;
}

/** A capability's class as its hosts declare it (`#classOf`). */
interface ClassInfo {
  class: HostRoutingClass | null;
  latency: HostRoutingLatency | null;
  yields_to: string[];
  unit_s: number | null;
  result_mb: number | null;
  conflict: string[] | null;
}

interface HostEntry {
  /** The capabilities it is approved for; empty while pending. */
  approved: ReadonlySet<string>;
  report: HostReport | null;
  /** Core's clock when the report came. */
  reportedAt: number;
  /** Its link comes from Core's own machine; `null` when unknown. */
  local: boolean | null;
  rttMs: number | null;
}

interface Reservation {
  id: number;
  /** `restKey` of its endpoint. */
  key: string;
  host: string;
  capability: string;
  at: number;
  acceptedAt: number | null;
  /** The host was known to be idle when it was sent: the time to done is its run time. */
  idle: boolean;
}

function restKey(endpoint: Endpoint): string {
  return `${endpoint.host}\u0000${endpoint.service}\u0000${endpoint.capability}`;
}

function bearer(token: string | undefined): Record<string, string> {
  return token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` };
}

/** What two URLs of the same place have in common. */
function sameUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "").toLowerCase();
}

function minAdded(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** `url` + `path` with exactly one slash between them. */
function join(url: string, path: string): string {
  if (path === "") return url;
  return `${url.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/** The endpoint's headers under the caller's: the caller's win. */
function mergeHeaders(base: Record<string, string>, own: RequestInit["headers"]): Headers {
  const headers = new Headers(base);
  if (own !== undefined) {
    for (const [name, value] of new Headers(own)) headers.set(name, value);
  }
  return headers;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a URL names this machine: `localhost`, `127.x`, `::1`. */
function loopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/u.test(host);
  } catch {
    return false;
  }
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;

/** The key under which `#speechHosts` says Core's own machine carries her voice. */
const CORE_MACHINE = "\u0000core-machine";

export class EndpointRegistry {
  readonly #hosts = new Map<string, HostEntry>();
  readonly #order: Readonly<Record<string, readonly string[]>>;
  readonly #static = new Map<string, StaticEntry>();
  #added = 0;
  readonly #retryMs: number;
  readonly #clock: Clock;
  readonly #fetch: typeof fetch;
  /** Endpoint key → when it may be tried again (epoch ms). */
  readonly #resting = new Map<string, number>();
  readonly #watchers = new Map<string, Set<() => void>>();
  /** The last list each watched capability was told about. */
  readonly #seen = new Map<string, string>();
  #relay: LinkRelay | null = null;
  readonly #routing: RoutingConfig;
  readonly #estimates: Estimates;
  #activity: () => ClusterActivity;
  readonly #log: EndpointRegistryOptions["log"];
  #panel: PanelControls = NO_PANEL_CONTROLS;
  /** `host\0service` → when Core first saw it serving. */
  readonly #firstSeen = new Map<string, number>();
  readonly #reservations = new Map<number, Reservation>();
  #nextReservation = 1;
  readonly #decisions = new Map<string, DispatchDecision[]>();
  /** `capability\0key` → where that session runs. */
  readonly #sessions = new Map<
    string,
    { capability: string; key: string; host: string; service: string; since: number }
  >();
  /** The last conflicts logged, by capability, so each is logged once. */
  readonly #conflicts = new Map<string, string>();
  /** Each connected host's routes and what was measured of them (§16). */
  readonly #routes: RouteTable;

  constructor(options: EndpointRegistryOptions = {}) {
    this.#order = options.order ?? {};
    this.#retryMs = (options.retrySecs ?? 30) * 1000;
    this.#clock = options.clock ?? systemClock;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#routing = options.routing ?? RoutingConfigSchema.parse({});
    this.#activity = options.activity ?? (() => QUIET);
    this.#log = options.log;
    this.#routes = new RouteTable({
      ...(options.routes !== undefined ? { config: options.routes } : {}),
      now: () => this.#clock.now(),
    });
    this.#estimates = new Estimates({
      store: options.estimates ?? null,
      now: () => this.#clock.now(),
      onError: (error) =>
        this.#log?.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "cannot keep the dispatch estimates",
        ),
    });
    for (const [name, entry] of Object.entries(options.static ?? {})) {
      this.#static.set(name, {
        name,
        provides: new Set(entry.provides),
        url: entry.url,
        headers: bearer(entry.token),
        added: null,
      });
    }
  }

  // ---- what Core's wiring adds -----------------------------------------------------------------

  /**
   * Adds a static entry while Core runs (an address a module's own config still names). It comes
   * after the other endpoints of its capabilities unless `order` names it, in the order entries
   * were added. Returns the function that removes it again. Throws when the name is taken.
   */
  addStatic(name: string, entry: StaticEndpointEntry): () => void {
    if (this.#static.has(name)) {
      throw new ClusterError(`there is a static endpoint named \`${name}\` already`);
    }
    const added: StaticEntry = {
      name,
      provides: new Set(entry.provides),
      url: entry.url,
      headers: { ...(entry.headers ?? {}), ...bearer(entry.token) },
      added: this.#added++,
    };
    this.#static.set(name, added);
    this.#changed();
    return () => {
      if (this.#static.get(name) !== added) return;
      this.#static.delete(name);
      for (const key of [...this.#resting.keys()]) {
        if (key.startsWith(`${name}\u0000${name}\u0000`)) this.#resting.delete(key);
      }
      this.#changed();
    };
  }

  /** Where her voice is now, for the speech-host rule; the cluster module sets one. */
  setActivity(activity: () => ClusterActivity): void {
    this.#activity = activity;
    this.#changed();
  }

  /** The owner's controls from the panel, over those of the config. */
  setPanelControls(controls: PanelControls): void {
    this.#panel = controls;
    this.#changed();
  }

  // ---- what the link feeds in ----------------------------------------------------------------

  /** A host connected, or its approval changed. `null` capabilities: pending, nothing is used. */
  setHost(name: string, approved: readonly string[] | null): void {
    const entry = this.#hosts.get(name);
    this.#hosts.set(name, {
      approved: new Set(approved ?? []),
      report: entry?.report ?? null,
      reportedAt: entry?.reportedAt ?? 0,
      local: entry?.local ?? null,
      rttMs: entry?.rttMs ?? null,
    });
    this.#changed();
  }

  /**
   * What the link knows of a connected host: whether it dials from Core's own machine, and the
   * last round trip of a ping, in ms.
   */
  setLink(name: string, link: { local?: boolean; rttMs?: number }): void {
    const entry = this.#hosts.get(name);
    if (entry === undefined) return;
    if (link.local !== undefined) entry.local = link.local;
    if (link.rttMs !== undefined) {
      entry.rttMs = link.rttMs;
      this.#routes.linkRtt(name, link.rttMs);
    }
  }

  /** A host's latest report. Ignored for a host that is not connected. */
  report(name: string, report: HostReport): void {
    const entry = this.#hosts.get(name);
    if (entry === undefined) return;
    entry.report = report;
    entry.reportedAt = this.#clock.now();
    this.#routes.update(name, report);
    const serving = new Set(
      report.services.filter((s) => SERVING.has(s.state)).map((s) => `${name}\u0000${s.name}`),
    );
    for (const key of [...this.#firstSeen.keys()]) {
      if (key.startsWith(`${name}\u0000`) && !serving.has(key)) this.#firstSeen.delete(key);
    }
    for (const key of serving) {
      if (!this.#firstSeen.has(key)) this.#firstSeen.set(key, entry.reportedAt);
    }
    this.#changed();
  }

  /** A host disconnected or was removed: its endpoints go at once. */
  removeHost(name: string): void {
    if (!this.#hosts.delete(name)) return;
    this.#routes.remove(name);
    for (const key of [...this.#resting.keys()]) {
      if (key.startsWith(`${name}\u0000`)) this.#resting.delete(key);
    }
    for (const key of [...this.#firstSeen.keys()]) {
      if (key.startsWith(`${name}\u0000`)) this.#firstSeen.delete(key);
    }
    for (const [key, session] of this.#sessions) {
      if (session.host === name) this.#sessions.delete(key);
    }
    this.#changed();
  }

  /** The hosts whose reports are held (connected ones). */
  hosts(): string[] {
    return [...this.#hosts.keys()].sort();
  }

  /** The hosts' routes, for the prober (§16). */
  get routes(): RouteTable {
    return this.#routes;
  }

  /** Installs the relay for `link` endpoints (v5-hostd §7.1); `null` takes it away. */
  setRelay(relay: LinkRelay | null): void {
    this.#relay = relay;
  }

  // ---- what modules ask ----------------------------------------------------------------------

  /** Every capability that has an endpoint now (approved and serving, or static), sorted. */
  capabilities(): string[] {
    const found = new Set<string>();
    for (const entry of this.#hosts.values()) {
      if (entry.report === null) continue;
      for (const service of entry.report.services) {
        for (const capability of service.provides) {
          if (entry.approved.has(capability)) found.add(capability);
        }
      }
    }
    for (const entry of this.#static.values()) {
      for (const capability of entry.provides) found.add(capability);
    }
    return [...found].filter((c) => this.#all(c, {}).length > 0).sort();
  }

  /** The first healthy endpoint that is not resting, in order; `null` when there is none. */
  pick(capability: string, options: PickOptions = {}): Endpoint | null {
    const now = this.#clock.now();
    const first = this.candidates(capability, { ...options, all: false })[0];
    return first?.healthy && !this.#isResting(first, now) ? first : null;
  }

  /**
   * Every endpoint of `capability` that takes new work, for callers with their own failover:
   * healthy ones that are not resting first. For a `job` capability by score (§15.3); otherwise
   * each group in `order`, then the reported endpoints and the entries of `[modules.cluster.static]`
   * by host and service name, then the entries added at run time in the order they were added. For
   * `single` only the instance that was there first. `all` adds the others at the end.
   */
  candidates(capability: string, options: PickOptions = {}): Endpoint[] {
    return this.#weigh(capability, options).map((w) => w.r.endpoint);
  }

  /** Passes over `endpoint` for `retry_secs`: it goes last until then. */
  failed(endpoint: Endpoint, _error?: unknown): void {
    if (this.#retryMs <= 0) return;
    this.#resting.set(restKey(endpoint), this.#clock.now() + this.#retryMs);
    this.#changed();
  }

  /**
   * Sends an HTTP request to `endpoint`: `fetch(url + path)` for a direct one, with its headers
   * (the bearer token) under the caller's; through the host's control link for a `link` one. For a
   * `job` capability a large answer is a sample of the host's transfer rate (§15.4).
   */
  async request(endpoint: Endpoint, path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    if (this.#hosts.has(endpoint.host) && this.#routes.declared(endpoint.host)) {
      response = await routedRequest(
        {
          table: this.#routes,
          fetch: this.#fetch,
          now: () => this.#clock.now(),
          relay: (e, p, i) =>
            this.#relay === null
              ? null
              : this.#relay.request(
                  {
                    ...endpoint,
                    ...e,
                    via: "link",
                    url: `link://${e.host}/${e.service}`,
                  },
                  p,
                  i,
                ),
        },
        endpoint,
        path,
        init,
        this.#workOf(endpoint),
      );
    } else if (endpoint.via === "link") {
      const relay = this.#relay;
      if (relay === null) {
        throw new RelayUnavailableError(
          `\`${endpoint.service}\` on \`${endpoint.host}\` is reachable only through its control link, and the cluster module's relay is not running`,
        );
      }
      response = await relay.request(endpoint, path, init);
    } else {
      response = await this.#fetch(join(endpoint.url, path), {
        ...init,
        headers: mergeHeaders(endpoint.headers, init.headers),
      });
    }
    if (this.#classOf(endpoint.capability).class !== "job") return response;
    return this.#measured(endpoint, response);
  }

  /** Calls `onChange` whenever the endpoints of `capability` change. Returns the dispose. */
  watch(capability: string, onChange: () => void): () => void {
    let set = this.#watchers.get(capability);
    if (set === undefined) {
      set = new Set();
      this.#watchers.set(capability, set);
      this.#seen.set(capability, this.#signature(capability));
    }
    set.add(onChange);
    return () => {
      const current = this.#watchers.get(capability);
      if (current === undefined) return;
      current.delete(onChange);
      if (current.size === 0) {
        this.#watchers.delete(capability);
        this.#seen.delete(capability);
      }
    };
  }

  // ---- dispatch (§15.3) ----------------------------------------------------------------------

  /**
   * A unit is being sent to `endpoint`: it counts against that endpoint (so the next unit goes
   * elsewhere while this one is not in a report yet) until it is done, a report shows it, or
   * `reserve_secs` pass (`max_unit_secs` for a host that reports no load). Records the decision.
   */
  reserve(endpoint: Endpoint, unit: { what?: string; sizeBytes?: number } = {}): DispatchedUnit {
    const now = this.#clock.now();
    const capability = endpoint.capability;
    const weighed = this.#weigh(capability, {
      all: true,
      ...(unit.sizeBytes !== undefined ? { sizeBytes: unit.sizeBytes } : {}),
    });
    const key = restKey(endpoint);
    const mine = weighed.find((w) => restKey(w.r.endpoint) === key);
    const idle =
      mine !== undefined &&
      mine.r.load !== null &&
      mine.r.load.running + mine.r.load.queued + mine.pending === 0;
    const decision: DispatchDecision = {
      at: now,
      capability,
      host: endpoint.host,
      service: endpoint.service,
      ...(unit.what !== undefined ? { what: unit.what } : {}),
      scores: weighed.map((w) => ({
        host: w.r.endpoint.host,
        service: w.r.endpoint.service,
        score_s: w.score === null ? null : seconds(w.score),
        ...(w.reason !== undefined ? { reason: w.reason } : {}),
      })),
    };
    const list = this.#decisions.get(capability) ?? [];
    list.unshift(decision);
    this.#decisions.set(capability, list.slice(0, MAX_DECISIONS));
    const id = this.#nextReservation++;
    const reservation: Reservation = {
      id,
      key,
      host: endpoint.host,
      capability,
      at: now,
      acceptedAt: null,
      idle,
    };
    this.#reservations.set(id, reservation);
    this.#changed();
    let ended = false;
    return {
      accepted: () => {
        if (ended || reservation.acceptedAt !== null) return;
        reservation.acceptedAt = this.#clock.now();
      },
      done: (outcome = {}) => {
        if (ended) return;
        ended = true;
        this.#reservations.delete(id);
        if (outcome.ok !== false) {
          const ran =
            outcome.run_ms ?? (reservation.idle ? this.#clock.now() - reservation.at : undefined);
          if (ran !== undefined) this.#estimates.unit(endpoint.host, capability, ran);
          if (outcome.bytes !== undefined) this.#estimates.size(capability, outcome.bytes);
        }
        this.#changed();
      },
    };
  }

  /**
   * Starts a session of `capability` under `key` (a karaoke room, a call): the endpoint nearest
   * Core among those that take new work (for `realtime`, the same machine, then the lowest round
   * trip; otherwise `order` first), and it stays there (`session`) until it ends or its endpoint
   * goes; another endpoint is only for the next session.
   */
  openSession(capability: string, key: string): Endpoint | null {
    const now = this.#clock.now();
    const { latency } = this.#classOf(capability);
    const eligible = this.#weigh(capability, { ignoreResting: true }).filter((w) => w.eligible);
    const distance = (r: Ranked) => (r.local === true ? 0 : (r.rttMs ?? UNKNOWN_RTT_MS));
    const listed = this.#order[capability] ?? [];
    const rank = (r: Ranked) => this.#orderRank(r, listed);
    const ready = (w: Weighed) => (w.r.endpoint.healthy && !w.resting ? 0 : 1);
    const sorted = [...eligible].sort((a, b) => {
      const first =
        latency === "realtime"
          ? distance(a.r) - distance(b.r) || rank(a.r) - rank(b.r)
          : rank(a.r) - rank(b.r) || distance(a.r) - distance(b.r);
      return (
        ready(a) - ready(b) ||
        first ||
        byText(a.r.endpoint.host, b.r.endpoint.host) ||
        byText(a.r.endpoint.service, b.r.endpoint.service)
      );
    });
    const chosen = sorted[0]?.r.endpoint ?? null;
    if (chosen === null) return null;
    this.#sessions.delete(`${capability}\u0000${key}`);
    this.#sessions.set(`${capability}\u0000${key}`, {
      capability,
      key,
      host: chosen.host,
      service: chosen.service,
      since: now,
    });
    while (this.#sessions.size > MAX_SESSIONS) {
      this.#sessions.delete(this.#sessions.keys().next().value as string);
    }
    return chosen;
  }

  /** Where the session `key` runs, while its endpoint is there; `null` otherwise. */
  session(capability: string, key: string): Endpoint | null {
    const placed = this.#sessions.get(`${capability}\u0000${key}`);
    if (placed === undefined) return null;
    const found = this.#all(capability, {}).find(
      (r) => r.endpoint.host === placed.host && r.endpoint.service === placed.service,
    );
    return found?.endpoint ?? null;
  }

  /** The session `key` ended. */
  closeSession(capability: string, key: string): void {
    this.#sessions.delete(`${capability}\u0000${key}`);
  }

  // ---- what the machines page reads ------------------------------------------------------------

  /** Every capability's routing: class, endpoints with their scores or why not, decisions. */
  routingView(): CapabilityRouting[] {
    return this.capabilities().map((capability) => {
      const info = this.#classOf(capability);
      const all = this.#all(capability, {});
      const single = info.class === "single" ? this.#single(capability, all) : null;
      const weighed = this.#weigh(capability, { all: true });
      return {
        capability,
        class: info.class,
        latency: info.latency,
        yields_to: info.yields_to,
        variant: this.#reference(
          capability,
          all,
          info.class === "job" ? this.#speechHosts(info.yields_to) : new Map(),
          this.#pinOf(capability),
        ),
        speech_mode: this.#speechMode(capability),
        conflict:
          single === null || single.others.length === 0
            ? null
            : {
                used: `${single.used.endpoint.host}/${single.used.endpoint.service}`,
                others: single.others.map((r) => `${r.endpoint.host}/${r.endpoint.service}`),
              },
        class_conflict: info.conflict,
        endpoints: weighed.map((w) => this.#endpointView(capability, w)),
        decisions: [...(this.#decisions.get(capability) ?? [])],
        sessions: [...this.#sessions.values()]
          .filter((s) => s.capability === capability)
          .map(({ key, host, service, since }) => ({ key, host, service, since })),
        result_mb: this.#resultBytes(capability, info) / MB,
      };
    });
  }

  /**
   * Each connected host: Core's own machine, its round trip, drained (and why), its weight, and
   * its routes with what was measured of them (never a token).
   */
  hostRouting(): Array<{
    host: string;
    local: boolean | null;
    rtt_ms: number | null;
    drained: string | null;
    weight: number;
    routes: RouteView[];
  }> {
    return this.hosts().map((host) => {
      const entry = this.#hosts.get(host) as HostEntry;
      return {
        host,
        local: entry.local,
        rtt_ms: entry.rttMs,
        drained: this.#drained(host),
        weight: this.#weight(host),
        routes: this.#routes.view(host),
      };
    });
  }

  /** What Core has measured, per host and capability. */
  estimates() {
    return this.#estimates.all();
  }

  /** Her activity as the speech-host rule sees it now. */
  activity(): ClusterActivity & { idle: boolean } {
    const now = this.#activity();
    return { ...now, idle: this.#idle(now) };
  }

  // ---- inside --------------------------------------------------------------------------------

  /**
   * What a request needs of a route: real-time for what a `direct` query returned, bulk for `job`
   * and `batch` work, else an answer someone waits for.
   */
  #workOf(endpoint: Endpoint): RouteWork {
    if (endpoint.direct_only === true) return "realtime";
    const info = this.#classOf(endpoint.capability);
    if (info.class === "job" || info.latency === "batch") return "bulk";
    return "interactive";
  }

  #isResting(endpoint: Endpoint, now: number): boolean {
    const until = this.#resting.get(restKey(endpoint));
    if (until === undefined) return false;
    if (until > now) return true;
    this.#resting.delete(restKey(endpoint));
    return false;
  }

  #orderRank(r: Ranked, listed: readonly string[]): number {
    let best = listed.length;
    for (const name of [r.endpoint.host, ...r.standsFor]) {
      const i = listed.indexOf(name);
      if (i >= 0 && i < best) best = i;
    }
    return best;
  }

  /**
   * The class a capability's hosts declare, with its latency and what it yields to; the strictest
   * class when they disagree (`conflict` lists what each said). `null`: none declares one.
   */
  #classOf(capability: string): ClassInfo {
    const said = new Map<string, HostServiceRouting>();
    for (const [name, entry] of this.#hosts) {
      if (!entry.approved.has(capability) || entry.report === null) continue;
      for (const service of entry.report.services) {
        if (!service.provides.includes(capability) || service.routing === undefined) continue;
        said.set(`${name}/${service.name}`, service.routing);
      }
    }
    if (said.size === 0) {
      return {
        class: null,
        latency: null,
        yields_to: [],
        unit_s: null,
        result_mb: null,
        conflict: null,
      };
    }
    const routings = [...said.values()];
    const strictest = routings.reduce((a, b) =>
      CLASS_RANK[b.class] < CLASS_RANK[a.class] ? b : a,
    );
    const classes = new Set(routings.map((r) => r.class));
    const yields = new Set<string>();
    for (const r of routings) for (const y of r.yields_to) yields.add(y);
    return {
      class: strictest.class,
      latency: strictest.latency,
      yields_to: [...yields].sort(),
      unit_s: routings.find((r) => r.unit_s !== undefined)?.unit_s ?? null,
      result_mb: routings.find((r) => r.result_mb !== undefined)?.result_mb ?? null,
      conflict:
        classes.size > 1 ? [...said].map(([where, r]) => `${where}: ${r.class}`).sort() : null,
    };
  }

  /** `single`: the instance there first (then `order`, then names) and the others. */
  #single(capability: string, all: Ranked[]): { used: Ranked; others: Ranked[] } | null {
    if (all.length === 0) return null;
    const listed = this.#order[capability] ?? [];
    const sorted = [...all].sort(
      (a, b) =>
        a.firstSeen - b.firstSeen ||
        this.#orderRank(a, listed) - this.#orderRank(b, listed) ||
        byText(a.endpoint.host, b.endpoint.host) ||
        byText(a.endpoint.service, b.endpoint.service),
    );
    const [used, ...others] = sorted as [Ranked, ...Ranked[]];
    const text = others.map((r) => `${r.endpoint.host}/${r.endpoint.service}`).join(",");
    if (this.#conflicts.get(capability) !== text) {
      this.#conflicts.set(capability, text);
      if (others.length > 0) {
        this.#log?.warn(
          {
            capability,
            used: `${used.endpoint.host}/${used.endpoint.service}`,
            others: others.map((r) => `${r.endpoint.host}/${r.endpoint.service}`),
          },
          "more than one instance of a single service: only the first is used",
        );
      }
    }
    return { used, others };
  }

  /**
   * The variant every instance must have: the config's, else the one most instances report (a
   * tie goes to `order`, then names). `null` when none reports one.
   */
  #variantOf(capability: string, all: Ranked[]): string | null {
    const configured = this.#routing.capabilities[capability]?.variant;
    if (configured !== undefined) return configured;
    const listed = this.#order[capability] ?? [];
    const counts = new Map<string, { n: number; best: Ranked }>();
    for (const r of all) {
      const v = r.routing?.variant;
      if (v === undefined) continue;
      const seen = counts.get(v);
      if (seen === undefined) counts.set(v, { n: 1, best: r });
      else {
        seen.n += 1;
        if (this.#orderRank(r, listed) < this.#orderRank(seen.best, listed)) seen.best = r;
      }
    }
    let winner: { v: string; n: number; best: Ranked } | null = null;
    for (const [v, { n, best }] of counts) {
      if (
        winner === null ||
        n > winner.n ||
        (n === winner.n &&
          (this.#orderRank(best, listed) - this.#orderRank(winner.best, listed) ||
            byText(best.endpoint.host, winner.best.endpoint.host)) < 0)
      ) {
        winner = { v, n, best };
      }
    }
    return winner?.v ?? null;
  }

  /**
   * The variant judged against: chosen among the endpoints that would take work for every other
   * reason (a host that is drained or carries her voice does not decide it), else among all.
   */
  #reference(
    capability: string,
    all: Ranked[],
    speech: Map<string, string[]>,
    pin: string | null,
  ): string | null {
    const usable = all.filter((r) => this.#exclusion(capability, r, null, speech, pin) === null);
    return this.#variantOf(capability, usable.length > 0 ? usable : all);
  }

  #speechMode(capability: string): SpeechHostMode {
    return (
      this.#routing.capabilities[capability]?.allow_on_speech_host ??
      this.#routing.allow_on_speech_host
    );
  }

  #idle(activity: ClusterActivity): boolean {
    if (activity.in_voice || activity.live) return false;
    if (activity.last_spoke_at === null) return true;
    return this.#clock.now() - activity.last_spoke_at >= this.#routing.idle_minutes * 60_000;
  }

  /**
   * The hosts whose services named in `yields` carry her voice now: a service of that name (or
   * capability) whose capability's session runs there, or, with no session, that a new request of
   * that capability would go to. With the services, for the reason.
   */
  #speechHosts(yields: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (yields.length === 0) return out;
    const used = new Map<string, Set<string>>();
    const usedFor = (capability: string): Set<string> => {
      let hosts = used.get(capability);
      if (hosts !== undefined) return hosts;
      hosts = new Set<string>();
      for (const s of this.#sessions.values()) if (s.capability === capability) hosts.add(s.host);
      // With no session: where a new request would go. A `job` capability is not asked (its
      // order is what is being worked out); her voice is `session` work.
      if (hosts.size === 0 && this.#classOf(capability).class !== "job") {
        const first = this.#weigh(capability, {})[0];
        if (first !== undefined) hosts.add(first.r.endpoint.host);
      }
      used.set(capability, hosts);
      return hosts;
    };
    for (const [name, entry] of this.#hosts) {
      if (entry.report === null) continue;
      for (const service of entry.report.services) {
        if (!SERVING.has(service.state)) continue;
        const named =
          yields.includes(service.name) || service.provides.some((p) => yields.includes(p));
        if (!named) continue;
        const carries = service.provides.some((p) => entry.approved.has(p) && usedFor(p).has(name));
        if (!carries) continue;
        const list = out.get(name) ?? [];
        list.push(service.name);
        out.set(name, list);
        // Core's own machine carries her voice: a static entry at a loopback address (an address
        // key of the config, not a host) is on that machine too.
        if (entry.local === true)
          out.set(CORE_MACHINE, [...(out.get(CORE_MACHINE) ?? []), service.name]);
      }
    }
    return out;
  }

  #drained(host: string): string | null {
    if (this.#panel.drained.includes(host)) return "擁有者在面板設定清空";
    if (this.#routing.drain.includes(host)) return "設定檔設定清空";
    const upgrade = this.#hosts.get(host)?.report?.upgrade;
    if (upgrade !== undefined && upgrade !== null && upgrade.finished_at === undefined) {
      return "正在更新,不接新工作";
    }
    return null;
  }

  #weight(host: string): number {
    return this.#panel.weights[host] ?? this.#routing.weights[host] ?? 1;
  }

  #pinOf(capability: string): string | null {
    return this.#panel.pins[capability] ?? this.#routing.capabilities[capability]?.pin ?? null;
  }

  #excluded(capability: string, host: string): boolean {
    return (
      (this.#panel.excludes[capability] ?? []).includes(host) ||
      (this.#routing.capabilities[capability]?.exclude ?? []).includes(host)
    );
  }

  /** Units sent to the endpoint that its last load reading does not show yet. */
  #pending(r: Ranked, now: number): number {
    const key = restKey(r.endpoint);
    let n = 0;
    for (const res of [...this.#reservations.values()]) {
      if (res.key !== key) continue;
      const age = now - res.at;
      if (age > this.#routing.max_unit_secs * 1000) {
        this.#reservations.delete(res.id);
        continue;
      }
      if (r.load === null) {
        n += 1;
        continue;
      }
      if (age > this.#routing.reserve_secs * 1000) continue;
      // A reading taken after the endpoint took the unit counts it itself.
      if (r.load.readAt > (res.acceptedAt ?? res.at)) continue;
      n += 1;
    }
    return n;
  }

  #unitMs(host: string, capability: string, info: { unit_s: number | null }): number {
    const measured = this.#estimates.get(host, capability)?.unit_ms;
    if (measured !== null && measured !== undefined) return measured;
    const seconds =
      this.#routing.capabilities[capability]?.unit_secs ??
      info.unit_s ??
      this.#routing.default_unit_secs;
    return seconds * 1000;
  }

  #resultBytes(capability: string, info: { result_mb: number | null }): number {
    const configured = this.#routing.capabilities[capability]?.result_mb;
    if (configured !== undefined) return configured * MB;
    const measured = this.#estimates.get("*", capability)?.size_bytes;
    if (measured !== null && measured !== undefined) return measured;
    return (info.result_mb ?? 0) * MB;
  }

  #rateBps(r: Ranked): number {
    const measured = this.#estimates.get(r.endpoint.host, r.endpoint.capability)?.rate_bps;
    if (measured !== null && measured !== undefined) return measured;
    if (this.#routes.declared(r.endpoint.host)) {
      const rate = this.#routes.bulkRate(r.endpoint.host, r.endpoint.service);
      if (rate !== null) return rate;
    }
    const t = this.#routing.transfer_mb_s;
    const mbs = r.local === true ? t.local : r.endpoint.via === "link" ? t.link : t.direct;
    return mbs * MB;
  }

  /**
   * Why an endpoint takes no new work now, or `null`; and whether its host carries her voice.
   * `speech` is the hosts of `#speechHosts` for this capability's `yields_to`.
   */
  #exclusion(
    capability: string,
    r: Ranked,
    variant: string | null,
    speech: Map<string, string[]>,
    pin: string | null,
  ): string | null {
    const host = r.endpoint.host;
    const routing = r.routing;
    if (routing?.accept === false) return "這台的主人設定不接受工作(host.toml accept = false)";
    if (routing !== null && !routing.ready) return routing.reason ?? "這台還沒準備好";
    if (variant !== null && routing?.variant !== undefined && routing.variant !== variant) {
      return `版本 ${routing.variant} 和其他台的 ${variant} 不同,結果不能互換`;
    }
    if (pin !== null && host !== pin && !r.standsFor.includes(pin)) return `釘在 ${pin}`;
    if (this.#excluded(capability, host)) return "被排除在這個能力之外";
    const drained = this.#drained(host);
    if (drained !== null) return drained;
    // A static entry has no host of its own: on a loopback address it is Core's machine.
    const carrying =
      speech.get(host) ??
      (r.routing === null && r.local === true ? speech.get(CORE_MACHINE) : undefined);
    if (carrying !== undefined) {
      const mode = this.#speechMode(capability);
      const voice = carrying.join("、");
      if (mode === "never") return `她的語音(${voice})在這台,工作不送來這裡`;
      if (mode === "when_idle" && !this.#idle(this.#activity())) {
        return `她的語音(${voice})在這台,她在語音、直播或剛說過話`;
      }
    }
    return null;
  }

  /**
   * The endpoints of `capability` in the order `candidates` returns them, each with whether it
   * takes new work and, for `job`, its score.
   */
  #weigh(capability: string, options: PickOptions): Weighed[] {
    const now = this.#clock.now();
    const info = this.#classOf(capability);
    let all = this.#all(capability, options);
    if (options.entry !== undefined) {
      const entry = options.entry;
      all = all.filter((r) => r.endpoint.host === entry || r.standsFor.includes(entry));
    }
    if (info.class === "single") {
      const single = this.#single(capability, this.#all(capability, {}));
      if (single === null) return [];
      const usedKey = restKey(single.used.endpoint);
      const rows: Weighed[] = all.map((r) => {
        const isUsed = restKey(r.endpoint) === usedKey;
        return {
          r,
          eligible: isUsed,
          ...(isUsed ? {} : { reason: "同一個服務只能有一個,這是多出來的那個,不會被使用" }),
          speech: false,
          resting: this.#isResting(r.endpoint, now),
          pending: 0,
          score: null,
        };
      });
      const used = rows.filter((w) => w.eligible);
      return options.all === true ? [...used, ...rows.filter((w) => !w.eligible)] : used;
    }
    const speech = info.class === "job" ? this.#speechHosts(info.yields_to) : new Map();
    const pin = this.#pinOf(capability);
    const variant = this.#reference(capability, all, speech, pin);
    const weighed: Weighed[] = all.map((r) => {
      const reason = this.#exclusion(capability, r, variant, speech, pin);
      return {
        r,
        eligible: reason === null,
        ...(reason !== null ? { reason } : {}),
        speech: speech.has(r.endpoint.host),
        resting: this.#isResting(r.endpoint, now),
        pending: 0,
        score: null,
      };
    });
    const out = info.class === "job" ? this.#scored(capability, info, weighed, options) : null;
    const ordered =
      out ??
      this.#legacy(
        capability,
        weighed.map((w) => w.r),
        options,
      ).map((r) => weighed.find((w) => w.r === r) as Weighed);
    const takes = ordered.filter((w) => w.eligible);
    if (options.all !== true) return takes;
    return [...takes, ...ordered.filter((w) => !w.eligible)];
  }

  /** The order before §15: ready first, `order`, reported then static, names, added order. */
  #legacy(capability: string, all: Ranked[], options: PickOptions): Ranked[] {
    const now = this.#clock.now();
    const listed = this.#order[capability] ?? [];
    const ready = ({ endpoint: e }: Ranked) =>
      e.healthy && (options.ignoreResting === true || !this.#isResting(e, now)) ? 0 : 1;
    const late = (r: Ranked) => (r.added === null ? 0 : 1);
    return [...all].sort(
      (a, b) =>
        ready(a) - ready(b) ||
        this.#orderRank(a, listed) - this.#orderRank(b, listed) ||
        late(a) - late(b) ||
        (a.added ?? 0) - (b.added ?? 0) ||
        byText(a.endpoint.host, b.endpoint.host) ||
        byText(a.endpoint.service, b.endpoint.service),
    );
  }

  /**
   * `job`: each endpoint's score, the time until a new unit would be finished and back on Core:
   * the wait for what is ahead of it (running, queued and sent but not reported yet, times a
   * unit's time there, over its concurrency), its own run time, the transfer of its results, and
   * the penalties (resting, held up from outside, unknown load, her voice there with `always`,
   * further down `order`), divided by the host's weight. Healthy before unhealthy, then by score,
   * then `order`, then names.
   */
  #scored(
    capability: string,
    info: ClassInfo,
    weighed: Weighed[],
    options: PickOptions,
  ): Weighed[] {
    const now = this.#clock.now();
    const cfg = this.#routing;
    const listed = this.#order[capability] ?? [];
    const sizeBytes = options.sizeBytes ?? this.#resultBytes(capability, info);
    const active = !this.#idle(this.#activity());
    for (const w of weighed) {
      const r = w.r;
      const unitMs = this.#unitMs(r.endpoint.host, capability, info);
      const concurrency = r.routing?.concurrency ?? 1;
      w.pending = this.#pending(r, now);
      const penalties: string[] = [];
      let penalty = 0;
      let ahead = w.pending;
      if (r.load === null) {
        ahead += cfg.unknown_load_units;
        if (cfg.unknown_load_units > 0) penalties.push("不知道它忙不忙");
      } else ahead += r.load.running + r.load.queued;
      if (w.resting && options.ignoreResting !== true) {
        penalty += cfg.resting_penalty_secs * 1000;
        penalties.push("剛剛連不上");
      }
      if (r.load?.outside !== undefined) {
        penalty += cfg.outside_busy_penalty_secs * 1000;
        penalties.push(r.load.outside);
      }
      if (w.speech && active) {
        penalty += cfg.speech_penalty_secs * 1000;
        penalties.push("她的語音在這台");
      }
      const rank = this.#orderRank(r, listed);
      if (rank > 0 && cfg.order_step_secs > 0) {
        penalty += rank * cfg.order_step_secs * 1000;
        penalties.push(`order 第 ${rank + 1} 位`);
      }
      const weight = this.#weight(r.endpoint.host);
      const parts: ScoreParts = {
        wait_ms: (ahead * unitMs) / concurrency,
        run_ms: unitMs,
        transfer_ms: (sizeBytes / this.#rateBps(r)) * 1000,
        penalty_ms: penalty,
        penalties,
        weight,
      };
      w.parts = parts;
      w.score = (parts.wait_ms + parts.run_ms + parts.transfer_ms + parts.penalty_ms) / weight;
    }
    const ready = (w: Weighed) => (w.r.endpoint.healthy ? 0 : 1);
    return [...weighed].sort(
      (a, b) =>
        ready(a) - ready(b) ||
        (a.score ?? 0) - (b.score ?? 0) ||
        this.#orderRank(a.r, listed) - this.#orderRank(b.r, listed) ||
        byText(a.r.endpoint.host, b.r.endpoint.host) ||
        byText(a.r.endpoint.service, b.r.endpoint.service),
    );
  }

  #endpointView(capability: string, w: Weighed): EndpointRouting {
    const r = w.r;
    const row = this.#estimates.get(r.endpoint.host, capability);
    const now = this.#clock.now();
    return {
      host: r.endpoint.host,
      service: r.endpoint.service,
      via: r.endpoint.via,
      healthy: r.endpoint.healthy,
      resting: w.resting,
      eligible: w.eligible,
      ...(w.reason !== undefined ? { reason: w.reason } : {}),
      score_s: w.score === null ? null : seconds(w.score),
      ...(w.parts !== undefined ? { parts: w.parts } : {}),
      routing: r.routing,
      load:
        r.load === null
          ? null
          : {
              running: r.load.running,
              queued: r.load.queued,
              age_ms: Math.max(0, now - r.load.readAt),
              ...(r.load.outside !== undefined ? { outside: r.load.outside } : {}),
            },
      pending: w.pending,
      speech: w.speech,
      estimate: {
        unit_s: row?.unit_ms === null || row === null ? null : seconds(row.unit_ms),
        rate_mb_s:
          row?.rate_bps === null || row === null ? null : Math.round((row.rate_bps / MB) * 10) / 10,
        units: row?.unit_n ?? 0,
        transfers: row?.rate_n ?? 0,
      },
    };
  }

  /** A response whose body, once read to its end, is a sample of the host's transfer rate. */
  #measured(endpoint: Endpoint, response: Response): Response {
    const body = response.body;
    if (body === null) return response;
    const started = this.#clock.now();
    let bytes = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush: () => {
        if (bytes < RATE_SAMPLE_BYTES) return;
        const ms = Math.max(1, this.#clock.now() - started);
        this.#estimates.rate(endpoint.host, endpoint.capability, (bytes / ms) * 1000);
      },
    });
    return new Response(body.pipeThrough(counter), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Every endpoint of `capability`, unordered: hosts' then static entries. A static entry at the
   * URL of an endpoint before it (a reported one, or an entry of `[modules.cluster.static]` for
   * one added at run time) is not returned; that endpoint stands for it.
   */
  #all(capability: string, options: PickOptions): Ranked[] {
    const out: Ranked[] = [];
    for (const [name, entry] of this.#hosts) {
      if (!entry.approved.has(capability) || entry.report === null) continue;
      for (const service of entry.report.services) {
        if (!service.provides.includes(capability) || !SERVING.has(service.state)) continue;
        const load = service.load;
        let url: string;
        let via: Endpoint["via"];
        let urls: string[];
        let directOnly = false;
        if (this.#routes.declared(name)) {
          // A host with routes (§16): the best route for this kind of query; a `direct` query
          // only gets endpoints with a route fit for real-time work, and keeps to such routes.
          const work: RouteWork = options.direct === true ? "realtime" : "interactive";
          const best = this.#routes.plan(name, service.name, work)[0];
          if (options.direct === true && best === undefined) continue;
          url = best?.url ?? `link://${name}/${service.name}`;
          via = best === undefined || best.url === null ? "link" : "direct";
          urls = Object.values(service.reach ?? {});
          directOnly = options.direct === true;
        } else {
          // Only an address the host says Core can call is direct; `url` alone is the address on
          // the host itself.
          const direct = service.advertised !== undefined && service.advertised !== "";
          url = direct ? (service.advertised as string) : `link://${name}/${service.name}`;
          via = direct ? "direct" : "link";
          urls = direct ? [url] : [];
        }
        out.push({
          endpoint: {
            capability,
            host: name,
            service: service.name,
            url,
            via,
            headers: bearer(service.token),
            healthy: service.healthy,
            version: service.version ?? null,
            ...(directOnly ? { direct_only: true } : {}),
          },
          standsFor: [],
          urls,
          added: null,
          routing: service.routing ?? null,
          load:
            load === undefined
              ? null
              : {
                  running: load.running,
                  queued: load.queued,
                  readAt: entry.reportedAt - load.age_ms,
                  ...(load.outside !== undefined ? { outside: load.outside } : {}),
                },
          local: entry.local,
          rttMs: entry.rttMs,
          firstSeen: this.#firstSeen.get(`${name}\u0000${service.name}`) ?? entry.reportedAt,
        });
      }
    }
    const statics = [...this.#static.values()]
      .filter((entry) => entry.provides.has(capability))
      // Entries of `[modules.cluster.static]` before the ones added at run time.
      .sort((a, b) => (a.added ?? -1) - (b.added ?? -1));
    for (const entry of statics) {
      const twin = out.find((r) => r.urls.some((u) => sameUrl(u) === sameUrl(entry.url)));
      if (twin !== undefined) {
        twin.standsFor.push(entry.name);
        twin.added = minAdded(twin.added, entry.added);
        continue;
      }
      out.push({
        endpoint: {
          capability,
          host: entry.name,
          service: entry.name,
          url: entry.url,
          via: "direct",
          headers: { ...entry.headers },
          healthy: true,
          version: null,
        },
        standsFor: [],
        urls: [entry.url],
        added: entry.added,
        routing: null,
        load: null,
        local: loopbackUrl(entry.url) ? true : null,
        rttMs: null,
        // Written in the config: there before any host.
        firstSeen: -1,
      });
    }
    return options.direct === true ? out.filter((r) => r.endpoint.via === "direct") : out;
  }

  #signature(capability: string): string {
    return JSON.stringify(this.candidates(capability, { all: true }));
  }

  /** Tells the watchers of every capability whose endpoints are not what they last saw. */
  #changed(): void {
    for (const [capability, watchers] of [...this.#watchers]) {
      const now = this.#signature(capability);
      if (this.#seen.get(capability) === now) continue;
      this.#seen.set(capability, now);
      for (const watcher of [...watchers]) {
        try {
          watcher();
        } catch {
          // A watcher's failure is its own; the others still hear.
        }
      }
    }
  }
}
