import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ClientError, FETCH_BLOCKED_PORTS, responseError } from "../../src/index.js";

/** Listens on a random 127.0.0.1 port that `fetch` may connect to; returns the port. */
export async function listenFetchable(server: Server): Promise<number> {
  for (;;) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    if (!FETCH_BLOCKED_PORTS.has(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export interface RawResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body, `null` when the body is empty or not JSON. */
  body: unknown;
  text: string;
}

export interface RawOptions {
  token?: string;
  headers?: Record<string, string>;
  json?: unknown;
}

/** One request without the client, redirects not followed. */
export async function raw(
  base: string,
  method: string,
  path: string,
  options: RawOptions = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(`${base}${path}`, { method, headers, body, redirect: "manual" });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

/**
 * A route of the route table called the way the CLI's client calls it: the bearer token, JSON in
 * and out, a `ClientError` when the call fails.
 */
export async function call<T>(
  base: string,
  token: string,
  method: string,
  path: string,
  json?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (json !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  } catch (error) {
    throw ClientError.transport(error);
  }
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The HTTP status of a rejected client call. */
export async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClientError && error.status !== null) return error.status;
    throw new Error(`expected an API error, got ${String(error)}`);
  }
  throw new Error("expected an API error, got success");
}

/** The rejected client call's error. */
export async function errorOf(promise: Promise<unknown>): Promise<ClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClientError) return error;
    throw error;
  }
  throw new Error("expected an API error, got success");
}

/** `GET /api/events` with the token: the body's reader, once the headers are in. */
export async function openEvents(
  base: string,
  token: string,
  query = "",
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(`${base}/api/events${query}`, {
    headers: { authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || res.body === null) throw new Error(`no event stream: ${res.status}`);
  return res.body.getReader();
}

/** The `data:` of the next event on an event stream, parsed; `null` once the stream ends. */
export async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { text: string } = { text: "" },
): Promise<unknown> {
  const decoder = new TextDecoder();
  for (;;) {
    const end = buffer.text.indexOf("\n\n");
    if (end >= 0) {
      const frame = buffer.text.slice(0, end);
      buffer.text = buffer.text.slice(end + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data !== undefined) return JSON.parse(data.slice("data: ".length));
      continue;
    }
    const { value, done } = await reader.read();
    if (done) return null;
    buffer.text += decoder.decode(value, { stream: true });
  }
}

/** Polls `check` every 20 ms until it returns a value, for up to 2 s. */
export async function waitFor<T>(
  check: () => T | null | undefined | Promise<T | null | undefined>,
): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met in time");
}
