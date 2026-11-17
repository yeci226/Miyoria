// Where guarded states come from when no control link has set a source: Core's public status, if
// Core is a service of this host (docs/design/v5-hostd.md §4).

import type { HostGuardState } from "@miyoria/contracts/host";
import type { GuardSource } from "./api.js";

export class GuardUnknownError extends Error {
  override name = "GuardUnknownError";
}

/** `{ state, live }` of `GET /api/public/status` as guarded states. */
export function guardStatesOf(body: unknown): HostGuardState[] {
  if (typeof body !== "object" || body === null) throw new GuardUnknownError("not a status");
  const { state, live } = body as { state?: unknown; live?: unknown };
  if (typeof state !== "string" || typeof live !== "boolean") {
    throw new GuardUnknownError("not a status");
  }
  const out: HostGuardState[] = [];
  if (state === "singing") out.push("singing");
  if (live) out.push("live");
  return out;
}

/** Reads Core's public status; `baseUrl()` is `null` while Core is not a service here. */
export function coreStatusGuard(baseUrl: () => string | null): GuardSource {
  return {
    async states(signal) {
      const base = baseUrl();
      if (base === null) throw new GuardUnknownError("Core is not a service of this host");
      const signals = [AbortSignal.timeout(3000)];
      if (signal !== undefined) signals.push(signal);
      const res = await fetch(`${base}/api/public/status`, { signal: AbortSignal.any(signals) });
      if (!res.ok) throw new GuardUnknownError(`Core answered ${res.status}`);
      return guardStatesOf(await res.json());
    },
  };
}

const LABEL: Record<HostGuardState, string> = {
  singing: "她正在唱歌(singing)",
  live: "正在直播(live)",
};

/** The text of a refusal. */
export function guardedMessage(service: string, active: readonly HostGuardState[]): string {
  return `${service} 受保護:${active.map((s) => LABEL[s]).join("、")};等一下再試,或加 --force`;
}

export function guardUnknownMessage(service: string, guard: readonly HostGuardState[]): string {
  return `${service} 受保護(${guard.join("、")}),但問不到 Core 現在的狀態;確定要做請加 --force`;
}
