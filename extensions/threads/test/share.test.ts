// The tools Core's `share` module calls: reading the feed and capturing one post.

import { describe, expect, it } from "vitest";
import type { Browser, Pictures } from "../src/adapter.js";
import type { Post, RawPost } from "../src/feed.js";
import { worthReading } from "../src/feed.js";
import threads from "../src/index.js";
import { ShareTools } from "../src/share.js";

function raw(n: number, extra: Partial<RawPost> = {}): RawPost {
  return {
    author: `/@u${n}`,
    link: `/@u${n}/post/p${n}`,
    time: null,
    text: `u${n}\n1天\n這是第 ${n} 則比較長的貼文內容`,
    images: 0,
    top: 0,
    height: 200,
    ...extra,
  };
}

class FakeBrowser implements Browser {
  open = false;
  logged = true;
  address = "https://www.threads.com/";
  feed: RawPost[] = [raw(1), raw(2), raw(3)];
  /** Posts that appear once she scrolled. */
  more: RawPost[] = [];
  /** Page order changes after a scroll into view. */
  afterFocus: RawPost[] | null = null;
  shots: number[] = [];

  async launch() {
    this.open = true;
  }
  async loggedIn() {
    return this.logged;
  }
  onPostPage() {
    return false;
  }
  viewportHeight() {
    return 1000;
  }
  url() {
    return this.address;
  }
  async posts() {
    return this.feed;
  }
  async focus() {
    if (this.afterFocus) this.feed = this.afterFocus;
  }
  async scrollBy() {
    this.feed = [...this.feed, ...this.more];
    this.more = [];
  }
  async shot(index: number) {
    this.shots.push(index);
    return `jpeg${index}`;
  }
  async openPost() {}
  async back() {}
  async home() {}
  async close() {
    this.open = false;
  }
}

function memory(initial: string[] = []) {
  const box = { links: initial };
  return {
    box,
    store: {
      load: async () => box.links,
      save: async (links: string[]) => {
        box.links = links;
      },
    },
  };
}

function post(extra: Partial<Post>): Post {
  return {
    author: "a",
    link: "/@a/post/1",
    time: null,
    age: null,
    body: "這是一則夠長的貼文內容",
    images: 0,
    likes: null,
    replies: null,
    reposts: null,
    shares: null,
    ...extra,
  };
}

describe("worthReading", () => {
  it("keeps a normal post, and a short one with a picture", () => {
    expect(worthReading(post({}))).toBe(true);
    expect(worthReading(post({ body: "哈", images: 1 }))).toBe(true);
  });

  it("drops ads and short posts", () => {
    expect(worthReading(post({ body: "贊助\n買這個超棒的東西喔" }))).toBe(false);
    expect(worthReading(post({ body: "Sponsored\nbuy this great thing now" }))).toBe(false);
    expect(worthReading(post({ link: null }))).toBe(false);
    expect(worthReading(post({ link: "https://example.com/post/1" }))).toBe(false);
    expect(worthReading(post({ link: "/@a/post/1?x=1" }))).toBe(false);
    expect(worthReading(post({ body: "太短了" }))).toBe(false);
  });
});

