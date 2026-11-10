// Her picture: its config, what a touch lands on, MediaMTX's state, and touches as pats.

import { EventBus, ServiceRegistry, Supervisor } from "@miyoria/kernel";
import { PeopleStoreKey } from "@miyoria/store";
import type { JsonObject } from "@miyoria/types";
import {
  type Envelope,
  type EventLog,
  EventLogKey,
  type LiveEvent,
  type LiveFeed,
  LiveFeedKey,
  type LivePart,
  type LivePats,
  type LiveTouch,
  ModerationKey,
  SocialSignalsKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  classify,
  LiveConfigSchema,
  LiveModule,
  PatDesk,
  type PatObservation,
  type PatWho,
  VIDEO_SRC,
  VideoWatch,
} from "../src/index.js";

const parse = (video: Record<string, unknown>) => LiveConfigSchema.safeParse({ video });

describe("[modules.live.video]", () => {
  it("is off by default, with the rects of the contract", () => {
    const v = LiveConfigSchema.parse({}).video;
    expect(v.enabled).toBe(false);
    expect(v.hls).toBe("http://127.0.0.1:8888/live/miyoria/");
    expect(v.api).toBe("http://127.0.0.1:9997");
    expect(v.path).toBe("live/miyoria");
    expect(v.poll_ms).toBe(2000);
    expect(v.secret).toBe("");
    expect(v.face).toEqual([0.67, 0.22, 0.83, 0.4]);
  });

  it("wants http(s) URLs, and hls ending with a slash", () => {
    expect(parse({ hls: "ftp://x/" }).success).toBe(false);
    expect(parse({ hls: "not a url/" }).success).toBe(false);
    expect(parse({ hls: "http://127.0.0.1:8888/live/miyoria" }).success).toBe(false);
    expect(parse({ api: "file:///etc" }).success).toBe(false);
    expect(parse({ hls: "https://h/x/", api: "https://h:9997" }).success).toBe(true);
  });

  it("wants rects of four numbers in 0..1 with x0 < x1 and y0 < y1, or empty", () => {
    expect(parse({ head: [] }).success).toBe(true);
    expect(parse({ head: [0, 0, 1, 1] }).success).toBe(true);
    for (const bad of [
      [0.1, 0.1, 0.2],
      [0.5, 0.1, 0.5, 0.2],
      [0.1, 0.5, 0.2, 0.4],
      [0, 0, 1.1, 1],
      [-0.1, 0, 1, 1],
    ]) {
      expect(parse({ face: bad }).success).toBe(false);
    }
  });
});

describe("classify", () => {
  const rects = {
    head: [0.4, 0.1, 0.8, 0.4],
    face: [0.5, 0.2, 0.7, 0.4],
    body: [0.3, 0.35, 0.9, 1],
  };
  it("takes face, then head, then body, else the screen", () => {
    expect(classify({ x: 0.6, y: 0.3 }, rects)).toBe("face");
    expect(classify({ x: 0.45, y: 0.15 }, rects)).toBe("head");
    expect(classify({ x: 0.35, y: 0.9 }, rects)).toBe("body");
    expect(classify({ x: 0.05, y: 0.05 }, rects)).toBe("screen");
  });
  it("never picks a part with no rect", () => {
    expect(classify({ x: 0.6, y: 0.3 }, { ...rects, face: [] })).toBe("head");
    expect(classify({ x: 0.6, y: 0.3 }, { head: [], face: [], body: [] })).toBe("screen");
  });
});

