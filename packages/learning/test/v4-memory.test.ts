// v4 §5.6 and §5.7 on the learning side: the documents about people step aside for the person
// profiles when asked to, and a recap says how old it is.

import { MemorySettingsStore } from "@miyoria/store";
import type { PromptRequest } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  KnowledgeConfigSchema,
  KnowledgeStore,
  knowledgeConfig,
  peopleInPrompt,
  recapAgeNote,
  subjectsFor,
} from "../src/index.js";

const request: PromptRequest = {
  profile: "p",
  turn: "t1",
  context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
  participants: [
    { account: { platform: "discord", id: "1" }, display_name: "Owen", person: "p-owen" },
  ],
  speakers: [{ platform: "discord", id: "1" }],
  query: "Owen: 嗨",
  recent: [],
  voice: false,
  now: "2026-11-10T04:00:00.000Z",
};

describe("documents about people and the person profiles", () => {
  it("lists the people present by default and leaves them out when profiles carry them", () => {
    // Not set: it follows the presence of the profiles; a set value wins.
    expect(KnowledgeConfigSchema.parse({}).prompt_people).toBeNull();
    expect(KnowledgeConfigSchema.parse({ prompt_people: false }).prompt_people).toBe(false);
    expect(peopleInPrompt(null, false)).toBe(true);
    expect(peopleInPrompt(null, true)).toBe(false);
    expect(peopleInPrompt(true, true)).toBe(true);
    expect(peopleInPrompt(false, false)).toBe(false);
    const kb = new KnowledgeStore(new MemorySettingsStore(), "p", knowledgeConfig(), {
      now: () => 0,
    });
    expect(subjectsFor(kb, request).map((s) => s.type)).toEqual([
      "person",
      "person",
      "guild",
      "self",
    ]);
    expect(subjectsFor(kb, request, false).map((s) => s.type)).toEqual(["guild", "self"]);
  });
});

describe("recap age", () => {
  const folded = { folded_up_to: { id: "x", ts: "2026-11-10T06:05:00.000Z" } };

  it("says up to when it was written when later lines exist", () => {
    expect(
      recapAgeNote(folded, "2026-11-10T06:10:00.000Z", { lastLineAt: "2026-11-10T06:09:00.000Z" }),
    ).toBe("(寫到 14:05 為止,之後的話在對話紀錄裡)");
  });

  it("says so when it is old, and nothing when it is current", () => {
    expect(recapAgeNote(folded, "2026-11-10T06:40:00.000Z")).toBe("(寫到 14:05 為止)");
    expect(recapAgeNote(folded, "2026-11-10T06:10:00.000Z")).toBe("");
    expect(recapAgeNote({ folded_up_to: null }, "2026-11-10T06:10:00.000Z")).toBe("");
  });
});
