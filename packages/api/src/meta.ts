// Page metadata for the panel's HTML: the title, description and preview tags a link unfurls with.
// Unfurl bots (Discord, Slack, X, search engines) do not run JavaScript, so the tags are put into
// the HTML the Core serves; `index.html` carries the same defaults for any other host.
//
// Only what the public pages already show may appear here. The member card page names the card's
// name, title, number and frame, the same words its page prints; an unknown, voided or unreadable
// serial gets the site's own tags and nothing of anybody.

import { frameName } from "@miyoria/card-face";
import type { IssuedCard } from "@miyoria/contracts/api";
import { type Character, DEFAULT_CHARACTER } from "@miyoria/types";

/** The site is named after her: the running profile's `[character] name` (Miyoria by default). */
export const SITE_NAME = DEFAULT_CHARACTER.name;

function siteDescription(her: Character): string {
  const p = her.pronoun;
  return `${her.name} 是住在 Discord 和直播裡的 AI VTuber。看看${p}現在在做什麼,領一張${p}發的會員卡。`;
}

/** Marks the block of `index.html` that holds the tags this file rewrites. */
export const META_START = "<!-- meta:start -->";
export const META_END = "<!-- meta:end -->";

export interface PageMeta {
  title: string;
  description: string;
  /** Absolute page URL. */
  url: string;
  /** Absolute image URL. */
  image: string;
  imageAlt: string;
  imageWidth: number;
  imageHeight: number;
  /** Whether search engines may list it. */
  index: boolean;
  /** `og:site_name`: her name (default `SITE_NAME`). */
  siteName?: string;
  /**
   * The words of her world for the panel (`<meta name="miyoria:world">`, JSON); absent: the panel
   * uses the first character's, and no tag is written.
   */
  world?: object;
}

/** The tag the panel reads the words of her world from (`apps/panel/src/lib/world.ts`). */
export const WORLD_META = "miyoria:world";

/** The default preview image: the panel serves it (`og.ts`). */
export const DEFAULT_IMAGE_PATH = "/og/default.png";
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
/** A card's own picture is the card, at its 630×880 ratio. */
export const CARD_IMAGE_WIDTH = 1000;
export const CARD_IMAGE_HEIGHT = Math.round((CARD_IMAGE_WIDTH * 880) / 630);

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The tag block for `meta`. */
export function metaTags(meta: PageMeta): string {
  const t = escapeHtml(meta.title);
  const d = escapeHtml(meta.description);
  const u = escapeHtml(meta.url);
  const i = escapeHtml(meta.image);
  const alt = escapeHtml(meta.imageAlt);
  return [
    META_START,
    `<title>${t}</title>`,
    `<meta name="description" content="${d}" />`,
    `<meta name="robots" content="${meta.index ? "index, follow" : "noindex, nofollow"}" />`,
    `<link rel="canonical" href="${u}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtml(meta.siteName ?? SITE_NAME)}" />`,
    `<meta property="og:locale" content="zh_TW" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:url" content="${u}" />`,
    `<meta property="og:image" content="${i}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="${meta.imageWidth}" />`,
    `<meta property="og:image:height" content="${meta.imageHeight}" />`,
    `<meta property="og:image:alt" content="${alt}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${i}" />`,
    `<meta name="twitter:image:alt" content="${alt}" />`,
    ...(meta.world === undefined
      ? []
      : [`<meta name="${WORLD_META}" content="${escapeHtml(JSON.stringify(meta.world))}" />`]),
    META_END,
  ].join("\n    ");
}

/** `html` with its tag block replaced by `meta`'s (inserted before `</head>` when it has none). */
export function injectMeta(html: string, meta: PageMeta): string {
  const tags = metaTags(meta);
  const from = html.indexOf(META_START);
  const to = html.indexOf(META_END);
  if (from !== -1 && to > from)
    return html.slice(0, from) + tags + html.slice(to + META_END.length);
  // No block: drop the lone <title> and put ours in; a page with no <head> stays as it is.
  if (!/<\/head>/i.test(html)) return html;
  const bare = html.replace(/<title>[\s\S]*?<\/title>\s*/i, "");
  return bare.replace(/<\/head>/i, `    ${tags}\n  </head>`);
}

