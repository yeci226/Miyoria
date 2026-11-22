// A member links their own GitHub account on the member page, so the issues their reports become
// can name them. The standard OAuth web flow of the GitHub App's user authorisation:
//
// 1. `begin`: a random `state` kept here (single use, ten minutes) with the member's account, and
//    a random binding the API puts in a short-lived HttpOnly SameSite=Lax cookie; the browser goes
//    to GitHub with the exact `redirect_uri` and no scope (a GitHub App's user token has only the
//    App's permissions, and reading who the user is needs none).
// 2. `finish`: the state is taken (gone whatever happens next), must belong to the same member
//    session and the cookie's binding must match it (compared in constant time). The code is
//    traded for a user token, `GET /user` is read once for the numeric id and the login, and the
//    token is revoked at once: it is never kept or logged. Only the id and the login are stored.
//
// An account already linked to someone else is refused, not moved: the safer of the two, since a
// move would let whoever holds the GitHub account take over another person's attribution. The
// system never acts as the member: the user token is used for `GET /user` and nothing else.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AccountRef, PersonId } from "@miyoria/types";
import { LOGIN } from "./github.js";
import { type FetchLike, GitHubError, githubRequest, isObject } from "./http.js";
import type { ReportTables } from "./store.js";

/** How long a started link waits for GitHub to send the member back. */
export const LINK_TTL_MS = 10 * 60_000;
/** Links started and not finished, at most (the oldest go first). */
export const LINK_MAX_PENDING = 256;
/** The cookie that ties a started link to the browser that started it. */
export const LINK_COOKIE = "miyoria_gh_link";

interface Pending {
  binding: string;
  account: AccountRef;
  person: PersonId;
  mention: boolean;
  at: number;
}

export type LinkFinish =
  | { ok: true; login: string; replaced: boolean }
  /**
   * `state`: unknown, used, expired, another session's or another browser's; `cancelled`: the
   * member said no on GitHub; `exchange`: GitHub would not give the identity; `taken`: that
   * account is linked to someone else.
   */
  | { ok: false; why: "state" | "cancelled" | "exchange" | "taken" };

export interface LinkerOptions {
  clientId: string;
  clientSecret: string;
  /** Exactly the App's callback URL. */
  redirectUri: string;
  store: ReportTables;
  webUrl?: string;
  apiUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  /** For tests: what makes `state` and the binding. */
  random?: () => string;
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};

const sameAccount = (a: AccountRef, b: AccountRef) => a.platform === b.platform && a.id === b.id;

export class GitHubLinker {
  readonly #options: LinkerOptions;
  readonly #web: string;
  readonly #api: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #random: () => string;
  readonly #pending = new Map<string, Pending>();

  constructor(options: LinkerOptions) {
    this.#options = options;
    this.#web = (options.webUrl ?? "https://github.com").replace(/\/+$/, "");
    this.#api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? (() => randomBytes(24).toString("base64url"));
  }

  /** Never the client secret. */
  toJSON(): Record<string, unknown> {
    return { client_id: this.#options.clientId, redirect_uri: this.#options.redirectUri };
  }

  /** Whether the callback comes back over https (the cookie is then `Secure`). */
  get secure(): boolean {
    return this.#options.redirectUri.startsWith("https:");
  }

  /** The cookie's path: the callback's. */
  get cookiePath(): string {
    return new URL(this.#options.redirectUri).pathname;
  }

  #prune(now: number): void {
    for (const [state, p] of this.#pending) {
      if (now - p.at >= LINK_TTL_MS) this.#pending.delete(state);
    }
    while (this.#pending.size >= LINK_MAX_PENDING) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
  }

  /** Starts a link for `person` (signed in as `account`): where the browser goes, and the cookie's value. */
  begin(person: PersonId, account: AccountRef, mention: boolean): { url: string; binding: string } {
    const now = this.#now();
    this.#prune(now);
    const state = this.#random();
    const binding = this.#random();
    this.#pending.set(state, { binding, account, person, mention, at: now });
    const url = new URL(`${this.#web}/login/oauth/authorize`);
    url.searchParams.set("client_id", this.#options.clientId);
    url.searchParams.set("redirect_uri", this.#options.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    return { url: url.href, binding };
  }

  /** Finishes a link GitHub sent the member back from. */
  async finish(input: {
    state: string | null;
    binding: string | null;
    code: string | null;
    error: string | null;
    account: AccountRef;
  }): Promise<LinkFinish> {
    if (input.state === null) return { ok: false, why: "state" };
    const pending = this.#pending.get(input.state);
    // Single use: taken whatever happens next.
    this.#pending.delete(input.state);
    if (pending === undefined || this.#now() - pending.at >= LINK_TTL_MS) {
      return { ok: false, why: "state" };
    }
    if (!sameAccount(pending.account, input.account)) return { ok: false, why: "state" };
    if (input.binding === null || !same(input.binding, pending.binding)) {
      return { ok: false, why: "state" };
    }
    if (input.error !== null) return { ok: false, why: "cancelled" };
    if (input.code === null || input.code === "") return { ok: false, why: "exchange" };
    const who = await this.#identity(input.code);
    if (who === null) return { ok: false, why: "exchange" };
    const linked = this.#options.store.link(
      pending.person,
      who.id,
      who.login,
      pending.mention,
      new Date(this.#now()).toISOString(),
    );
    if (!linked.ok) return { ok: false, why: "taken" };
    return { ok: true, login: who.login, replaced: linked.replaced };
  }

  /** The id and login behind `code`; the user token lives only inside this call. */
  async #identity(code: string): Promise<{ id: number; login: string } | null> {
    const { clientId, clientSecret, redirectUri } = this.#options;
    let token: string | null = null;
    try {
      const traded = await githubRequest(this.#fetch, `${this.#web}/login/oauth/access_token`, {
        method: "POST",
        accept: "application/json",
        body: { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri },
      });
      token =
        isObject(traded) && typeof traded.access_token === "string" ? traded.access_token : null;
      if (token === null) return null;
      const user = await githubRequest(this.#fetch, `${this.#api}/user`, {
        method: "GET",
        authorization: `Bearer ${token}`,
      });
      const id = isObject(user) && typeof user.id === "number" ? user.id : null;
      const login = isObject(user) && typeof user.login === "string" ? user.login : null;
      if (
        id === null ||
        !Number.isSafeInteger(id) ||
        id < 1 ||
        login === null ||
        !LOGIN.test(login)
      ) {
        return null;
      }
      return { id, login };
    } catch (error) {
      if (error instanceof GitHubError) return null;
      throw error;
    } finally {
      if (token !== null) await this.#revoke(token);
      token = null;
    }
  }

  /** Revokes the user token (best effort: it also expires on its own). */
  async #revoke(token: string): Promise<void> {
    const { clientId, clientSecret } = this.#options;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    try {
      await githubRequest(
        this.#fetch,
        `${this.#api}/applications/${encodeURIComponent(clientId)}/token`,
        {
          method: "DELETE",
          authorization: `Basic ${basic}`,
          body: { access_token: token },
        },
      );
    } catch {
      // Nothing to do: GitHub's user tokens expire within hours, and it is not kept here.
    }
  }
}
