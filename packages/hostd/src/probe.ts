// Health probes (docs/design/v5-hostd.md §4): HTTP, TCP, or the process being alive.

import { tcpConnect } from "./ports.js";

/**
 * `GET url`: healthy when the status is 200 and, when the body is JSON with a `status` field,
 * that field is `"ok"`. Another program's 200 with `{"status": "starting"}` is not healthy.
 */
export async function httpHealthy(
  url: string,
  options: { timeoutMs: number; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<boolean> {
  return (await httpProbe(url, options)).healthy;
}

/** `httpHealthy` with the JSON body of the answer (`undefined` when it was not JSON). */
export async function httpProbe(
  url: string,
  options: { timeoutMs: number; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<{ healthy: boolean; body: unknown }> {
  const signals = [AbortSignal.timeout(options.timeoutMs)];
  if (options.signal !== undefined) signals.push(options.signal);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.any(signals),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    });
    const text = await res.text();
    if (res.status !== 200) return { healthy: false, body: undefined };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { healthy: true, body: undefined };
    }
    if (typeof body === "object" && body !== null && !Array.isArray(body) && "status" in body) {
      return { healthy: (body as { status: unknown }).status === "ok", body };
    }
    return { healthy: true, body };
  } catch {
    return { healthy: false, body: undefined };
  }
}

/** Whether something accepts a TCP connection on host:port. */
export function tcpHealthy(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return tcpConnect(host, port, timeoutMs);
}
