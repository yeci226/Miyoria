import { describe, expect, it, vi } from "vitest";
import { envelope } from "@/test/envelope";
import { TestStream } from "@/test/push-stream";
import { ApiClient } from "./http";
import { createRpc } from "./orpc";
import { backoff, type StreamStatus, streamEvents } from "./sse";

const env = (id: string) =>
  envelope("agent.turn.started", { turn: "T", context: { platform: "discord", scope: null, channel: "1", kind: "dm" } }, { id });

describe("backoff", () => {
  it("grows exponentially and is capped", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(backoff(1)).toBe(1000);
    expect(backoff(3)).toBe(4000);
    expect(backoff(20, 30_000)).toBe(30_000);
  });
});

function streamResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("streamEvents", () => {
  it("streams envelopes with auth and topics, then reconnects with Last-Event-ID", async () => {
    const ctl = new AbortController();
    const received: string[] = [];
    const statuses: StreamStatus["state"][] = [];
    const a = JSON.stringify(env("A"));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse([`:\n\nevent: message\nid: A\ndata: ${a.slice(0, 10)}`, `${a.slice(10)}\n\n`, "data: 5\n\n"]),
      )
      .mockImplementationOnce(async () => {
        ctl.abort();
        return streamResponse([]);
      });
    vi.stubGlobal("fetch", fetch);

    await streamEvents(createRpc(new ApiClient({ baseUrl: "http://core", token: "tok" })), {
      topics: ["agent.*", "voice.*"],
      signal: ctl.signal,
      onEnvelope: (e) => received.push(e.id),
      onStatus: (s) => statuses.push(s.state),
      maxDelayMs: 1,
    });

    expect(received).toEqual(["A"]);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://core/api/events?topics=agent.*%2Cvoice.*");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    // Session cookies and the CSRF header go along too.
    expect(headers["X-Miyoria-Request"]).toBe("1");
    expect(init.credentials).toBe("same-origin");
    const second = fetch.mock.calls[1]?.[1] as RequestInit;
    expect((second.headers as Record<string, string>)["Last-Event-ID"]).toBe("A");
    expect(statuses).toContain("open");
    expect(statuses).toContain("retrying");
    expect(statuses.at(-1)).toBe("closed");
  });

  /** The waits between connections, until `count` of them were asked for. */
  async function retryDelays(responses: () => Response, count: number): Promise<number[]> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const ctl = new AbortController();
      const delays: number[] = [];
      vi.stubGlobal("fetch", vi.fn(async () => responses()));
      const done = streamEvents(createRpc(new ApiClient({ baseUrl: "http://core", token: "tok" })), {
        signal: ctl.signal,
        onEnvelope: () => {},
        onStatus: (s) => {
          if (s.state !== "retrying") return;
          delays.push(s.inMs);
          if (delays.length === count) ctl.abort();
        },
      });
      let finished = false;
      void done.then(() => {
        finished = true;
      });
      for (let i = 0; i < 40 && !finished; i++) await vi.advanceTimersByTimeAsync(5_000);
      await done;
      return delays;
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  }

  it("backs off further each time a stream is closed as soon as it opens", async () => {
    expect(await retryDelays(() => streamResponse([]), 4)).toEqual([1000, 2000, 4000, 8000]);
  });

  it("starts the backoff over after a stream that stayed open", async () => {
    let calls = 0;
    const delays = await retryDelays(() => {
      calls += 1;
      if (calls !== 3) return streamResponse([]);
      // The third one stays open for a while before it is closed.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          setTimeout(() => c.close(), 10_000);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }, 4);
    // Back at the first wait, for the one after it and for the next connection's own.
    expect(delays).toEqual([1000, 2000, 1000, 1000]);
  });

  it("stops for good on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"error":"missing or invalid bearer token"}', { status: 401 })),
    );
    const statuses: StreamStatus[] = [];
    await streamEvents(createRpc(new ApiClient({ baseUrl: "", token: "x" })), {
      signal: new AbortController().signal,
      onEnvelope: () => {},
      onStatus: (s) => statuses.push(s),
    });
    const last = statuses.at(-1);
    expect(last?.state).toBe("closed");
    expect(last && "error" in last ? last.error : "").toContain("登入已失效");
  });
});

describe("the admin stream's watchdog", () => {
  /** Follows the stream with fake timers; each call of fetch takes the next stream. */
  function follow(streams: TestStream[]) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const ctl = new AbortController();
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      const next = streams.shift() ?? new TestStream();
      next.follow(init?.signal);
      return next.response;
    });
    vi.stubGlobal("fetch", fetch);
    const statuses: StreamStatus[] = [];
    const done = streamEvents(createRpc(new ApiClient({ baseUrl: "http://core", token: "tok" })), {
      signal: ctl.signal,
      onEnvelope: () => {},
      onStatus: (s) => statuses.push(s),
    });
    const stop = async () => {
      ctl.abort();
      await vi.advanceTimersByTimeAsync(0);
      await done;
      vi.useRealTimers();
      vi.restoreAllMocks();
    };
    return { fetch, statuses, stop };
  }

  it("reconnects a stream that went silent without closing, with the usual backoff", async () => {
    const first = new TestStream();
    const { fetch, statuses, stop } = follow([first]);
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.state).toBe("open");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    const retrying = statuses.find((s) => s.state === "retrying");
    expect(retrying).toMatchObject({ error: "串流沒有回應", inMs: 1000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await stop();
  });

  it("keeps a quiet stream whose 15 s comments arrive (no new kind of event on it)", async () => {
    const first = new TestStream();
    const { fetch, statuses, stop } = follow([first]);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      first.comment();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(statuses.some((s) => s.state === "retrying")).toBe(false);
    await stop();
  });

  it("reconnects once, at once, after the page slept", async () => {
    const first = new TestStream();
    const second = new TestStream();
    const { fetch, statuses, stop } = follow([first, second]);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(statuses.filter((s) => s.state === "retrying")).toEqual([
      { state: "retrying", attempt: 1, inMs: 0, error: "重新連線" },
    ]);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      second.comment();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    await stop();
  });
});
