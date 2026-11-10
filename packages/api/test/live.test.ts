// The live page's routes (src/live.ts) against a fake feed: the stream's shape and limits, and a
// pat travelling from the request to the feed as the session's own person.

import {
  type LiveEvent,
  type LiveFeed,
  LiveFeedKey,
  type LivePatOutcome,
  type LivePatter,
  type LiveSnapshot,
} from "@miyoria/types";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_STREAMS_PER_CLIENT,
  liveRoutes,
  PATS_CLOSED,
  sseMessage,
  VIDEO_PER_CLIENT,
  videoUrl,
} from "../src/live.js";
import { Monitor } from "../src/monitor.js";
import { PublicConfigSchema, PublicSide } from "../src/public.js";
import type { SessionRecord } from "../src/session.js";
import { type ApiEnv, ApiState } from "../src/state.js";

const SNAPSHOT: LiveSnapshot = {
  presence: { place: "idle", game: null },
  activity: null,
  speaking: false,
  emotion: { name: "neutral", intensity: 0 },
  line: null,
  pats: { recent: 0, open: true },
  video: { on: false, src: null },
};

class FakeFeed implements LiveFeed {
  listeners = new Set<(e: LiveEvent) => void>();
  pats: LivePatter[] = [];
  outcome: LivePatOutcome = { status: "ok", pats: { recent: 1, open: true } };
  info: ReturnType<LiveFeed["video"]> = null;
  video(): ReturnType<LiveFeed["video"]> {
    return this.info;
  }
  constructor(private readonly max = 100) {}
  snapshot(): LiveSnapshot {
    return SNAPSHOT;
  }
  follow(listener: (e: LiveEvent) => void): (() => void) | null {
    if (this.listeners.size >= this.max) return null;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async pat(by: LivePatter): Promise<LivePatOutcome> {
    this.pats.push(by);
    return this.outcome;
  }
  emit(e: LiveEvent): void {
    for (const l of this.listeners) l(e);
  }
}

const SESSION: SessionRecord = {
  account: { platform: "discord", id: "222" },
  name: "Alice",
  avatar_url: null,
  tier: "member",
  created_at: "2026-11-10T00:00:00.000Z",
  expires_at: "2026-11-17T00:00:00.000Z",
};

function rig(feed: LiveFeed | undefined, publicEnabled = true) {
  const ctx = {
    clock: { now: () => 0 },
    services: { get: (key: unknown) => (key === LiveFeedKey ? feed : undefined) },
  };
  const side = new PublicSide(PublicConfigSchema.parse({ enabled: publicEnabled }), () => 0);
  const state = new ApiState(
    ctx as never,
    {} as never,
    new Monitor(),
    null,
    () => [],
    [],
    undefined,
    undefined,
    undefined,
    side,
  );
  const app = new Hono<ApiEnv>();
  // The real router authenticates; here the member is simply who the session says.
  for (const route of liveRoutes(state)) {
    app.on(route.method, route.path, async (c) => {
      if (route.member) c.set("member", SESSION);
      try {
        return await route.handler(c);
      } catch (error) {
        return (error as { toResponse(): Response }).toResponse();
      }
    });
  }
  return { app, routes: liveRoutes(state) };
}

/** Reads a stream until `count` SSE messages (comments and `retry:` skipped) arrived. */
async function messages(
  res: Response,
  count: number,
): Promise<Array<{ event: string; data: unknown }>> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: Array<{ event: string; data: unknown }> = [];
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) out.push({ event, data: JSON.parse(data) });
      end = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return out;
}

