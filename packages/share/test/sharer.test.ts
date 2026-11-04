import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ChatResponse, Completer } from "@miyoria/llm";
import type { ToolRegistry } from "@miyoria/tools";
import type {
  AccountRef,
  ContextKey,
  JsonValue,
  MessageRef,
  OutgoingMessage,
  PlatformSink,
} from "@miyoria/types";
import { beforeEach, describe, expect, it } from "vitest";
import { type ShareConfig, ShareConfigSchema } from "../src/config.js";
import { type CaptureResult, type FeedResult, ThreadsFeed } from "../src/feed.js";
import type { FeedPost } from "../src/judge.js";
import { Sharer, type SharerDeps } from "../src/sharer.js";

const here: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const owners: AccountRef[] = [
  { platform: "discord", id: "1" },
  { platform: "discord", id: "2" },
];
const NOON = new Date(2026, 10, 4, 12).getTime();
const HOUR = 3_600_000;
const POST = '{"action":"post","post":"p1","channel":"c1","comment":"好笑"}';

const post = (n: number, images = 0): FeedPost => ({
  link: `/@u/post/${n}`,
  author: "u",
  age: "1天",
  body: `貼文 ${n}`,
  images,
});

class Model implements Completer {
  calls = 0;
  constructor(public replies: (string | Error)[]) {}
  async complete(_purpose: string, _request: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    const reply = this.replies.shift() ?? new Error("no reply scripted");
    if (reply instanceof Error) throw reply;
    return { text: reply, reasoning: "", tool_calls: [], finish_reason: "stop", usage: null };
  }
}

class Feed {
  ready = true;
  result: FeedResult | Error = { logged_in: true, posts: [post(1)] };
  captures: Record<string, CaptureResult> = {};
  log: string[] = [];
  onFeed: () => void = () => {};
  async feed(limit: number): Promise<FeedResult> {
    this.log.push(`feed ${limit}`);
    this.onFeed();
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async capture(link: string): Promise<CaptureResult> {
    this.log.push(`capture ${link}`);
    return this.captures[link] ?? { jpeg: "AQID", description: null };
  }
  async close(): Promise<void> {
    this.log.push("close");
  }
}

class Sink {
  readonly platform = "discord";
  sendsFiles = true;
  sent: { context: ContextKey; message: OutgoingMessage; hadFile: boolean[] }[] = [];
  dms: string[] = [];
  fail: Error | null = null;
  async send(context: ContextKey, message: OutgoingMessage): Promise<MessageRef> {
    if (context.kind === "dm") {
      this.dms.push(`${context.channel}:${message.text}`);
      return { context, id: "dm" };
    }
    if (this.fail) throw this.fail;
    const hadFile = (message.files ?? []).map((f) => existsSync(f.path));
    this.sent.push({ context, message, hadFile });
    return { context, id: "m" };
  }
  async openDm(account: AccountRef): Promise<ContextKey> {
    return { platform: "discord", scope: null, channel: `dm${account.id}`, kind: "dm" };
  }
}

interface Rig {
  sharer: Sharer;
  feed: Feed;
  model: Model;
  sink: Sink;
  dir: string;
  saved: { value: JsonValue | null };
  deps: SharerDeps;
  clock: { now: number };
  decided: { lively: ContextKey[]; open: boolean; hits: string[] };
}

function rig(replies: (string | Error)[], config: Partial<ShareConfig> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "miyoria-share-"));
  const feed = new Feed();
  const model = new Model(replies);
  const sink = new Sink();
  const saved: { value: JsonValue | null } = { value: null };
  const clock = { now: NOON };
  const decided = { lively: [] as ContextKey[], open: true, hits: ["大家喜歡貼文"] };
  const deps: SharerDeps = {
    model,
    persona: () => "鯨魚娘",
    feed,
    contexts: () => [here],
    lively: () => decided.lively,
    ceiling: () => ({
      mode: decided.open ? "normal" : "off",
      label: "",
      blocked: null,
    }),
    match: {
      recall: async () => decided.hits.map((content) => ({ record: { content } })),
      notes: () => "",
      name: async () => "#聊天",
    },
    sink: () => sink as unknown as PlatformSink,
    owners: () => owners,
    settings: {
      load: async () => saved.value,
      save: async (value) => {
        saved.value = value;
      },
    },
    now: () => clock.now,
    warn: () => {},
  };
  const sharer = new Sharer(
    ShareConfigSchema.parse({ quiet_hours: "", browse_gap_mins: 0, ...config }),
    deps,
    dir,
  );
  return { sharer, feed, model, sink, dir, saved, deps, clock, decided };
}

