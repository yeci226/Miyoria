import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VoiceE2eLatency, VoiceState, WorldView } from "@/api/types";
import { VoiceCard } from "@/pages/live/VoiceCard";
import { mockFetch, renderPage } from "@/test/render";
import { VoiceLatency } from "./voice-latency";

const stat = (p50: number | null, p90: number | null, samples = 12) => ({ p50_ms: p50, p90_ms: p90, samples });

const E2E: VoiceE2eLatency = {
  total: stat(4800, 7100),
  segments: {
    endpoint: stat(600, 900),
    asr: stat(1364, 2000),
    llm_first: stat(1900, 3000),
    tts_queue: stat(300, 700),
    tts_first: stat(520, 800),
    playback: stat(116, 200),
  },
  complete: 12,
  incomplete: 3,
  incomplete_by_reason: { barge_in: 2, cancelled: 1 },
};

const CTX = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" } as const;

describe("語音回應", () => {
  it("shows the median, the slowest 10% and the six segments in the order she says them", async () => {
    renderPage(<VoiceLatency e2e={E2E} />);
    const facts = await screen.findByLabelText("語音回應延遲");
    expect(facts).toHaveTextContent("中位數4.80 s");
    expect(facts).toHaveTextContent("最慢 10%7.10 s");
    expect(facts).toHaveTextContent("量到12 次");
    const rows = within(screen.getByRole("list", { name: "各段中位數" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "判斷說完600 ms",
      "辨識1.36 s",
      "LLM 首字1.90 s",
      "TTS 排隊300 ms",
      "TTS 合成520 ms",
      "播放116 ms",
    ]);
    expect(screen.getByText("未完成 3 次:被打斷 2、取消 1")).toBeInTheDocument();
  });

  it("says when a Core does not measure it, and when nothing was measured yet", async () => {
    const { unmount } = renderPage(<VoiceLatency e2e={undefined} />);
    expect(await screen.findByText("這個 Core 還沒有提供語音回應延遲")).toBeInTheDocument();
    unmount();
    renderPage(
      <VoiceLatency
        e2e={{ ...E2E, total: stat(null, null, 0), complete: 0, incomplete: 0, incomplete_by_reason: {}, segments: { ...E2E.segments, asr: stat(null, null, 0) } }}
      />,
    );
    expect(await screen.findByText("還沒有量到語音回應")).toBeInTheDocument();
  });

  it("replaces the old ASR / first token / first audio figures in the voice card", async () => {
    mockFetch((_m, url) => {
      if (url.pathname === "/api/voice") {
        return {
          body: {
            sessions: [
              {
                context: CTX,
                label: "雜談",
                participants: [],
                speaking: [],
                joined_at: "2026-11-07T10:00:00.000Z",
                latency: {
                  asr: { p50_ms: 111, p95_ms: 222, samples: 3 },
                  llm_first_token: { p50_ms: 333, p95_ms: 444, samples: 3 },
                  tts_first_audio: { p50_ms: 555, p95_ms: 666, samples: 3 },
                  e2e: E2E,
                },
                last_turn: null,
              },
            ],
          } satisfies VoiceState,
        };
      }
      if (url.pathname === "/api/world") {
        return {
          body: {
            at: "2026-11-07T10:00:00.000Z",
            time: { local: "2026-11-07T18:00", weekday: 6, weekend: true, part_of_day: "傍晚", utc_offset_minutes: 480 },
            her: { voice: null, voice_name: null, golive: null, streaming: false, scene: null, game: null },
            people: [],
            voice_channels: [],
            channels: [],
          } satisfies WorldView,
        };
      }
      return undefined;
    });
    renderPage(<VoiceCard />);
    expect(await screen.findByLabelText("語音回應延遲")).toHaveTextContent("4.80 s");
    expect(screen.queryByText("TTS 首音")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("延遲中位數(毫秒)")).not.toBeInTheDocument();
    expect(screen.queryByText("111")).not.toBeInTheDocument();
  });
});
