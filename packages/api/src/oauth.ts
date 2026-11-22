// Discord OAuth2 login for the panel (authorization code + PKCE, scope `identify`) and the
// `/api/auth/methods|session|logout` routes. An account with `admin.panel.access` gets an admin
// session; with `[modules.api.public]` on, anyone else gets a member session, which opens the
// member routes alone (see `session.ts`).
//
// Failures redirect to `/login?error=<code>` and never carry details: `disabled`,
// `cancelled`, `state`, `exchange`, `discord`, `denied`, `unavailable`. Details go to the log.

import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthMethods, SessionInfo } from "@miyoria/contracts/api";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import { type AccountRef, AuthorizerKey, accountRefString, type Clock } from "@miyoria/types";
import { z } from "zod";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import {
  COOKIE,
  cookieHeader,
  cookieToken,
  cookieValue,
  hasCsrfHeader,
  LOGIN_COOKIE,
  PANEL_ACCESS,
  randomToken,
} from "./session.js";
import type { ApiContext, ApiState, PanelAuth } from "./state.js";

const log = getLogger("api.oauth");

/** How long a started login may take to come back. */
export const STATE_TTL_MS = 10 * 60_000;
/** Cap on logins in flight (the login route is public). */
export const MAX_PENDING = 1024;
export const DEFAULT_NEXT = "/";
export const CDN = "https://cdn.discordapp.com";
/** Timeout of each request to Discord. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Where the login comes back, as mounted here; a reverse proxy may put a prefix in front. */
const CALLBACK_PATH = "/api/auth/oauth/callback";
/** Where a login starts, as mounted here. */
const LOGIN_PATH = "/api/auth/oauth/login";
/** Marks a login already sent over to its redirect's host, so it is never sent twice. */
const MOVED_PARAM = "moved";

/**
 * `[modules.api.discord_oauth]`. Login is on only when `client_id`, `client_secret` and
 * `redirect_uri` are all set.
 */
export const DiscordOAuthConfigSchema = z.object({
  /** The application id (Developer Portal → OAuth2). */
  client_id: z.string().default(""),
  client_secret: z.string().default(""),
  /**
   * Must match a redirect registered in the Developer Portal, e.g.
   * `http://127.0.0.1:7878/api/auth/oauth/callback`.
   */
  redirect_uri: z.string().default(""),
  /**
   * More addresses the panel is reached at, e.g. a public domain. A login comes back to the one
   * whose host it started on; a login started on any other host is first sent over to
   * `redirect_uri`'s host and starts there, since the cookie tying it to the browser only comes
   * back to the host it was set on. Each must be registered in the Developer Portal too.
   */
  redirect_uris: z.array(z.string()).default([]),
  /** Session lifetime in days (1–365). Default 7. */
  session_days: z.number().int().nonnegative().default(7),
  /** `Secure` cookie flag. Default: on when `redirect_uri` is https. */
  cookie_secure: z.boolean().nullable().default(null),
  /** How long a permission check is reused, in seconds. Default 5. */
  recheck_secs: z.number().nonnegative().default(5),
  /** Discord's base URL. Default `https://discord.com` (tests override it). */
  discord_url: z.string().default("https://discord.com"),
});
export type DiscordOAuthConfig = z.output<typeof DiscordOAuthConfigSchema>;

/** Session lifetime in ms (`session_days` clamped to 1–365). */
export function sessionTtlMs(config: DiscordOAuthConfig): number {
  return Math.min(Math.max(config.session_days, 1), 365) * 86_400_000;
}

export function recheckMs(config: DiscordOAuthConfig): number {
  return config.recheck_secs * 1000;
}

export interface PendingLogin {
  verifier: string;
  next: string;
  /** Where Discord sends this login back: the token exchange must name the same address. */
  redirect: URL;
  /** What the browser that started this login holds in `LOGIN_COOKIE`. */
  binding: string;
  /** Epoch ms. */
  at: number;
}

