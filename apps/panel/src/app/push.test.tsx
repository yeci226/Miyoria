// Server push on the page side (app/push.tsx, v5-architecture §11.4): values into the query cache
// and no polling once a stream is ready; polling again (and a fresh fetch) whenever the stream is
// not there; backoff, `Last-Event-ID` and recovery; and on each converted page, a pushed value
// changing what is drawn. The admin live page is kept fresh by the admin event stream instead.

import type { PushEvent } from "@miyoria/contracts/api";
import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "@/api/http";
import { createRpc } from "@/api/orpc";
import { DanmakuForm } from "@/pages/public/live/DanmakuForm";
import { RoomsEntry } from "@/pages/public/karaoke/RoomsEntry";
import Landing from "@/pages/public/landing/Landing";
import { QueueCard } from "@/pages/live/QueueCard";
import { envelope } from "@/test/envelope";
import { TestStream } from "@/test/push-stream";
import { renderPage, writer } from "@/test/render";
import { EventStore, EventStoreContext, EventStreamProvider, LIVE_SAFETY_MS, useLivePoll } from "./events-store";
import { PushClient, PushProvider } from "./push";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const Stream = TestStream;
type Answer = TestStream | { status: number; body?: unknown };

/**
 * `fetch` for the tests: each call of a stream route takes the next answer of `streams` (a stream,
 * or a status); everything else goes to `json`, or is the Core's 404.
 */
