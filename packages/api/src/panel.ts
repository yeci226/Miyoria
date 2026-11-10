// Serves the built admin panel (`apps/panel/dist`) at `/`. Static files never need the bearer
// token; the panel asks for it and sends it to `/api`.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
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

/** Serves one panel file with caching headers (GET / HEAD only, like `ServeDir`). */
/** Rewrites a page of HTML for the request that asked for it (the tags of a link preview). */
export type HtmlRewrite = (html: string, request: Request) => Promise<string>;

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
      const headers = new Headers({
        "content-type": MIME[".html"] ?? "text/html",
        "cache-control": REVALIDATE,
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "content-length": String(bytes.length),
        etag: `"${createHash("sha1").update(bytes).digest("base64url")}"`,
      });
      if (request.headers.get("if-none-match") === headers.get("etag")) {
        headers.delete("content-type");
        headers.delete("content-length");
        return new Response(null, { status: 304, headers });
      }
      return new Response(method === "HEAD" ? null : bytes, { status: 200, headers });
    }

    const assets = url.pathname.startsWith("/assets/");
    const headers = new Headers({
      "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
      "cache-control": assets ? IMMUTABLE : REVALIDATE,
      "x-content-type-options": "nosniff",
      // The page is open to the internet and has buttons that delete: nobody may frame it.
      "x-frame-options": "DENY",
      "last-modified": new Date(Math.floor(info.mtimeMs / 1000) * 1000).toUTCString(),
      "accept-ranges": "bytes",
    });
    const since = request.headers.get("if-modified-since");
    if (since !== null) {
      const sinceMs = Date.parse(since);
      if (!Number.isNaN(sinceMs) && Math.floor(info.mtimeMs / 1000) * 1000 <= sinceMs) {
        headers.delete("content-type");
        return new Response(null, { status: 304, headers });
      }
    }
    headers.set("content-length", String(info.size));
    if (method === "HEAD") return new Response(null, { status: 200, headers });
    const body = await readFile(path);
    return new Response(body, { status: 200, headers });
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot serve panel file");
    return new Response(null, { status: 500 });
  }
}
