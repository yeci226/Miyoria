// The browser she scrolls Threads in: Playwright's Chromium as a window without tabs or address
// bar (OBS captures it), with her own profile folder so her login stays. Read-only by design:
// it only scrolls, opens a post's page and goes back; nothing here clicks like, reply or post.

import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";
import type { RawPost } from "./feed.js";

export interface BrowserOptions {
  startUrl: string;
  profileDir: string;
  width: number;
  height: number;
}

/** The window title OBS captures it by (its window is a Chromium "app" window). */
export const WINDOW_TITLE = "Miyoria Threads";

/** Where her browser profile lives unless configured. */
export function defaultProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA ?? join(env.HOME ?? env.USERPROFILE ?? ".", ".local", "share");
  return join(base, "Miyoria", "threads-browser");
}

/**
 * Finds the posts in the page: every `<time>` belongs to one post, and the post is the largest
 * ancestor that still holds only that one `<time>`. Independent of Threads' generated class
 * names. Marks each block with `data-miyoria-post` so it can be scrolled to.
 */
const READ_POSTS = `(() => {
  const out = [];
  let i = 0;
  for (const t of document.querySelectorAll("time")) {
    let el = t;
    while (el.parentElement && el.parentElement.querySelectorAll("time").length === 1) el = el.parentElement;
    if (el === document.body) continue;
    el.setAttribute("data-miyoria-post", String(i));
    const r = el.getBoundingClientRect();
    const media = [...el.querySelectorAll("img, video")].filter((m) => m.getBoundingClientRect().width > 120);
    out.push({
      author: el.querySelector('a[href^="/@"]')?.getAttribute("href")?.split("/").slice(0, 2).join("/") ?? null,
      link: el.querySelector('a[href*="/post/"]')?.getAttribute("href") ?? null,
      time: t.getAttribute("datetime"),
      text: el.innerText,
      images: media.length,
      top: Math.round(r.top),
      height: Math.round(r.height),
    });
    i++;
  }
  return out;
})()`;

export class ThreadsBrowser {
  readonly #opts: BrowserOptions;
  #context: BrowserContext | null = null;
  #page: Page | null = null;

  constructor(opts: BrowserOptions) {
    this.#opts = opts;
  }

  get open(): boolean {
    return this.#page !== null && !this.#page.isClosed();
  }

  async launch(): Promise<void> {
    if (this.open) return;
    const { startUrl, profileDir, width, height } = this.#opts;
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: "chromium",
      headless: false,
      viewport: null,
      locale: "zh-TW",
      args: [`--app=${startUrl}`, `--window-size=${width},${height}`, "--disable-infobars"],
    });
    context.on("close", () => {
      this.#context = null;
      this.#page = null;
    });
    this.#context = context;
    const page = context.pages()[0] ?? (await context.newPage());
    if (!page.url().startsWith("http"))
      await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    // The window title OBS matches (Threads sets its own title on every navigation).
    await page.addInitScript(`(() => {
      const fix = () => { if (document.title !== ${JSON.stringify(WINDOW_TITLE)}) document.title = ${JSON.stringify(WINDOW_TITLE)}; };
      new MutationObserver(fix).observe(document, { subtree: true, childList: true, characterData: true });
      fix();
    })()`);
    await page.evaluate(`document.title = ${JSON.stringify(WINDOW_TITLE)}`).catch(() => {});
    this.#page = page;
  }

  #need(): Page {
    if (!this.#page || this.#page.isClosed()) throw new Error("the browser is not open");
    return this.#page;
  }

  /** Signed in: the page offers no "log in" link. */
  async loggedIn(): Promise<boolean> {
    const page = this.#need();
    const prompts = await page.locator('a[href*="/login"]').count();
    return prompts === 0;
  }

  /** Whether the current page is a single post (`/@name/post/<id>`). */
  onPostPage(): boolean {
    return /\/post\//.test(this.#page?.url() ?? "");
  }

  url(): string {
    return this.#page?.url() ?? "";
  }

  viewportHeight(): number {
    return this.#page?.viewportSize()?.height ?? this.#opts.height;
  }

  async posts(): Promise<RawPost[]> {
    return (await this.#need().evaluate(READ_POSTS)) as RawPost[];
  }

  /** Brings post `index` (as last read by `posts`) near the top of the window, smoothly. */
  async focus(index: number): Promise<void> {
    await this.#need().evaluate(`(() => {
      const el = document.querySelector('[data-miyoria-post="${Number(index)}"]');
      if (el) window.scrollBy({ top: el.getBoundingClientRect().top - 90, behavior: "smooth" });
    })()`);
    await this.#need().waitForTimeout(900);
  }

  /** Scrolls down by `px` (to make the page load more posts). */
  async scrollBy(px: number): Promise<void> {
    await this.#need().evaluate(`window.scrollBy({ top: ${Math.round(px)}, behavior: "smooth" })`);
    await this.#need().waitForTimeout(1500);
  }

  /** A JPEG of post `index` (for the picture model), at most `maxHeight` px tall. */
  async shot(index: number, maxHeight = 1400): Promise<string | null> {
    const el = this.#need()
      .locator(`[data-miyoria-post="${Number(index)}"]`)
      .first();
    if ((await el.count()) === 0) return null;
    const box = await el.boundingBox();
    if (!box) return null;
    const clip = { ...box, height: Math.min(box.height, maxHeight) };
    const png = await this.#need().screenshot({ type: "jpeg", quality: 70, clip });
    return png.toString("base64");
  }

  /** Opens a post's own page (its replies). Only Threads links are followed. */
  async openPost(link: string): Promise<void> {
    if (!/^\/@[\w.]+\/post\/[\w-]+$/.test(link)) throw new Error(`not a post link: ${link}`);
    const url = new URL(link, this.#opts.startUrl).toString();
    await this.#need().goto(url, { waitUntil: "domcontentloaded" });
    await this.#need().waitForTimeout(2500);
  }

  async back(): Promise<void> {
    const page = this.#need();
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    if (!page.url().startsWith(new URL(this.#opts.startUrl).origin)) {
      await page.goto(this.#opts.startUrl, { waitUntil: "domcontentloaded" });
    }
    await page.waitForTimeout(2000);
  }

  async home(): Promise<void> {
    await this.#need().goto(this.#opts.startUrl, { waitUntil: "domcontentloaded" });
    await this.#need().waitForTimeout(3000);
  }

  async close(): Promise<void> {
    const context = this.#context;
    this.#context = null;
    this.#page = null;
    await context?.close().catch(() => {});
  }
}