const signal = new AbortController().signal;

async function round(r: Rig): Promise<boolean> {
  const started = r.sharer.start(signal);
  await r.sharer.idle();
  return started;
}

describe("a round", () => {
  it("one round posts one message", async () => {
    const r = rig(['{"picks":["p1"]}', POST]);
    expect(await round(r)).toBe(true);
    expect(r.feed.log).toEqual(["feed 10", "capture /@u/post/1", "close"]);
    expect(r.model.calls).toBe(2);
    expect(r.sink.sent.length).toBe(1);
    const sent = r.sink.sent[0];
    expect(sent?.context).toEqual(here);
    expect(sent?.message.text).toBe("好笑\n<https://www.threads.com/@u/post/1>");
    expect(sent?.message.mentions).toBe(false);
    expect(sent?.message.files?.[0]?.contentType).toBe("image/jpeg");
    expect(sent?.hadFile).toEqual([true]);
  });

  it("the temp image is deleted after sending", async () => {
    const r = rig(['{"picks":["p1"]}', POST]);
    await round(r);
    expect(readdirSync(r.dir)).toEqual([]);
  });

  it("the temp image is deleted when sending fails", async () => {
    const r = rig(['{"picks":["p1"]}', POST]);
    r.sink.fail = new Error("403");
    await round(r);
    expect(readdirSync(r.dir)).toEqual([]);
  });

  it("does not consider a place that cannot show the picture", async () => {
    const r = rig(['{"picks":["p1"]}', POST]);
    r.sink.sendsFiles = false;
    await round(r);
    expect(r.model.calls).toBe(1);
    expect(r.sink.sent).toEqual([]);
  });

  it("the post is on record before the round ends", async () => {
    const r = rig(['{"picks":["p1"]}', POST]);
    let posts: unknown = null;
    r.feed.close = async () => {
      posts = (r.saved.value as { limits: { posts: number } }).limits.posts;
    };
    await round(r);
    expect(posts).toBe(1);
  });

  it("no pick ends the round with one model call and no capture", async () => {
    const r = rig(['{"picks":[]}']);
    await round(r);
    expect(r.model.calls).toBe(1);
    expect(r.feed.log).toEqual(["feed 10", "close"]);
    expect(r.sink.sent).toEqual([]);
  });

  it("no matching channel ends before capture and decide", async () => {
    const r = rig(['{"picks":["p1"]}']);
    r.decided.hits = [];
    await round(r);
    expect(r.model.calls).toBe(1);
    expect(r.feed.log).toEqual(["feed 10", "close"]);
  });

  it("a post with pictures and no description is dropped", async () => {
    const r = rig(['{"picks":["p1"]}']);
    r.feed.result = { logged_in: true, posts: [post(1, 2)] };
    await round(r);
    expect(r.model.calls).toBe(1);
    expect(r.sink.sent).toEqual([]);
    expect(readdirSync(r.dir)).toEqual([]);
  });

  it("keeps the post that has a description", async () => {
    const r = rig(['{"picks":["p1","p2"]}', POST]);
    r.feed.result = { logged_in: true, posts: [post(1, 2), post(2, 1)] };
    r.feed.captures["/@u/post/2"] = { jpeg: "AQID", description: "海邊" };
    await round(r);
    expect(r.sink.sent[0]?.message.text).toContain("/@u/post/2");
  });

  it("a post that left the page is dropped", async () => {
    const r = rig(['{"picks":["p1"]}']);
    r.feed.captures["/@u/post/1"] = { jpeg: null, description: null };
    await round(r);
    expect(r.model.calls).toBe(1);
  });

  it("a failed send does not count against the limit", async () => {
    const r = rig(['{"picks":["p1"]}', POST, '{"picks":["p1"]}', POST], {
      max_per_day: 1,
      min_gap_mins: 0,
    });
    r.sink.fail = new Error("403");
    await round(r);
    r.sink.fail = null;
    expect(await round(r)).toBe(true);
    expect(r.sink.sent.length).toBe(1);
  });

  it("limits are checked again right before sending", async () => {
    const r = rig(['{"picks":["p1"]}', POST], { quiet_hours: "13:00-14:00" });
    r.feed.onFeed = () => {
      r.clock.now = NOON + HOUR + 1;
    };
    await round(r);
    expect(r.sink.sent).toEqual([]);
  });

  it("a decision for a channel now closed is not sent", async () => {
    const r = rig(['{"picks":["p1"]}', POST]);
    const model = r.deps.model;
    r.deps.model = {
      complete: async (purpose, request, abort) => {
        const reply = await model.complete(purpose, request, abort);
        if (reply.text === POST) r.decided.open = false;
        return reply;
      },
    };
    await round(r);
    expect(r.sink.sent).toEqual([]);
  });

  it("only one round at a time", async () => {
    const r = rig(['{"picks":[]}']);
    expect(r.sharer.start(signal)).toBe(true);
    expect(r.sharer.available(NOON)).toBe(false);
    expect(r.sharer.start(signal)).toBe(false);
    await r.sharer.idle();
    expect(r.feed.log.filter((l) => l.startsWith("feed")).length).toBe(1);
  });

  it("does not start when the extension is not running", () => {
    const r = rig([]);
    r.feed.ready = false;
    expect(r.sharer.available(NOON)).toBe(false);
    expect(r.sharer.start(signal)).toBe(false);
  });

  it("the extension going away mid round ends it quietly", async () => {
    const r = rig([]);
    r.feed.result = new Error("tool `internal_threads_feed` is not registered");
    expect(await round(r)).toBe(true);
    expect(r.feed.log).toEqual(["feed 10", "close"]);
    expect(readdirSync(r.dir)).toEqual([]);
  });

  it("model failure ends the round and uses it up", async () => {
    const r = rig([new Error("down")], { browse_per_day: 1 });
    await round(r);
    expect(r.model.calls).toBe(1);
    expect(r.sharer.available(NOON)).toBe(false);
  });

  it("stops before sending when aborted", async () => {
    const r = rig(['{"picks":["p1"]}', POST]);
    const stop = new AbortController();
    r.feed.onFeed = () => stop.abort();
    r.sharer.start(stop.signal);
    await r.sharer.idle();
    expect(r.sink.sent).toEqual([]);
    expect(r.feed.log).toContain("close");
  });
});

