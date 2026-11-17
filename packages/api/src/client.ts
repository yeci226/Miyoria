// How a call of the admin API fails for the CLI: the route table's typed client
// (`@miyoria/contracts/api`, built in `packages/cli`) turns a transport failure or an answer that
// is not ok into a `ClientError` here.

import { type ErrorBody, statusText } from "./errors.js";

export type ClientErrorKind = "transport" | "api";

/** Every failure of a call. `status` is set for `api` errors (non-success answers). */
export class ClientError extends Error {
  override readonly name = "ClientError";

  private constructor(
    readonly kind: ClientErrorKind,
    message: string,
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  static transport(error: unknown): ClientError {
    let reason = error instanceof Error ? error.message : String(error);
    // `fetch` reports "fetch failed" and keeps the reason (ECONNREFUSED, ...) in `cause`.
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof Error && cause.message !== "") reason = `${reason}: ${cause.message}`;
    return new ClientError("transport", `cannot reach the admin API: ${reason}`, null, {
      cause: error,
    });
  }

  static api(status: number, message: string): ClientError {
    return new ClientError("api", `admin API returned ${statusText(status)}: ${message}`, status);
  }
}

/** The `ClientError` of a response that is not ok, with the server's message when it sent one. */
export async function responseError(response: Response): Promise<ClientError> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  let message: string;
  try {
    const parsed = JSON.parse(text) as Partial<ErrorBody>;
    if (typeof parsed.error !== "string") throw new Error("not an error body");
    message = parsed.error;
  } catch {
    message =
      text.trim() !== ""
        ? text.trim()
        : statusText(response.status).split(" ").slice(1).join(" ") || "error";
  }
  return ClientError.api(response.status, message);
}
