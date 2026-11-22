// Whether the caller of a long request (an event stream) may still be served: asked again while it
// is open, so a stream ends when the session does (logout, expiry, the account losing the panel),
// when the token no longer matches, or when the address is locked out for wrong tokens. The checks
// are the server's own (`server.ts`), without counting anything: a recheck is not a new attempt.

import { SettingsStoreKey } from "@miyoria/store";
import { AuthorizerKey, accountRefString } from "@miyoria/types";
import * as oauth from "./oauth.js";
import { cookieToken, type SessionRecord, tokenMatches } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";

/** How often an open stream's caller is checked again. */
export const RECHECK_MS = 30_000;

async function liveSession(state: ApiState, c: ApiContext) {
  const auth = state.auth;
  const token = auth.oauth ? cookieToken(oauth.requestCookies(c)) : null;
  if (token === null) return null;
  return auth.sessions.lookup(
    state.optional(SettingsStoreKey),
    state.optional(AuthorizerKey),
    token,
  );
}

/** A member stream: the same person's session is still live. */
export async function memberStillIn(state: ApiState, c: ApiContext): Promise<boolean> {
  const was = c.get("member") as SessionRecord | undefined;
  if (was === undefined) return false;
  const found = await liveSession(state, c);
  return found !== null && accountRefString(found.record.account) === accountRefString(was.account);
}

/**
 * An admin stream: the bearer token still matches and its address is not locked out, or the
 * session is still an admin session with panel access (the same two conditions as at connect).
 */
export async function adminStillIn(state: ApiState, c: ApiContext): Promise<boolean> {
  const auth = state.auth;
  const header = c.req.header("authorization");
  if (header !== undefined) {
    const limiter = auth.limiter;
    if (
      limiter !== undefined &&
      limiter.blocked(state.publicSide.client(c), state.now()) !== null
    ) {
      return false;
    }
    return header.startsWith("Bearer ") && tokenMatches(auth.token, header.slice(7));
  }
  const found = await liveSession(state, c);
  return found !== null && found.record.tier === "admin" && found.access.panel;
}