// ---- pages ----------------------------------------------------------------------------------

/** Pages that are the panel itself: signed-in, so nothing for a search engine. */
const ADMIN = new Set([
  "/activity",
  "/character",
  "/inner",
  "/llm",
  "/system",
  "/live",
  "/rules",
  "/eval",
  "/access",
  "/data",
  "/settings",
  "/people",
]);

/** The origin a request came to, behind a tunnel or not. Only plain host characters get through. */
export function originOf(request: Request): string {
  const url = new URL(request.url);
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded && /^[a-z0-9.:[\]-]+$/i.test(forwarded) ? forwarded : url.host;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const local = /^(localhost|127\.|\[::1\])/i.test(host);
  const scheme =
    proto === "http" || proto === "https" ? proto : local ? url.protocol.slice(0, -1) : "https";
  return `${scheme}://${host}`;
}

/** The site's own tags for `path` (a panel route, not a card); `her`: the running profile's. */
export function pageMeta(
  path: string,
  origin: string,
  her: Character = DEFAULT_CHARACTER,
): PageMeta {
  const first = `/${path.split("/").filter(Boolean)[0] ?? ""}`;
  const site = her.name;
  let title = site;
  let description = siteDescription(her);
  let index = true;
  if (first === "/me") {
    title = `我的頁面 · ${site}`;
    description = "她記得你什麼、你的會員卡、錢包和點歌,都在這裡。";
    index = false;
  } else if (first === "/card") {
    title = `會員卡 · ${site}`;
    description = `${site} 發的會員卡,掃卡上的條碼就能確認它是不是真的。`;
    index = false;
  } else if (first === "/watch") {
    title = `現場 · ${site}`;
    description = `${site} 現在的直播畫面和${her.pronoun}說的話,登入後可以在畫面上摸摸${her.pronoun}。`;
  } else if (first === "/login") {
    title = `登入 · ${site}`;
    index = false;
  } else if (ADMIN.has(first)) {
    title = `管理面板 · ${site}`;
    description = `${site} 的管理面板。`;
    index = false;
  }
  return {
    title,
    description,
    // A card page without a card names no serial: nothing a visitor typed is echoed back.
    url: `${origin}${first === "/card" ? "/card" : path}`,
    image: `${origin}${DEFAULT_IMAGE_PATH}`,
    imageAlt: `${site}`,
    imageWidth: OG_WIDTH,
    imageHeight: OG_HEIGHT,
    index,
    siteName: site,
  };
}

/** The words about a card that its page already prints (name, title, number, frame). */
export function cardWords(
  card: IssuedCard,
  her: Character = DEFAULT_CHARACTER,
): { title: string; description: string; alt: string } {
  const site = her.name;
  const title = card.relationship ?? "初次見面";
  const no = `No.${String(card.number).padStart(3, "0")}`;
  const frame = frameName(card.frame);
  const bits = [`${card.name} 的 ${site} 會員卡`, `${title}`, no];
  if (card.foil) bits.push("閃卡");
  if (frame) bits.push(frame);
  const description = `${bits.join(" · ")} · 編號 ${card.serial}`;
  return {
    title: `${card.name} 的會員卡 · ${site}`,
    description,
    alt: `${card.name} 的 ${site} 會員卡,${title},${no}`,
  };
}

/** The tags of a card's page: its own preview image (`imageUrl`) and words. */
export function cardMeta(
  card: IssuedCard,
  origin: string,
  imageUrl: string,
  her: Character = DEFAULT_CHARACTER,
): PageMeta {
  const words = cardWords(card, her);
  return {
    title: words.title,
    description: words.description,
    url: `${origin}/card/${encodeURIComponent(card.serial)}`,
    image: imageUrl,
    imageAlt: words.alt,
    imageWidth: CARD_IMAGE_WIDTH,
    imageHeight: CARD_IMAGE_HEIGHT,
    index: false,
    siteName: her.name,
  };
}