/** Logins between `/login` and `/callback`, by `state`. */
export class Pending {
  readonly map = new Map<string, PendingLogin>();

  insert(state: string, login: PendingLogin, now: number): void {
    for (const [key, p] of this.map) {
      if (now - p.at >= STATE_TTL_MS) this.map.delete(key);
    }
    if (this.map.size >= MAX_PENDING) {
      let oldest: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, p] of this.map) {
        if (p.at < oldestAt) {
          oldest = key;
          oldestAt = p.at;
        }
      }
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(state, login);
  }

  /** Removes and returns the login for `state` unless it expired. */
  take(state: string, now: number): PendingLogin | null {
    const login = this.map.get(state);
    if (!login) return null;
    this.map.delete(state);
    return now - login.at < STATE_TTL_MS ? login : null;
  }
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export function avatarUrl(user: DiscordUser): string {
  if (user.avatar) return `${CDN}/avatars/${user.id}/${user.avatar}.png?size=64`;
  let index = 0n;
  try {
    index = (BigInt(user.id) >> 22n) % 6n;
  } catch {
    index = 0n;
  }
  return `${CDN}/embed/avatars/${index}.png`;
}

export function userName(user: DiscordUser): string {
  const global = user.global_name?.trim();
  return global ? global : user.username;
}

/** Discord ids are snowflakes. */
export function validId(id: string): boolean {
  return id.length > 0 && id.length <= 20 && /^[0-9]+$/.test(id);
}

/** `next` if it is a same-origin relative path (`/…`, not `//…`). */
export function safeNext(next: string): string | null {
  const ok =
    next.startsWith("/") &&
    !next.startsWith("//") &&
    next.length <= 512 &&
    /^[\x21-\x7e]+$/.test(next) &&
    !next.includes("\\");
  return ok ? next : null;
}

/** base64url(SHA-256(verifier)), the S256 PKCE challenge. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

const TokenResponseSchema = z.object({ access_token: z.string() });
const DiscordUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  global_name: z.string().nullable().default(null),
  avatar: z.string().nullable().default(null),
});

export class OAuthConfigError extends Error {
  override readonly name = "OAuthConfigError";
}

/** A checked callback address; throws `OAuthConfigError` on a bad one. */
function redirectUrl(value: string): URL {
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    throw new OAuthConfigError("`[modules.api.discord_oauth] redirect_uri` is not an http(s) URL");
  }
  if (redirect.protocol !== "http:" && redirect.protocol !== "https:") {
    throw new OAuthConfigError("`[modules.api.discord_oauth] redirect_uri` is not an http(s) URL");
  }
  // The login cookie's `Path` comes from here, and a `;` would end it early.
  if (redirect.pathname.includes(";") || !isHeaderValue(redirect.pathname)) {
    throw new OAuthConfigError(
      "`[modules.api.discord_oauth] redirect_uri` has a path a cookie cannot name (a `;`)",
    );
  }
  if (!redirect.pathname.endsWith(CALLBACK_PATH)) {
    log.warn(
      { redirect: redirect.href },
      "discord_oauth redirect_uri should end in /api/auth/oauth/callback",
    );
  }
  return redirect;
}

/** A configured Discord OAuth client. */
export class OAuth {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: URL;
  readonly #alternates: readonly URL[];
  readonly #discord: URL;
  readonly #clock: Clock;
  readonly pending = new Pending();

  private constructor(
    clientId: string,
    clientSecret: string,
    redirectUri: URL,
    alternates: readonly URL[],
    discord: URL,
    clock: Clock,
  ) {
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#redirectUri = redirectUri;
    this.#alternates = alternates;
    this.#discord = discord;
    this.#clock = clock;
  }

