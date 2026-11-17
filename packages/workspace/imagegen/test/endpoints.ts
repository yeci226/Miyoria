// A small stand-in for Core's endpoint registry: entries in the order given, requests with the
// global `fetch`, and a record of what was reported failed.

import type { Endpoint, EndpointQuery, EndpointSource } from "../src/endpoints.js";

export interface FakeEntry {
  name: string;
  url: string;
  headers?: Record<string, string>;
  via?: "direct" | "link";
}

export class FakeEndpoints implements EndpointSource {
  entries: FakeEntry[];
  readonly failures: Endpoint[] = [];
  readonly requests: string[] = [];

  constructor(entries: FakeEntry[] = []) {
    this.entries = entries;
  }

  candidates(capability: string, query: EndpointQuery = {}): Endpoint[] {
    return this.entries
      .filter((e) => query.direct !== true || (e.via ?? "direct") === "direct")
      .map((e) => ({
        capability,
        host: e.name,
        service: e.name,
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

  failed(endpoint: Endpoint): void {
    this.failures.push(endpoint);
  }

  request(endpoint: Endpoint, path: string, init: RequestInit = {}): Promise<Response> {
    this.requests.push(`${endpoint.host} ${path}`);
    const headers = new Headers(endpoint.headers);
    for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
    return fetch(`${endpoint.url.replace(/\/+$/, "")}${path}`, { ...init, headers });
  }

  watch(): () => void {
    return () => undefined;
  }
}

/** The registry as Core's wiring fills it from `[modules.imagegen] url`. */
export function comfyAt(url: string, headers: Record<string, string> = {}): FakeEndpoints {
  return new FakeEndpoints([{ name: "imagegen", url, headers }]);
}
