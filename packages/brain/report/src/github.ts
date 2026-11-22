// GitHub's REST API for one repository, with plain `fetch` (no client package for a handful of
// requests): search the repository's open issues by title, open an issue, comment on one, read one
// back to see whether it was closed, and read a user's login from their numeric id. `fetch` is
// injected, so tests never reach GitHub.
//
// Who the calls are made as is a `GitHubAuth` (`auth.ts`): the GitHub App's installation (the
// recommended way: issues show as the App's bot) or a static token. A call refused with 401 asks
// the auth for a fresh token and is tried once more. Secrets go in the `Authorization` header and
// nowhere else: not in a URL, an error, a log line or `toJSON`.

import { type GitHubAuth, StaticToken } from "./auth.js";
import type { IssueMatch } from "./duplicates.js";
import { type FetchLike, GitHubError, githubRequest, isObject } from "./http.js";

export {
  API_VERSION,
  type FetchLike,
  GitHubError,
  githubRequest,
  isObject,
  USER_AGENT,
} from "./http.js";

export interface OpenedIssue {
  number: number;
  url: string;
}

export interface IssueState {
  number: number;
  state: "open" | "closed";
  /** `completed`, `not_planned`, `reopened`, `duplicate`; `null` when GitHub says none. */
  reason: string | null;
  closed_at: string | null;
  url: string;
}

/** What a report does on GitHub. */
export interface IssueTracker {
  /** Open issues of the repository whose title has every one of `terms`. */
  search(terms: readonly string[], limit?: number): Promise<IssueMatch[]>;
  open(issue: { title: string; body: string; labels: readonly string[] }): Promise<OpenedIssue>;
  comment(number: number, body: string): Promise<{ url: string }>;
  issue(number: number): Promise<IssueState>;
  /** The current login of the account with numeric id `id`; `null` when it is gone. */
  login?(id: number): Promise<string | null>;
  /** How the calls are made: as the GitHub App, or with a static token. */
  readonly kind?: "app" | "token";
}

export interface GitHubOptions {
  /** Who the calls are made as. */
  auth?: GitHubAuth;
  /** A static token: shorthand for `auth: new StaticToken(token)`. */
  token?: string;
  /** `owner/name`. */
  repo: string;
  apiUrl?: string;
  fetch?: FetchLike;
}

/** A GitHub login as GitHub allows it: letters, digits and single inner hyphens, at most 39. */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** GitHub's REST API for one repository. */
export class GitHubIssues implements IssueTracker {
  readonly #auth: GitHubAuth;
  readonly #repo: string;
  readonly #api: string;
  readonly #fetch: FetchLike;

  constructor(options: GitHubOptions) {
    const auth =
      options.auth ?? (options.token === undefined ? null : new StaticToken(options.token));
    if (auth === null) throw new Error("GitHubIssues needs `auth` or `token`");
    this.#auth = auth;
    this.#repo = options.repo;
    this.#api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get repo(): string {
    return this.#repo;
  }

  /** How the calls are made: `app` or `token`. */
  get kind(): GitHubAuth["kind"] {
    return this.#auth.kind;
  }

  /** Never a secret. */
  toJSON(): { repo: string; api: string; auth: GitHubAuth["kind"] } {
    return { repo: this.#repo, api: this.#api, auth: this.#auth.kind };
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = `${this.#api}${path}`;
    const once = async (token: string) =>
      githubRequest(this.#fetch, url, {
        method,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { body }),
      });
    const token = await this.#auth.token();
    try {
      return await once(token);
    } catch (error) {
      // A token that stopped working (revoked, or expired early): one fresh one, one more try.
      if (error instanceof GitHubError && error.status === 401 && this.#auth.refused(token)) {
        return once(await this.#auth.token());
      }
      throw error;
    }
  }

  #issues(rest = ""): string {
    return `/repos/${this.#repo}/issues${rest}`;
  }

  async search(terms: readonly string[], limit = 5): Promise<IssueMatch[]> {
    const words = terms.map((t) => (/\s/.test(t) ? `"${t.replace(/"/g, "")}"` : t));
    const q = [`repo:${this.#repo}`, "is:issue", "is:open", "in:title", ...words].join(" ");
    const found = await this.#call(
      "GET",
      `/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(Math.max(limit, 1), 20)}`,
    );
    const items = isObject(found) && Array.isArray(found.items) ? found.items : [];
    return items.flatMap((item): IssueMatch[] =>
      isObject(item) &&
      typeof item.number === "number" &&
      typeof item.title === "string" &&
      typeof item.html_url === "string" &&
      // The search finds pull requests too unless told; never offer one.
      item.pull_request === undefined
        ? [{ number: item.number, title: item.title, url: item.html_url }]
        : [],
    );
  }

  async open(issue: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<OpenedIssue> {
    const made = await this.#call("POST", this.#issues(), {
      title: issue.title,
      body: issue.body,
      ...(issue.labels.length === 0 ? {} : { labels: [...issue.labels] }),
    });
    if (!isObject(made) || typeof made.number !== "number" || typeof made.html_url !== "string") {
      throw new GitHubError(0, "GitHub opened an issue but its answer has no number");
    }
    return { number: made.number, url: made.html_url };
  }

  async comment(number: number, body: string): Promise<{ url: string }> {
    const made = await this.#call("POST", this.#issues(`/${number}/comments`), { body });
    if (!isObject(made) || typeof made.html_url !== "string") {
      throw new GitHubError(0, "GitHub added the comment but its answer has no link");
    }
    return { url: made.html_url };
  }

  async issue(number: number): Promise<IssueState> {
    const got = await this.#call("GET", this.#issues(`/${number}`));
    if (!isObject(got) || typeof got.number !== "number" || typeof got.state !== "string") {
      throw new GitHubError(0, `GitHub's answer for #${number} is not an issue`);
    }
    return {
      number: got.number,
      state: got.state === "closed" ? "closed" : "open",
      reason: typeof got.state_reason === "string" ? got.state_reason : null,
      closed_at: typeof got.closed_at === "string" ? got.closed_at : null,
      url: typeof got.html_url === "string" ? got.html_url : "",
    };
  }

  async login(id: number): Promise<string | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    try {
      const got = await this.#call("GET", `/user/${id}`);
      const login = isObject(got) && typeof got.login === "string" ? got.login : null;
      return login !== null && LOGIN.test(login) ? login : null;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }
}