  /** `null` when login is not configured; throws `OAuthConfigError` on bad URLs. */
  static fromConfig(config: DiscordOAuthConfig, clock: Clock): OAuth | null {
    const clientId = config.client_id.trim();
    const clientSecret = config.client_secret.trim();
    const redirectUri = config.redirect_uri.trim();
    const set = [clientId, clientSecret, redirectUri].filter((s) => s !== "").length;
    if (set < 3) {
      if (set > 0) {
        log.warn(
          "`[modules.api.discord_oauth]` needs client_id, client_secret and redirect_uri; Discord login stays off",
        );
      }
      return null;
    }
    const redirect = redirectUrl(redirectUri);
    const alternates = config.redirect_uris.map((u) => redirectUrl(u.trim()));
    let discord: URL;
    try {
      discord = new URL(config.discord_url.trim());
    } catch {
      throw new OAuthConfigError("`[modules.api.discord_oauth] discord_url` is not a URL");
    }
    if (!discord.pathname.startsWith("/")) {
      throw new OAuthConfigError("`[modules.api.discord_oauth] discord_url` is not a URL");
    }
    if (!discord.pathname.endsWith("/")) discord.pathname = `${discord.pathname}/`;
    return new OAuth(clientId, clientSecret, redirect, alternates, discord, clock);
  }

  redirectIsHttps(): boolean {
    return this.#redirectUri.protocol === "https:";
  }

  /** The configured address for `host`. A host nobody configured never becomes a redirect. */
  redirectFor(host: string | null): URL {
    return this.#alternates.find((u) => u.host === host) ?? this.#redirectUri;
  }

  #endpoint(path: string): URL {
    return new URL(path, this.#discord);
  }

  /**
   * Starts a login: remembers `state`, the PKCE verifier and the browser's `binding`, returns
   * the authorize URL.
   */
  begin(next: string, host: string | null, binding: string): URL {
    const state = randomToken(32);
    const verifier = randomToken(32);
    const now = this.#clock.now();
    const redirect = this.redirectFor(host);
    this.pending.insert(state, { verifier, next, redirect, binding, at: now }, now);
    const url = this.#endpoint("oauth2/authorize");
    const q = url.searchParams;
    q.append("response_type", "code");
    q.append("client_id", this.#clientId);
    q.append("scope", "identify");
    q.append("redirect_uri", redirect.href);
    q.append("state", state);
    q.append("code_challenge", pkceChallenge(verifier));
    q.append("code_challenge_method", "S256");
    q.append("prompt", "none");
    return url;
  }

  take(state: string): PendingLogin | null {
    return this.pending.take(state, this.#clock.now());
  }

  /** Exchanges the code and fetches the user, or names what failed. */
  async fetchUser(
    code: string,
    verifier: string,
    redirect: URL,
    signal: AbortSignal,
  ): Promise<DiscordUser | "exchange" | "discord"> {
    const form = new URLSearchParams([
      ["grant_type", "authorization_code"],
      ["code", code],
      ["redirect_uri", redirect.href],
      ["code_verifier", verifier],
      ["client_id", this.#clientId],
      ["client_secret", this.#clientSecret],
    ]);
    const timeout = () => AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let accessToken: string;
    try {
      const response = await fetch(this.#endpoint("api/oauth2/token"), {
        method: "POST",
        body: form,
        redirect: "manual",
        signal: timeout(),
      });
      if (!response.ok) throw new Error(`HTTP status ${response.status}`);
      accessToken = TokenResponseSchema.parse(await response.json()).access_token;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "Discord OAuth code exchange failed");
      return "exchange";
    }
    let user: DiscordUser;
    try {
      const response = await fetch(this.#endpoint("api/users/@me"), {
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: "manual",
        signal: timeout(),
      });
      if (!response.ok) throw new Error(`HTTP status ${response.status}`);
      user = DiscordUserSchema.parse(await response.json());
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot fetch the Discord user");
      return "discord";
    }
    if (!validId(user.id)) {
      log.warn({ id: user.id }, "Discord returned an invalid user id");
      return "discord";
    }
    return user;
  }
}

// ---- cookies ----------------------------------------------------------------------------

/** `Set-Cookie` value starting a session. */
export function sessionCookie(
  auth: PanelAuth,
  token: string,
  secure: boolean = auth.cookieSecure,
): string {
  const maxAge = Math.max(Math.floor(auth.sessions.ttlMs / 1000), 0);
  return cookieHeader(`${COOKIE}=${token}; Max-Age=${maxAge}`, secure);
}

/** `Set-Cookie` value deleting the session cookie. */
export function clearCookie(auth: PanelAuth): string {
  return cookieHeader(`${COOKIE}=; Max-Age=0`, auth.cookieSecure);
}

/** Every `Cookie` header of the request. */
export function requestCookies(c: ApiContext): string[] {
  const raw = c.env as { incoming?: { headersDistinct?: Record<string, string[] | undefined> } };
  const distinct = raw?.incoming?.headersDistinct?.cookie;
  if (distinct) return distinct;
  const header = c.req.header("cookie");
  return header ? [header] : [];
}

// ---- routes -----------------------------------------------------------------------------

/** A header value must be visible ASCII, spaces or tabs. */
function isHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c !== 9 && (c < 32 || c > 126)) return false;
  }
  return true;
}

