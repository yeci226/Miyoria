// The site is named after her: the Core puts the running profile's `[character] name` into the
// page's `og:site_name` (docs/design/v5-profiles.md). A page served without a Core (the dev server,
// tests) keeps `index.html`'s, Miyoria.

const FALLBACK = "Miyoria";

/** Her name as the Core that served this page tagged it. */
export function siteName(doc: Document | undefined = globalThis.document): string {
  const tagged = doc?.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim();
  return tagged || FALLBACK;
}

/** Read once: it cannot change without the Core restarting, which reloads the page. */
export const SITE_NAME = siteName();
