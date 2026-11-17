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
  const signals = [AbortSignal.timeout(options.timeoutMs)];
  if (options.signal !== undefined) signals.push(options.signal);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.any(signals),
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    });
    const text = await res.text();
    if (res.status !== 200) return false;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return true;
    }
    if (typeof body === "object" && body !== null && !Array.isArray(body) && "status" in body) {
      return (body as { status: unknown }).status === "ok";
    }
    return true;
  } catch {
    return false;
  }
}

/** Whether something accepts a TCP connection on host:port. */
export function tcpHealthy(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return tcpConnect(host, port, timeoutMs);
}