describe("VideoWatch", () => {
  const config = { api: "http://mtx:9997/", path: "live/miyoria", poll_ms: 2000 };
  function rig(answers: Array<() => Response | Promise<Response>>) {
    const urls: string[] = [];
    const changes: boolean[] = [];
    const notes: string[] = [];
    let n = 0;
    const watch = new VideoWatch({
      config,
      fetch: (async (url: string) => {
        urls.push(url);
        const answer = answers[Math.min(n++, answers.length - 1)];
        return answer?.();
      }) as unknown as typeof fetch,
      changed: (v) => changes.push(v.on),
      note: (_, reason) => notes.push(reason),
    });
    return { watch, urls, changes, notes };
  }
  const ready = (value: boolean) => () => Response.json({ ready: value });
  const status = (code: number) => () => new Response("x", { status: code });
  const down = () => {
    throw new Error("ECONNREFUSED");
  };

  it("asks for the encoded path and says only what changes", async () => {
    const r = rig([ready(true), ready(true), status(404), status(404), ready(false), ready(true)]);
    for (let i = 0; i < 6; i++) await r.watch.poll();
    expect(r.urls[0]).toBe("http://mtx:9997/v3/paths/get/live%2Fmiyoria");
    expect(r.changes).toEqual([true, false, true]);
    expect(r.notes).toHaveLength(3);
  });

  it("is off for a 404, an error status, an unreachable API, and ready not true", async () => {
    const r = rig([ready(true), down, ready(true), status(500), ready(true), ready(false)]);
    await r.watch.poll();
    expect(r.watch.on).toBe(true);
    for (const expected of [false, true, false, true, false]) {
      await r.watch.poll();
      expect(r.watch.on).toBe(expected);
    }
    // a failing poll while off is not news
    const quiet = rig([down, down, status(404)]);
    for (let i = 0; i < 3; i++) await quiet.watch.poll();
    expect(quiet.changes).toEqual([]);
    expect(quiet.notes).toEqual([]);
  });

  it("a body that is not JSON counts as off", async () => {
    const r = rig([ready(true), () => new Response("<html>")]);
    await r.watch.poll();
    await r.watch.poll();
    expect(r.changes).toEqual([true, false]);
  });
});

const PEOPLE: Record<string, PatWho> = {
  "1": { kind: "known", person: "p-owen", handle: "Owen", name: "Owen Liu" },
  "3": { kind: "blocked" },
};

function deskRig(config: Record<string, unknown> = {}) {
  let clock = 1_800_000_000_000;
  const written: PatObservation[] = [];
  const changes: Array<{ pats: LivePats; patted: boolean; part?: LivePart }> = [];
  const touches: LiveTouch[] = [];
  const desk = new PatDesk({
    config: LiveConfigSchema.parse({
      pats: true,
      video: { head: [0.4, 0.1, 0.8, 0.4], face: [0.5, 0.2, 0.7, 0.4], body: [0.3, 0.35, 0.9, 1] },
      ...config,
    }),
    now: () => clock,
    who: async (by) => PEOPLE[by.account.id] ?? { kind: "stranger" },
    observe: (o) => written.push(o),
    changed: (pats, patted, touch) => changes.push({ pats, patted, part: touch?.part }),
    touched: (t) => touches.push(t),
  });
  const by = (id: string, spot?: { x: number; y: number }) => ({
    account: { platform: "discord", id } as const,
    name: `n${id}`,
    ...(spot ? { spot } : {}),
  });
  return {
    desk,
    written,
    changes,
    touches,
    by,
    close() {
      clock += 21_000;
      desk.tick();
    },
  };
}

describe("pats with a spot", () => {
  it("are told with their part, and without a spot are the head", async () => {
    const r = deskRig();
    await r.desk.pat(r.by("1", { x: 0.6, y: 0.3 }));
    await r.desk.pat(r.by("1"));
    expect(r.changes.map((c) => c.part)).toEqual(["face", undefined]);
    expect(r.touches).toEqual([{ x: 0.6, y: 0.3, part: "face" }]);
  });

  it("say what kinds of touches a batch had, and keep the old words for only head-pats", async () => {
    const r = deskRig();
    await r.desk.pat(r.by("1", { x: 0.45, y: 0.15 }));
    await r.desk.pat(r.by("1", { x: 0.6, y: 0.3 }));
    await r.desk.pat(r.by("1", { x: 0.6, y: 0.3 }));
    await r.desk.pat(r.by("1", { x: 0.35, y: 0.9 }));
    await r.desk.pat(r.by("9", { x: 0.01, y: 0.01 }));
    r.close();
    expect(r.written).toHaveLength(1);
    const summary = r.written[0]?.observation.summary ?? "";
    expect(summary).toContain("一共 5 下");
    expect(summary).toContain("摸頭 1 下、戳臉 2 下、碰身體 1 下、點畫面 1 下");
    expect(summary).toContain("Owen(4 下)");
    expect(summary).toContain("1 個你不認識的人");

    await r.desk.pat(r.by("1"));
    await r.desk.pat(r.by("1", { x: 0.45, y: 0.15 }));
    r.close();
    expect(r.written[1]?.observation.summary).toBe(
      "網頁現場有人摸了摸你的頭,一共 2 下:Owen(2 下)。",
    );
  });

  it("publish no touch for the blocked, the closed, or the limited", async () => {
    const r = deskRig({ per_person_per_minute: 1 });
    await r.desk.pat(r.by("3", { x: 0.5, y: 0.5 }));
    expect(r.touches).toEqual([]);
    expect(r.changes).toHaveLength(1); // accepted the same way, goes nowhere
    await r.desk.pat(r.by("1", { x: 0.5, y: 0.5 }));
    expect((await r.desk.pat(r.by("1", { x: 0.5, y: 0.5 }))).status).toBe("too_many");
    expect(r.touches).toHaveLength(1);
    const closed = deskRig({ pats: false });
    expect((await closed.desk.pat(closed.by("1", { x: 0.5, y: 0.5 }))).status).toBe("closed");
    expect(closed.touches).toEqual([]);
  });
});

