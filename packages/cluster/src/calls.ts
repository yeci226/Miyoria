// What a service of a host may ask Core for through its hostd (docs/design/v5-hostd.md §5, H8):
// `cluster.llm`, a completion through Core's LLM, `cluster.fetch`, one small HTTP request to a
// capability's endpoint, and `cluster.resolve`, a capability's endpoints with their tokens to call
// itself. The LLM key never leaves Core and every completion is counted and logged like Core's own.
//
// Core decides, never the caller. hostd adds the name of the service that asked (`service`), which
// the service cannot set itself; Core then checks that
//   1. the host is approved,
//   2. the host's last report lists that service,
//   3. the service provides a capability the host is approved for, and
//   4. the table `uses` lets that capability use what is asked for (an LLM purpose, a capability
//      to fetch from, a capability to resolve). Purposes must also be on `purposes`.
// Anything else is `NotAllowed`. `cluster.llm` is rate limited per host.

import {
  HOST_ERROR_CODE,
  HOST_FETCH_LIMITS,
  HOST_RELAY_DROPPED_REQUEST_HEADERS,
  HOST_RELAY_DROPPED_RESPONSE_HEADERS,
  type HostFetch,
  type HostFetchResult,
  HostFetchSchema,
  type HostLlm,
  type HostLlmMessage,
  type HostLlmResult,
  HostLlmSchema,
  type HostResolve,
  type HostResolveResult,
  HostResolveSchema,
  type HostServiceStatus,
  relayHeaders,
} from "@miyoria/contracts/host";
import { errorMessage } from "@miyoria/runtime/kernel";
import { RpcError } from "@miyoria/sdk";
import type { Clock } from "@miyoria/types";
import type { EndpointRegistry } from "./registry.js";

/** What a service that provides one capability may use. */
export interface ClusterUse {
  /** LLM purposes it may ask for (`cluster.llm`). */
  llm?: readonly string[];
  /** Capabilities it may send requests to through Core (`cluster.fetch`). */
  fetch?: readonly string[];
  /**
   * Capabilities whose endpoints it may be given to call itself (`cluster.resolve`), with the
   * headers to send them, bearer tokens included. More than `fetch`: the token leaves Core.
   */
  resolve?: readonly string[];
}

/** By the capability a service PROVIDES: what it may use. */
export type ClusterUses = Readonly<Record<string, ClusterUse>>;

/**
 * The song worker and the lyrics service: the lyrics lookup's model and its ASR spot check. No
 * service resolves another capability's endpoints today (they go through `cluster.fetch`), so
 * nothing may `cluster.resolve`.
 */
export const DEFAULT_CLUSTER_USES: ClusterUses = {
  sing: { llm: ["fast"], fetch: ["asr"] },
  lyrics: { llm: ["fast"], fetch: ["asr"] },
};

/** The LLM purposes any service may ask for at all. */
export const DEFAULT_CLUSTER_LLM_PURPOSES: readonly string[] = ["fast"];

/** At most `calls` completions per host within `window_ms`. */
export interface ClusterRateLimit {
  calls: number;
  window_ms: number;
}

export const DEFAULT_CLUSTER_LLM_RATE: ClusterRateLimit = { calls: 30, window_ms: 60_000 };

/** One completion Core runs for a service of a host. */
export interface ClusterCompletion {
  purpose: string;
  messages: readonly HostLlmMessage[];
  max_tokens?: number;
  temperature?: number;
  json?: boolean;
  /** Who asked: for the call log's label. */
  host: string;
  service: string;
}

/** Runs a completion; Core's wiring gives one that goes through its LLM router. */
export type ClusterCompleteFn = (
  request: ClusterCompletion,
  signal: AbortSignal,
) => Promise<string>;

/** The caller host as the link knows it. */
export interface CallerHost {
  name: string;
  approved: boolean;
  /** The capabilities it is approved for. */
  capabilities: readonly string[];
  /** The services of its last report; `null` before the first. */
  services: readonly HostServiceStatus[] | null;
}

export interface ClusterCallsOptions {
  registry: EndpointRegistry;
  uses?: ClusterUses;
  purposes?: readonly string[];
  llmRate?: ClusterRateLimit;
  /** `null` when Core has no LLM for the cluster. */
  complete: ClusterCompleteFn | null;
  clock: Clock;
  /** How long the endpoint's response head may take (and then its body), in ms. */
  fetchTimeoutMs?: number;
  /** Largest request and response body of `cluster.fetch`, in bytes. */
  maxBodyBytes?: number;
}

