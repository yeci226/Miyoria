// Her working notes (notes.ts): kept per conversation, shown every turn, gone when they expire.

import type { ContextKey, PromptRequest } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { MAX_NOTE_CHARS, MAX_NOTES, WorkingNotes } from "../src/notes.js";

const A: ContextKey = { platform: "discord", scope: "g", channel: "a", kind: "channel" };
const B: ContextKey = { platform: "discord", scope: "g", channel: "b", kind: "channel" };

describe("working notes", () => {
  it("are kept per conversation and shown in its prompt until they expire", async () => {
    let now = 0;
    const notes = new WorkingNotes(() => now);
    const n = notes.keep(A, "〈我喜歡你〉:喔喔喔愛,什麼是愛 / 我對你的感覺我說不出來", 10);
    expect(notes.list(A).map((x) => x.id)).toEqual([n.id]);
    expect(notes.list(B)).toEqual([]);
    const sections = await notes.contributor().contribute({ context: A } as PromptRequest);
    expect(sections[0]?.body).toContain("我對你的感覺我說不出來");
    expect(sections[0]?.body).toContain(`[${n.id}]`);
    now = 10 * 60_000 + 1;
    expect(notes.list(A)).toEqual([]);
    expect(await notes.contributor().contribute({ context: A } as PromptRequest)).toEqual([]);
  });

  it("can be dropped, are capped in number and length", () => {
    const notes = new WorkingNotes(() => 0);
    const first = notes.keep(A, "一");
    for (let i = 0; i < MAX_NOTES; i++) notes.keep(A, `第 ${i} 則`);
    expect(notes.list(A)).toHaveLength(MAX_NOTES);
    expect(notes.list(A).some((x) => x.id === first.id)).toBe(false); // the oldest went
    const long = notes.keep(B, "字".repeat(MAX_NOTE_CHARS + 50));
    expect([...long.text]).toHaveLength(MAX_NOTE_CHARS);
    expect(notes.drop(B, long.id)).toBe(true);
    expect(notes.drop(B, long.id)).toBe(false);
  });
});
