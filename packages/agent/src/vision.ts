// Images she looks at with the chat model.
//
// Which images (like Avocados): those of the messages she answers, of the message they reply
// to, and those the same person sent shortly before (`same_author_window_ms`); png / jpeg /
// webp / gif only, each at most `max_image_bytes`, at most `max_images` per turn and
// `max_total_bytes` together. They are downloaded (platform CDN URLs are signed and expire,
// and only `allowed_hosts` over HTTPS are fetched) and sent as base64 data URLs; downloads are
// cached by attachment id. Nothing is downloaded when the chat model takes no images
// (`[llm.image_input]`). The history keeps `[圖片: name(alt)]` for later turns and memory.

import { errorMessage } from "@miyoria/kernel";
import type { ContentPart } from "@miyoria/llm";
import { type Attachment, type IncomingMessage, imageType, safeName } from "@miyoria/types";
import type { VisionConfig } from "./config.js";
import type { HistoryEntry, Session } from "./session.js";
import { timeout } from "./util.js";

/** An image chosen for a turn, before download. */
export interface ImageCandidate {
  attachment: Attachment;
  /** Display name of who sent it. */
  author: string;
  /**
   * Where it was: on a message she answers, on the message one of them replies to, or sent by
   * the same person a little `earlier` (`ago_s` seconds before). Her prompt says which, so an
   * older screenshot is not read as part of the question.
   */
  source: "message" | "parent" | "earlier";
  /** `earlier` only: seconds between it and the message she answers. */
  ago_s?: number;
  /** Cache key: the attachment id, else the URL without its query. */
  key: string;
  type: string;
}

/** A downloaded image. */
export interface LoadedImage {
  candidate: ImageCandidate;
  dataUrl: string;
  bytes: number;
}

/** `fetch` as the downloader uses it (tests pass a fake; no real network). */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; redirect: "error" },
) => Promise<Response>;

function cacheKey(a: Attachment): string {
  if (a.id) return `id:${a.id}`;
  const q = a.url.indexOf("?");
  return `url:${q === -1 ? a.url : a.url.slice(0, q)}`;
}

/** Whether `url` is HTTPS on one of `hosts`. */
export function allowedUrl(url: string, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && hosts.includes(parsed.hostname.toLowerCase());
}

/**
 * The images of a turn, in order of relevance: the messages she answers (newest first), the
 * messages they reply to (`parents`: entries in the history or fetched), then the same
 * people's images in the history up to `same_author_window_ms` before (not for a reply: it
 * points at what it is about, and an older image of theirs was taken for its answer on
 * 2026-11-08 14:22). Unsupported types,
 * images known to be too large and URLs outside `allowed_hosts` are skipped; at most
 * `max_images`.
 */
export function selectImages(
  inputs: readonly IncomingMessage[],
  session: Session,
  parents: readonly HistoryEntry[],
  cfg: VisionConfig,
): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const keys = new Set<string>();
  const consider = (
    a: Attachment,
    author: string,
    source: ImageCandidate["source"],
    agoMs = 0,
  ): void => {
    if (out.length >= cfg.max_images) return;
    const type = imageType(a);
    if (type === null) return;
    if (a.size != null && a.size > cfg.max_image_bytes) return;
    if (!allowedUrl(a.url, cfg.allowed_hosts)) return;
    const key = cacheKey(a);
    if (keys.has(key)) return;
    keys.add(key);
    out.push({
      attachment: a,
      author,
      key,
      type,
      source,
      ...(source === "earlier" ? { ago_s: Math.max(0, Math.round(agoMs / 1000)) } : {}),
    });
  };
  const newest = [...inputs].reverse();
  for (const m of newest) {
    for (const a of [...m.attachments, ...(m.forwarded ?? []).flatMap((f) => f.attachments)]) {
      consider(a, m.author.display_name, "message");
    }
  }
  for (const p of parents) for (const a of p.attachments) consider(a, p.author, "parent");
  const ids = new Set(inputs.map((m) => m.id.id));
  for (const m of newest) {
    if (m.reply_to != null) continue;
    const until = Date.parse(m.ts);
    const since = until - cfg.same_author_window_ms;
    for (const e of [...session.history()].reverse()) {
      if (e.isSelf || (e.id !== null && ids.has(e.id))) continue;
      if (e.ts > until || e.ts < since) continue;
      if (e.account.platform !== m.author.account.platform) continue;
      if (e.account.id !== m.author.account.id) continue;
      for (const a of e.attachments) consider(a, e.author, "earlier", until - e.ts);
    }
  }
  return out;
}

