import { createContext, type ReactNode, useContext } from "react";
import type { SessionInfo } from "../api/types";

/** What the Core said about the signed-in user (`GET /api/auth/session`). */
export interface SessionValue {
  session: SessionInfo;
  /** Ends the Discord session, or forgets the token. */
  logout: () => void;
}

/** Older Cores have no `/api/auth/session`; a working token may do anything. */
export const TOKEN_SESSION: SessionInfo = { method: "token", user: null, permissions: { write: true } };

/** Tooltip on controls a read-only (no `admin.panel.write`) account cannot use. */
export const READ_ONLY_HINT = "你的帳號只能檢視(需要 admin.panel.write 權限)";

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ value, children }: { value: SessionValue; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue | null {
  return useContext(SessionContext);
}

/** False for Discord users without `admin.panel.write`; true outside a session (tests, token). */
export function useCanWrite(): boolean {
  return useContext(SessionContext)?.session.permissions.write ?? true;
}

// --- login redirects ---------------------------------------------------------

/** `?error=` codes the Core's OAuth callback redirects to (`/login?error=…`). */
export const LOGIN_ERRORS: Record<string, string> = {
  disabled: "這個 Core 沒有設定 Discord 登入。",
  cancelled: "已取消 Discord 授權。",
  state: "登入連結已過期或無效,請再試一次。",
  exchange: "Discord 授權沒有完成,請再試一次。",
  discord: "暫時無法向 Discord 取得帳號資料,請稍後再試。",
  denied: "這個 Discord 帳號沒有管理面板權限(admin.panel.access)。請擁有者用 /admin role assign 或 /admin perm allow 開放。",
  unavailable: "權限模組沒有在執行,暫時無法用 Discord 登入。",
};

export function loginErrorMessage(code: string): string {
  return LOGIN_ERRORS[code] ?? "登入失敗,請再試一次。";
}

const isLoginPath = (path: string) => path === "/login" || path.startsWith("/login?") || path.startsWith("/login/");

/** The `?error=` code of a failed Discord login in `path` (`/login?error=<code>`), or `null`. */
export function loginErrorIn(path: string): string | null {
  if (!isLoginPath(path)) return null;
  const q = path.indexOf("?");
  return q === -1 ? null : new URLSearchParams(path.slice(q + 1)).get("error");
}

/** The address asks for the login screen itself (`/login`), not for a failed login's message. */
export function wantsTokenLogin(path: string): boolean {
  return isLoginPath(path) && loginErrorIn(path) === null;
}

/** Where to come back to after a Discord login: the current page (never the login page). */
export function loginNext(): string {
  const path = `${window.location.pathname || "/"}${window.location.search}`;
  return isLoginPath(path) ? "/" : path;
}

/**
 * Addresses from before clean ones (`/#/card/MYR-…`, `/#/people`) become the same page without
 * the `#`, so the QR codes on cards people already have keep working.
 */
export function cleanHashAddress(): void {
  const hash = window.location.hash;
  if (!hash.startsWith("#/")) return;
  try {
    window.history.replaceState(window.history.state, "", hash.slice(1));
  } catch {
    // Leave the address as it is; the page still opens at `/`.
  }
}

/** Cookies only reach the Core when the panel and the API share an origin. */
export function isSameOrigin(baseUrl: string): boolean {
  if (!baseUrl.trim()) return true;
  try {
    return new URL(baseUrl, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}
