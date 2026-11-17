// The registry of service endpoints (docs/design/v5-hostd.md §6.3): where each capability can be
// used now. Built from the latest `host.report` of every connected host and from the static
// entries of `[modules.cluster.static]`; nothing of it is stored.
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

import type { HostEndpoint, HostReport, HostServiceState } from "@miyoria/contracts/host";
import { type Clock, systemClock } from "@miyoria/types";
import type { StaticEndpointConfig } from "./config.js";
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

/** Service states in which a service can answer. */
const SERVING: ReadonlySet<HostServiceState> = new Set(["running", "foreign", "external"]);

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
  /** The earliest `added` of itself and the entries it stands for; `null`: none was added. */
  added: number | null;
}

interface HostEntry {
  /** The capabilities it is approved for; empty while pending. */
  approved: ReadonlySet<string>;
  report: HostReport | null;
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

  constructor(options: EndpointRegistryOptions = {}) {
    this.#order = options.order ?? {};
    this.#retryMs = (options.retrySecs ?? 30) * 1000;
    this.#clock = options.clock ?? systemClock;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
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

  // ---- what the link feeds in ----------------------------------------------------------------

  /** A host connected, or its approval changed. `null` capabilities: pending, nothing is used. */
  setHost(name: string, approved: readonly string[] | null): void {
    const entry = this.#hosts.get(name);
    this.#hosts.set(name, { approved: new Set(approved ?? []), report: entry?.report ?? null });
    this.#changed();
  }

  /** A host's latest report. Ignored for a host that is not connected. */
  report(name: string, report: HostReport): void {
    const entry = this.#hosts.get(name);
    if (entry === undefined) return;
    entry.report = report;
    this.#changed();
  }

  /** A host disconnected or was removed: its endpoints go at once. */
  removeHost(name: string): void {
    if (!this.#hosts.delete(name)) return;
    for (const key of [...this.#resting.keys()]) {
      if (key.startsWith(`${name}\u0000`)) this.#resting.delete(key);
    }
    this.#changed();
  }

  /** The hosts whose reports are held (connected ones). */
  hosts(): string[] {
    return [...this.#hosts.keys()].sort();
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
    const first = this.candidates(capability, options)[0];
    return first?.healthy && !this.#isResting(first, now) ? first : null;
  }

  /**
   * Every endpoint of `capability`, for callers with their own failover: healthy ones that are
   * not resting first; each group in `order`, then the reported endpoints and the entries of
   * `[modules.cluster.static]` by host and service name, then the entries added at run time in
   * the order they were added.
   */
  candidates(capability: string, options: PickOptions = {}): Endpoint[] {
    const now = this.#clock.now();
    const listed = this.#order[capability] ?? [];
    const rank = (r: Ranked) => {
      let best = listed.length;
      for (const name of [r.endpoint.host, ...r.standsFor]) {
        const i = listed.indexOf(name);
        if (i >= 0 && i < best) best = i;
      }
      return best;
    };
    const ready = ({ endpoint: e }: Ranked) =>
      e.healthy && (options.ignoreResting === true || !this.#isResting(e, now)) ? 0 : 1;
    const late = (r: Ranked) => (r.added === null ? 0 : 1);
    const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    let all = this.#all(capability, options);
    if (options.entry !== undefined) {
      const entry = options.entry;
      all = all.filter((r) => r.endpoint.host === entry || r.standsFor.includes(entry));
    }
    return all
      .sort(
        (a, b) =>
          ready(a) - ready(b) ||
          rank(a) - rank(b) ||
          late(a) - late(b) ||
          (a.added ?? 0) - (b.added ?? 0) ||
          byText(a.endpoint.host, b.endpoint.host) ||
          byText(a.endpoint.service, b.endpoint.service),
      )
      .map((r) => r.endpoint);
  }

  /** Passes over `endpoint` for `retry_secs`: it goes last until then. */
  failed(endpoint: Endpoint, _error?: unknown): void {
    if (this.#retryMs <= 0) return;
    this.#resting.set(restKey(endpoint), this.#clock.now() + this.#retryMs);
    this.#changed();
  }

  /**
   * Sends an HTTP request to `endpoint`: `fetch(url + path)` for a direct one, with its headers
   * (the bearer token) under the caller's; through the host's control link for a `link` one.
   */
  async request(endpoint: Endpoint, path: string, init: RequestInit = {}): Promise<Response> {
    if (endpoint.via === "link") {
      const relay = this.#relay;
      if (relay === null) {
        throw new RelayUnavailableError(
          `\`${endpoint.service}\` on \`${endpoint.host}\` is reachable only through its control link, and the cluster module's relay is not running`,
        );
      }
      return relay.request(endpoint, path, init);
    }
    return this.#fetch(join(endpoint.url, path), {
      ...init,
      headers: mergeHeaders(endpoint.headers, init.headers),
    });
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

  // ---- inside --------------------------------------------------------------------------------

  #isResting(endpoint: Endpoint, now: number): boolean {
    const until = this.#resting.get(restKey(endpoint));
    if (until === undefined) return false;
    if (until > now) return true;
    this.#resting.delete(restKey(endpoint));
    return false;
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
        // Only an address the host says Core can call is direct; `url` alone is the address on
        // the host itself.
        const direct = service.advertised !== undefined && service.advertised !== "";
        out.push({
          endpoint: {
            capability,
            host: name,
            service: service.name,
            url: direct ? (service.advertised as string) : `link://${name}/${service.name}`,
            via: direct ? "direct" : "link",
            headers: bearer(service.token),
            healthy: service.healthy,
            version: service.version ?? null,
          },
          standsFor: [],
          added: null,
        });
      }
    }
    const statics = [...this.#static.values()]
      .filter((entry) => entry.provides.has(capability))
      // Entries of `[modules.cluster.static]` before the ones added at run time.
      .sort((a, b) => (a.added ?? -1) - (b.added ?? -1));
    for (const entry of statics) {
      const twin = out.find(
        (r) => r.endpoint.via === "direct" && sameUrl(r.endpoint.url) === sameUrl(entry.url),
      );
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
        added: entry.added,
      });
    }
    return options.direct === true ? out.filter((r) => r.endpoint.via === "direct") : out;
  }

  #signature(capability: string): string {
    return JSON.stringify(this.candidates(capability));
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