/** Downloads images (with a small in-memory cache keyed by attachment id). */
export class ImageLoader {
  readonly #cache = new Map<string, { dataUrl: string; bytes: number }>();

  constructor(
    readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    readonly onError: (key: string, error: string) => void = () => undefined,
  ) {}

  /**
   * Downloads `candidates` in order, skipping failures, until `max_total_bytes` would be
   * exceeded. Each download has `download_timeout_ms`.
   */
  async load(
    candidates: readonly ImageCandidate[],
    cfg: VisionConfig,
    signal: AbortSignal,
  ): Promise<LoadedImage[]> {
    const out: LoadedImage[] = [];
    let total = 0;
    for (const candidate of candidates) {
      signal.throwIfAborted();
      let image: { dataUrl: string; bytes: number } | null;
      try {
        image = await this.#get(candidate, cfg, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        this.onError(candidate.key, errorMessage(error));
        continue;
      }
      if (image === null || total + image.bytes > cfg.max_total_bytes) continue;
      total += image.bytes;
      out.push({ candidate, ...image });
    }
    return out;
  }

  async #get(
    candidate: ImageCandidate,
    cfg: VisionConfig,
    signal: AbortSignal,
  ): Promise<{ dataUrl: string; bytes: number } | null> {
    const cached = this.#cache.get(candidate.key);
    if (cached) {
      // Most recently used last.
      this.#cache.delete(candidate.key);
      this.#cache.set(candidate.key, cached);
      return cached;
    }
    const image = await timeout(cfg.download_timeout_ms, signal, (s) =>
      download(this.fetchImpl, candidate, cfg.max_image_bytes, s),
    );
    if (image === null || cfg.cache_entries <= 0) return image;
    this.#cache.set(candidate.key, image);
    while (this.#cache.size > cfg.cache_entries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return image;
  }

  /** Cached downloads (tests). */
  get cached(): number {
    return this.#cache.size;
  }
}

async function download(
  fetchImpl: FetchLike,
  candidate: ImageCandidate,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ dataUrl: string; bytes: number } | null> {
  const response = await fetchImpl(candidate.attachment.url, { signal, redirect: "error" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  // A page instead of an image (an error page, a login wall) is not looked at.
  if (declared && !declared.startsWith("image/") && declared !== "application/octet-stream") {
    return null;
  }
  const type = declared?.startsWith("image/") ? declared : candidate.type;
  if (imageType({ url: "", filename: "", content_type: type }) === null) return null;
  const length = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(length) && length > maxBytes) return null;
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0 || body.length > maxBytes) return null;
  return { dataUrl: `data:${type};base64,${body.toString("base64")}`, bytes: body.length };
}

/** The line before an image: who sent it and where it was. */
function imageLabel(c: ImageCandidate, who: string, name: string): string {
  if (c.source === "parent") return `(被回覆的那則訊息裡 ${who} 傳的圖片 ${name})`;
  if (c.source === "earlier") {
    const ago = c.ago_s ?? 0;
    const when = ago < 60 ? `${ago} 秒前` : `${Math.floor(ago / 60)} 分鐘前`;
    return `(${who} ${when}另外傳的圖片 ${name},不是這則訊息附的)`;
  }
  return `(${who} 這則訊息附的圖片 ${name})`;
}

/** The content parts for loaded images: a label (who sent which file, and where), then the image. */
export function imageParts(
  images: readonly LoadedImage[],
  detail: VisionConfig["detail"],
): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const { candidate, dataUrl } of images) {
    const name = safeName(candidate.attachment.filename, 60);
    const who = safeName(candidate.author);
    parts.push({ type: "text", text: imageLabel(candidate, who, name) });
    parts.push({
      type: "image_url",
      image_url: { url: dataUrl, detail },
      alt: `[圖片: ${name}]`,
    });
  }
  return parts;
}
