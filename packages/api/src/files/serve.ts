// The file origin (v5-architecture §11.2): a listener of its own on a host of its own, serving only
// what a share link or a member's ticket opens, and nothing else: no panel, no API, no cookies.
//
// * `GET|HEAD /f/<token>`: a share link. Anyone with it, for a link anyone may open; for one person
//   or a server's members, the browser is first sent to the member site
//   (`/api/member/files/pass/<token>`), which checks the login and sends it back with a ticket
//   (`?k=`). The ticket is for this share only and lives two minutes; the person it names is
//   checked against the share again here.
// * `GET|HEAD /d/<artifact id>?k=<ticket>`: one of the member's own items, from the member page.
// * `GET /robots.txt`: nothing here is for indexing.
//
// Every answer carries `X-Content-Type-Options: nosniff`, a CSP that runs nothing
// (`default-src 'none'` with `sandbox`), `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`
// and `X-Robots-Tag: noindex`; no answer ever sets a cookie, and no request's cookies are read.
// A file has its stored type (sniffed from its bytes when it came in) and a `Content-Disposition`
// with the cleaned name: `attachment` for a PDF, for `?dl=1` and for a member's own download,
// else `inline`. Song covers are never served. A text passes the secret check again, an image is
// served as its cleaned copy. A link anyone may open may be kept by a CDN for a few minutes; every
// other answer is `no-store`. Each address and each link have a rate limit. A use is counted once
// per request that starts at the first byte (a video's later ranges are not new uses).

import type { ArtifactCleaner, ArtifactStore, Artifact as StoredArtifact } from "@miyoria/store";
import type { ModerationService, PersonId } from "@miyoria/types";
import { Hono } from "hono";
import { byteRange } from "../panel.js";
import { clientKey, RateWindow } from "../public.js";
import type { ApiEnv } from "../state.js";
import { contentRefusal } from "./links.js";
import type { Tickets } from "./tickets.js";

const MINUTE_MS = 60_000;

/** The CSP of every answer: nothing runs, nothing loads but the file itself. */
export const FILE_CSP =
  "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";

/** Headers every answer of the file origin carries. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": FILE_CSP,
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cross-origin-opener-policy": "same-origin",
};

export interface FileOriginOptions {
  store: () => ArtifactStore | undefined;
  cleaner: ArtifactCleaner;
  tickets: Tickets;
  /** The member site's origin, where a scoped link sends its visitor to log in; `null`: none. */
  site: () => string | null;
  /** Whether `person` is a member of `space` (`isSpaceMember`). */
  isMember: (person: PersonId, space: string) => boolean;
  moderation: () => ModerationService | undefined;
  now: () => number;
  perIpPerMinute: number;
  perLinkPerMinute: number;
  /** `max-age` of a file of a link anyone may open; 0: `no-store`. */
  publicCacheSecs: number;
  /** The header the proxy on this machine names the visitor in (`client_ip_header`). */
  clientIpHeader: string;
}