describe("when something is wrong with Threads", () => {
  it("login lost pauses and tells each owner once", async () => {
    const r = rig([]);
    r.feed.result = { logged_in: false, posts: [] };
    await round(r);
    expect(r.sink.dms.length).toBe(2);
    expect(r.sharer.available(NOON)).toBe(false);
    expect(await round(r)).toBe(false);
    expect(r.sink.dms.length).toBe(2);
  });

  it("three empty rounds pause and tell the owners", async () => {
    const r = rig([]);
    r.feed.result = { logged_in: true, posts: [] };
    await round(r);
    await round(r);
    expect(r.sink.dms).toEqual([]);
    await round(r);
    expect(r.sink.dms.length).toBe(2);
    expect(r.model.calls).toBe(0);
    expect(r.sharer.available(NOON)).toBe(false);
  });

  it("probe resumes when logged in, spends no tokens", async () => {
    const r = rig([]);
    r.feed.result = { logged_in: false, posts: [] };
    await round(r);
    await r.sharer.probe();
    expect(r.sharer.available(NOON)).toBe(false);
    r.feed.result = { logged_in: true, posts: [post(1)] };
    await r.sharer.probe();
    expect(r.sharer.available(NOON)).toBe(true);
    expect(r.model.calls).toBe(0);
    expect(r.feed.log.at(-1)).toBe("close");
  });

  it("probe does nothing unless paused", async () => {
    const r = rig([]);
    await r.sharer.probe();
    expect(r.feed.log).toEqual([]);
  });
});

