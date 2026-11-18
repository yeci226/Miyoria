// The lyrics module shared by the member page and the stream (`@miyoria/play/karaoke/lyrics`):
// the member page's tests cover it through its re-exports; these hold the shared entry itself.

import type { WorkersKaraokeLineV2 } from "@miyoria/contracts/workers";
import { describe, expect, it } from "vitest";
import {
  countdown,
  fillClip,
  keyLabel,
  lineProgress,
  readingLabel,
  readingModes,
  StallWatch,
  stageLines,
  sungEnd,
  videoStep,
} from "../src/lyrics/index.js";

function line(
  start: number,
  texts: [string, number, number][],
  extra: Partial<WorkersKaraokeLineV2> = {},
) {
  return {
    start,
    end: start + 5,
    text: texts.map(([t]) => t).join(""),
    status: "matched",
    source: "found",
    similarity: null,
    heard: null,
    aligned: true,
    pieces: texts.map(([text, s, e]) => ({
      text,
      sung: true,
      start: s,
      end: e,
      reading: null,
      roman: text,
    })),
    edited: false,
    ...extra,
  } satisfies WorkersKaraokeLineV2;
}

describe("shared karaoke lyrics", () => {
  const lines = [
    line(1, [
      ["a", 1, 2],
      ["b", 2, 3],
    ]),
    line(10, [["c", 10, 11]]),
  ];
  const timed = lines.map((l) => ({ start: l.start, end: sungEnd(l) }));

  it("lights each piece as it is sung", () => {
    expect(lineProgress(lines[0] as WorkersKaraokeLineV2, 1.5)).toEqual([0.5, 0]);
    expect(lineProgress(lines[0] as WorkersKaraokeLineV2, 2.5)).toEqual([1, 0.5]);
    expect(fillClip(1)).toBe("inset(-0.3em -0.2em -0.3em -0.2em)");
    expect(fillClip(0.25)).toBe("inset(-0.3em 75% -0.3em -0.2em)");
  });

  it("shows the line being sung over the next, and counts in after a rest", () => {
    expect(sungEnd(lines[0] as WorkersKaraokeLineV2)).toBe(3);
    expect(stageLines(timed, 0)).toEqual({ main: 0, second: 1 });
    expect(stageLines(timed, 2)).toEqual({ main: 0, second: 1 });
    expect(stageLines(timed, 5)).toEqual({ main: 1, second: null });
    expect(countdown(timed, 7.5)).toBe(3);
    expect(countdown(timed, 2)).toBeNull();
  });

  it("names readings and keys, and moves the video with the song", () => {
    expect(
      readingModes({
        provider: null,
        source: "found",
        language: "ja",
        timing: "char",
        check: null,
        lines,
      }),
    ).toEqual(["roman"]);
    expect(readingLabel("reading", "zh")).toBe("拼音");
    expect(keyLabel(-3)).toBe("−3");
    expect(
      videoStep(
        { time: 0, paused: true, rate: 1, duration: 60, seeking: false },
        { time: 5, playing: true },
      ),
    ).toEqual({
      seek: 5,
      play: true,
    });
    expect(new StallWatch().check(0, 1, true)).toBe(false);
  });
});
