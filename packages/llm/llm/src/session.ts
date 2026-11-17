// Stable conversation ids for `ChatRequest.session`.
//
// Providers that support it use the id for routing and prompt caching, so it must stay the
// same for every request of one conversation (and identical to the Rust implementation, so
// caches survive the port). Raw platform ids never appear in it: the context is hashed.

import { createHash } from "node:crypto";
import { type ContextKey, type ContextKind, contextKeyString } from "@miyoria/types";

/** Rust `Debug` names of `ContextKind`, part of the hashed text. */
const KIND_DEBUG: Readonly<Record<ContextKind, string>> = {
  channel: "Channel",
  thread: "Thread",
  dm: "Dm",
  voice: "Voice",
};

/** First 16 hex digits of SHA-256 over `"<context display>|<Kind>"`. */
export function contextHash(context: ContextKey): string {
  return createHash("sha256")
    .update(`${contextKeyString(context)}|${KIND_DEBUG[context.kind]}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** `miyoria-<profile>-<context hash>` for a conversation context. */
export function contextSession(profile: string, context: ContextKey): string {
  return sessionId(profile, contextHash(context));
}

/** `miyoria-<profile>-<scope>`; the profile id is reduced to header-safe characters. */
export function sessionId(profile: string, scope: string): string {
  let safe = "";
  for (const c of profile) safe += /^[A-Za-z0-9_-]$/.test(c) ? c : "_";
  return `miyoria-${safe}-${scope}`;
}
