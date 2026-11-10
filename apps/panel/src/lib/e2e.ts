// Voice response latency as `latency.e2e` of `GET /api/voice` and the `voice.latency` bus events
// (stage `e2e`) report it: speech end to first audio, in six consecutive segments.

import type { E2eRecord, E2eSegmentName, LogEvent } from "@/api/types";

/** In the order a listener hears them. */
export const E2E_SEGMENTS: { name: E2eSegmentName; label: string }[] = [
  { name: "endpoint", label: "判斷說完" },
  { name: "asr", label: "辨識" },
  { name: "prepare", label: "準備" },
  { name: "llm_first", label: "LLM 首字" },
  { name: "tts_queue", label: "TTS 排隊" },
  { name: "tts_first", label: "TTS 合成" },
  { name: "playback", label: "播放" },
];

/** Why a measurement did not complete. */
export const E2E_REASON_LABEL: Record<string, string> = {
  barge_in: "被打斷",
  interrupted: "被中斷",
  cancelled: "取消",
  floor: "場地被佔用",
  tts_failed: "TTS 失敗",
  playback_failed: "播放失敗",
  speech_end_unknown: "沒量到說完",
  expired: "過期",
  unknown: "不明",
};

/** `640 ms` below a second, `2.14 s` above. */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s.toFixed(s < 10 ? 2 : 1)} s`;
}

/** A `voice.latency` payload as one reply's measurement; `null` for other stages or shapes. */
export function asE2eRecord(payload: unknown): E2eRecord | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.stage !== "e2e" || typeof p.turn !== "string" || p.segments === null || typeof p.segments !== "object") return null;
  return p as unknown as E2eRecord;
}

/** The measurement a `voice.latency` line of the EventLog keeps (`body.e2e`); `null` for any other line. */
export function asE2eEvent(event: LogEvent): E2eRecord | null {
  if (event.kind !== "result" || event.source !== "voice.latency") return null;
  const body = event.body;
  if (body === null || typeof body !== "object") return null;
  const e2e = (body as Record<string, unknown>).e2e;
  if (e2e === null || typeof e2e !== "object") return null;
  return asE2eRecord({ stage: "e2e", turn: (body as Record<string, unknown>).turn, ...e2e });
}
