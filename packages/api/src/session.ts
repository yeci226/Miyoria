// Panel login: the static bearer token or a Discord OAuth session cookie.
//
// Session tokens are 256 random bits; only their SHA-256 hash is kept, in memory and (when there
// is a `SettingsStore`) under profile `_global`, key `panel_session:<hash>`, so sessions survive
// a restart. Every request re-checks `admin.panel.access` (cached for `recheck_secs`, and at once
// after a role change made through the API), so revoking a role takes effect without logging
// anyone out by hand; a session whose tier no longer fits the account's access is ended.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PANEL_ACCESS, PANEL_WRITE } from "@miyoria/auth";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  type Authorizer,
  accountRefString,
  type Clock,
  isJsonObject,
  type JsonValue,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";

const log = getLogger("api.session");

/** Name of the session cookie. */
export const COOKIE = "miyoria_session";
/**
 * Name of the cookie that ties a Discord login to the browser that started it: the callback is
 * only taken from a browser that holds it, so a callback link made in someone else's login logs
 * nobody in.
 */
export const LOGIN_COOKIE = "miyoria_login";
/**
 * Header cookie-authenticated changes must carry (value `1`). A cross-site form or link cannot
 * set it, which makes it a CSRF guard.
 */
export const CSRF_HEADER = "x-miyoria-request";
/** Lets OAuth users into the panel at all; `PANEL_WRITE` lets them change things. */
export { PANEL_ACCESS, PANEL_WRITE };
/** Actor recorded in audit entries for changes made with the bearer token. */
export const TOKEN_ACTOR = "api";

/** Settings profile and key prefix of persisted sessions. */
export const STORE_PROFILE = "_global";
export const STORE_PREFIX = "panel_session:";
/** Length of a base64url-encoded 32-byte token. */
export const TOKEN_LEN = 43;

/** `n` random bytes from the OS, base64url without padding. */
export function randomToken(n: number): string {
  return randomBytes(n).toString("base64url");
}

/** Lowercase hex SHA-256. */
export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export function looksLikeToken(token: string): boolean {
  return token.length === TOKEN_LEN && /^[A-Za-z0-9_-]+$/.test(token);
}

/**
 * What a session was opened as. `admin` was given to an account holding `admin.panel.access`;
 * `member` to anyone else who logged in, and it opens the member routes and nothing more. When the
 * account's access changes either way (a role granted or taken), the session ends at its next
 * check, so the person logs in again and gets the tier that fits.
 */
export type SessionTier = "admin" | "member";

/** A logged-in panel user, as persisted. */
export interface SessionRecord {
  account: AccountRef;
  name: string;
  avatar_url: string | null;
  tier: SessionTier;
  created_at: Timestamp;
  expires_at: Timestamp;
}

function parseRecord(value: JsonValue): SessionRecord | null {
  if (!isJsonObject(value)) return null;
  const { account, name, avatar_url, tier, created_at, expires_at } = value;
  if (
    !isJsonObject(account) ||
    typeof account.platform !== "string" ||
    typeof account.id !== "string" ||
    typeof name !== "string" ||
    !(avatar_url === null || avatar_url === undefined || typeof avatar_url === "string") ||
    typeof created_at !== "string" ||
    typeof expires_at !== "string" ||
    Number.isNaN(Date.parse(created_at)) ||
    Number.isNaN(Date.parse(expires_at))
  ) {
    return null;
  }
  return {
    account: { platform: account.platform, id: account.id },
    name,
    avatar_url: avatar_url ?? null,
    // Sessions stored before tiers existed were all admin logins; access is re-checked regardless.
    tier: tier === "member" ? "member" : "admin",
    created_at,
    expires_at,
  };
}

export interface Access {
  panel: boolean;
  write: boolean;
}

/** What an account may do in the panel. Without an authorizer nobody but the token gets in. */
export function checkAccess(authorizer: Authorizer | undefined, account: AccountRef): Access {
  if (!authorizer) return { panel: false, write: false };
  const panel = authorizer.allows(account, PANEL_ACCESS);
  return { panel, write: panel && authorizer.allows(account, PANEL_WRITE) };
}

interface Entry {
  record: SessionRecord;
  checked: { at: number; access: Access } | null;
}

/** Who made a protected request. */
export type Principal =
  | { kind: "token" }
  | { kind: "session"; record: SessionRecord; write: boolean };

/** Actor of a request for audit entries: `"api"` or the account (`discord:<id>`). */
export function principalActor(principal: Principal | undefined): string {
  if (!principal || principal.kind === "token") return TOKEN_ACTOR;
  return accountRefString(principal.record.account);
}

function storeKey(hash: string): string {
  return `${STORE_PREFIX}${hash}`;
}

/** Live sessions by token hash. */
export class Sessions {
  readonly #map = new Map<string, Entry>();
  readonly ttlMs: number;
  readonly #recheckMs: number;
  readonly #clock: Clock;

  constructor(ttlMs: number, recheckMs: number, clock: Clock) {
    this.ttlMs = ttlMs;
    this.#recheckMs = recheckMs;
    this.#clock = clock;
  }

  /** Number of sessions held in memory (diagnostics and tests). */
  get size(): number {
    return this.#map.size;
  }

  /** The display name of a live session of `account` held in memory, `null` when none. */
  nameOf(account: AccountRef): string | null {
    for (const { record } of this.#map.values()) {
      if (record.account.platform === account.platform && record.account.id === account.id) {
        return record.name;
      }
    }
    return null;
  }

