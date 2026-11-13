// Serves the built admin panel (`apps/panel/dist`) at `/`. Static files never need the bearer
// token; the panel asks for it and sends it to `/api`.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlib } from "node:zlib";
import { errorMessage, getLogger } from "@miyoria/kernel";

const log = getLogger("api.panel");

/** Environment variable that overrides `[modules.api] panel_dir`. */
export const PANEL_DIR_ENV = "MIYORIA_PANEL_DIR";

/** Hashed Vite bundles: safe to cache forever. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** `index.html` and unhashed files: always revalidate. */
const REVALIDATE = "no-cache";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Text files worth compressing; pictures, video, audio and fonts are compressed already. */
const COMPRESSIBLE = new Set([
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".map",
  ".webmanifest",
  ".txt",
  ".xml",
  ".svg",
]);
/** Below this a compressed body saves next to nothing. */
const MIN_COMPRESS_BYTES = 1024;
/** Bytes of compressed files kept in memory (the panel's text is a few MB per encoding). */
const COMPRESSED_CACHE_BYTES = 32 * 1024 * 1024;

export type Encoding = "br" | "gzip";

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/**
 * The encoding to send for an `Accept-Encoding` header (RFC 9110 §12.5.3): the acceptable coding
 * with the highest `q`, brotli before gzip before none on a tie, `null` for none. `*` stands for
 * any coding not listed; sending as is (`identity`) is acceptable unless refused with `q=0`, and
 * when it is not named it counts as the lowest `q` listed.
 */
export function pickEncoding(header: string | null): Encoding | null {
  if (header === null) return null;
  const q = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name = "", ...params] = part.split(";").map((x) => x.trim().toLowerCase());
    if (name === "") continue;
    const qp = params.find((x) => x.startsWith("q="));
    const value = qp === undefined ? 1 : Number(qp.slice(2));
    q.set(name, Number.isFinite(value) ? value : 0);
  }
  const weight = (coding: string, otherwise: number) => q.get(coding) ?? q.get("*") ?? otherwise;
  let best: Encoding | null = null;
  // Not named, sending as is ranks with the least wanted coding listed (as `negotiator` does).
  let bestQ = weight("identity", q.size === 0 ? 1 : Math.min(...q.values()));
  for (const coding of ["gzip", "br"] as const) {
    const w = weight(coding, 0);
    if (w > 0 && w >= bestQ) {
      best = coding;
      bestQ = w;
    }
  }
  return best;
}

