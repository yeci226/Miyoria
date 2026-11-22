// What the summariser reads: the lines as a request shows them, people by her handles for them
// once those are known, so a summary names people the way the rest of her prompt does.
// The names are made up.

import type { SpeakerNames, TranscriptEntry } from "@miyoria/memory/transcript";
import { toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { summaryText } from "../src/summarise.js";

const said = (seq: number, author: string, id: string, content: string): TranscriptEntry => ({
  session: "s",
  seq,
  kind: "other",
  person_id: null,
  account: { platform: "discord", id },
  author,
  content,
  images: [],
  tool_calls: [],
  tool_call_id: null,
  reasoning: null,
  turn: null,
  message_id: `m${seq}`,
  reply_to: null,
  label: null,
  about_seq: null,
  addressed: false,
  bot: false,
  spoken: false,
  flagged: null,
  interrupted: false,
  heard: null,
  tokens: 1,
  at: toTimestamp(0),
  redacted_at: null,
});

describe("summaryText", () => {
  const lines = [said(1, "Model-9 Lumen", "1", "我欠的那半碗呢"), said(2, "Kiri", "2", "我也要")];

  it("names people by handle, with the name shown then once", () => {
    const names: SpeakerNames = (who) => (who.account?.id === "1" ? "Nobu" : "Kiri");
    expect(summaryText(lines, names)).toBe(
      "Nobu(顯示名「Model-9 Lumen」): 我欠的那半碗呢\nKiri: 我也要",
    );
  });

  it("keeps the names shown without handles", () => {
    expect(summaryText(lines)).toBe("Model-9 Lumen: 我欠的那半碗呢\nKiri: 我也要");
  });
});
