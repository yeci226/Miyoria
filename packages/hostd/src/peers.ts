// The GPU arbiter's calls to the evictable services of this machine (docs/design/v5-gpu.md §8):
// `offload`, `reload`, `busy` and `health`, at the paths of each descriptor (`[gpu] offload`,
// `reload`, `busy`; `[run.health] http`). The address and the service's own token come from the
// daemon at each call (`HostApi.target`), so a restart on another port or with a new token is
// followed. As the song worker's `http_post` / `http_get` did: a status that is not 2xx, a body
// that is not JSON, a timeout or a refused connection throws; JSON that is not an object is `{}`.

import type { PeerClient, Tenant } from "./arbiter/index.js";

/** Where a running service of this machine listens and what to send it; `null` when it is not running. */
export type ServiceTarget = (
  service: string,
) => { url: string; headers: Record<string, string> } | null;

export class PeerError extends Error {
  override name = "PeerError";
}

export class HttpPeerClient implements PeerClient {
  readonly #target: ServiceTarget;

  constructor(target: ServiceTarget) {
    this.#target = target;
  }

  offload(
    tenant: Tenant,
    body: { reason: string; max_s: number },
    timeoutS: number,
  ): Promise<Record<string, unknown>> {
    return this.#call(tenant, "POST", tenant.offload, body, timeoutS);
  }

  reload(tenant: Tenant, timeoutS: number): Promise<Record<string, unknown>> {
    return this.#call(tenant, "POST", tenant.reload, {}, timeoutS);
  }

  busy(tenant: Tenant, timeoutS: number): Promise<Record<string, unknown>> {
    return this.#call(tenant, "GET", tenant.busy, undefined, timeoutS);
  }

  health(tenant: Tenant, timeoutS: number): Promise<Record<string, unknown>> {
    return this.#call(tenant, "GET", tenant.health, undefined, timeoutS);
  }

  async #call(
    tenant: Tenant,
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutS: number,
  ): Promise<Record<string, unknown>> {
    const target = this.#target(tenant.name);
    if (target === null) throw new PeerError(`${tenant.name} is not running`);
    const url = `${target.url.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
    const signal = AbortSignal.timeout(Math.max(1, Math.round(timeoutS * 1000)));
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...target.headers,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
        redirect: "manual",
      });
    } catch (error) {
      const what =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? `no answer within ${timeoutS} s`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new PeerError(`${method} ${path} of ${tenant.name}: ${what}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new PeerError(
        `${method} ${path} of ${tenant.name}: the answer broke off (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PeerError(
        `${method} ${path} of ${tenant.name}: HTTP ${response.status} ${text.slice(0, 120)}`.trim(),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PeerError(`${method} ${path} of ${tenant.name}: the answer is not JSON`);
    }
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }
}
