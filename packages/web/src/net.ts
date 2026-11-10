// The SSRF guard and the page download. A page URL is only fetched when, for every hop:
//   * the scheme is http or https, without credentials, on port 80 / 443 (or an allowed one);
//   * the host is a real name (no bare hostname, no `localhost`, no `.local` / `.internal`) or a
//     public IP literal;
//   * every address DNS gives for it is public (`isBlockedAddress`);
//   * the connection goes to exactly the address that was checked (`pinnedTransport` hands the
//     socket's `lookup` that address), so a second DNS answer cannot swap in a private one.
// Redirects are followed by hand and each hop goes through all of the above.

import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { WebConfig } from "./config.js";

/** A refusal or failure with a message for her (Traditional Chinese). */
export class WebError extends Error {
  override readonly name = "WebError";
  constructor(
    message: string,
    /** Why, for the log (never shown to people). */
    readonly reason: string = message,
  ) {
    super(message);
  }
}

// ---- addresses ----------------------------------------------------------------------------

/** `a.b.c.d` as four octets, or `null` (strict dotted decimal only). */
export function parseIPv4(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/** An IPv6 address as eight 16-bit groups, or `null`. Handles `::` and a dotted IPv4 tail. */
export function parseIPv6(text: string): number[] | null {
  if (text.includes("%") || isIP(text) !== 6) return null;
  let head = text;
  let tail: number[] = [];
  const dot = text.lastIndexOf(".");
  if (dot !== -1) {
    const colon = text.lastIndexOf(":");
    const v4 = parseIPv4(text.slice(colon + 1));
    if (v4 === null) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    head = text.slice(0, colon + 1);
    // `::1.2.3.4` keeps its `::`; `a:b::1.2.3.4` too. A single trailing `:` is the separator.
    if (!head.endsWith("::")) head = head.slice(0, -1);
  }
  const group = (s: string) => (s === "" ? [] : s.split(":").map((g) => Number.parseInt(g, 16)));
  const gap = head.indexOf("::");
  let groups: number[];
  if (gap === -1) {
    groups = [...group(head), ...tail];
  } else {
    const left = group(head.slice(0, gap));
    const right = [...group(head.slice(gap + 2)), ...tail];
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

/** Is the IPv4 address one that must never be fetched (private, loopback, shared, reserved)? */
function blockedV4([a, b, c]: readonly number[]): boolean {
  const [o1, o2, o3] = [a as number, b as number, c as number];
  return (
    o1 === 0 || // "this" network, unspecified
    o1 === 10 ||
    (o1 === 100 && o2 >= 64 && o2 <= 127) || // CGNAT
    o1 === 127 || // loopback
    (o1 === 169 && o2 === 254) || // link-local, cloud metadata
    (o1 === 172 && o2 >= 16 && o2 <= 31) ||
    (o1 === 192 && o2 === 0 && o3 === 0) || // IETF protocol assignments
    (o1 === 192 && o2 === 0 && o3 === 2) || // documentation
    (o1 === 192 && o2 === 88 && o3 === 99) || // 6to4 relay (deprecated)
    (o1 === 192 && o2 === 168) ||
    (o1 === 198 && (o2 === 18 || o2 === 19)) || // benchmarking
    (o1 === 198 && o2 === 51 && o3 === 100) ||
    (o1 === 203 && o2 === 0 && o3 === 113) ||
    o1 >= 224 // multicast, reserved, broadcast
  );
}

/**
 * Must `address` (an IPv4 or IPv6 literal) never be fetched? Covers loopback, private,
 * link-local, CGNAT, multicast, unspecified, reserved and documentation ranges, IPv6 ULA /
 * link-local / site-local, and IPv6 forms that carry an IPv4 address (mapped, compatible,
 * NAT64, 6to4, Teredo). Anything that does not parse is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4 !== null) return blockedV4(v4);
  const g = parseIPv6(address);
  if (g === null) return true;
  const w = g as [number, number, number, number, number, number, number, number];
  const embedded = (hi: number, lo: number) => blockedV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  const zeros5 = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0;
  if (zeros5 && w[5] === 0 && w[6] === 0 && w[7] <= 1) return true; // :: and ::1
  if (zeros5 && w[5] === 0xffff) return embedded(w[6], w[7]); // ::ffff:a.b.c.d (mapped)
  if (zeros5 && w[5] === 0) return true; // ::a.b.c.d (compatible, deprecated)
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
    return embedded(w[6], w[7]); // 64:ff9b::/96 NAT64
  }
  if (w[0] === 0x2002) return embedded(w[1], w[2]); // 6to4
  if (w[0] === 0x2001 && w[1] === 0) return true; // Teredo
  if (w[0] === 0x2001 && w[1] === 0xdb8) return true; // documentation
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true; // discard
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

// ---- URLs ---------------------------------------------------------------------------------

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home"];

/** `[::1]` to `::1`. */
const unbracket = (host: string) => (host.startsWith("[") ? host.slice(1, -1) : host);

/**
 * The checks that need no network: scheme, credentials, port and the shape of the host. Returns
 * the parsed URL. (`new URL` already turns `http://2130706433/` or `http://0x7f.1/` into
 * `127.0.0.1`, which `isBlockedAddress` then refuses.)
 */
export function checkUrl(raw: string, allowPorts: readonly number[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebError("這不是有效的網址", "unparsable url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebError("只能讀 http 或 https 的網頁", `scheme ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebError("不能讀帶帳號密碼的網址", "credentials in url");
  }
  if (url.port !== "") {
    const port = Number(url.port);
    if (port !== 80 && port !== 443 && !allowPorts.includes(port)) {
      throw new WebError("這個網址的連接埠不能讀", `port ${port}`);
    }
  }
  const host = unbracket(url.hostname).toLowerCase().replace(/\.$/, "");
  if (host === "") throw new WebError("這不是有效的網址", "empty host");
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) throw new WebError("這個網址是內部位址,不能讀", `address ${host}`);
    return url;
  }
  if (!host.includes(".")) throw new WebError("這個網址是內部名稱,不能讀", `bare host ${host}`);
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new WebError("這個網址是內部名稱,不能讀", `internal host ${host}`);
  }
  return url;
}

/** What `lookup` returns for a name: every address it has. */
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = async (host) =>
  await dnsLookup(host, { all: true, verbatim: true });

/** The address to connect to for `url`: every DNS answer must be public, the first is used. */
export async function resolvePublic(
  url: URL,
  resolve: Resolver,
): Promise<{ address: string; family: 4 | 6 }> {
  const host = unbracket(url.hostname).replace(/\.$/, "");
  const version = isIP(host);
  if (version !== 0) return { address: host, family: version as 4 | 6 };
  let answers: { address: string; family: number }[];
  try {
    answers = await resolve(host);
  } catch {
    throw new WebError("找不到這個網站", `dns failed for ${host}`);
  }
  const first = answers[0];
  if (first === undefined) throw new WebError("找不到這個網站", `no addresses for ${host}`);
  // One private answer among public ones is enough to refuse: the client could be given any.
  for (const a of answers) {
    if (isBlockedAddress(a.address)) {
      throw new WebError("這個網址指到內部位址,不能讀", `${host} resolves to ${a.address}`);
    }
  }
  return { address: first.address, family: isIP(first.address) === 6 ? 6 : 4 };
}

// ---- transport ----------------------------------------------------------------------------

export interface RawResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Drops the connection (called when the body is not read to the end). */
  destroy(): void;
}

