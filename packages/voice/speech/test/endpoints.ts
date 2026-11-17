// A small stand-in for Core's endpoint registry: static entries in the order given, requests with
// the global `fetch`, and a record of what was reported failed.

import type { Endpoint, EndpointQuery, EndpointSource } from "../src/index.js";

export interface FakeEntry {
  name: string;
  provides: readonly string[];
  url: string;
  headers?: Record<string, string>;
  via?: "direct" | "link";
  healthy?: boolean;
}

export class FakeEndpoints implements EndpointSource {
  entries: FakeEntry[];
  readonly failures: { endpoint: Endpoint; error: unknown }[] = [];
  readonly requests: { url: string; path: string }[] = [];
  readonly #watchers = new Map<string, Set<() => void>>();

  constructor(entries: FakeEntry[] = []) {
    this.entries = entries;
  }

  /** Replaces the entries and tells every watcher. */
  set(entries: FakeEntry[]): void {
    this.entries = entries;
    for (const set of this.#watchers.values()) for (const w of [...set]) w();
  }

  candidates(capability: string, query: EndpointQuery = {}): Endpoint[] {
    return this.entries
      .filter((e) => e.provides.includes(capability))
      .filter((e) => query.entry === undefined || e.name === query.entry)
      .filter((e) => query.direct !== true || (e.via ?? "direct") === "direct")
      .map((e) => ({
        capability,
        host: e.name,
        service: e.name,
        url: e.url,
        via: e.via ?? "direct",
        headers: { ...(e.headers ?? {}) },
        healthy: e.healthy ?? true,
        version: null,
      }));
  }

  pick(capability: string, query: EndpointQuery = {}): Endpoint | null {
    return this.candidates(capability, query).find((e) => e.healthy) ?? null;
  }

  failed(endpoint: Endpoint, error?: unknown): void {
    this.failures.push({ endpoint, error });
  }

  request(endpoint: Endpoint, path: string, init: RequestInit = {}): Promise<Response> {
    this.requests.push({ url: endpoint.url, path });
    const headers = new Headers(endpoint.headers);
    for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
    return fetch(`${endpoint.url.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`, {
      ...init,
      headers,
    });
  }

  watch(capability: string, onChange: () => void): () => void {
    let set = this.#watchers.get(capability);
    if (set === undefined) {
      set = new Set();
      this.#watchers.set(capability, set);
    }
    set.add(onChange);
    return () => set.delete(onChange);
  }
}

/** The static entries Core's wiring makes of `[speech]`: one per `http-worker` with a `url`. */
export function speechEntries(config: {
  asr?: Record<string, { kind: string; url?: unknown }>;
  tts?: Record<string, { kind: string; url?: unknown }>;
}): FakeEntry[] {
  const out: FakeEntry[] = [];
  for (const family of ["asr", "tts"] as const) {
    for (const [name, provider] of Object.entries(config[family] ?? {})) {
      if (provider.kind === "http-worker" && typeof provider.url === "string") {
        out.push({ name: `speech.${family}.${name}`, provides: [family], url: provider.url });
      }
    }
  }
  return out;
}
