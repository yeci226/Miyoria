import { describe, expect, it } from "vitest";
import { WatchNotes } from "../src/notes.js";

describe("WatchNotes", () => {
  it("keeps the newest notes_keep notes", () => {
    const n = new WatchNotes({ notes_keep: 2, transcript_secs: 180 }, () => 0);
    n.addNote("a");
    n.addNote("b");
    n.addNote("c");
    expect(n.notes()).toEqual(["b", "c"]);
  });
  it("drops lines older than transcript_secs", () => {
    let t = 0;
    const n = new WatchNotes({ notes_keep: 10, transcript_secs: 180 }, () => t);
    n.addLine("old");
    t = 181_000;
    n.addLine("new");
    expect(n.transcript()).toEqual(["new"]);
    t = 181_000 + 180_000;
    expect(n.transcript()).toEqual(["new"]);
    t += 1;
    expect(n.transcript()).toEqual([]);
  });
  it("ignores blank text", () => {
    const n = new WatchNotes({ notes_keep: 10, transcript_secs: 180 }, () => 0);
    n.addNote("  ");
    n.addLine("\n");
    expect(n.notes()).toEqual([]);
    expect(n.transcript()).toEqual([]);
  });
  it("cuts overlong entries", () => {
    const n = new WatchNotes({ notes_keep: 10, transcript_secs: 180 }, () => 0);
    n.addNote("x".repeat(1000));
    n.addLine("y".repeat(1000));
    expect([...(n.notes()[0] ?? "")].length).toBeLessThanOrEqual(240);
    expect([...(n.transcript()[0] ?? "")].length).toBeLessThanOrEqual(240);
  });
});