const pat = (app: Hono<ApiEnv>, body: unknown = {}) =>
  app.request("/api/member/live/pat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /api/public/live", () => {
  it("starts with the snapshot, then carries every event as SSE", async () => {
    const feed = new FakeFeed();
    const { app } = rig(feed);
    const res = await app.request("/api/public/live");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const line: LiveEvent = {
      type: "line",
      line: { id: 1, text: "晚安", final: true, via: "text" },
    };
    feed.emit(line);
    expect(await messages(res, 2)).toEqual([
      { event: "hello", data: { type: "hello", snapshot: SNAPSHOT } },
      { event: "line", data: line },
    ]);
  });

  it("lets go of the feed when the page leaves", async () => {
    const feed = new FakeFeed();
    const { app } = rig(feed);
    const res = await app.request("/api/public/live");
    expect(feed.listeners.size).toBe(1);
    await res.body?.cancel();
    expect(feed.listeners.size).toBe(0);
  });

  it("takes a few streams per client, and another one once one closed", async () => {
    const feed = new FakeFeed();
    const { app } = rig(feed);
    const open: Response[] = [];
    for (let i = 0; i < LIVE_STREAMS_PER_CLIENT; i++) {
      const res = await app.request("/api/public/live");
      expect(res.status).toBe(200);
      open.push(res);
    }
    const refused = await app.request("/api/public/live");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    await open[0]?.body?.cancel();
    expect((await app.request("/api/public/live")).status).toBe(200);
  });

  it("says 503 when the feed has as many watchers as it takes, or is not running", async () => {
    expect((await rig(new FakeFeed(0)).app.request("/api/public/live")).status).toBe(503);
    expect((await rig(undefined).app.request("/api/public/live")).status).toBe(503);
  });

  it("puts one event on one message, whatever the text holds", () => {
    const text = "第一行\n\nevent: hello\ndata: x";
    const message = sseMessage({ type: "line", line: { id: 1, text, final: false, via: "voice" } });
    expect(message.split("\n\n")).toHaveLength(2);
    expect(message.endsWith("\n\n")).toBe(true);
  });

  it("goes away with the public switch", () => {
    expect(rig(new FakeFeed(), false).routes).toEqual([]);
  });
});

describe("POST /api/member/live/pat", () => {
  it("pats as the session's person, and tells the counts", async () => {
    const feed = new FakeFeed();
    const res = await pat(rig(feed).app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pats: { recent: 1, open: true } });
    expect(feed.pats).toEqual([{ account: SESSION.account, name: "Alice" }]);
  });

  it("takes an empty body only: nobody pats as someone else", async () => {
    const feed = new FakeFeed();
    const res = await pat(rig(feed).app, { account: { platform: "discord", id: "1" } });
    expect(res.status).toBe(422);
    expect(feed.pats).toEqual([]);
  });

  it("answers 429 with Retry-After past a limit", async () => {
    const feed = new FakeFeed();
    feed.outcome = { status: "too_many", wait_ms: 4_200 };
    const res = await pat(rig(feed).app);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
  });

  it("answers 403 in words while pats are off, and 503 without the module", async () => {
    const feed = new FakeFeed();
    feed.outcome = { status: "closed" };
    const closed = await pat(rig(feed).app);
    expect(closed.status).toBe(403);
    expect(await closed.json()).toEqual({ error: PATS_CLOSED });
    expect((await pat(rig(undefined).app)).status).toBe(503);
  });
});

describe("POST /api/member/live/pat with a spot", () => {
  it("carries a spot to the feed, and takes none", async () => {
    const feed = new FakeFeed();
    expect((await pat(rig(feed).app, { x: 0.25, y: 1 })).status).toBe(200);
    expect(feed.pats[0]?.spot).toEqual({ x: 0.25, y: 1 });
    expect((await pat(rig(feed).app, {})).status).toBe(200);
    expect(feed.pats[1]?.spot).toBeUndefined();
  });

  it("refuses half a spot, out of range, not a number, or anything more", async () => {
    const feed = new FakeFeed();
    const { app } = rig(feed);
    for (const body of [
      { x: 0.5 },
      { y: 0.5 },
      { x: 1.01, y: 0 },
      { x: -0.1, y: 0 },
      { x: "0.5", y: 0.5 },
      { x: null, y: 0.5 },
      { x: 0.5, y: 0.5, account: "1" },
    ]) {
      expect((await pat(app, body)).status).toBe(422);
    }
    expect(feed.pats).toEqual([]);
  });
});