  /** Starts a session and returns its token (the cookie value). */
  async create(
    store: SettingsStore | undefined,
    account: AccountRef,
    name: string,
    avatarUrl: string | null,
    tier: SessionTier,
  ): Promise<string> {
    const token = randomToken(32);
    const hash = sha256Hex(token);
    const now = this.#clock.now();
    const record: SessionRecord = {
      account,
      name,
      avatar_url: avatarUrl,
      tier,
      created_at: toTimestamp(now),
      expires_at: toTimestamp(now + this.ttlMs),
    };
    if (store) {
      try {
        await store.set(STORE_PROFILE, storeKey(hash), { ...record, account: { ...account } });
      } catch (error) {
        log.warn(
          { error: errorMessage(error) },
          "cannot persist panel session; it lasts until restart",
        );
      }
    }
    this.#map.set(hash, { record, checked: null });
    return token;
  }

  /** The live session for `token` and what it may do now. */
  async lookup(
    store: SettingsStore | undefined,
    authorizer: Authorizer | undefined,
    token: string,
  ): Promise<{ record: SessionRecord; access: Access } | null> {
    if (!looksLikeToken(token)) return null;
    const hash = sha256Hex(token);
    const now = this.#clock.now();
    let entry = this.#map.get(hash);
    if (entry && Date.parse(entry.record.expires_at) <= now) {
      this.#map.delete(hash);
      entry = undefined;
    }
    let record: SessionRecord;
    let checked: Entry["checked"];
    if (entry) {
      record = entry.record;
      checked = entry.checked;
    } else {
      const loaded = await this.#load(store, hash, now);
      if (!loaded) return null;
      record = loaded;
      checked = null;
    }
    if (checked && this.#clock.now() - checked.at < this.#recheckMs) {
      return { record, access: checked.access };
    }
    const access = checkAccess(authorizer, record.account);
    // The account's roles changed since the login: a member who may now use the panel, or an
    // admin who no longer may, logs in again to get the session that fits. Without an authorizer
    // (the auth module is restarting) nothing can be told, so nothing is ended.
    if (authorizer !== undefined && (record.tier === "admin") !== access.panel) {
      log.info(
        { account: accountRefString(record.account), tier: record.tier },
        "panel session ended: the account's access changed",
      );
      await this.#drop(store, hash);
      return null;
    }
    const current = this.#map.get(hash);
    if (current) current.checked = { at: this.#clock.now(), access };
    return { record, access };
  }

  /**
   * Forgets every session's last access check, so the next request of each is checked again at
   * once (after a role, an assignment or a mapping changed), whatever `recheck_secs` says.
   */
  recheckAll(): void {
    for (const entry of this.#map.values()) entry.checked = null;
  }

  async #drop(store: SettingsStore | undefined, hash: string): Promise<void> {
    this.#map.delete(hash);
    if (!store) return;
    try {
      await store.set(STORE_PROFILE, storeKey(hash), null);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot delete panel session");
    }
  }

  /** Reads a session another run of this module persisted. */
  async #load(
    store: SettingsStore | undefined,
    hash: string,
    now: number,
  ): Promise<SessionRecord | null> {
    if (!store) return null;
    const key = storeKey(hash);
    let value: JsonValue | null;
    try {
      value = await store.get(STORE_PROFILE, key);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot read panel session");
      return null;
    }
    if (value === null) return null;
    const record = parseRecord(value);
    if (!record || Date.parse(record.expires_at) <= now) {
      try {
        await store.set(STORE_PROFILE, key, null);
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "cannot delete expired panel session");
      }
      return null;
    }
    this.#map.set(hash, { record, checked: null });
    return record;
  }

  /** Ends the session for `token`, if any. */
  async remove(store: SettingsStore | undefined, token: string): Promise<void> {
    if (!looksLikeToken(token)) return;
    const hash = sha256Hex(token);
    this.#map.delete(hash);
    if (!store) return;
    try {
      await store.set(STORE_PROFILE, storeKey(hash), null);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot delete panel session");
    }
  }

  /** Drops expired sessions from memory and the store. */
  async prune(store: SettingsStore | undefined): Promise<void> {
    const now = this.#clock.now();
    for (const [hash, entry] of this.#map) {
      if (Date.parse(entry.record.expires_at) <= now) this.#map.delete(hash);
    }
    if (!store) return;
    let all: Map<string, JsonValue>;
    try {
      all = await store.list(STORE_PROFILE, STORE_PREFIX);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot list panel sessions");
      return;
    }
    for (const [key, value] of all) {
      const record = parseRecord(value);
      const live = record !== null && Date.parse(record.expires_at) > now;
      if (live) continue;
      try {
        await store.set(STORE_PROFILE, key, null);
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "cannot delete expired panel session");
      }
    }
  }
}

/** Compares the presented token with the configured one in constant time. */
export function tokenMatches(expected: Buffer, presented: string): boolean {
  const given = Buffer.from(presented.trim(), "utf8");
  if (given.length !== expected.length) {
    // Still spend the comparison so timing does not depend on where the mismatch is.
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(given, expected);
}

/** `Set-Cookie` value with the shared attributes. */
export function cookieHeader(start: string, secure: boolean): string {
  return `${start}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The session cookie's value, if the request has one. Every `Cookie` header is searched. */
export function cookieToken(cookieHeaders: readonly string[]): string | null {
  return cookieValue(cookieHeaders, COOKIE);
}

/** The value of the cookie `name`, if the request has one. Every `Cookie` header is searched. */
export function cookieValue(cookieHeaders: readonly string[], name: string): string | null {
  for (const header of cookieHeaders) {
    for (const pair of header.split(";")) {
      const trimmed = pair.trim();
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      if (trimmed.slice(0, eq) !== name) continue;
      const value = trimmed.slice(eq + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/** Did the request carry the CSRF guard header? */
export function hasCsrfHeader(value: string | null | undefined): boolean {
  return value === "1";
}

export function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