function refuse(message: string): RpcError {
  return new RpcError(HOST_ERROR_CODE.NotAllowed, message);
}

function invalid(error: { message: string }): RpcError {
  return RpcError.invalidParams(error.message);
}

/** Reads a body up to `max` bytes; `null` when it is longer (the rest is cancelled). */
async function readCapped(response: Response, max: number): Promise<Buffer | null> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Whether `text` is plain base64 (padding optional); `Buffer.from` would skip anything else. */
function isBase64(text: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/u.test(text.replace(/\s+/gu, ""));
}

export class ClusterCalls {
  readonly #o: ClusterCallsOptions;
  readonly #uses: ClusterUses;
  readonly #purposes: readonly string[];
  readonly #rate: ClusterRateLimit;
  /** Per host: when its recent completions were asked for (epoch ms). */
  readonly #recent = new Map<string, number[]>();

  constructor(options: ClusterCallsOptions) {
    this.#o = options;
    this.#uses = options.uses ?? DEFAULT_CLUSTER_USES;
    this.#purposes = options.purposes ?? DEFAULT_CLUSTER_LLM_PURPOSES;
    this.#rate = options.llmRate ?? DEFAULT_CLUSTER_LLM_RATE;
  }

  /** What `service` of `host` may use; throws `NotAllowed` when it may use nothing. */
  allowed(host: CallerHost, service: string | undefined): Required<ClusterUse> {
    if (!host.approved) throw refuse(`host \`${host.name}\` is not approved`);
    if (service === undefined || service === "") {
      throw refuse("the request names no service (hostd adds it)");
    }
    const status = host.services?.find((s) => s.name === service);
    if (status === undefined) {
      throw refuse(`host \`${host.name}\` reports no service \`${service}\``);
    }
    const capabilities = status.provides.filter((c) => host.capabilities.includes(c));
    if (capabilities.length === 0) {
      throw refuse(`\`${service}\` on \`${host.name}\` provides nothing the host is approved for`);
    }
    const llm = new Set<string>();
    const fetch = new Set<string>();
    const resolve = new Set<string>();
    for (const capability of capabilities) {
      for (const purpose of this.#uses[capability]?.llm ?? []) llm.add(purpose);
      for (const target of this.#uses[capability]?.fetch ?? []) fetch.add(target);
      for (const target of this.#uses[capability]?.resolve ?? []) resolve.add(target);
    }
    return { llm: [...llm], fetch: [...fetch], resolve: [...resolve] };
  }

  /**
   * `cluster.resolve`: the endpoints of a capability, with their headers (bearer tokens), for a
   * service allowed to call it itself. Everything else is refused before the registry is read,
   * so no endpoint or token of a capability the service was not granted leaves Core.
   */
  resolve(host: CallerHost, params: unknown): HostResolveResult {
    const parsed = HostResolveSchema.safeParse(params);
    if (!parsed.success) throw invalid(parsed.error);
    const request: HostResolve = parsed.data;
    const uses = this.allowed(host, request.service);
    if (!uses.resolve.includes(request.capability)) {
      throw refuse(
        `\`${request.service}\` on \`${host.name}\` may not be given the endpoints of \`${request.capability}\``,
      );
    }
    return { endpoints: this.#o.registry.candidates(request.capability) };
  }

  /** `cluster.llm`. */
  async llm(host: CallerHost, params: unknown, signal: AbortSignal): Promise<HostLlmResult> {
    const parsed = HostLlmSchema.safeParse(params);
    if (!parsed.success) throw invalid(parsed.error);
    const request: HostLlm = parsed.data;
    const uses = this.allowed(host, request.service);
    const service = request.service as string;
    if (!uses.llm.includes(request.purpose) || !this.#purposes.includes(request.purpose)) {
      throw refuse(
        `\`${service}\` on \`${host.name}\` may not use the LLM for \`${request.purpose}\``,
      );
    }
    this.#count(host.name);
    const complete = this.#o.complete;
    if (complete === null) {
      throw new RpcError(HOST_ERROR_CODE.Unavailable, "Core has no LLM to lend");
    }
    try {
      const text = await complete(
        {
          purpose: request.purpose,
          messages: request.messages,
          ...(request.max_tokens === undefined ? {} : { max_tokens: request.max_tokens }),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.json === undefined ? {} : { json: request.json }),
          host: host.name,
          service,
        },
        signal,
      );
      return { text };
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(
        HOST_ERROR_CODE.Unavailable,
        `the completion failed: ${errorMessage(error)}`,
      );
    }
  }

  /** Counts one completion of `host`; throws `RateLimited` over the limit. */
  #count(host: string): void {
    const now = this.#o.clock.now();
    const recent = (this.#recent.get(host) ?? []).filter((t) => now - t < this.#rate.window_ms);
    if (recent.length >= this.#rate.calls) {
      this.#recent.set(host, recent);
      throw new RpcError(
        HOST_ERROR_CODE.RateLimited,
        `host \`${host}\` asked for more than ${this.#rate.calls} completions in ${Math.round(this.#rate.window_ms / 1000)} s`,
      );
    }
    recent.push(now);
    this.#recent.set(host, recent);
  }

  /** `cluster.fetch`. */
  async fetch(host: CallerHost, params: unknown, signal: AbortSignal): Promise<HostFetchResult> {
    const parsed = HostFetchSchema.safeParse(params);
    if (!parsed.success) throw invalid(parsed.error);
    const request: HostFetch = parsed.data;
    const uses = this.allowed(host, request.service);
    if (!uses.fetch.includes(request.capability)) {
      throw refuse(
        `\`${request.service}\` on \`${host.name}\` may not send requests to \`${request.capability}\``,
      );
    }
    const max = this.#o.maxBodyBytes ?? HOST_FETCH_LIMITS.MAX_BODY_BYTES;
    let body: Buffer | undefined;
    if (request.body !== undefined && request.body !== "") {
      if (!isBase64(request.body)) throw RpcError.invalidParams("body: not base64");
      body = Buffer.from(request.body, "base64");
      if (body.byteLength > max) {
        throw new RpcError(
          HOST_ERROR_CODE.TooLarge,
          `the request body is ${body.byteLength} bytes; at most ${max} are allowed`,
        );
      }
    }
    const registry = this.#o.registry;
    const endpoint = registry.pick(request.capability);
    if (endpoint === null) {
      throw new RpcError(
        HOST_ERROR_CODE.Unavailable,
        `no endpoint of \`${request.capability}\` can be used now`,
      );
    }

    const timeoutMs = this.#o.fetchTimeoutMs ?? HOST_FETCH_LIMITS.HEAD_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const arm = () =>
      setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("timed out"));
      }, timeoutMs);
    let timer = arm();
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const what = `\`${request.capability}\` (${endpoint.service} on ${endpoint.host})`;
    try {
      let response: Response;
      try {
        response = await registry.request(endpoint, request.path, {
          method: request.method,
          headers: relayHeaders(
            Object.entries(request.headers ?? {}),
            HOST_RELAY_DROPPED_REQUEST_HEADERS,
          ),
          ...(body === undefined ? {} : { body: new Uint8Array(body) }),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        registry.failed(endpoint, error);
        throw new RpcError(
          HOST_ERROR_CODE.Unavailable,
          timedOut
            ? `${what} sent no answer within ${Math.round(timeoutMs / 1000)} s`
            : `${what} failed: ${errorMessage(error)}`,
        );
      }
      // The head is in; the body gets as long again.
      clearTimeout(timer);
      timer = arm();
      let bytes: Buffer | null;
      try {
        bytes = await readCapped(response, max);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new RpcError(
          HOST_ERROR_CODE.Unavailable,
          timedOut
            ? `${what} did not finish its answer within ${Math.round(timeoutMs / 1000)} s`
            : `${what} broke off its answer: ${errorMessage(error)}`,
        );
      }
      if (bytes === null) {
        throw new RpcError(HOST_ERROR_CODE.TooLarge, `the answer of ${what} is over ${max} bytes`);
      }
      return {
        status: response.status,
        headers: relayHeaders(response.headers, HOST_RELAY_DROPPED_RESPONSE_HEADERS),
        body: bytes.toString("base64"),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
