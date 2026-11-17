// Where a worker is: the part of Core's endpoint registry (`@miyoria/cluster`,
// docs/design/v5-hostd.md §6.3) that a module uses. It is declared here, once, so modules do not
// depend on the cluster module: Core's wiring hands the registry in, tests hand in a fake.
// `Endpoint` has the shape of `HostEndpoint` in `@miyoria/contracts/host`.

import type { ServiceLookup } from "./services.js";

/** One place a capability can be used: its URL, the headers to send (the token), `via`. */
export interface Endpoint {
  capability: string;
  /** The host name, or the static entry's name. */
  host: string;
  service: string;
  /** With `via: "link"` this is the address on the host itself, not one Core can call. */
  url: string;
  /** `direct`: call `url`. `link`: the request travels over the host's control link. */
  via: "direct" | "link";
  /** What to send with each request, such as the bearer token. */
  headers: Record<string, string>;
  healthy: boolean;
  version: string | null;
}

export interface EndpointQuery {
  /** Only endpoints Core can call itself (a WebSocket service, real-time speech). */
  direct?: boolean;
  /** Only the endpoint of this static entry (or the reported one at its URL). */
  entry?: string;
  /** An endpoint that failed lately keeps its place instead of going last. */
  ignoreResting?: boolean;
}

/** Core's endpoint registry, as far as a module uses it. */
export interface EndpointSource {
  /** The first healthy endpoint that is not resting, in order; `null` when there is none. */
  pick(capability: string, query?: EndpointQuery): Endpoint | null;
  /** Every endpoint, ready ones first, in order. */
  candidates(capability: string, query?: EndpointQuery): Endpoint[];
  /** The endpoint did not answer: it rests a while and goes last. */
  failed(endpoint: Endpoint, error?: unknown): void;
  /** An HTTP request to the endpoint, with its headers under the caller's. */
  request(endpoint: Endpoint, path: string, init?: RequestInit): Promise<Response>;
  /** Calls `onChange` whenever the endpoints of `capability` change; returns the dispose. */
  watch(capability: string, onChange: () => void): () => void;
}

/** How a module finds the registry once it starts (Core's wiring passes it). */
export type EndpointsOption = (services: ServiceLookup) => EndpointSource | null;

/**
 * The endpoint to call now: the first healthy one, preferring those that are not resting. Unlike
 * `pick`, an endpoint that failed a moment ago is still returned when it is the only one, so a
 * single worker is tried on every call as before.
 */
export function firstEndpoint(
  source: EndpointSource | null,
  capability: string,
  query: EndpointQuery = {},
): Endpoint | null {
  if (source === null) return null;
  return source.candidates(capability, query).find((e) => e.healthy) ?? null;
}