describe("videoUrl", () => {
  const base = "http://127.0.0.1:8888/live/miyoria/";
  const q = (s = "") => new URLSearchParams(s);

  it("takes the files MediaMTX serves", () => {
    for (const file of [
      "index.m3u8",
      "video1_stream.m3u8",
      "audio2_stream.m3u8",
      "afeec1028f39_video1_part22.mp4",
      "seg0.m4s",
      "a.ts",
      "x.aac",
    ]) {
      expect(videoUrl(base, file, q())).toBe(`${base}${file}`);
    }
  });

  it("refuses anything else", () => {
    for (const file of [
      "",
      "..",
      "../index.m3u8",
      "a/b.m3u8",
      "a\\b.m3u8",
      ".hidden.m3u8",
      "a..b.m3u8",
      "index",
      "index.html",
      "index.m3u8/",
      "a%2Fb.m3u8",
      "a b.m3u8",
      `${"a".repeat(130)}.m3u8`,
    ]) {
      expect(videoUrl(base, file, q())).toBeNull();
    }
  });

  it("forwards only the LL-HLS query, and only well-formed", () => {
    const out = videoUrl(
      base,
      "video1_stream.m3u8",
      q("_HLS_msn=12&_HLS_part=3&_HLS_skip=YES&token=x&hlsSession=1"),
    );
    expect(out).toBe(`${base}video1_stream.m3u8?_HLS_msn=12&_HLS_part=3&_HLS_skip=YES`);
    expect(videoUrl(base, "a.m3u8", q("_HLS_msn=-1&_HLS_part=1e3&_HLS_skip=NO"))).toBe(
      `${base}a.m3u8`,
    );
  });
});

describe("GET /api/public/live/video/:file", () => {
  afterEach(() => vi.unstubAllGlobals());
  const INFO = { on: true, upstream: "http://mtx/live/miyoria/", secret: "s3cret", max_viewers: 2 };

  function live(info: ReturnType<LiveFeed["video"]> = INFO) {
    const feed = new FakeFeed();
    feed.info = info;
    return rig(feed).app;
  }

  it("proxies with the secret only, and passes the headers that matter", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("#EXTM3U", {
        status: 200,
        headers: {
          "content-type": "application/vnd.apple.mpegurl",
          "cache-control": "public, max-age=1",
          "set-cookie": "hlsSession=1",
          "content-length": "7",
        },
      });
    });
    const res = await live().request("/api/public/live/video/index.m3u8?_HLS_msn=4&x=1", {
      headers: { cookie: "miyoria_session=zzz", authorization: "Bearer mine", accept: "*/*" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("#EXTM3U");
    expect(res.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(res.headers.get("cache-control")).toBe("public, max-age=1");
    expect(res.headers.get("content-length")).toBe("7");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen[0]?.url).toBe("http://mtx/live/miyoria/index.m3u8?_HLS_msn=4");
    expect(seen[0]?.init.redirect).toBe("manual");
    expect(seen[0]?.init.headers).toEqual({ authorization: "Bearer s3cret", accept: "*/*" });
  });

  it("is 404 while video is off or not publishing, and for a bad file", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    expect((await live(null).request("/api/public/live/video/index.m3u8")).status).toBe(404);
    expect(
      (await live({ ...INFO, on: false }).request("/api/public/live/video/index.m3u8")).status,
    ).toBe(404);
    for (const path of ["..%2Findex.m3u8", "a%2Fb.m3u8", "index.html", "%2e%2e"]) {
      expect((await live().request(`/api/public/live/video/${path}`)).status).toBe(404);
    }
    expect(fetched).not.toHaveBeenCalled();
  });

  it("maps upstream trouble: 404 stays, the rest is 502", async () => {
    for (const [up, down] of [
      [404, 404],
      [401, 502],
      [302, 502],
      [500, 502],
    ] as const) {
      vi.stubGlobal("fetch", async () => new Response("no", { status: up }));
      expect((await live().request("/api/public/live/video/a.m3u8")).status).toBe(down);
    }
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect((await live().request("/api/public/live/video/a.m3u8")).status).toBe(502);
  });

  it("answers HEAD without a body", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
    const res = await live().request("/api/public/live/video/a.m3u8", { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  it("limits what one client holds at once, and frees a slot when one ends", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
    );
    const app = live({ ...INFO, max_viewers: 100 });
    const open: Response[] = [];
    for (let i = 0; i < VIDEO_PER_CLIENT; i++) {
      open.push(await app.request("/api/public/live/video/a.m3u8"));
    }
    const refused = await app.request("/api/public/live/video/a.m3u8");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    await open[0]?.body?.cancel();
    expect((await app.request("/api/public/live/video/a.m3u8")).status).toBe(200);
  });

  it("limits the total to three per viewer the feed takes", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
    );
    const feed = new FakeFeed();
    feed.info = { ...INFO, max_viewers: 1 };
    const { app } = rig(feed);
    for (let i = 0; i < 3; i++) {
      expect((await app.request("/api/public/live/video/a.m3u8")).status).toBe(200);
    }
    expect((await app.request("/api/public/live/video/a.m3u8")).status).toBe(429);
  });
});