export interface TransportRequest {
  url: URL;
  /** Already checked: connect here and nowhere else. */
  address: { address: string; family: 4 | 6 };
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** One GET to one address. Tests inject a fake. */
export type Transport = (request: TransportRequest) => Promise<RawResponse>;

/** `node:http(s)` with the socket's DNS lookup replaced by the checked address. */
export const pinnedTransport: Transport = ({ url, address, headers, signal }) =>
  new Promise<RawResponse>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      {
        host: unbracket(url.hostname),
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        agent: false,
        signal,
        // Called for the connection itself (also with `all: true` by happy-eyeballs).
        lookup: (_host, options, callback) => {
          const entry = { address: address.address, family: address.family };
          if ((options as { all?: boolean }).all) {
            (callback as (e: null, a: unknown[]) => void)(null, [entry]);
          } else {
            callback(null, entry.address, entry.family);
          }
        },
      },
      (res) => {
        const flat: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          flat[k] = Array.isArray(v) ? v.join(", ") : v;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: flat,
          body: res,
          destroy: () => res.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

// ---- the guarded download -----------------------------------------------------------------

export interface Download {
  /** The URL after redirects. */
  url: URL;
  contentType: string;
  bytes: Uint8Array;
  /** The size limit cut the body. */
  truncated: boolean;
}

export interface GuardDeps {
  resolve?: Resolver;
  transport?: Transport;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const READABLE_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

/** Reads at most `limit` bytes of `body`. */
async function readLimited(
  body: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    const room = limit - size;
    if (chunk.length >= room) {
      chunks.push(chunk.subarray(0, room));
      size += room;
      return { bytes: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}

/**
 * Downloads `raw` under the guard: every hop is checked (`checkUrl`, DNS, pinned connection),
 * at most `max_redirects` hops, only readable content types, `max_download_bytes`, and one
 * timeout over the whole thing (also stopped by `signal`).
 */
export async function guardedGet(
  raw: string,
  config: WebConfig,
  signal: AbortSignal,
  deps: GuardDeps = {},
): Promise<Download> {
  const resolve = deps.resolve ?? systemResolver;
  const transport = deps.transport ?? pinnedTransport;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.timeout_ms)]);
  let target = raw;
  for (let hop = 0; ; hop++) {
    const url = checkUrl(target, config.allow_ports);
    const address = await resolvePublic(url, resolve);
    if (deadline.aborted) throw new WebError("網站回應太久了", "aborted before connect");
    let res: RawResponse;
    try {
      res = await transport({
        url,
        address,
        signal: deadline,
        headers: {
          "user-agent": config.user_agent,
          accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
          "accept-encoding": "identity",
        },
      });
    } catch (error) {
      if (deadline.aborted) throw new WebError("網站回應太久了", "timeout");
      throw new WebError("連不上這個網站", `connect failed: ${(error as Error).message}`);
    }
    try {
      if (REDIRECTS.has(res.status)) {
        const location = res.headers.location;
        res.destroy();
        if (!location) throw new WebError("網站的轉址有問題", "redirect without location");
        if (hop >= config.max_redirects) throw new WebError("轉址太多次了", "too many redirects");
        try {
          target = new URL(location, url).href;
        } catch {
          throw new WebError("網站的轉址有問題", "bad redirect location");
        }
        continue;
      }
      if (res.status !== 200) {
        res.destroy();
        throw new WebError(`網站回了 ${res.status},讀不到`, `status ${res.status}`);
      }
      const contentType = (res.headers["content-type"] ?? "").toLowerCase();
      const mime = contentType.split(";")[0]?.trim() ?? "";
      // A page that does not say what it is is read as HTML only when it looks like text.
      if (mime !== "" && !READABLE_TYPES.includes(mime)) {
        res.destroy();
        throw new WebError("這不是網頁文字(只讀 HTML 或純文字)", `content-type ${mime}`);
      }
      let read: { bytes: Uint8Array; truncated: boolean };
      try {
        read = await readLimited(res.body, config.max_download_bytes);
      } catch (error) {
        if (deadline.aborted) throw new WebError("網站回應太久了", "timeout");
        throw new WebError("下載到一半斷了", `body failed: ${(error as Error).message}`);
      }
      if (read.truncated) res.destroy();
      return { url, contentType, bytes: read.bytes, truncated: read.truncated };
    } catch (error) {
      res.destroy();
      throw error;
    }
  }
}