describe("module live with video", () => {
  let sup: Supervisor | null = null;
  afterEach(async () => {
    await sup?.stopAll();
    sup = null;
  });

  async function boot(config: JsonObject, fetcher: typeof fetch) {
    const services = new ServiceRegistry();
    const log = {
      observe: () => ({}) as never,
      append: () => ({}) as never,
    } as unknown as EventLog;
    services.provide("facts", EventLogKey, log);
    services.provide("moderation", ModerationKey, {
      screen: () => ({ ok: true, visible: null, voice: null, blocked: [] }),
    } as never);
    services.provide("social", SocialSignalsKey, { attitude: () => null });
    services.provide("store", PeopleStoreKey, {
      personByAccount: async () => null,
      all: async () => [],
    } as never);
    const bus = new EventBus();
    const published: Envelope[] = [];
    const all = bus.subscribe("*");
    void (async () => {
      for await (const env of all) published.push(env);
    })();
    sup = new Supervisor({ bus, services });
    await sup.register(new LiveModule({ names: ["Miyoria"], fetch: fetcher }), config, true);
    await sup.startAll();
    return { feed: services.get(LiveFeedKey) as LiveFeed, published };
  }

  const video = (extra: Record<string, unknown> = {}) => ({
    video: { enabled: true, secret: "s", poll_ms: 500, ...extra },
  });

  it("follows MediaMTX into the snapshot and a video event, and offers the upstream", async () => {
    let ready = false;
    const fetcher = (async () => Response.json({ ready })) as unknown as typeof fetch;
    const { feed } = await boot(video(), fetcher);
    const seen: LiveEvent[] = [];
    feed.follow((e) => seen.push(e));
    expect(feed.snapshot().video).toEqual({ on: false, src: null });
    expect(feed.video()).toEqual({
      on: false,
      upstream: "http://127.0.0.1:8888/live/miyoria/",
      secret: "s",
      max_viewers: 500,
    });
    ready = true;
    await expect.poll(() => feed.snapshot().video.on, { timeout: 4_000 }).toBe(true);
    expect(feed.snapshot().video.src).toBe(VIDEO_SRC);
    expect(feed.video()?.on).toBe(true);
    expect(seen.filter((e) => e.type === "video")).toEqual([
      { type: "video", video: { on: true, src: VIDEO_SRC } },
    ]);
  });

  it("stays off, and polls nothing, when disabled or without a secret", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return Response.json({ ready: true });
    }) as unknown as typeof fetch;
    for (const config of [{}, video({ enabled: false }), video({ secret: "" })]) {
      const { feed } = await boot(config, fetcher);
      await new Promise((r) => setTimeout(r, 700));
      expect(feed.video()).toBeNull();
      expect(feed.snapshot().video).toEqual({ on: false, src: null });
      await sup?.stopAll();
    }
    expect(calls).toBe(0);
  });

  it("publishes live.touch for an accepted pat with a spot, and carries it in the pat event", async () => {
    const fetcher = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const { feed, published } = await boot({ pats: true, ...video() }, fetcher);
    const seen: LiveEvent[] = [];
    feed.follow((e) => seen.push(e));
    const account = { platform: "discord", id: "1" } as const;
    await feed.pat({ account, name: "x" });
    await feed.pat({ account, name: "x", spot: { x: 0.7, y: 0.3 } });
    const touches = () =>
      published.filter((e) => e.event.type === "custom" && e.event.data.topic === "live.touch");
    await expect.poll(() => touches().length).toBe(1);
    const event = touches()[0]?.event;
    expect(event?.type === "custom" && event.data.payload).toEqual({
      x: 0.7,
      y: 0.3,
      part: "face",
    });
    expect(touches()[0]?.source).toBe("live");
    const pats = seen.filter((e) => e.type === "pat");
    expect(pats[0]).not.toHaveProperty("spot");
    expect(pats[1]).toMatchObject({ spot: { x: 0.7, y: 0.3 }, part: "face" });
  });
});
