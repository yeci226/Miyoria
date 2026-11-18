import { STATUS_CODES } from "node:http";
import { errorMessage } from "@miyoria/runtime/kernel";

/** Every error response: `{ "error": "..." }`. */
export interface ErrorBody {
  error: string;
}

/**
 * The message of the fallback for unknown `/api/*` routes; the panel shows "not provided by
 * this Core" when it sees exactly this.
 */
export const NO_SUCH_ENDPOINT = "no such endpoint";

/** An error response, serialized as `{ "error": "..." }`. Thrown by handlers. */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    message: string,
    /** Extra response headers (`retry-after`, `cache-control`). */
    readonly headers: Record<string, string> = {},
    /** Extra fields of the body besides `error` (a refused save's `problems`). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  static badRequest(message: string): ApiError {
    return new ApiError(400, message);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, message);
  }

  static conflict(message: string): ApiError {
    return new ApiError(409, message);
  }

  /** `429` with how long to wait, never cached. */
  static tooMany(waitMs: number): ApiError {
    return new ApiError(429, "too many requests", {
      "cache-control": "no-store",
      "retry-after": String(Math.max(Math.ceil(waitMs / 1000), 1)),
    });
  }

  static unavailable(message: string): ApiError {
    return new ApiError(503, message);
  }

  /** A downstream node (stage, voice) failed the request. */
  static badGateway(error: unknown): ApiError {
    return new ApiError(502, errorMessage(error));
  }

  static internal(error: unknown): ApiError {
    return new ApiError(500, errorMessage(error));
  }

  toResponse(): Response {
    const headers = new Headers({ "content-type": "application/json", ...this.headers });
    if (this.status === 401) headers.set("www-authenticate", "Bearer");
    const body: ErrorBody = { ...this.extra, error: this.message };
    return new Response(JSON.stringify(body), { status: this.status, headers });
  }
}

/** `"401 Unauthorized"`, like `http::StatusCode`'s `Display`. */
export function statusText(status: number): string {
  const reason = STATUS_CODES[status];
  return reason ? `${status} ${reason}` : `${status}`;
}
