// Reading Threads posts, and the adapter against a fake browser.

import { describe, expect, it } from "vitest";
import { ACTIONS, type Browser, type Pictures, ThreadsAdapter } from "../src/adapter.js";
import { describePost, parseCount, type RawPost, toPost } from "../src/feed.js";

describe("toPost", () => {
  it("reads the author, age, body and counts the page shows", () => {
    const post = toPost({
      author: "/@zuck",
      link: "/@zuck/post/DfNR0zhEdWv",
      time: "2026-11-01T17:33:48.000Z",
      text: "zuck\n1天\nTried to get the family to dress as burger night\n4,150\n745\n212\n100",
      images: 3,
      top: 0,
      height: 400,
    });
    expect(post).toMatchObject({
      author: "zuck",
      age: "1天",
      body: "Tried to get the family to dress as burger night",
      likes: 4150,
      replies: 745,
      reposts: 212,
      shares: 100,
      images: 3,
    });
  });

  it("keeps a body that ends in a number and copes with missing counts", () => {
    const post = toPost({
      author: "/@amy",
      link: null,
      time: null,
      text: "amy\n2026-10-13\n今天跑了 10\n公里\n3",
      images: 0,
      top: 0,
      height: 100,
    });
    expect(post.age).toBe("2026-10-13");
    expect(post.body).toBe("今天跑了 10\n公里");
    expect(post.likes).toBe(3);
    expect(post.replies).toBeNull();
  });

  it("parses counts with units", () => {
    expect(parseCount("1.2萬")).toBe(12000);
    expect(parseCount("3.4K")).toBe(3400);
    expect(parseCount("2M")).toBe(2_000_000);
    expect(parseCount("讚")).toBeNull();
  });

  it("describes a post for her, pictures included", () => {
    const post = toPost({
      author: "/@a",
      link: "/@a/post/1",
      time: null,
      text: "a\n5 小時\n看我的貓\n12\n3",
      images: 1,
      top: 0,
      height: 1,
    });
    expect(describePost(post, "一隻橘貓趴在鍵盤上")).toBe(
      "@a(5 小時):\n看我的貓\n圖片:一隻橘貓趴在鍵盤上\n12 讚、3 則留言",
    );
    expect(describePost(post)).toContain("附了 1 張圖或影片(看不到內容)");
  });
});

const raw = (n: number, top: number, extra: Partial<RawPost> = {}): RawPost => ({
  author: `/@u${n}`,
  link: `/@u${n}/post/p${n}`,
  time: null,
  text: `u${n}\n1天\n貼文 ${n}\n${n}`,
  images: 0,
  top,
  height: 300,
  ...extra,
});

/** A feed of posts 300 px apart; scrolling to a post moves it to the top. */
class FakeBrowser implements Browser {
  open = false;
  logged = true;
  page: "feed" | "post" = "feed";
  offset = 0;
  feed = [raw(1, 0), raw(2, 300), raw(3, 600, { images: 2 }), raw(4, 900)];
  calls: string[] = [];

  async launch() {
    this.open = true;
  }
  async loggedIn() {
    return this.logged;
  }
  onPostPage() {
    return this.page === "post";
  }
  viewportHeight() {
    return 1000;
  }
  async posts() {
    if (this.page === "post") return [raw(3, 0), raw(91, 300), raw(92, 500)];
    return this.feed.map((p, i) => ({ ...p, top: i * 300 - this.offset }));
  }
  async focus(index: number) {
    this.offset = index * 300 - 90;
    this.calls.push(`focus ${index}`);
  }
  async scrollBy(px: number) {
    this.offset += px;
  }
  async shot(index: number) {
    this.calls.push(`shot ${index}`);
    return "jpeg";
  }
  async openPost(link: string) {
    this.calls.push(`open ${link}`);
    this.page = "post";
  }
  async back() {
    this.page = "feed";
  }
  async home() {
    this.offset = 0;
  }
  async close() {
    this.open = false;
  }
}

describe("ThreadsAdapter", () => {
  it("has no action that writes anything on Threads", () => {
    expect(ACTIONS.map((a) => a.name).sort()).toEqual([
      "back",
      "launch",
      "next",
      "open",
      "quit",
      "refresh",
    ]);
  });

  it("asks for the browser, then for a login, before she reads anything", async () => {
    const browser = new FakeBrowser();
    const adapter = new ThreadsAdapter(browser);
    expect((await adapter.observe()).state).toMatchObject({
      connected: false,
      launch: { available: true },
    });
    await adapter.act({ name: "launch" });
    browser.logged = false;
    const out = await adapter.observe();
    expect(out.state).toMatchObject({ connected: true, in_game: false });
    expect(out.summary).toContain("還沒登入");
  });

  it("reads the feed post by post, describes pictures once, and opens a post's replies", async () => {
    const browser = new FakeBrowser();
    const asked: string[] = [];
    const pictures: Pictures = {
      describe: async (key) => {
        asked.push(key);
        return "兩張海邊的照片";
      },
    };
    const adapter = new ThreadsAdapter(browser, pictures);
    await adapter.act({ name: "launch" });
    expect((await adapter.observe()).summary).toContain("貼文 1");
    const second = await adapter.act({ name: "next" });
    expect(second).toMatchObject({ ok: true });
    expect(second.message).toContain("貼文 2");
    const third = await adapter.act({ name: "next" });
    expect(third.message).toContain("圖片:兩張海邊的照片");
    expect(asked).toEqual(["/@u3/post/p3"]);
    const opened = await adapter.act({ name: "open" });
    expect(browser.calls).toContain("open /@u3/post/p3");
    expect(opened.message).toContain("留言:");
    expect(opened.message).toContain("@u91");
    // Going on from a post's page goes back to the feed first, to a post not seen yet.
    const fourth = await adapter.act({ name: "next" });
    expect(fourth.message).toContain("貼文 4");
    expect(browser.page).toBe("feed");
  });

  it("refuses an unknown action", async () => {
    const adapter = new ThreadsAdapter(new FakeBrowser());
    expect(await adapter.act({ name: "like" })).toMatchObject({ ok: false });
  });
});

describe("Vision", () => {
  it("asks an OpenCode endpoint without reasoning, with its session header, and caches", async () => {
    const { Vision } = await import("../src/vision.js");
    const sent: Array<{
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: "一隻貓 " } }] }));
    }) as unknown as typeof fetch;
    const v = new Vision({
      url: "https://opencode.ai/inference/go/v1/",
      model: "deepseek-v4.1-flash",
      key: "k",
      timeoutMs: 1000,
      fetch: fake,
    });
    expect(await v.describe("/@a/post/1", "jpeg")).toBe("一隻貓");
    expect(await v.describe("/@a/post/1", "jpeg")).toBe("一隻貓");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://opencode.ai/inference/go/v1/chat/completions");
    expect(sent[0]?.headers["x-opencode-session"]).toMatch(/^miyoria-threads-/);
    expect(sent[0]?.body.thinking).toEqual({ type: "disabled" });
  });
});
