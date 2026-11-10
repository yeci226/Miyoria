// The table of what each emotion does (docs/design/v3-architecture.md §12). That every row really
// reaches something is packages/core/test/emotions.test.ts; here, that the table itself holds.

import { describe, expect, it } from "vitest";
import {
  EMOTION_NAMES,
  EMOTION_OUTPUTS,
  PERSON_EMOTION_NAMES,
  PERSON_EMOTION_OUTPUTS,
  voiceClips,
} from "../src/index.js";

describe("EMOTION_OUTPUTS", () => {
  it("has exactly one row per emotion", () => {
    expect(Object.keys(EMOTION_OUTPUTS).sort()).toEqual([...EMOTION_NAMES].sort());
    expect(Object.keys(PERSON_EMOTION_OUTPUTS).sort()).toEqual([...PERSON_EMOTION_NAMES].sort());
  });

  it("every feeling toward someone does something about them", () => {
    for (const name of PERSON_EMOTION_NAMES) {
      const row = PERSON_EMOTION_OUTPUTS[name];
      expect(row.want !== null || row.distance > 0, name).toBe(true);
    }
  });

  it("a line carries the tag, so emotions that share one share their clips", () => {
    for (const name of EMOTION_NAMES) {
      const { tag, voice } = EMOTION_OUTPUTS[name];
      expect(voice.length, name).toBeGreaterThan(0);
      expect(voiceClips(tag), name).toEqual(voice);
    }
  });

  it("weights stay weights: no single feeling moves more than a full unit", () => {
    for (const name of EMOTION_NAMES) {
      const row = EMOTION_OUTPUTS[name];
      expect(Math.abs(row.talk), name).toBeLessThanOrEqual(1);
      expect(Math.abs(row.initiative), name).toBeLessThanOrEqual(1);
    }
  });
});

describe("voiceClips", () => {
  it("reads a tag or an emotion's own name, whatever the case", () => {
    expect(voiceClips("happy")).toEqual(["happy"]);
    expect(voiceClips(" Joy ")).toEqual(["happy"]);
    expect(voiceClips("surprised")).toEqual(["surprised", "embarrassed"]);
  });

  it("a tag no emotion shows as is its own clip", () => {
    expect(voiceClips("neutral")).toEqual(["neutral"]);
    expect(voiceClips("thinking")).toEqual(["thinking"]);
    expect(voiceClips("constructor")).toEqual(["constructor"]);
  });
});
