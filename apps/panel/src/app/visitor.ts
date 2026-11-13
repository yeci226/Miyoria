// Who is at the door: an admin (token or Discord), a member, or anyone else. Asked by the panel
// on load and by the landing page while it already shows, so neither waits for the other.

import type { Api } from "@/api/endpoints";
import { isApiError } from "@/api/http";
import type { AuthMethods, MemberSession, SessionInfo } from "@/api/types";
import { readStorage, writeStorage } from "@/lib/storage";
import { TOKEN_SESSION } from "./session";

export type AuthState =
  | { status: "checking" }
  /** `rejected`: the saved token stopped working; `expired`: the Discord session ended. */
  | { status: "signed_out"; reason?: "rejected" | "expired" }
  | { status: "signed_in"; session: SessionInfo }
  /**
   * Not an admin. Someone logged in (`member`) sees their page; anyone else, the login screen.
   */
  | { status: "public"; member: MemberSession | null };

/** What the check found: who it is and how one may log in (`null`: the Core did not say). */
export interface Visitor {
  auth: Exclude<AuthState, { status: "checking" }>;
  methods: AuthMethods | null;
}

/**
 * Who sees the public site, or `null` when this Core has none (older, or switched off): then the
 * login screen is all there is. Being unable to reach it says nothing about it, so that is `null`
 * too, and the login screen shows what is wrong.
 */
async function publicVisitor(api: Api, signal: AbortSignal): Promise<{ member: MemberSession | null } | null> {
  const [site, member] = await Promise.allSettled([api.publicStatus({ signal }), api.memberSession({ signal })]);
  const open = site.status === "fulfilled" || (isApiError(site.reason) && site.reason.status === 429);
  if (!open) return null;
  return { member: member.status === "fulfilled" ? member.value : null };
}

/** Asks the Core who this is (`token`: the saved one, `""` for none); `null` once aborted. */
export async function checkVisitor(api: Api, token: string, signal: AbortSignal): Promise<Visitor | null> {
  const [m, s] = await Promise.allSettled([api.authMethods({ signal }), api.session({ signal })]);
  if (signal.aborted) return null;
  const methods = m.status === "fulfilled" ? m.value : null;
  if (s.status === "fulfilled") return { auth: { status: "signed_in", session: s.value }, methods };
  const e: unknown = s.reason;
  const unauthorized = isApiError(e) && e.kind === "unauthorized";
  // A saved token on an older or unreachable Core: carry on as before
  // (the shell shows the Core as unreachable).
  if (token && !unauthorized) return { auth: { status: "signed_in", session: TOKEN_SESSION }, methods };
  if (token) return { auth: { status: "signed_out", reason: "rejected" }, methods };
  const visitor = await publicVisitor(api, signal);
  if (signal.aborted) return null;
  return { auth: visitor ? { status: "public", member: visitor.member } : { status: "signed_out" }, methods };
}

/**
 * Set while this browser is logged in (an admin, or a member with a page of their own): the next
 * load goes straight to the panel instead of showing the landing page first.
 */
export const SIGNED_IN_HINT = "miyoria.panel.signedIn";

export function rememberVisitor(auth: AuthState): void {
  if (auth.status === "checking") return;
  const signedIn = auth.status === "signed_in" || (auth.status === "public" && auth.member !== null);
  writeStorage(SIGNED_IN_HINT, signedIn ? "1" : null);
}

/**
 * Whether this load may show the landing page before knowing who it is: the bare front page, no
 * saved token, and nobody logged in last time. Anyone else gets the panel, which asks first.
 */
export function landingFirst(path: string, token: string): boolean {
  return path === "/" && token === "" && readStorage(SIGNED_IN_HINT) === null;
}
