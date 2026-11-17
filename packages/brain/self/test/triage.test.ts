import { describe, expect, it } from "vitest";
import type { ChannelMode } from "../../agent/src/index.js";
import {
  addressedReason,
  DEFAULT_TRIAGE,
  GLANCES_PER_HOUR,
  HOUR_MS,
  noteGlance,
  type TriageEvent,
  type TriageState,
  triage,
} from "../src/triage.js";

const NOW = Date.UTC(2026, 10, 16, 12);
const PLACE = "discord:g1:c1";

const state = (over: Partial<TriageState> = {}, level: ChannelMode = "normal"): TriageState => ({
  config: DEFAULT_TRIAGE,
  level: () => level,
  glances: new Map(),
  today: 0,
  ...over,
});

const line = (over: Partial<Extract<TriageEvent, { kind: "line" }>> = {}): TriageEvent => ({
  kind: "line",
  place: PLACE,
  at: NOW,
  addressed: null,
  own: false,
  bot: false,
  flagged: false,
  muted: false,
  ...over,
});

describe("triage", () => {
  it.each([
    ["a mention", line({ addressed: "mention" }), "wake"],
    ["a DM", line({ addressed: "dm" }), "wake"],
    ["a reply to her", line({ addressed: "reply" }), "wake"],
    ["her name", line({ addressed: "name" }), "wake"],
    ["a result", { kind: "result" } as TriageEvent, "wake"],
    ["a due timer", { kind: "timer", due: true } as TriageEvent, "wake"],
    ["a timer not due", { kind: "timer", due: false } as TriageEvent, "hold"],
    ["a salient world event", { kind: "world", salient: true } as TriageEvent, "wake"],
    ["a world event that is not", { kind: "world", salient: false } as TriageEvent, "hold"],
    ["an ambient line", line(), "glance"],
    ["her own line", line({ own: true, addressed: "mention" }), "hold"],
    ["a bot", line({ bot: true, addressed: "mention" }), "hold"],
    ["a flagged line", line({ flagged: true, addressed: "dm" }), "hold"],
    ["a muted line", line({ muted: true, addressed: "mention" }), "hold"],
  ])("%s: %s", (_name, event, decision) => {
    expect(triage(event, state(), NOW).decision).toBe(decision);
  });

  it("glances per hour by the place's level: quiet 2, normal 6, talkative 12", () => {
    expect(GLANCES_PER_HOUR).toMatchObject({ quiet: 2, normal: 6, lively: 12 });
    for (const [level, n] of [
      ["quiet", 2],
      ["normal", 6],
      ["lively", 12],
    ] as const) {
      let s = state({}, level);
      let taken = 0;
      // A line every minute for an hour.
      for (let t = 0; t < 60; t++) {
        const at = NOW + t * 60_000;
        if (triage(line({ at }), s, at).decision === "glance") {
          s = noteGlance(s, PLACE, at);
          taken += 1;
        }
      }
      expect(taken).toBe(n);
    }
  });

  it("holds at the hourly cap, too soon after a glance, at the day's cap, and when off", () => {
    const full = state({
      glances: new Map([[PLACE, [1, 2, 3, 4, 5, 6].map((m) => NOW - m * 60_000)]]),
    });
    expect(triage(line(), full, NOW)).toEqual({ decision: "hold", why: "hourly_cap" });
    const just = state({ glances: new Map([[PLACE, [NOW - 60_000]]]) });
    expect(triage(line(), just, NOW)).toEqual({ decision: "hold", why: "too_soon" });
    const later = state({ glances: new Map([[PLACE, [NOW - HOUR_MS / 12]]]) });
    expect(triage(line(), later, NOW).decision).toBe("glance");
    expect(triage(line(), state({ today: DEFAULT_TRIAGE.perDay }), NOW)).toEqual({
      decision: "hold",
      why: "daily_cap",
    });
    const off = state({ config: { ...DEFAULT_TRIAGE, glances: false } });
    expect(triage(line(), off, NOW)).toEqual({ decision: "hold", why: "glances_off" });
    expect(triage(line({ addressed: "mention" }), off, NOW).decision).toBe("wake");
    expect(triage(line(), state({}, "mention-only"), NOW)).toEqual({
      decision: "hold",
      why: "level",
    });
  });

  it("glances an hour old no longer count", () => {
    const old = state({
      glances: new Map([[PLACE, [1, 2, 3, 4, 5, 6].map((m) => NOW - HOUR_MS - m * 60_000)]]),
    });
    expect(triage(line(), old, NOW).decision).toBe("glance");
    const after = noteGlance(old, PLACE, NOW);
    expect(after.glances.get(PLACE)).toEqual([NOW]);
    expect(after.today).toBe(1);
  });

  it("reads today's directReason", () => {
    expect(addressedReason("dm")).toBe("dm");
    expect(addressedReason("mention")).toBe("mention");
    expect(addressedReason("reply")).toBe("reply");
    expect(addressedReason("name `Miyo`")).toBe("name");
    expect(addressedReason(null)).toBeNull();
  });
});
