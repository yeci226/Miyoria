import { readFileSync } from "node:fs";
import type { RawResponse, Transport, TransportRequest } from "../src/net.js";

export const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** A response whose body arrives in the given chunks. */
export function response(
  status: number,
  body: string | Uint8Array | Uint8Array[],
  headers: Record<string, string> = {},
): RawResponse & { destroyed: boolean } {
  const chunks =
    typeof body === "string"
      ? [new TextEncoder().encode(body)]
      : Array.isArray(body)
        ? body
        : [body];
  const res = {
    status,
    headers,
    destroyed: false,
    destroy() {
      res.destroyed = true;
    },
    body: (async function* () {
      for (const c of chunks) yield c;
    })(),
  };
  return res;
}

export const html = (body: string, extra: Record<string, string> = {}) =>
  response(200, body, { "content-type": "text/html; charset=utf-8", ...extra });

/** A transport serving `pages` by URL; records what it was asked. */
export function fakeTransport(
  pages: Record<string, () => RawResponse | Promise<RawResponse>>,
): Transport & { calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const t = (async (request: TransportRequest) => {
    calls.push(request);
    const make = pages[request.url.href];
    if (make === undefined) throw new Error(`no page for ${request.url.href}`);
    return await make();
  }) as Transport & { calls: TransportRequest[] };
  t.calls = calls;
  return t;
}

/** A resolver answering from a table (default: a public address). */
export const resolver =
  (table: Record<string, string[]> = {}) =>
  async (host: string) => {
    const list = table[host] ?? ["93.184.216.34"];
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
