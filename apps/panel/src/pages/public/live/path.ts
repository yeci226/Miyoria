// Where the live page lives, apart from the page itself so the landing can link to it without
// loading the player.

/**
 * The address of the live page: anyone may open it, logged in or not. Not `/live`: that is the
 * admin panel's 直播 page.
 */
export const LIVE_PAGE = "/watch";

/** Whether `path` (path and query) is the live page. */
export function isLivePath(path: string): boolean {
  const bare = path.split(/[?#]/)[0] ?? "";
  return bare === LIVE_PAGE || bare === `${LIVE_PAGE}/`;
}
