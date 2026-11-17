// The overlay feed: every message round-trips through JSON and the union tells them apart.

import { describe, expect, it } from "vitest";
import { type OverlayMessage, OverlayMessageSchema } from "../src/index.js";

const messages: OverlayMessage[] = [
  { type: "subtitle", turn: "t1", text: "嗨", final: true },
  { type: "emotion", name: "joy", intensity: 0.5 },
  { type: "notice", text: "準備歌曲中…" },
  {
    type: "activity",
    kind: "singing",
    label: "唱歌中",
    detail: "Song",
    progress: 0.25,
    elapsed_ms: 5000,
    duration_ms: 200_000,
  },
  {
    type: "activity",
    kind: null,
    label: "",
    detail: null,
    progress: null,
    elapsed_ms: null,
    duration_ms: null,
  },
  { type: "gift", text: "Mia 送了 3 碗飯" },
  { type: "screen", kind: "message", name: "Mia", text: "hi", song: null },
  { type: "touch", x: 0.25, y: 0.75, part: "face" },
  { type: "speaking", state: "stopped" },
  { type: "levels", rms: 0.3, bands: [0.1, 0.2] },
  { type: "levels", rms: 0 },
  { type: "status", core: true, vts: true, obs: false, scene: null, streaming: false },
];

describe("OverlayMessage", () => {
  it.each(messages.map((m, i) => [`${i} ${m.type}`, m] as const))("%s round-trips", (_name, m) => {
    expect(OverlayMessageSchema.parse(JSON.parse(JSON.stringify(m)))).toStrictEqual(m);
  });

  it("covers every type of the union", () => {
    const tags = OverlayMessageSchema.options.map((o) => o.shape.type.value).sort();
    expect([...new Set(messages.map((m) => m.type))].sort()).toEqual(tags);
  });

  it("rejects a type it does not know, and `queue`, which nothing sends", () => {
    expect(OverlayMessageSchema.safeParse({ type: "queue", items: [] }).success).toBe(false);
    expect(OverlayMessageSchema.safeParse({ type: "dance" }).success).toBe(false);
  });
});