/** Compresses on the zlib thread pool, never on the event loop. */
async function compress(bytes: Buffer, encoding: Encoding): Promise<Buffer> {
  return encoding === "br"
    ? brotli(bytes, {
        params: {
          // 6: about 10% smaller than gzip in tens of ms; 11 takes over a second for the entry.
          [zlib.BROTLI_PARAM_QUALITY]: 6,
          [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
          [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.length,
        },
      })
    : gzipped(bytes, { level: 6 });
}

/** Compressed files by path, date, size and encoding; the oldest go first past the budget. */
const compressedFiles = new Map<string, Promise<Buffer>>();
const compressedSizes = new Map<string, number>();
let compressedBytes = 0;

function compressedFile(
  path: string,
  mtimeMs: number,
  size: number,
  encoding: Encoding,
): Promise<Buffer> {
  const key = `${encoding}\u0000${mtimeMs}\u0000${size}\u0000${path}`;
  const cached = compressedFiles.get(key);
  if (cached !== undefined) {
    // Most recently used last.
    compressedFiles.delete(key);
    compressedFiles.set(key, cached);
    return cached;
  }
  const pending = readFile(path).then((bytes) => compress(bytes, encoding));
  compressedFiles.set(key, pending);
  pending.then(
    (bytes) => {
      if (compressedFiles.get(key) !== pending) return;
      compressedSizes.set(key, bytes.length);
      compressedBytes += bytes.length;
      for (const old of compressedFiles.keys()) {
        if (compressedBytes <= COMPRESSED_CACHE_BYTES || old === key) break;
        compressedBytes -= compressedSizes.get(old) ?? 0;
        compressedSizes.delete(old);
        compressedFiles.delete(old);
      }
    },
    () => compressedFiles.delete(key),
  );
  return pending;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The directory to serve: `env` when set (non-empty), else `configured`. `null` when that is
 * empty or has no `index.html`.
 */
export function pickDir(env: string | undefined, configured: string): string | null {
  const fromEnv = env?.trim() ?? "";
  const raw = fromEnv !== "" ? fromEnv : configured.trim();
  if (raw === "") return null;
  return isFile(join(raw, "index.html")) ? raw : null;
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

/** Decoded path segments of a request path, or `null` when it tries to escape the root. */
function segments(path: string): string[] | null {
  const out: string[] = [];
  for (const raw of path.split("/")) {
    if (raw === "") continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // Separators, drive letters / NTFS streams and NUL never appear in panel file names.
    if (seg === "." || seg === ".." || /[/\\:]/.test(seg) || seg.includes("\u0000")) return null;
    out.push(seg);
  }
  return out;
}

/**
 * The byte range a `Range` header asks for in a file of `size` bytes (RFC 9110 §14): `null` when
 * the header is to be ignored and the whole file sent (absent, another unit, several ranges, or
 * an invalid range such as `bytes=50-10`), `"unsatisfiable"` for a valid range outside the file
 * (416), else the inclusive `[start, end]`.
 */
export function byteRange(
  header: string | null,
  size: number,
): readonly [number, number] | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^\s*([A-Za-z]+)\s*=(.*)$/.exec(header);
  if (!match || (match[1] ?? "").toLowerCase() !== "bytes") return null;
  const spec = (match[2] ?? "").trim();
  if (spec.includes(",")) return null;
  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!parts) return null;
  const [, first = "", last = ""] = parts;
  if (first === "" && last === "") return null;
  if (first === "") {
    // `-N`: the last N bytes. Of an empty file there is no part to name: it is sent whole.
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable";
    if (size === 0) return null;
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return null;
  if (start >= size) return "unsatisfiable";
  return [start, last === "" ? size - 1 : Math.min(Number(last), size - 1)];
}

async function readSlice(path: string, start: number, end: number): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(end - start + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled === buffer.length ? buffer : buffer.subarray(0, filled);
  } finally {
    await file.close();
  }
}

/** Rewrites a page of HTML for the request that asked for it (the tags of a link preview). */
export type HtmlRewrite = (html: string, request: Request) => Promise<string>;

/**
 * Serves one panel file with caching headers (GET / HEAD only, like `ServeDir`). A GET with a
 * single byte range gets 206 with that part (what Safari needs to play a video).
 */
export async function servePanel(
  dir: string,
  request: Request,
  rewrite?: HtmlRewrite,
): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET,HEAD" } });
  }
  const url = new URL(request.url);
  const parts = segments(url.pathname);
  if (parts === null) return notFound();
  const root = resolve(dir);
  let path = resolve(root, ...parts);
  if (path !== root && !path.startsWith(root + sep)) return notFound();

  try {
    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        // Like `ServeDir`: directories are served at their path with a trailing slash.
        const location = `${url.pathname}/${url.search}`;
        return new Response(null, { status: 307, headers: { location } });
      }
      path = join(path, "index.html");
      info = await stat(path).catch(() => null);
    }
    if (!info?.isFile()) {
      // The panel's own pages (`/card/MYR-…`, `/people/…`, `/me`) are routes in the page, not files:
      // a path whose last part has no extension gets `index.html`. A missing asset stays a 404.
      const last = parts[parts.length - 1] ?? "";
      if (last.includes(".")) return notFound();
      path = join(root, "index.html");
      info = await stat(path).catch(() => null);
      if (!info?.isFile()) return notFound();
    }

    if (rewrite && extname(path).toLowerCase() === ".html") {
      // The tags differ per page and change with a card, so it revalidates on the page as sent
      // (an ETag), never on the file's date.
      const html = await rewrite((await readFile(path)).toString("utf8"), request);
      const bytes = Buffer.from(html, "utf8");
      const tag = `"${createHash("sha1").update(bytes).digest("base64url")}"`;
      const encoding =
        bytes.length >= MIN_COMPRESS_BYTES
          ? pickEncoding(request.headers.get("accept-encoding"))
          : null;
      const headers = new Headers({
        "content-type": MIME[".html"] ?? "text/html",
        "cache-control": REVALIDATE,
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "content-length": String(bytes.length),
        vary: "accept-encoding",
        // Compressed, the same page is a weak match: the tag names the page, not the bytes.
        etag: encoding === null ? tag : `W/${tag}`,
      });
      const match = request.headers.get("if-none-match");
      if (match === tag || match === `W/${tag}`) {
        headers.delete("content-type");
        headers.delete("content-length");
        return new Response(null, { status: 304, headers });
      }
      // HEAD gets the headers GET would (the same encoding, length and tag), without the body.
      let body: Buffer = bytes;
      if (encoding !== null) {
        body = await compress(bytes, encoding);
        headers.set("content-encoding", encoding);
        headers.set("content-length", String(body.length));
      }
      return new Response(method === "HEAD" ? null : body, { status: 200, headers });
    }

    const assets = url.pathname.startsWith("/assets/");
    const ext = extname(path).toLowerCase();
    const compressible = COMPRESSIBLE.has(ext) && info.size >= MIN_COMPRESS_BYTES;
    const headers = new Headers({
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": assets ? IMMUTABLE : REVALIDATE,
      "x-content-type-options": "nosniff",
      // The page is open to the internet and has buttons that delete: nobody may frame it.
      "x-frame-options": "DENY",
      "last-modified": new Date(Math.floor(info.mtimeMs / 1000) * 1000).toUTCString(),
      "accept-ranges": "bytes",
    });
    if (compressible) headers.set("vary", "accept-encoding");
    const since = request.headers.get("if-modified-since");
    if (since !== null) {
      const sinceMs = Date.parse(since);
      if (!Number.isNaN(sinceMs) && Math.floor(info.mtimeMs / 1000) * 1000 <= sinceMs) {
        headers.delete("content-type");
        return new Response(null, { status: 304, headers });
      }
    }
    headers.set("content-length", String(info.size));
    const encoding = compressible ? pickEncoding(request.headers.get("accept-encoding")) : null;
    if (method === "HEAD") {
      // The headers of the whole file as GET would send it: compressed, the compressed length
      // (from the same cache). A HEAD never answers a range.
      if (encoding !== null) {
        const body = await compressedFile(path, info.mtimeMs, info.size, encoding);
        headers.set("content-encoding", encoding);
        headers.set("content-length", String(body.length));
      }
      return new Response(null, { status: 200, headers });
    }
    // `If-Range` asks for the part only while the file is the one it names: anything but its
    // date as sent here gets the whole file.
    const ifRange = request.headers.get("if-range");
    const range =
      ifRange === null || ifRange.trim() === headers.get("last-modified")
        ? byteRange(request.headers.get("range"), info.size)
        : null;
    if (range === "unsatisfiable") {
      headers.delete("content-type");
      headers.set("content-length", "0");
      headers.set("content-range", `bytes */${info.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range !== null) {
      const [start, end] = range;
      const part = await readSlice(path, start, end);
      headers.set("content-length", String(part.length));
      headers.set("content-range", `bytes ${start}-${start + part.length - 1}/${info.size}`);
      return new Response(part, { status: 206, headers });
    }
    // The whole file, compressed when the client takes it. A range is always of the file as it
    // is on disk (above), so ranges and compression never meet.
    if (encoding !== null) {
      const body = await compressedFile(path, info.mtimeMs, info.size, encoding);
      headers.set("content-encoding", encoding);
      headers.set("content-length", String(body.length));
      return new Response(body, { status: 200, headers });
    }
    const body = await readFile(path);
    return new Response(body, { status: 200, headers });
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot serve panel file");
    return new Response(null, { status: 500 });
  }
}
