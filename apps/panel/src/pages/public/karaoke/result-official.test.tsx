// A singer alone, just after singing, with the panel's own query client (its staleness, its
// refetching on focus): the number says 預估 until Core's official score is in, then the official
// number takes its place; a failed look on the way does not take it away. And the member page is
// not torn down when a later look at its overview fails (a song or a room's stage would go with it).

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KaraokeOverview, KaraokeResult } from "@miyoria/contracts/api";
import { ConnectionProvider } from "@/app/connection";
import { createQueryClient } from "@/app/query-client";
import { mockFetch, renderPage } from "@/test/render";
import { KaraokePage } from "./KaraokePage";
import { OVERVIEW, VOICE_POLL_MS } from "./queries";
import { Result } from "./Result";

const coreResult = (over: Partial<KaraokeResult>): KaraokeResult =>
  ({
    session: "S1",
    source: "estimate",
    voice: { state: "waiting", estimate_total: null, checks: [], upload: true },
    song: { id: "k1", title: "紙船", artist: null },
    at: "2026-11-18T01:00:00Z",
    total: 78.6,
    pitch: { score: 45.2, max: 60, hit: 0.8 },
    stability: { score: 11, max: 15, wobble_cents: 20, held: 3 },
    rhythm: { score: 12, max: 15, calibrated: true, measured: true, offset_ms: 10, spread_ms: 30, onsets: 9, found: 8, feel: "steady" },
    expression: { score: 7, max: 10, vibrato_s: 1, long_tones: 1, scoops: 0, falls: 0 },
    phrases: [],
    facts: { coverage: 0.93, best: null, weakest: null, octave: 0, offset_cents: null, sung_s: 20, reference_s: 22 },
    unranked: false,
    client_total: 78.4,
    latency_ms: 60,
    best_before: null,
    comment: { state: "none", text: null },
    ...over,
  }) as KaraokeResult;

function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => createQueryClient());
  return (
    <ConnectionProvider initial={{ baseUrl: "", token: "" }}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ConnectionProvider>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the official score replaces the estimate", () => {
  it("says 預估 while it is worked out, then shows the official number in its place", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const waiting = coreResult({});
    const scoring = coreResult({ voice: { state: "scoring", estimate_total: null, checks: [], upload: false } });
    const official = coreResult({ source: "voice", total: 82.1, voice: { state: "scored", estimate_total: 78.6, checks: [], upload: false } });
    let looks = 0;
    mockFetch((method, url) => {
      if (url.pathname === "/api/member/karaoke/sessions/S1/result" && method === "POST") return { body: waiting };
      if (url.pathname === "/api/member/karaoke/sessions/S1/voice") return { status: 202, body: { state: "scoring" } };
      if (url.pathname === "/api/member/karaoke/sessions/S1") {
        looks++;
        // One look fails on the way: what is shown stays.
        if (looks === 2) return { status: 502, body: { error: "bad gateway" } };
        return { body: looks < 3 ? scoring : official };
      }
      if (url.pathname === "/api/member/karaoke") return { status: 500, body: { error: "down" } };
      return undefined;
    });
    const pending = {
      session: "S1",
      song: { id: "k1", title: "紙船", artist: null },
      body: { track: "AAAA", latency_ms: 60, calibrated: true, client_total: 78.4, browser: "Chrome 131", recording: true },
      provisional: null,
      lines: [],
      voice: { blob: new Blob([new Uint8Array(8)]), type: "audio/webm", offset_ms: 0 },
    };
    render(
      <Providers>
        <Result session="S1" title="紙船" artist={null} pending={pending} onAgain={() => {}} onBack={() => {}} />
      </Providers>,
    );
    expect(await screen.findByLabelText("預估 78.6")).toBeInTheDocument();
    expect(await screen.findByText("正在算正式分數")).toBeInTheDocument();
    for (let i = 0; i < 4 && screen.queryByLabelText("正式分數 82.1") === null; i++) {
      await vi.advanceTimersByTimeAsync(VOICE_POLL_MS + 100);
    }
    expect(await screen.findByLabelText("正式分數 82.1")).toBeInTheDocument();
    expect(screen.queryByLabelText("預估 78.6")).toBeNull();
    // The earlier estimate stays small beside it.
    expect(screen.getByRole("region", { name: "分數" })).toHaveTextContent("預估78.6");
  });
});

describe("the member page and a failed look again", () => {
  it("keeps the page when the overview cannot be had again", async () => {
    const overview: KaraokeOverview = {
      open: true,
      admin: false,
      preparing: false,
      songs: [],
      limits: { daily: 10, used: 0, max_minutes: 8 },
      tolerance_cents: 50,
      comments: true,
      recent: [],
    };
    let down = false;
    let asked = 0;
    mockFetch((_m, url) => {
      if (url.pathname === "/api/member/karaoke") {
        asked++;
        return down ? { status: 429, body: { error: "too many" } } : { body: overview };
      }
      return undefined;
    });
    const { queryClient } = renderPage(<KaraokePage member={{ name: "小魚乾", avatar_url: null } as never} home="/" />);
    expect(await screen.findByRole("region", { name: "可以唱的歌" })).toBeInTheDocument();
    down = true;
    // Its retries wait a second and two: on a fake clock.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    void queryClient.invalidateQueries({ queryKey: OVERVIEW });
    for (let i = 0; i < 5 && queryClient.getQueryState(OVERVIEW)?.status !== "error"; i++) await vi.advanceTimersByTimeAsync(1_500);
    expect(asked).toBeGreaterThan(1);
    await waitFor(() => expect(queryClient.getQueryState(OVERVIEW)?.status).toBe("error"));
    expect(screen.getByRole("region", { name: "可以唱的歌" })).toBeInTheDocument();
  });
});
