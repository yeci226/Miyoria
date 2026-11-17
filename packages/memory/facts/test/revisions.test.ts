import { type JsonValue, type LogEvent, type ObservationBody, toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { RevisionBook } from "../src/revisions.js";

const T0 = Date.UTC(2026, 10, 7, 12);

describe("states", () => {
  it("goes up only when the state changes", () => {
    const book = new RevisionBook();
    expect(book.state("k", "a", T0)).toEqual({ revision: 1, fresh: true, first: true });
    expect(book.state("k", "a", T0 + 1)).toEqual({ revision: 1, fresh: false, first: false });
    expect(book.state("k", "b", T0 + 2)).toEqual({ revision: 2, fresh: true, first: false });
    expect(book.state("k", "a", T0 + 3).revision).toBe(3);
  });
});

describe("events", () => {
  it("is the same thing inside the window, a new one after it", () => {
    const book = new RevisionBook();
    expect(book.event("k", T0, 1000)).toEqual({ revision: 1, fresh: true, first: true });
    expect(book.event("k", T0 + 999, 1000)).toEqual({ revision: 1, fresh: false, first: false });
    expect(book.event("k", T0 + 1000, 1000)).toEqual({ revision: 2, fresh: true, first: false });
    // The window runs from the start of the revision, not from the last occurrence.
    expect(book.event("k", T0 + 1999, 1000).revision).toBe(2);
    expect(book.event("k", T0 + 2000, 1000).revision).toBe(3);
  });

  it("a window of 0 makes every occurrence new", () => {
    const book = new RevisionBook();
    book.event("death", T0, 0);
    expect(book.event("death", T0, 0).revision).toBe(2);
  });
});

describe("from the log", () => {
  function logged(key: string, revision: number, at: number): LogEvent {
    const body = {
      observation: { attention_key: key, revision },
      buckets: [],
    } as unknown as ObservationBody;
    return {
      id: `${key}${revision}`,
      at: toTimestamp(at),
      kind: "observation",
      source: "s",
      cause: null,
      context: null,
      person: null,
      body: body as unknown as JsonValue,
    };
  }

  it("carries on where the last run stopped", () => {
    const book = new RevisionBook();
    book.apply(logged("k", 3, T0));
    book.apply(logged("k", 2, T0 + 1));
    expect(book.current("k")).toBe(3);
    expect(book.event("k", T0 + 10, 1000)).toEqual({ revision: 3, fresh: false, first: false });
    expect(book.event("k", T0 + 2000, 1000).revision).toBe(4);
    expect(book.current("nope")).toBeNull();
  });

  it("takes an unknown state for a change: nothing says it is the same one", () => {
    const book = new RevisionBook();
    book.apply(logged("k", 1, T0));
    expect(book.state("k", "a", T0 + 1).revision).toBe(2);
  });
});
