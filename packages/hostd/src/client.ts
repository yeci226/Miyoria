// A small typed client for the local API of a running daemon, as the CLI uses it.

import { HOST_ERROR_CODE } from "@miyoria/contracts/host";
import { HostRpcError } from "./api.js";
import { type RunInfo, readRunFile, runFilePath } from "./run-file.js";

/** No daemon answers at the address of the run file. */
export class HostdUnavailableError extends Error {
  override name = "HostdUnavailableError";
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Default 30 s; a stop may wait out a service's grace period. */
  timeoutMs?: number;
  /** Progress lines of a long method (an install) as the daemon sends them. */
  onLine?: (line: string) => void;
}

export interface LogsOptions {
  lines?: number;
  follow?: boolean;
  signal?: AbortSignal;
}

let nextId = 1;

function signalOf(options: CallOptions, fallbackMs: number): AbortSignal {
  const signals = [AbortSignal.timeout(options.timeoutMs ?? fallbackMs)];
  if (options.signal !== undefined) signals.push(options.signal);
  return AbortSignal.any(signals);
}

/** Reads an NDJSON answer: the `{"line"}` objects go to `onLine`, the last object is returned. */
async function readStream(res: Response, onLine: (line: string) => void): Promise<unknown> {
  if (!(res.headers.get("content-type") ?? "").includes("ndjson") || res.body === null) {
    return await res.json(); // an error before the stream started
  }
  const decoder = new TextDecoder();
  let rest = "";
  let last: unknown;
  const take = (text: string) => {
    if (text.trim() === "") return;
    const value = JSON.parse(text) as { line?: unknown };
    if (typeof value.line === "string" && !("jsonrpc" in value)) onLine(value.line);
    else last = value;
  };
  for await (const chunk of res.body) {
    rest += decoder.decode(chunk as Uint8Array, { stream: true });
    const parts = rest.split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) take(part);
  }
  take(rest);
  if (last === undefined) throw new Error("the stream ended without an answer");
  return last;
}

export class HostdClient {
  readonly info: RunInfo;
  readonly baseUrl: string;

  constructor(info: RunInfo) {
    this.info = info;
    this.baseUrl = `http://127.0.0.1:${info.port}`;
  }

  /** The client of the run file in a state folder, or `null` when there is none. */
  static read(stateDir: string): HostdClient | null {
    const info = readRunFile(runFilePath(stateDir));
    return info === null ? null : new HostdClient(info);
  }

  /** The client of a state folder's daemon when it answers, else `null`. */
  static async connect(stateDir: string, timeoutMs = 2000): Promise<HostdClient | null> {
    const client = HostdClient.read(stateDir);
    if (client === null) return null;
    return (await client.ping(timeoutMs)) ? client : null;
  }

  /** Whether the daemon answers with this token. */
  async ping(timeoutMs = 2000): Promise<boolean> {
    try {
      await this.call("service.list", {}, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /** One method call. Throws `HostRpcError` for an error answer, `HostdUnavailableError` without one. */
  async call<T = unknown>(
    method: string,
    params: unknown = {},
    options: CallOptions = {},
  ): Promise<T> {
    const id = nextId++;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.info.token}`,
          "content-type": "application/json",
          ...(options.onLine !== undefined ? { "x-miyoria-stream": "lines" } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: signalOf(options, 30_000),
      });
    } catch (error) {
      throw new HostdUnavailableError(
        `hostd at ${this.baseUrl} does not answer: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    let body: unknown;
    try {
      body =
        options.onLine !== undefined ? await readStream(res, options.onLine) : await res.json();
    } catch (error) {
      throw new HostdUnavailableError(`hostd at ${this.baseUrl} sent no JSON (${res.status})`, {
        cause: error,
      });
    }
    const message = body as {
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    if (message.error !== undefined) {
      throw new HostRpcError(message.error.code, message.error.message, message.error.data);
    }
    return message.result as T;
  }

  /** Log lines of a service: the last `lines`, then with `follow` new ones until `signal` aborts. */
  async *logs(service: string, options: LogsOptions = {}): AsyncGenerator<string> {
    const query = new URLSearchParams({ lines: String(options.lines ?? 100) });
    if (options.follow) query.set("follow", "1");
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/logs/${encodeURIComponent(service)}?${query}`, {
        headers: { authorization: `Bearer ${this.info.token}` },
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) return;
      throw new HostdUnavailableError(`hostd at ${this.baseUrl} does not answer`, { cause: error });
    }
    if (res.status === 404) {
      throw new HostRpcError(HOST_ERROR_CODE.UnknownService, `unknown service ${service}`);
    }
    if (!res.ok || res.body === null) {
      throw new HostRpcError(HOST_ERROR_CODE.NotAllowed, `hostd answered ${res.status}`);
    }
    const decoder = new TextDecoder();
    let rest = "";
    try {
      for await (const chunk of res.body) {
        rest += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) yield line.replace(/\r$/, "");
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      throw error;
    }
    if (rest !== "") yield rest;
  }
}
