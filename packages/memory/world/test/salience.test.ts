import { describe, expect, it } from "vitest";
import { type Candidate, Salience } from "../src/salience.js";
import { acct, T0 } from "./helpers.js";

const candidate = (key: string, score = 0.5, detail = key): Candidate => ({
  kind: "came_online",
  key,
  account: acct("1"),
  person: null,
  display_name: "a",
  context: null,
  detail,
  score,
});

const salience = (over: Partial<ConstructorParameters<typeof Salience>[0]> = {}) =>
  new Salience({ coalesce_ms: 5_000, cooldown_secs: 900, max_salient_per_minute: 6, ...over });

describe("salience", () => {
  it("merges repeats within the coalescing window", () => {
    const s = salience();
    s.offer(candidate("k", 0.4, "first"), T0);
    s.offer(candidate("k", 0.7, "second"), T0 + 1_000);
    s.offer(candidate("k", 0.5, "third"), T0 + 2_000);
    expect(s.due(T0 + 4_999)).toEqual([]);
    const [e, ...rest] = s.due(T0 + 5_000);
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      key: "k",
      count: 3,
      score: 0.7,
      detail: "third",
      first_at: new Date(T0).toISOString(),
      at: new Date(T0 + 2_000).toISOString(),
    });
  });

  it("mutes the same key for the cooldown", () => {
    const s = salience({ coalesce_ms: 0, cooldown_secs: 60 });
    s.offer(candidate("k"), T0);
    expect(s.due(T0)).toHaveLength(1);
    s.offer(candidate("k"), T0 + 30_000);
    expect(s.due(T0 + 30_000)).toEqual([]);
    expect(s.stats().suppressed).toBe(1);
    s.offer(candidate("k"), T0 + 61_000);
    expect(s.due(T0 + 61_000)).toHaveLength(1);
  });

  it("rate limits by score and drops what got stale", () => {
    const s = salience({ coalesce_ms: 0, max_salient_per_minute: 2 });
    s.offer(candidate("low", 0.1), T0);
    s.offer(candidate("high", 0.9), T0);
    s.offer(candidate("mid", 0.5), T0);
    expect(s.due(T0).map((e) => e.key)).toEqual(["high", "mid"]);
    // The minute is full; "low" waits...
    expect(s.due(T0 + 30_000)).toEqual([]);
    // ...and loses against newer, stronger changes once it is a minute late.
    s.offer(candidate("h2", 0.9), T0 + 61_000);
    s.offer(candidate("h3", 0.8), T0 + 61_000);
    expect(s.due(T0 + 61_000).map((e) => e.key)).toEqual(["h2", "h3"]);
    expect(s.stats()).toMatchObject({ dropped: 1, pending: 0 });
  });

  it("sends late events while they are fresh", () => {
    const s = salience({ coalesce_ms: 0, max_salient_per_minute: 1 });
    s.offer(candidate("a", 0.9), T0);
    s.offer(candidate("b", 0.5), T0 + 10_000);
    expect(s.due(T0 + 10_000).map((e) => e.key)).toEqual(["a"]);
    expect(s.due(T0 + 60_000)).toEqual([]);
    expect(s.due(T0 + 70_000).map((e) => e.key)).toEqual(["b"]);
  });
});