/** A `302 Found` that is never cached or leaks the callback URL. */
export function found(location: string, ...cookies: string[]): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  headers.set("location", isHeaderValue(location) ? location : DEFAULT_NEXT);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function loginError(code: string): Response {
  return found(`/login?error=${code}`);
}

export function methods(state: ApiState): AuthMethods {
  return { token: true, discord: state.auth.oauth !== null };
}

export function login(state: ApiState, c: ApiContext): Response {
  const oauth = state.auth.oauth;
  if (!oauth) return loginError("disabled");
  const next = c.req.query("next");
  const target = next !== undefined && safeNext(next) !== null ? next : DEFAULT_NEXT;
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? null;
  const redirect = oauth.redirectFor(host);
  // The login cookie is set on the host the browser is on, and the callback must find it there:
  // a login started on another host (`localhost` while the redirect names `127.0.0.1`) starts
  // over on the redirect's host first. Only a configured address is ever a target, and only once.
  if (host !== null && host.toLowerCase() !== redirect.host) {
    const moved = loginUrlOn(redirect);
    if (c.req.query(MOVED_PARAM) !== undefined) {
      // A proxy that rewrites `Host` looks like this; the browser is on the redirect's host.
      log.info({ host, redirect: redirect.host }, "a moved Discord login still names another host");
    } else if (moved) {
      moved.searchParams.set("next", target);
      moved.searchParams.set(MOVED_PARAM, "1");
      return found(moved.href);
    } else {
      log.warn(
        { host, redirect: redirect.href },
        "a Discord login started on a host its redirect_uri does not name, and that redirect_uri does not end in /api/auth/oauth/callback; the callback will not see the login cookie and fails. Add the host to redirect_uris",
      );
    }
  }
  const binding = randomToken(18);
  const url = oauth.begin(target, host, binding);
  const https = redirect.protocol === "https:";
  return found(url.href, loginCookie(binding, state.auth.cookieSecure || https, redirect));
}

/** `redirect`'s login route: its callback path with `login` for `callback`. */
function loginUrlOn(redirect: URL): URL | null {
  if (!redirect.pathname.endsWith(CALLBACK_PATH)) return null;
  const url = new URL(redirect.origin);
  url.pathname = `${redirect.pathname.slice(0, -CALLBACK_PATH.length)}${LOGIN_PATH}`;
  return url;
}

/**
 * The login cookie's `Path`: the directory of the callback, prefix included, so a panel mounted
 * under `/miyoria/` still gets it back.
 */