function stubFetch(streams: Answer[], json: (path: string, url: URL) => unknown = () => undefined) {
  const fn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input), "http://panel.test");
    if (url.pathname.endsWith("/stream") || url.pathname === "/api/events") {
      const next = streams.shift();
      if (next === undefined) return new Response(JSON.stringify({ error: "no such endpoint" }), { status: 404, headers: { "content-type": "application/json" } });
      if (next instanceof Stream) {
        next.follow(_init?.signal);
        return next.response;
      }
      return new Response(JSON.stringify(next.body ?? { error: "not now" }), { status: next.status, headers: { "content-type": "application/json" } });
    }
    const body = json(url.pathname, url);
    if (body === undefined) return new Response(JSON.stringify({ error: "no such endpoint" }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const streamCalls = (fn: ReturnType<typeof stubFetch>) =>
  fn.mock.calls
    .map(([input, init]) => ({ url: new URL(String(input), "http://panel.test"), init: init as RequestInit }))
    .filter((c) => c.url.pathname.endsWith("/stream"));

const KEY = ["member", "danmaku"] as const;
const value = (topic: string, data: unknown, param: string | null = null) => ({ kind: "value", topic, param, data });
const READY: PushEvent = { kind: "ready" };

function client(audience: "public" | "member" = "member") {
  const queryClient = new QueryClient();
  const push = new PushClient({
    rpc: createRpc(new ApiClient({ baseUrl: "", token: "" })),
    queryClient,
    audience,
    delay: () => 5,
  });
  return { push, queryClient };
}

describe("the push client", () => {
  it("writes each value where the polled answer goes, and takes the topic once ready", async () => {
    const stream = new Stream();
    const fn = stubFetch([stream]);
    const { push, queryClient } = client();
    push.start();
    push.want("danmaku", null, KEY);
    await waitFor(() => expect(streamCalls(fn)).toHaveLength(1));
    const call = streamCalls(fn)[0];
    expect(call?.url.pathname).toBe("/api/member/stream");
    expect(call?.url.searchParams.get("topics")).toBe("danmaku");
    // The member stream goes with the session cookie, never the token.
    expect(call?.init.credentials).toBe("same-origin");
    expect((call?.init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();

    stream.send(value("danmaku", { open: true, why: null }));
    await waitFor(() => expect(queryClient.getQueryData(KEY)).toEqual({ open: true, why: null }));
    expect(push.isLive("danmaku")).toBe(false);
    stream.send(READY, "r.3.h");
    await waitFor(() => expect(push.isLive("danmaku")).toBe(true));
    push.stop();
  });

  it("polls again at once when the stream breaks, and resumes with Last-Event-ID", async () => {
    const first = new Stream();
    const second = new Stream();
    const fn = stubFetch([first, second]);
    const { push, queryClient } = client();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    push.start();
    push.want("danmaku", null, KEY);
    await waitFor(() => expect(streamCalls(fn)).toHaveLength(1));
    first.send(value("danmaku", { n: 1 }));
    first.send(READY, "r.3.h");
    await waitFor(() => expect(push.isLive("danmaku")).toBe(true));

    first.end();
    await waitFor(() => expect(push.isLive("danmaku")).toBe(false));
    // Its value may be old now: fetched again, then polled until the stream is back.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY, exact: true });
    await waitFor(() => expect(streamCalls(fn)).toHaveLength(2));
    const headers = streamCalls(fn)[1]?.init.headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe("r.3.h");
    second.send(READY, "r.3.h");
    await waitFor(() => expect(push.isLive("danmaku")).toBe(true));
    push.stop();
  });

  it("keeps polling while the stream cannot connect, and takes over once it can", async () => {
    const stream = new Stream();
    const fn = stubFetch([{ status: 503 }, { status: 502 }, { status: 500 }, stream]);
    const { push } = client("public");
    push.start();
    push.want("status", null, ["public", "status"]);
    await waitFor(() => expect(streamCalls(fn)).toHaveLength(4));
    expect(push.isLive("status")).toBe(false);
    expect(streamCalls(fn)[0]?.url.pathname).toBe("/api/public/stream");
    stream.send(value("status", { state: "idle" }));
    stream.send(READY, "r.1.h");
    await waitFor(() => expect(push.isLive("status")).toBe(true));
    push.stop();
  });

  it("waits long before asking an older Core again (no such route)", async () => {
    const fn = stubFetch([]);
    const { push } = client("public");
    push.start();
    push.want("status", null, ["public", "status"]);
    await waitFor(() => expect(push.state).toBe("waiting"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(streamCalls(fn)).toHaveLength(1);
    expect(push.isLive("status")).toBe(false);
    push.stop();
  });

  it("leaves a refused topic polling and takes the others", async () => {
    const stream = new Stream();
    stubFetch([stream]);
    const { push } = client();
    push.start();
    push.want("rooms", "spaceB", ["member", "karaoke", "rooms", "spaceB"]);
    push.want("status", null, ["public", "status"]);
    await waitFor(() => expect(push.state).toBe("open"));
    stream.send({ kind: "refused", topic: "rooms", param: "spaceB", status: 403, message: "你不在這個伺服器裡" });
    stream.send(value("status", { state: "idle" }));
    stream.send(READY, "r.1.h");
    await waitFor(() => expect(push.isLive("status")).toBe(true));
    expect(push.isLive("rooms~spaceB")).toBe(false);
    push.stop();
  });

  it("opens one stream for what the page wants, again when that changes, and none for nothing", async () => {
    const one = new Stream();
    const two = new Stream();
    const fn = stubFetch([one, two]);
    const { push } = client();
    push.start();
    const status = push.want("status", null, ["public", "status"]);
    push.want("songs", null, ["public", "songs"]);
    await waitFor(() => expect(streamCalls(fn)).toHaveLength(1));
    expect(streamCalls(fn)[0]?.url.searchParams.get("topics")).toBe("songs,status");
    one.send(READY, "r.1.h");
    await waitFor(() => expect(push.isLive("status")).toBe(true));
    status();
    await waitFor(() => expect(streamCalls(fn)).toHaveLength(2));
    const second = streamCalls(fn)[1];
    expect(second?.url.searchParams.get("topics")).toBe("songs");
    // Other topics: every value again, no resume.
    expect((second?.init.headers as Record<string, string> | undefined)?.["Last-Event-ID"]).toBeUndefined();
    push.stop();
    expect(push.state).toBe("idle");
  });
});

describe("a stream that goes silent", () => {
  const FAKE = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] } as const;
  const ping = { kind: "ping" };

  async function live() {
    vi.useFakeTimers({ ...FAKE, toFake: [...FAKE.toFake] });
    const first = new Stream();
    const second = new Stream();
    const fn = stubFetch([first, second]);
    const { push, queryClient } = client();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    push.start();
    push.want("danmaku", null, KEY);
    await vi.advanceTimersByTimeAsync(60);
    expect(streamCalls(fn)).toHaveLength(1);
    first.send(value("danmaku", { n: 1 }));
    first.send(READY, "r.1.h");
    await vi.advanceTimersByTimeAsync(0);
    expect(push.isLive("danmaku")).toBe(true);
    return { first, second, fn, push, invalidate };
  }

  it("polls again within the watchdog's window and recovers on a new connection", async () => {
    const { second, fn, push, invalidate } = await live();
    // Not a byte more, and the socket never closes.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(push.isLive("danmaku")).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(push.isLive("danmaku")).toBe(false);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY, exact: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(streamCalls(fn)).toHaveLength(2);
    second.send(READY, "r.1.h");
    await vi.advanceTimersByTimeAsync(0);
    expect(push.isLive("danmaku")).toBe(true);
    push.stop();
  });

  it("stays on a quiet stream that pings, without reconnecting", async () => {
    const { first, fn, push } = await live();
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      first.send(ping);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(streamCalls(fn)).toHaveLength(1);
    expect(push.isLive("danmaku")).toBe(true);
    push.stop();
  });

  it("reconnects once, at once, after the page slept", async () => {
    const { second, fn, push } = await live();
    // The laptop sleeps ten minutes: no timer runs, nothing arrives.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(streamCalls(fn)).toHaveLength(2);
    second.send(READY, "r.1.h");
    await vi.advanceTimersByTimeAsync(0);
    expect(push.isLive("danmaku")).toBe(true);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      second.send(ping);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(streamCalls(fn)).toHaveLength(2);
    push.stop();
  });

  it("does nothing when its timers were only held back and the pings kept coming", async () => {
    const { first, fn, push } = await live();
    // A background tab: the check runs two minutes late, but a ping has just arrived.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    first.send(ping);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(streamCalls(fn)).toHaveLength(1);
    expect(push.isLive("danmaku")).toBe(true);
    push.stop();
  });
});

// ---- the pages ----------------------------------------------------------------------------------

const DANMAKU_VIEW = {
  open: true,
  live: false,
  currency: "點數",
  price: 2,
  max_chars: 30,
  cooldown_s: 20,
  per_day: 10,
  sent_today: 0,
  wait_s: 0,
  balance: 9,
  why: "她現在沒在直播",
};

describe("pages under push", () => {
  it("the danmaku form opens as soon as she goes live", async () => {
    const stream = new Stream();
    stubFetch([stream], (path) => (path === "/api/member/danmaku" ? DANMAKU_VIEW : undefined));
    renderPage(
      <PushProvider audience="member">
        <DanmakuForm />
      </PushProvider>,
    );
    expect(await screen.findByText("她現在沒在直播")).toBeInTheDocument();
    stream.send(value("danmaku", DANMAKU_VIEW));
    stream.send(READY, "r.1.h");
    stream.send(value("danmaku", { ...DANMAKU_VIEW, live: true, why: null, sent_today: 3 }), "r.2.h");
    await waitFor(() => expect(screen.queryByText("她現在沒在直播")).toBeNull());
    expect(screen.getByText(/今天 3\/10/)).toBeInTheDocument();
  });

  it("the karaoke rooms' button follows her joining a voice channel", async () => {
    const stream = new Stream();
    const rooms = {
      available: false,
      reason: "她不在語音頻道",
      terms: { currency: "點數", price: 10, prize: 5, finish: 1, rounds: 3, max_singers: 4 },
      balance: 50,
      mine: null,
    };
    stubFetch([stream], (path) => (path === "/api/member/karaoke/rooms" ? rooms : undefined));
    renderPage(
      <PushProvider audience="member">
        <RoomsEntry onEnter={() => {}} />
      </PushProvider>,
    );
    const card = await screen.findByRole("region", { name: "一起唱" });
    await waitFor(() => expect(within(card).getByRole("button", { name: /開一間房/ })).toBeDisabled());
    stream.send(value("rooms", rooms));
    stream.send(READY, "r.1.h");
    stream.send(value("rooms", { ...rooms, available: true, reason: null }), "r.2.h");
    await waitFor(() => expect(within(card).getByRole("button", { name: /開一間房/ })).toBeEnabled());
  });

  it("the landing page's state and songs follow her", async () => {
    const stream = new Stream();
    const status = { state: "idle", live: false, in_voice: false, game: null, today: { songs_sung: 0, hours_live: 0, hours_in_voice: 0 }, days: [] };
    const songs = { playing: null, upcoming: [], recent: [] };
    stubFetch([stream], (path) =>
      path === "/api/public/status" ? status : path === "/api/public/songs" ? songs : path === "/api/public/landing" ? undefined : undefined,
    );
    renderPage(
      <PushProvider audience="public">
        <Landing discord={false} />
      </PushProvider>,
    );
    const board = await screen.findByRole("region", { name: "她現在" });
    expect(await within(board).findByText(/閒著/)).toBeInTheDocument();
    stream.send(value("status", status));
    stream.send(value("songs", songs));
    stream.send(READY, "r.1.h");
    stream.send(value("status", { ...status, state: "singing", in_voice: true }), "r.2.h");
    stream.send(value("songs", { ...songs, playing: { title: "Pushed Song", artist: null, duration_s: 200 } }), "r.3.h");
    expect(await within(board).findByText(/在唱歌/)).toBeInTheDocument();
    expect(await screen.findByText("Pushed Song")).toBeInTheDocument();
  });
});

/** What `useLivePoll(3 s)` said last. */
let seen = 0;
function Probe() {
  seen = useLivePoll(3_000);
  return null;
}

describe("the admin live page", () => {
  it("fetches the queue again when the event stream says it changed", async () => {
    const events = new Stream();
    let items: unknown[] = [];
    const fn = stubFetch([events], (path) => (path === "/api/queue" ? { paused: false, items } : undefined));
    renderPage(
      <EventStreamProvider>
        <QueueCard />
      </EventStreamProvider>,
      { session: writer },
    );
    const queueCalls = () => fn.mock.calls.filter(([u]) => String(u).startsWith("/api/queue")).length;
    // Once on mount, once more when the stream opened (a snapshot after the gap).
    await waitFor(() => expect(queueCalls()).toBe(2));
    items = [
      {
        id: 7,
        kind: "request",
        text: "pushed request",
        state: "pending",
        position: 1,
        author: { display_name: "Alice" },
        context: null,
        enqueued_at: "2026-11-22T00:00:00Z",
        priority: 0,
        votes: 0,
      },
    ];
    await act(async () => {
      events.send(envelope("queue.changed", { items: [], paused: false }), "E2");
    });
    expect(await screen.findByText("pushed request", {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(queueCalls()).toBe(3);
  });

  it("polls a live view slowly only while the event stream is open", () => {
    const store = new EventStore(0);
    seen = 0;
    render(
      <EventStoreContext.Provider value={store}>
        <Probe />
      </EventStoreContext.Provider>,
    );
    expect(seen).toBe(3_000);
    act(() => store.setStatus({ state: "open" }));
    expect(seen).toBe(LIVE_SAFETY_MS);
    act(() => store.setStatus({ state: "retrying", attempt: 1, inMs: 1000, error: "x" }));
    expect(seen).toBe(3_000);
  });
});
