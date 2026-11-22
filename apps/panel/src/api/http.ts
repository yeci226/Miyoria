// Minimal typed HTTP layer over `fetch` for the Admin API.
//
// Every protected route needs `Authorization: Bearer <token>` or the panel's
// Discord session cookie; errors come back as `{ "error": "..." }`. Every
// request sends `X-Miyoria-Request: 1` (the Core's CSRF guard for cookie
// sessions) and same-origin credentials. Unknown routes hit the server's fallback, which
// answers `404 { "error": "no such endpoint" }` — that is how the panel tells
// "this Core is older than the panel" apart from "this item does not exist".

import type { ErrorBody } from "./types";

/** Header the Core requires on cookie-authenticated changes. */
export const CSRF_HEADER = "X-Miyoria-Request";

export interface ApiConfig {
  /** Origin (and optional path prefix) of the Core, e.g. `http://127.0.0.1:7878`. Empty = same origin. */
  baseUrl: string;
  token: string;
}

/** The exact message of the server's fallback handler (`packages/api/src/server.ts`). */
export const FALLBACK_NOT_FOUND = "no such endpoint";

export type ApiErrorKind =
  /** The request never got a response (offline, CORS, DNS, refused). */
  | "network"
  /** 401: token or session missing, wrong or expired. */
  | "unauthorized"
  /** The route does not exist on this Core version. */
  | "not_provided"
  /** 404 for a specific item on a route that exists. */
  | "not_found"
  /** 503: the module providing the service is stopped. */
  | "unavailable"
  /** A 2xx response whose body was not the JSON we expected. */
  | "bad_response"
  | "http";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly path: string;
  /** The error body's JSON, when it was JSON (a refused settings save carries `problems`). */
  readonly body: unknown;

  constructor(kind: ApiErrorKind, status: number, path: string, message: string, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.path = path;
    this.body = body;
  }

  get notProvided(): boolean {
    return this.kind === "not_provided";
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function isNotProvided(e: unknown): boolean {
  return isApiError(e) && e.kind === "not_provided";
}

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Extra request headers (e.g. `Idempotency-Key`). */
  headers?: Record<string, string>;
  /** Skip the bearer token (only `/api/health` is public). */
  public?: boolean;
  /** An event stream's: called for every piece of it that arrives, comments too (`watchdog.ts`). */
  onChunk?: () => void;
}

export interface Download {
  blob: Blob;
  /** From `Content-Disposition`. */
  name: string;
  headers: Headers;
}

export type FetchLike =(input: string, init?: RequestInit) => Promise<Response>;

/** Joins a base URL and an absolute API path without doubling slashes. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Builds a query string, dropping `undefined`, `null` and empty strings. */
export function buildQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Encodes one path segment (module ids contain dots, persona keys dashes). */
export const seg = (value: string): string => encodeURIComponent(value);

async function readError(res: Response): Promise<{ message: string; json: boolean; body?: unknown }> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as Partial<ErrorBody>;
    if (typeof body.error === "string") return { message: body.error, json: true, body };
  } catch {
    // Not JSON: a proxy, a static file server or an old Core.
  }
  return { message: text.trim().slice(0, 200) || res.statusText || `HTTP ${res.status}`, json: false };
}

function classify(status: number, message: string, json: boolean): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 404) {
    // The fallback, or something that isn't the Core at all (no JSON body).
    return message === FALLBACK_NOT_FOUND || !json ? "not_provided" : "not_found";
  }
  if (status === 405 || status === 501) return "not_provided";
  if (status === 503) return "unavailable";
  return "http";
}

