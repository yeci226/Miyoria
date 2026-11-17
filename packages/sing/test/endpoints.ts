// A small stand-in for Core's endpoint registry: entries in the order given (as static entries
// added at run time are), requests with the global `fetch`, a record of what was reported failed,
// and watchers told when the entries change.

import type { Endpoint, EndpointQuery, EndpointSource } from "../src/endpoints.js";

export interface FakeEntry {
  /** The host (or static entry) name. */
  name: string;
  service?: string;
  url: string;
  headers?: Record<string, string>;
  via?: "direct" | "link";
}

export class FakeEndpoints implements EndpointSource {
  entries: FakeEntry[];
  readonly failures: { endpoint: Endpoint; error: unknown }[] = [];
  /** When set, what a request to a link endpoint is rejected with. */
  linkError: Error | null = null;
  readonly #watchers = new Set<() => void>();

  constructor(entries: FakeEntry[] = []) {
    this.entries = entries;
  }

  /** Replaces the entries and tells the watchers. */
  set(entries: FakeEntry[]): void {
    this.entries = entries;
    for (const w of [...this.#watchers]) w();
  }

  candidates(capability: string, query: EndpointQuery = {}): Endpoint[] {
    return this.entries
      .filter((e) => query.direct !== true || (e.via ?? "direct") === "direct")
      .map((e) => ({
        capability,
        host: e.name,
        service: e.service ?? e.name,
        url: e.url,
        via: e.via ?? "direct",
        headers: { ...(e.headers ?? {}) },
        healthy: true,
        version: null,
      }));
  }

  pick(capability: string, query: EndpointQuery = {}): Endpoint | null {
    return this.candidates(capability, query)[0] ?? null;
  }

  failed(endpoint: Endpoint, error?: unknown): void {
    this.failures.push({ endpoint, error });
  }

  request(endpoint: Endpoint, path: string, init: RequestInit = {}): Promise<Response> {
    if (endpoint.via === "link") {
      // What the registry throws for a link endpoint: by default "no relay"; a test may set what
      // a running relay would throw instead.
      if (this.linkError !== null) return Promise.reject(this.linkError);
      const error = new Error("the cluster module's relay is not running");
      error.name = "RelayUnavailableError";
      return Promise.reject(error);
    }
    const headers = new Headers(endpoint.headers);
    for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
    return fetch(`${endpoint.url.replace(/\/+$/, "")}${path}`, { ...init, headers });
  }

  watch(_capability: string, onChange: () => void): () => void {
    this.#watchers.add(onChange);
    return () => this.#watchers.delete(onChange);
  }

  get watching(): number {
    return this.#watchers.size;
  }
}

/** The registry as Core's wiring fills it from `[modules.sing] url` alone. */
export function oneWorker(url = "http://127.0.0.1:8005"): () => FakeEndpoints {
  const endpoints = new FakeEndpoints([{ name: "sing", url }]);
  return () => endpoints;
}