describe("ShareTools.feed", () => {
  it("feed returns unseen posts up to the limit and remembers them", async () => {
    const browser = new FakeBrowser();
    const { box, store } = memory(["/@u1/post/p1"]);
    const tools = new ShareTools(browser, null, store, 5);
    const first = await tools.feed(1);
    expect(first.logged_in).toBe(true);
    expect(first.posts.map((p) => p.link)).toEqual(["/@u2/post/p2"]);
    expect(first.posts[0]).toMatchObject({ author: "u2", age: "1天", images: 0 });
    expect(box.links).toContain("/@u2/post/p2");
    const second = await tools.feed(5);
    expect(second.posts.map((p) => p.link)).toEqual(["/@u3/post/p3"]);
  });

  it("scrolls for more until it has enough", async () => {
    const browser = new FakeBrowser();
    browser.more = [raw(4), raw(5)];
    const tools = new ShareTools(browser, null, memory().store);
    const out = await tools.feed(5);
    expect(out.posts.length).toBe(5);
  });

  it("the seen list keeps the newest 500", async () => {
    const old = Array.from({ length: 500 }, (_, i) => `/@old/post/${i}`);
    const { box, store } = memory(old);
    await new ShareTools(new FakeBrowser(), null, store).feed(3);
    expect(box.links.length).toBe(500);
    expect(box.links).not.toContain("/@old/post/0");
    expect(box.links).toContain("/@u3/post/p3");
  });

  it("feed reports logged_in false on the login page", async () => {
    const browser = new FakeBrowser();
    browser.logged = false;
    const { box, store } = memory();
    const out = await new ShareTools(browser, null, store).feed(5);
    expect(out).toEqual({ logged_in: false, posts: [] });
    expect(box.links).toEqual([]);
  });

  it("feed treats a page off threads.com as not logged in", async () => {
    const browser = new FakeBrowser();
    browser.address = "https://www.instagram.com/challenge/";
    const out = await new ShareTools(browser, null, memory().store).feed(5);
    expect(out).toEqual({ logged_in: false, posts: [] });
  });

  it("feed stops at the deadline with what it has", async () => {
    const browser = new FakeBrowser();
    const out = await new ShareTools(browser, null, memory().store, 5).feed(50);
    expect(out.posts.length).toBe(3);
  });
});

describe("ShareTools.capture", () => {
  it("capture finds the post by link again", async () => {
    const browser = new FakeBrowser();
    browser.afterFocus = [raw(9), raw(8), raw(2)];
    const tools = new ShareTools(browser, null, memory().store);
    const out = await tools.capture("/@u2/post/p2");
    expect(browser.shots).toEqual([2]);
    expect(out).toEqual({ jpeg: "jpeg2", description: null });
  });

  it("describes a post with pictures", async () => {
    const browser = new FakeBrowser();
    browser.feed = [raw(1, { images: 2 })];
    const pictures: Pictures = { describe: async () => "海邊" };
    const out = await new ShareTools(browser, pictures, memory().store).capture("/@u1/post/p1");
    expect(out).toEqual({ jpeg: "jpeg0", description: "海邊" });
  });

  it("does not ask the picture model about a post without pictures", async () => {
    const asked: string[] = [];
    const pictures: Pictures = {
      describe: async (key) => {
        asked.push(key);
        return "x";
      },
    };
    await new ShareTools(new FakeBrowser(), pictures, memory().store).capture("/@u1/post/p1");
    expect(asked).toEqual([]);
  });

  it("capture with pictures but no description", async () => {
    const browser = new FakeBrowser();
    browser.feed = [raw(1, { images: 2 })];
    const pictures: Pictures = { describe: async () => null };
    const out = await new ShareTools(browser, pictures, memory().store).capture("/@u1/post/p1");
    expect(out).toEqual({ jpeg: "jpeg0", description: null });
  });

  it("capture of a post that is gone", async () => {
    const tools = new ShareTools(new FakeBrowser(), null, memory().store);
    expect(await tools.capture("/@gone/post/x")).toEqual({ jpeg: null, description: null });
  });
});

describe("activation", () => {
  function context(config: Record<string, unknown>) {
    const adapters: unknown[] = [];
    const tools: string[] = [];
    const ctx = {
      config,
      log: { info() {} },
      game: {
        registerAdapter: async (a: unknown) => {
          adapters.push(a);
        },
      },
      tools: {
        register: async (t: { name: string }) => {
          tools.push(t.name);
        },
      },
      storage: { get: async () => null, set: async () => {} },
      onShutdown() {},
    };
    return { adapters, tools, ctx };
  }

  it("does not register the game adapter when game is false", async () => {
    const { adapters, tools, ctx } = context({ game: false });
    await threads.activate(ctx as never);
    expect(adapters).toEqual([]);
    expect(tools).toEqual([
      "internal.threads.feed",
      "internal.threads.capture",
      "internal.threads.close",
    ]);
  });

  it("keeps the game adapter by default", async () => {
    const { adapters, ctx } = context({});
    await threads.activate(ctx as never);
    expect(adapters.length).toBe(1);
  });
});