export class ApiClient {
  readonly config: ApiConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: ApiConfig, fetchImpl?: FetchLike) {
    this.config = config;
    // Bind lazily so tests can stub `globalThis.fetch` after construction.
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  url(path: string, query?: Query): string {
    return joinUrl(this.config.baseUrl, path) + buildQuery(query);
  }

  headers(extra?: Record<string, string>, isPublic = false): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", [CSRF_HEADER]: "1", ...extra };
    const token = this.config.token.trim();
    if (token && !isPublic) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const json = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const { value } = await this.exchange(method, path, opts, json);
    return value as T;
  }

  /**
   * A request whose body is already JSON text, answered with a response whose body is JSON (or
   * empty), or an event stream, passed on as it arrives: the route table's client (`orpc.ts`)
   * sends through this, so its calls carry the same headers and fail with the same `ApiError` as
   * `request`.
   */
  async send(method: string, path: string, opts: Omit<RequestOptions, "body" | "query"> = {}, json?: string): Promise<Response> {
    const res = await this.respond(method, path, opts, json);
    if (res.headers.get("content-type")?.startsWith("text/event-stream")) {
      const tap = opts.onChunk;
      const body =
        tap && res.body
          ? res.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, out) {
                  tap();
                  out.enqueue(chunk);
                },
              }),
            )
          : res.body;
      return new Response(body, { status: res.status, headers: { "content-type": "text/event-stream" } });
    }
    const { status, value } = await this.decode(res, path);
    const body = value === undefined ? null : JSON.stringify(value);
    return new Response(status === 204 ? null : body, { status, headers: { "content-type": "application/json" } });
  }

  private async exchange(method: string, path: string, opts: RequestOptions, json: string | undefined): Promise<{ status: number; value: unknown }> {
    return this.decode(await this.respond(method, path, opts, json), path);
  }

  /** The response to one request, once it is known to be a success. */
  private async respond(method: string, path: string, opts: RequestOptions, json: string | undefined): Promise<Response> {
    const init: RequestInit = {
      method,
      headers: this.headers({ ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...opts.headers }, opts.public),
      body: json,
      signal: opts.signal,
      credentials: "same-origin",
    };
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), init);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      const reason = e instanceof Error ? e.message : String(e);
      throw new ApiError("network", 0, path, `無法連線到 Core(${reason})`);
    }
    if (!res.ok) {
      const { message, json, body } = await readError(res);
      throw new ApiError(classify(res.status, message, json), res.status, path, message, body);
    }
    return res;
  }

  /** A successful response's JSON body. */
  private async decode(res: Response, path: string): Promise<{ status: number; value: unknown }> {
    if (res.status === 204) return { status: 204, value: undefined };
    const text = await res.text();
    if (!text) return { status: res.status, value: undefined };
    try {
      return { status: res.status, value: JSON.parse(text) };
    } catch {
      throw new ApiError("bad_response", res.status, path, "回應不是 JSON:API 位址可能指向了別的服務");
    }
  }

  /** A file response (`Content-Disposition: attachment`): its bytes, name and headers. */
  async download(method: string, path: string, opts: RequestOptions = {}): Promise<Download> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), {
        method,
        headers: this.headers({ Accept: "application/json" }),
        signal: opts.signal,
        credentials: "same-origin",
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      const reason = e instanceof Error ? e.message : String(e);
      throw new ApiError("network", 0, path, `無法連線到 Core(${reason})`);
    }
    if (!res.ok) {
      const { message, json } = await readError(res);
      throw new ApiError(classify(res.status, message, json), res.status, path, message);
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "download.json";
    return { blob: await res.blob(), name, headers: res.headers };
  }

  get<T>(path: string, opts?: Omit<RequestOptions, "body">): Promise<T> {
    return this.request<T>("GET", path, opts);
  }
  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body });
  }
  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, { ...opts, body });
  }
  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, { ...opts, body });
  }
  delete<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, opts);
  }
}

/** Short, user-facing description of any error thrown by the client. */
export function describeError(e: unknown): string {
  if (isApiError(e)) {
    switch (e.kind) {
      case "network":
        return e.message;
      case "unauthorized":
        return "登入已失效:請重新登入,或到設定更新 token。";
      case "not_provided":
        return "這個 Core 版本還沒有提供此 API。";
      case "unavailable":
        return `服務暫停中:${e.message}`;
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
