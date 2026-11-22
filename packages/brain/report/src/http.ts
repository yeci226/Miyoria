// One request to GitHub's REST API (or its OAuth endpoints) over an injected `fetch`, and the
// error it fails with. Nothing secret ever goes in an error: only the method, the path, the status
// and GitHub's own message.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Longest wait for one call. */
const TIMEOUT_MS = 15_000;
export const API_VERSION = "2022-11-28";
export const USER_AGENT = "miyoria-report";

/** A call GitHub refused or that did not arrive; `status` 0 when there was no answer. */
export class GitHubError extends Error {
  override readonly name = "GitHubError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface GitHubRequest {
  method: "GET" | "POST" | "DELETE";
  /** The whole `Authorization` header value (`Bearer …`, `Basic …`); none: anonymous. */
  authorization?: string;
  body?: unknown;
  /** Default the REST API's media type. */
  accept?: string;
}

/**
 * One request to GitHub: the parsed JSON answer (`null` for an empty one), or a `GitHubError` with
 * the status and GitHub's own message. The error names the method and the path, never the query,
 * the headers or the body.
 */
export async function githubRequest(
  fetcher: FetchLike,
  url: string,
  request: GitHubRequest,
): Promise<unknown> {
  const path = new URL(url).pathname;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: request.method,
      headers: {
        Accept: request.accept ?? "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": USER_AGENT,
        ...(request.authorization === undefined ? {} : { Authorization: request.authorization }),
        ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const why = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
    throw new GitHubError(0, `GitHub ${request.method} ${path}: the request ${why}`);
  }
  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const said = isObject(parsed) && typeof parsed.message === "string" ? parsed.message : "";
    throw new GitHubError(
      response.status,
      `GitHub answered ${response.status}${said === "" ? "" : `: ${said.slice(0, 200)}`}`,
    );
  }
  return parsed;
}
