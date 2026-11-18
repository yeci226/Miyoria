// Where the karaoke page lives, apart from the page so the member page can link to it without
// loading it. A room is `/karaoke/room/<code>` (or `/karaoke?room=<code>`), on the same page.

/** The member's karaoke page. */
export const KARAOKE_PAGE = "/karaoke";

/** A room's own address. */
export function roomPage(code: string): string {
  return `${KARAOKE_PAGE}/room/${encodeURIComponent(code)}`;
}

/** Whether `path` (path and query) is the karaoke page, or a room on it. */
export function isKaraokePath(path: string): boolean {
  const bare = path.split(/[?#]/)[0] ?? "";
  return bare === KARAOKE_PAGE || bare === `${KARAOKE_PAGE}/` || /^\/karaoke\/room\/[^/]+\/?$/.test(bare);
}

/** The room `path` (path and query) leads to, as written (upper case), or `null`. */
export function roomCodeIn(path: string): string | null {
  const [bare = "", query = ""] = path.split("#")[0]?.split("?") ?? [];
  const inPath = /^\/karaoke\/room\/([^/]+)\/?$/.exec(bare)?.[1];
  const raw = inPath !== undefined ? decodeURIComponent(inPath) : new URLSearchParams(query).get("room");
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return /^[2-9A-HJKMNP-Z]{6}$/.test(code) ? code : null;
}