describe("when = active", () => {
  it("active keeps candidates until a channel is lively", async () => {
    const r = rig(['{"picks":["p1"]}', POST], { when: "active" });
    await round(r);
    expect(r.feed.log).toEqual(["feed 10", "capture /@u/post/1", "close"]);
    expect(r.model.calls).toBe(1);
    expect(readdirSync(r.dir).length).toBe(1);
    await r.sharer.flush(signal);
    expect(r.model.calls).toBe(1);
    r.decided.lively = [here];
    await r.sharer.flush(signal);
    expect(r.model.calls).toBe(2);
    expect(r.sink.sent.length).toBe(1);
    expect(readdirSync(r.dir)).toEqual([]);
  });

  it("a failing memory lookup does not escape flush", async () => {
    const warned: string[] = [];
    const r = rig(['{"picks":["p1"]}'], { when: "active" });
    r.deps.warn = (message) => warned.push(message);
    await round(r);
    r.decided.lively = [here];
    r.deps.match.recall = async () => {
      throw new Error("db down");
    };
    await expect(r.sharer.flush(signal)).resolves.toBeUndefined();
    expect(warned.length).toBe(1);
  });

  it("does not scroll while a candidate waits", async () => {
    const r = rig(['{"picks":["p1"]}'], { when: "active" });
    await round(r);
    expect(r.sharer.available(NOON)).toBe(false);
  });

  it("active drops candidates after keep_hours", async () => {
    const r = rig(['{"picks":["p1"]}'], { when: "active", keep_hours: 24 });
    await round(r);
    r.clock.now = NOON + 25 * HOUR;
    r.decided.lively = [here];
    await r.sharer.flush(signal);
    expect(r.model.calls).toBe(1);
    expect(readdirSync(r.dir)).toEqual([]);
    expect(r.sharer.available(r.clock.now)).toBe(true);
  });

  it("a skip drops the candidates, so one post costs one decision", async () => {
    const r = rig(['{"picks":["p1"]}', '{"action":"skip"}'], { when: "active" });
    await round(r);
    r.decided.lively = [here];
    await r.sharer.flush(signal);
    await r.sharer.flush(signal);
    expect(r.model.calls).toBe(2);
    expect(readdirSync(r.dir)).toEqual([]);
  });
});

describe("restarts", () => {
  it("state survives a restart", async () => {
    const r = rig(['{"picks":["p1"]}', POST], { max_per_day: 1 });
    await round(r);
    const config = ShareConfigSchema.parse({ quiet_hours: "", max_per_day: 1, min_gap_mins: 0 });
    const again = new Sharer(config, r.deps, r.dir);
    await again.restore();
    expect(again.available(NOON)).toBe(false);
  });

  it("a waiting candidate survives a restart, leftover files do not", async () => {
    const r = rig(['{"picks":["p1"]}'], { when: "active" });
    await round(r);
    const kept = readdirSync(r.dir);
    writeFileSync(join(r.dir, "old.jpg"), "x");
    const config = ShareConfigSchema.parse({ quiet_hours: "", when: "active" });
    const again = new Sharer(config, r.deps, r.dir);
    await again.restore();
    expect(readdirSync(r.dir)).toEqual(kept);
    expect(again.available(NOON)).toBe(false);
  });

  it("unreadable state starts fresh", async () => {
    const r = rig([]);
    r.saved.value = { nonsense: true };
    await r.sharer.restore();
    expect(r.sharer.available(NOON)).toBe(true);
  });
});

describe("ThreadsFeed", () => {
  const ctx = {} as never;
  function tools(calls: string[], result: string | Error): () => ToolRegistry {
    return () =>
      ({
        get: (name: string) => ({
          call: async (_ctx: unknown, args: unknown) => {
            calls.push(`${name} ${JSON.stringify(args)}`);
            if (result instanceof Error) throw result;
            return result;
          },
        }),
      }) as unknown as ToolRegistry;
  }

  let calls: string[];
  beforeEach(() => {
    calls = [];
  });

  it("is not ready without the tools", () => {
    const empty = { get: () => undefined } as unknown as ToolRegistry;
    expect(new ThreadsFeed(() => empty, ctx).ready).toBe(false);
    expect(new ThreadsFeed(() => undefined, ctx).ready).toBe(false);
  });

  it("parses what the extension reports", async () => {
    const reply = JSON.stringify({ logged_in: true, posts: [post(1)] });
    const feed = new ThreadsFeed(tools(calls, reply), ctx);
    expect(feed.ready).toBe(true);
    expect((await feed.feed(5)).posts).toEqual([post(1)]);
    expect(calls).toEqual(['internal_threads_feed {"limit":5}']);
  });

  it("refuses a reply it cannot read", async () => {
    await expect(new ThreadsFeed(tools(calls, "nope"), ctx).feed(5)).rejects.toThrow();
  });

  it("close never throws", async () => {
    await new ThreadsFeed(tools(calls, new Error("gone")), ctx).close();
    await new ThreadsFeed(() => undefined, ctx).close();
    expect(calls).toEqual(["internal_threads_close {}"]);
  });
});