export function loginCookiePath(redirect: URL): string {
  const path = redirect.pathname;
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

/**
 * `Set-Cookie` value tying a login to this browser, for as long as the login may take; an empty
 * `binding` deletes it.
 */
function loginCookie(binding: string, secure: boolean, redirect: URL): string {
  const maxAge = binding === "" ? 0 : Math.floor(STATE_TTL_MS / 1000);
  const path = loginCookiePath(redirect);
  return `${LOGIN_COOKIE}=${binding}; Max-Age=${maxAge}; Path=${path}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Whether the browser asking is the one that started `pending`. */
function sameBrowser(pending: PendingLogin, c: ApiContext): boolean {
  const held = cookieValue(requestCookies(c), LOGIN_COOKIE);
  if (held === null) {
    log.info("a Discord login came back without its login cookie (another browser or host)");
    return false;
  }
  const a = Buffer.from(held, "utf8");
  const b = Buffer.from(pending.binding, "utf8");
  if (a.length === b.length && timingSafeEqual(a, b)) return true;
  log.info("a Discord login came back in a browser that did not start it");
  return false;
}

export async function callback(state: ApiState, c: ApiContext): Promise<Response> {
  const oauth = state.auth.oauth;
  if (!oauth) return loginError("disabled");
  const stateParam = c.req.query("state");
  const pending = stateParam !== undefined ? oauth.take(stateParam) : null;
  if (c.req.query("error") !== undefined) return loginError("cancelled");
  if (!pending) return loginError("state");
  // `pending` is already taken: a refused callback uses its state up.
  if (!sameBrowser(pending, c)) return loginError("state");
  const code = c.req.query("code");
  if (!code) return loginError("exchange");
  const user = await oauth.fetchUser(code, pending.verifier, pending.redirect, state.ctx.signal);
  if (typeof user === "string") return loginError(user);
  const account: AccountRef = { platform: "discord", id: user.id };
  const actor = accountRefString(account);
  const authorizer = state.optional(AuthorizerKey);
  if (!authorizer) {
    log.warn({ account: actor }, "no authorizer service; refusing panel login");
    return loginError("unavailable");
  }
  const admin = authorizer.allows(account, PANEL_ACCESS);
  if (!admin && !state.publicSide.config.enabled) {
    log.info({ account: actor }, `panel login denied: no \`${PANEL_ACCESS}\``);
    await state.auditAs(actor, "panel.login", actor, {}, false);
    return loginError("denied");
  }
  const store = state.optional(SettingsStoreKey);
  const name = userName(user);
  const tier = admin ? "admin" : "member";
  const token = await state.auth.sessions.create(store, account, name, avatarUrl(user), tier);
  log.info({ account: actor, name, tier }, "panel login");
  await state.auditAs(actor, admin ? "panel.login" : "member.login", actor, { name }, true);
  const secure = state.auth.cookieSecure || pending.redirect.protocol === "https:";
  // The login is done: the cookie that tied it to this browser has nothing left to do.
  return found(
    pending.next,
    sessionCookie(state.auth, token, secure),
    loginCookie("", secure, pending.redirect),
  );
}

export function session(c: ApiContext): SessionInfo {
  const principal = c.get("principal");
  if (!principal || principal.kind === "token") {
    return { method: "token", user: null, permissions: { write: true } };
  }
  const { record, write } = principal;
  return {
    method: "discord",
    user: { id: record.account.id, name: record.name, avatar_url: record.avatar_url },
    permissions: { write },
  };
}

/** `GET /api/auth/methods` (public), `GET /api/auth/session`. */
export const authRpc = {
  methods: os.auth.methods.handler(({ context }) => methods(context.state)),
  session: os.auth.session.handler(({ context }) => session(context.c)),
};

export async function logout(state: ApiState, c: ApiContext): Promise<Response> {
  const token = cookieToken(requestCookies(c));
  if (token !== null) {
    if (!hasCsrfHeader(c.req.header("x-miyoria-request"))) {
      throw new ApiError(403, "missing the `x-miyoria-request: 1` header");
    }
    await state.auth.sessions.remove(state.optional(SettingsStoreKey), token);
  }
  return new Response(null, { status: 204, headers: { "set-cookie": clearCookie(state.auth) } });
}
