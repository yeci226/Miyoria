import { describe, expect, it, vi } from "vitest";
import { envelope } from "@/test/envelope";
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
