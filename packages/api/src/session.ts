// Panel login: the static bearer token or a Discord OAuth session cookie.
//
// Session tokens are 256 random bits; only their SHA-256 hash is kept, in memory and (when there
// is a `SettingsStore`) under profile `_global`, key `panel_session:<hash>`, so sessions survive
// a restart. Every request re-checks `admin.panel.access` (cached for `recheck_secs`), so revoking
// a role takes effect without logging anyone out by hand.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PANEL_ACCESS, PANEL_WRITE } from "@miyoria/auth";
import { errorMessage, getLogger } from "@miyoria/kernel";
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
 * `member` to anyone else who logged in, and it opens the member routes and nothing more, even if
 * the account gains the permission later: admin access takes a new login.
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
    const current = this.#map.get(hash);
    if (current) current.checked = { at: this.#clock.now(), access };
    return { record, access };
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
  for (const header of cookieHeaders) {
    for (const pair of header.split(";")) {
      const trimmed = pair.trim();
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      if (trimmed.slice(0, eq) !== COOKIE) continue;
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
