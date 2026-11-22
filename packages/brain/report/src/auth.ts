// Who the report module's GitHub calls are made as.
//
// * `AppInstallationAuth` (recommended): the GitHub App installed on the one repository. Core signs
//   a short RS256 JWT as the App (Node's `crypto`, no package), exchanges it for an installation
//   token restricted to that repository and `issues: write`, keeps it, and asks for the next one a
//   few minutes before it expires, one request at a time however many calls wait. Issues show as
//   the App's bot. Without an installation id it is looked up from the repository once.
// * `StaticToken`: a fine-grained personal access token, kept as the fallback.
//
// The private key, the JWT and the tokens are never logged, never put in an error and never in
// `toJSON`.

import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { type FetchLike, GitHubError, githubRequest, isObject } from "./http.js";

export interface GitHubAuth {
  readonly kind: "app" | "token";
  /** A token for the repository's calls. */
  token(): Promise<string>;
  /**
   * `token` was refused (401). `true` when the next `token()` gets a fresh one worth trying; a
   * static token would only be refused again.
   */
  refused(token: string): boolean;
  toJSON(): Record<string, unknown>;
}

export class StaticToken implements GitHubAuth {
  readonly kind = "token";
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async token(): Promise<string> {
    return this.#token;
  }

  refused(): boolean {
    return false;
  }

  toJSON(): Record<string, unknown> {
    return { kind: this.kind };
  }
}

/** The App's private key could not be used; it says nothing of the key. */
export class AppKeyError extends Error {
  override readonly name = "AppKeyError";

  constructor() {
    super("the GitHub App's private key cannot be read: it should be the App's RSA key in PEM");
  }
}

/**
 * The App's private key from its PEM text. A key kept on one line in `.env` with literal `\n`
 * between its lines works too. Throws `AppKeyError` (without any of the key in it).
 */
export function readPrivateKey(pem: string): KeyObject {
  const text = pem.trim().replace(/\\n/g, "\n").replace(/\r\n?/g, "\n");
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text, format: "pem" });
  } catch {
    throw new AppKeyError();
  }
  if (key.asymmetricKeyType !== "rsa") throw new AppKeyError();
  return key;
}

const base64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

/** How far back a JWT's `iat` is set, for a clock a little ahead of GitHub's. */
export const JWT_BACKDATE_S = 60;
/** How long a JWT is good for (GitHub allows at most ten minutes). */
export const JWT_LIFETIME_S = 9 * 60;

/** The App's JWT: RS256, `iss` the App id, `iat` a minute back, `exp` nine minutes ahead. */
export function appJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: appId }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** A new installation token is asked for this long before the one held expires. */
export const RENEW_BEFORE_MS = 5 * 60_000;

export interface AppAuthOptions {
  appId: string;
  /** Empty: looked up from `repo` (`GET /repos/{owner}/{repo}/installation`). */
  installationId: string | null;
  /** The App's private key (PEM, or with literal `\n`). Read at once: a bad key throws here. */
  privateKey: string;
  /** `owner/name`: the one repository the token is limited to. */
  repo: string;
  apiUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  renewBeforeMs?: number;
}

/** The GitHub App's installation on the repository. */
export class AppInstallationAuth implements GitHubAuth {
  readonly kind = "app";
  readonly #appId: string;
  readonly #key: KeyObject;
  readonly #repo: string;
  readonly #api: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #renewBefore: number;
  #installation: string | null;
  #held: { token: string; expiresAt: number } | null = null;
  #renewing: Promise<string> | null = null;

  constructor(options: AppAuthOptions) {
    this.#appId = options.appId;
    this.#key = readPrivateKey(options.privateKey);
    this.#repo = options.repo;
    this.#installation = options.installationId?.trim() || null;
    this.#api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#renewBefore = options.renewBeforeMs ?? RENEW_BEFORE_MS;
  }

  /** Never the key, the JWT or a token. */
  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      app_id: this.#appId,
      installation: this.#installation,
      repo: this.#repo,
    };
  }

  async token(): Promise<string> {
    const held = this.#held;
    if (held !== null && this.#now() < held.expiresAt - this.#renewBefore) return held.token;
    // One renewal at a time: every call that finds the token old waits for the same one.
    this.#renewing ??= this.#renew().finally(() => {
      this.#renewing = null;
    });
    return this.#renewing;
  }

  refused(token: string): boolean {
    if (this.#held?.token === token) this.#held = null;
    return true;
  }

  #jwt(): string {
    return `Bearer ${appJwt(this.#appId, this.#key, this.#now())}`;
  }

  async #installationId(): Promise<string> {
    if (this.#installation !== null) return this.#installation;
    const found = await githubRequest(
      this.#fetch,
      `${this.#api}/repos/${this.#repo}/installation`,
      {
        method: "GET",
        authorization: this.#jwt(),
      },
    );
    const id = isObject(found) && typeof found.id === "number" ? found.id : null;
    if (id === null) throw new GitHubError(0, "GitHub's answer names no installation of the App");
    this.#installation = String(id);
    return this.#installation;
  }

  async #renew(): Promise<string> {
    const installation = await this.#installationId();
    const name = this.#repo.split("/")[1] ?? this.#repo;
    const made = await githubRequest(
      this.#fetch,
      `${this.#api}/app/installations/${encodeURIComponent(installation)}/access_tokens`,
      {
        method: "POST",
        authorization: this.#jwt(),
        body: { repositories: [name], permissions: { issues: "write" } },
      },
    );
    const token = isObject(made) && typeof made.token === "string" ? made.token : null;
    const expires =
      isObject(made) && typeof made.expires_at === "string"
        ? Date.parse(made.expires_at)
        : Number.NaN;
    if (token === null || Number.isNaN(expires)) {
      throw new GitHubError(0, "GitHub's answer has no installation token");
    }
    this.#held = { token, expiresAt: expires };
    return token;
  }
}