/** A plain-text page (an error, a refusal), with the security headers and no cache. */
function page(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(`${text}\n`, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

const NOT_FOUND = () => page(404, "這個連結打不開:可能已經過期、被收回,或是網址不完整。");

/** `Content-Disposition` for `filename` (already cleaned by the store): an ASCII name and UTF-8. */
export function disposition(kind: "inline" | "attachment", filename: string): string {
  const name = filename.replace(/[\r\n"\\]/g, "_");
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[;%]/g, "_") || "file";
  const utf8 = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** The `Content-Type` an artifact is sent as. */
function contentType(mime: string): string {
  return mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime;
}

interface Serving {
  artifact: StoredArtifact;
  download: boolean;
  cache: string;
}

/** The file origin's app. */
export function fileOriginApp(options: FileOriginOptions): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const perIp = new RateWindow(options.perIpPerMinute, MINUTE_MS);
  const perLink = new RateWindow(options.perLinkPerMinute, MINUTE_MS);

  /** The bytes of `serving`, or a refusal; images cleaned, text checked, song covers never. */
  const send = async (request: Request, serving: Serving, count: () => boolean) => {
    const store = options.store();
    if (store === undefined) return page(503, "現在拿不到檔案,晚點再試。");
    let artifact = serving.artifact;
    if (artifact.source === "sing" || !artifact.downloadable) {
      return page(403, "翻唱的成品不開放下載,只在語音和直播裡聽。");
    }
    const refusal = await contentRefusal(store, artifact, options.moderation());
    if (refusal !== null) return page(403, "這個檔案不能從這裡送出。");
    try {
      artifact = (await options.cleaner.handOut(artifact)).artifact;
    } catch {
      return page(403, "這個檔案不能從這裡送出。");
    }
    const size = artifact.size;
    const head = request.method === "HEAD";
    const range = head ? null : byteRange(request.headers.get("range"), size);
    if (range === "unsatisfiable") {
      return page(416, "要求的範圍不在檔案裡。", { "content-range": `bytes */${size}` });
    }
    // A use is a request from the first byte; the rest of a video's ranges are the same use.
    if (!head && (range === null || range[0] === 0) && !count()) return NOT_FOUND();
    const download = serving.download || artifact.mime === "application/pdf";
    const headers = new Headers({
      ...SECURITY_HEADERS,
      "content-type": contentType(artifact.mime),
      "content-disposition": disposition(download ? "attachment" : "inline", artifact.filename),
      "cache-control": serving.cache,
      "accept-ranges": "bytes",
      etag: `"${artifact.sha256}"`,
    });
    if (head) {
      headers.set("content-length", String(size));
      return new Response(null, { status: 200, headers });
    }
    let stream: ReadableStream;
    try {
      const node = await store.openContent(
        artifact,
        range === null ? undefined : { start: range[0], end: range[1] },
      );
      stream = ReadableStream.from(node) as ReadableStream;
    } catch {
      return page(410, "這個檔案的內容已經不在了。");
    }
    if (range === null) {
      headers.set("content-length", String(size));
      return new Response(stream, { status: 200, headers });
    }
    headers.set("content-length", String(range[1] - range[0] + 1));
    headers.set("content-range", `bytes ${range[0]}-${range[1]}/${size}`);
    return new Response(stream, { status: 206, headers });
  };

  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return page(405, "這裡只能下載檔案。", { allow: "GET, HEAD" });
    }
    const wait = perIp.hit(clientKey(c, options.clientIpHeader), options.now());
    if (wait !== null) {
      return page(429, "太多次了,等一下再試。", { "retry-after": String(Math.ceil(wait / 1000)) });
    }
    await next();
    // Nothing on this origin ever sets a cookie.
    c.res.headers.delete("set-cookie");
    return undefined;
  });

  app.get(
    "/robots.txt",
    () =>
      new Response("User-agent: *\nDisallow: /\n", {
        headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
      }),
  );

  app.get("/f/:token", async (c) => {
    const store = options.store();
    if (store === undefined) return page(503, "現在拿不到檔案,晚點再試。");
    const token = c.req.param("token");
    const found = store.shares.lookup(token);
    if (!found.ok) return NOT_FOUND();
    const { share, artifact } = found;
    // A song cover is refused before anyone is asked to log in for it.
    if (artifact.source === "sing" || !artifact.downloadable) {
      return page(403, "翻唱的成品不開放下載,只在語音和直播裡聽。");
    }
    if (perLink.hit(share.id, options.now()) !== null) {
      return page(429, "這個連結現在太多人在開,等一下再試。", { "retry-after": "60" });
    }
    if (share.audience !== "link") {
      const person = options.tickets.verify(c.req.query("k"), "s", share.id);
      if (person === null) {
        const site = options.site();
        if (site === null)
          return page(403, "這個連結只給特定的人,要登入才能打開,但這裡沒有開登入。");
        return new Response(null, {
          status: 302,
          headers: {
            ...SECURITY_HEADERS,
            location: `${site}/api/member/files/pass/${encodeURIComponent(token)}`,
            "cache-control": "no-store",
          },
        });
      }
      const allowed =
        share.audience === "person"
          ? share.person_id === person
          : share.space_id !== null && options.isMember(person, share.space_id);
      if (!allowed) return page(403, "這個檔案不是給你的。");
    }
    const cache =
      share.audience === "link" && options.publicCacheSecs > 0
        ? `public, max-age=${options.publicCacheSecs}`
        : "private, no-store";
    return send(
      c.req.raw,
      { artifact, download: share.mode === "download" && c.req.query("dl") === "1", cache },
      () => store.shares.use(token).ok,
    );
  });

  app.get("/d/:id", async (c) => {
    const store = options.store();
    if (store === undefined) return page(503, "現在拿不到檔案,晚點再試。");
    const id = c.req.param("id");
    const person = options.tickets.verify(c.req.query("k"), "d", id);
    if (person === null) return NOT_FOUND();
    const artifact = store.get(id);
    if (artifact === null || artifact.made_for !== person || !store.isLive(artifact)) {
      return NOT_FOUND();
    }
    return send(c.req.raw, { artifact, download: true, cache: "private, no-store" }, () => true);
  });

  app.notFound(() => NOT_FOUND());
  app.onError(() => page(500, "出了點問題,晚點再試。"));
  return app;
}
