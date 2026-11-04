// What Core's `share` module calls when she scrolls on her own (tools `internal.threads.*`): read
// the posts she has not seen yet, and capture one of them. Spends no tokens except the picture
// model on a post that was picked. Nothing here writes on Threads.

import type { Browser, Pictures } from "./adapter.js";
import { type Post, toPost, worthReading } from "./feed.js";

export interface FeedPost {
  link: string;
  author: string;
  age: string | null;
  body: string;
  images: number;
}

export interface FeedResult {
  logged_in: boolean;
  posts: FeedPost[];
}

export interface CaptureResult {
  /** The post as a JPEG (base64), `null` when it is no longer on the page. */
  jpeg: string | null;
  /** What the picture model saw; `null` without pictures or when it failed. */
  description: string | null;
}

/** Posts she has already seen, oldest first. */
export interface SeenStore {
  load(): Promise<string[]>;
  save(links: string[]): Promise<void>;
}

const THREADS_HOST = /(^|\.)threads\.com$/;
const MAX_SEEN = 500;
/** A tool call may take 30 seconds (`call_timeout_ms`). */
const FEED_DEADLINE_MS = 25_000;

function onThreads(url: string): boolean {
  try {
    return THREADS_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function feedPost(post: Post, link: string): FeedPost {
  return { link, author: post.author, age: post.age, body: post.body, images: post.images };
}

export class ShareTools {
  readonly #browser: Browser;
  readonly #pictures: Pictures | null;
  readonly #seen: SeenStore;
  readonly #deadlineMs: number;

  constructor(
    browser: Browser,
    pictures: Pictures | null,
    seen: SeenStore,
    deadlineMs = FEED_DEADLINE_MS,
  ) {
    this.#browser = browser;
    this.#pictures = pictures;
    this.#seen = seen;
    this.#deadlineMs = deadlineMs;
  }

  /** Up to `limit` posts she has not seen; scrolls for more until the deadline. */
  async feed(limit: number): Promise<FeedResult> {
    const browser = this.#browser;
    const end = Date.now() + this.#deadlineMs;
    await browser.launch();
    await browser.home();
    if (!onThreads(browser.url()) || !(await browser.loggedIn())) {
      return { logged_in: false, posts: [] };
    }
    const seen = await this.#seen.load();
    const known = new Set(seen);
    const found = new Map<string, FeedPost>();
    while (true) {
      for (const raw of await browser.posts()) {
        const post = toPost(raw);
        const link = post.link;
        if (link === null || known.has(link) || found.size >= limit) continue;
        if (worthReading(post) && !found.has(link)) found.set(link, feedPost(post, link));
      }
      if (found.size >= limit || Date.now() >= end) break;
      await browser.scrollBy(browser.viewportHeight() * 0.8);
    }
    await this.#seen.save([...seen, ...found.keys()].slice(-MAX_SEEN));
    return { logged_in: true, posts: [...found.values()] };
  }

  /** The post at `link`, brought into view first so its pictures have loaded. */
  async capture(link: string): Promise<CaptureResult> {
    const browser = this.#browser;
    const before = (await browser.posts()).findIndex((p) => p.link === link);
    if (before < 0) return { jpeg: null, description: null };
    await browser.focus(before);
    const after = await browser.posts();
    const index = after.findIndex((p) => p.link === link);
    const raw = after[index];
    if (raw === undefined) return { jpeg: null, description: null };
    const jpeg = await browser.shot(index);
    if (jpeg === null) return { jpeg: null, description: null };
    const description =
      raw.images > 0 && this.#pictures !== null ? await this.#pictures.describe(link, jpeg) : null;
    return { jpeg, description };
  }

  async close(): Promise<void> {
    await this.#browser.close();
  }
}
