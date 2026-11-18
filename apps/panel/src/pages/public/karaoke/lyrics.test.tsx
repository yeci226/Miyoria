// The lyrics of reference.json version 2 under the lane: pieces lit as they are sung, readings
// above them, 「聽寫」 on heard lyrics, the mark on a line that did not match, what this browser
// keeps (the reading shown, the key of each song), and a version 1 reference read the same way.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  karaokeBackingName,
  karaokeReferenceV2,
  shiftKaraokeReference,
  type WorkersKaraokeLineV2,
  type WorkersKaraokeLyricsV2,
  type WorkersKaraokePiece,
  type WorkersKaraokeReferenceV1,
} from "@miyoria/contracts/workers/karaoke";
import {
  countdown,
  isDoubtful,
  keyLabel,
  lineProgress,
  loadKey,
  loadReading,
  pieceProgress,
  readingLabel,
  readingModes,
  rubyOf,
  saveKey,
  saveReading,
  stageLines,
  stepped,
  sungEnd,
} from "./lyric-text";
import { fillClip, HeardBadge, LYRIC_MAIN, LYRIC_NEXT, LYRIC_RUBY, Lyrics, ReadingToggle } from "./Lyrics";

const piece = (text: string, start: number | null, end: number | null, over: Partial<WorkersKaraokePiece> = {}) => ({
  text,
  sung: text.trim() !== "",
  start,
  end,
  reading: null,
  roman: null,
  ...over,
});

const line = (over: Partial<WorkersKaraokeLineV2> = {}): WorkersKaraokeLineV2 => ({
  start: 1,
  end: 4,
  text: "私は歌う",
  status: "matched",
  source: "found",
  similarity: 1,
  heard: "私は歌う",
  aligned: true,
  pieces: [
    piece("私", 1, 2, { reading: "わたし", roman: "watashi" }),
    piece("は", 2, 2.5, { roman: "wa" }),
    piece(" ", null, null),
    piece("歌う", 2.5, 3.5, { reading: "うたう", roman: "utau" }),
  ],
  edited: false,
  ...over,
});

const lyrics = (lines: WorkersKaraokeLineV2[], over: Partial<WorkersKaraokeLyricsV2> = {}): WorkersKaraokeLyricsV2 => ({
  provider: "lrclib",
  source: "found",
  language: "ja",
  timing: "char",
  check: null,
  lines,
  ...over,
});

function memory(): () => Pick<Storage, "getItem" | "setItem"> {
  const m = new Map<string, string>();
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  return () => s;
}

describe("the lyrics' logic", () => {
  it("lights each piece by its own time, and a space as the piece before it", () => {
    const l = line();
    expect(pieceProgress(l.pieces?.[0] as WorkersKaraokePiece, 1.5)).toBe(0.5);
    expect(pieceProgress(l.pieces?.[2] as WorkersKaraokePiece, 1.5)).toBeNull();
    expect(lineProgress(l, 0.5)).toEqual([0, 0, 0, 0]);
    expect(lineProgress(l, 2.25)).toEqual([1, 0.5, 0, 0]);
    expect(lineProgress(l, 3)).toEqual([1, 1, 1, 0.5]);
    expect(lineProgress(l, 9)).toEqual([1, 1, 1, 1]);
    expect(lineProgress(line({ aligned: false }), 2)).toBeNull();
    expect(lineProgress(line({ pieces: null }), 2)).toBeNull();
  });

  it("puts the line being sung (or the one coming) over the one after, and counts a line in after a rest", () => {
    const lines = [
      { start: 5, end: 9 },
      { start: 9.5, end: 12 },
      { start: 20, end: 24 },
      { start: 24, end: 27 },
    ];
    expect(stageLines(lines, 1)).toEqual({ main: 0, second: 1 });
    expect(stageLines(lines, 6)).toEqual({ main: 0, second: 1 });
    expect(stageLines(lines, 10)).toEqual({ main: 1, second: 2 });
    // Over a second past the end of a line, the coming one takes its place.
    expect(stageLines(lines, 15)).toEqual({ main: 2, second: 3 });
    expect(stageLines(lines, 25)).toEqual({ main: 3, second: null });
    expect(stageLines([], 3)).toEqual({ main: null, second: null });
    // The first line, and a line after a rest of four seconds or more, are counted in.
    expect(countdown(lines, 0.5)).toBeNull();
    expect(countdown(lines, 1.2)).toBe(4);
    expect(countdown(lines, 4.1)).toBe(1);
    expect(countdown(lines, 17.5)).toBe(3);
    // A line right after another is not.
    expect(countdown(lines, 9.2)).toBeNull();
    expect(countdown(lines, 22)).toBeNull();
    expect([stepped(0), stepped(0.01), stepped(1)]).toEqual([0, 1, 1]);
    // An aligned line ends with its last timed piece, not at the next line's start.
    expect(sungEnd(line({ end: 9 }))).toBe(3.5);
    expect(sungEnd(line({ end: 9, aligned: false }))).toBe(9);
  });

  it("offers the readings the pieces carry, named for the language", () => {
    expect(readingModes(lyrics([line()]))).toEqual(["reading", "roman"]);
    expect(readingModes(lyrics([line({ pieces: null })]))).toEqual([]);
    expect(readingModes(null)).toEqual([]);
    expect(readingLabel("reading", "ja")).toBe("假名");
    expect(readingLabel("reading", "zh")).toBe("拼音");
    expect(readingLabel("roman", "ja")).toBe("羅馬字");
    const p = line().pieces?.[0] as WorkersKaraokePiece;
    expect([rubyOf(p, "off"), rubyOf(p, "reading"), rubyOf(p, "roman")]).toEqual([null, "わたし", "watashi"]);
  });

  it("marks only looked-up lines that did not match", () => {
    expect(isDoubtful(line({ status: "uncertain" }))).toBe(true);
    expect(isDoubtful(line({ status: "failed" }))).toBe(true);
    expect(isDoubtful(line({ status: "matched" }))).toBe(false);
    expect(isDoubtful(line({ status: "unchecked" }))).toBe(false);
    expect(isDoubtful(line({ status: "uncertain", source: "heard" }))).toBe(false);
  });

  it("keeps the reading and each song's key in this browser", () => {
    const s = memory();
    expect(loadReading(s)).toBe("off");
    saveReading("roman", s);
    expect(loadReading(s)).toBe("roman");
    expect(loadKey("song", 6, s)).toBe(0);
    saveKey("song", -3, s);
    expect(loadKey("song", 6, s)).toBe(-3);
    s().setItem("miyoria.karaoke.key:song", "9");
    expect(loadKey("song", 6, s)).toBe(0);
    const broken = () => ({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadReading(broken)).toBe("off");
    expect(() => saveKey("x", 1, broken)).not.toThrow();
    expect([keyLabel(0), keyLabel(2), keyLabel(-3)]).toEqual(["原調", "+2", "−3"]);
  });

  it("reads a version 1 reference as version 2, and moves a reference to another key", () => {
    const v1: WorkersKaraokeReferenceV1 = {
      format: "miyoria.karaoke.reference",
      version: 1,
      id: "k",
      title: "t",
      artist: null,
      duration_s: 2,
      backing: "karaoke.m4a",
      pitch: { hz: 50, start: 0, midi: [60, null, 61.5] },
      notes: [{ start: 0, end: 1, midi: 60, source: "pitch", line: null, char: null }],
      lyrics: {
        provider: "lrclib",
        timing: "line",
        lines: [{ start: 0, end: 2, text: "la", check: "unchecked", confidence: null, chars: null }],
      },
      quality: { ok: true, reason: null, voiced_ratio: 0.6, notes: 1, lead_split: true },
      made: { pitch: "rmvpe", notes: "pitch-runs-1", lyrics: "line" },
    };
    const v2 = karaokeReferenceV2(v1);
    expect(v2.version).toBe(2);
    expect(v2.lyrics?.source).toBe("found");
    expect(v2.lyrics?.lines[0]).toMatchObject({ status: "unchecked", aligned: false, pieces: null });
    const up = shiftKaraokeReference(v2, 3);
    expect(up.pitch.midi).toEqual([63, null, 64.5]);
    expect(up.notes[0]?.midi).toBe(63);
    expect(shiftKaraokeReference(v2, 0)).toBe(v2);
    expect([karaokeBackingName(0), karaokeBackingName(3), karaokeBackingName(-6)]).toEqual([
      "karaoke.m4a",
      "karaoke.k+3.m4a",
      "karaoke.k-6.m4a",
    ]);
  });
});

/** The words as read out: the fill over a piece is a copy hidden from assistive technology. */
function shownText(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll("[aria-hidden]")) hidden.remove();
  return copy.textContent ?? "";
}

describe("the lyrics on the stage", () => {
  const lit = (root: HTMLElement) => [...root.querySelectorAll("[data-lit]")].map((el) => el.getAttribute("data-lit"));

  it("lights the line being sung, large, over the next one", () => {
    const next = line({ start: 4, end: 7, text: "次", pieces: [piece("次", 4, 5)] });
    const { container } = render(<Lyrics lyrics={lyrics([line(), next])} now={2.25} loaded mode="off" />);
    // 私 sung, は half way, 歌う not yet; the next line is not lit.
    expect(lit(container)).toEqual(["all", "part", "none", "none"]);
    const current = container.querySelector("[data-line=current]") as HTMLElement;
    const following = container.querySelector("[data-line=next]") as HTMLElement;
    expect(shownText(current)).toBe("私は 歌う");
    expect(following).toHaveTextContent("次");
    // Karaoke-box sizes: the line being sung up to 52 px, the next one up to 38 px, both outlined.
    expect(current.className).toContain(LYRIC_MAIN);
    expect(following.className).toContain(LYRIC_NEXT);
    expect(current.className).toContain("[-webkit-text-stroke:");
    expect(container.querySelector("rt")).toBeNull();
    // The fill shows up to the share sung, and past the box on the other sides (the outline).
    expect(fillClip(0.5)).toBe("inset(-0.3em 50% -0.3em -0.2em)");
    expect(fillClip(1)).toBe("inset(-0.3em -0.2em -0.3em -0.2em)");
    const half = container.querySelector("[data-lit=part]") as HTMLElement;
    expect(half.style.clipPath).toBe("inset(-0.3em 50% -0.3em -0.2em)");
  });

  it("lights each piece whole as it begins under reduced motion", () => {
    const { container } = render(<Lyrics lyrics={lyrics([line()])} now={2.25} loaded mode="off" reduced />);
    expect(lit(container)).toEqual(["all", "all", "none", "none"]);
  });

  it("shows the coming line in place before it is sung, counted in after a rest", () => {
    const base = line();
    const first = line({
      start: 10,
      end: 13,
      pieces: base.pieces?.map((p) => ({ ...p, start: p.start === null ? null : p.start + 9, end: p.end === null ? null : p.end + 9 })) ?? null,
    });
    const second = line({ start: 13, end: 16, text: "二", pieces: [piece("二", 13, 14)] });
    const { container } = render(<Lyrics lyrics={lyrics([first, second])} now={7.5} loaded mode="off" />);
    expect(shownText(container.querySelector("[data-line=current]") as HTMLElement)).toBe("私は 歌う");
    expect(lit(container)).toEqual(["none", "none", "none", "none"]);
    expect(container.querySelector("[data-line=next]")).toHaveTextContent("二");
    expect(screen.getByRole("img", { name: "3 秒後開始" })).toBeInTheDocument();
    expect([...container.querySelectorAll("[data-dot]")].map((d) => d.getAttribute("data-dot"))).toEqual([
      "off",
      "on",
      "on",
      "on",
    ]);
  });

  it("shows readings above the words at a readable size when asked", () => {
    const { container } = render(<Lyrics lyrics={lyrics([line()])} now={1} loaded mode="reading" />);
    const rts = [...container.querySelectorAll("rt")];
    expect(rts.map((r) => r.textContent)).toEqual(["わたし", "うたう"]);
    expect(rts[0]?.className).toContain("text-[max(12px,");
    expect(rts[0]?.className).toBe(LYRIC_RUBY);
  });

  it("offers the readings in the bar, and the choice goes back", async () => {
    let chosen = "";
    render(<ReadingToggle lyrics={lyrics([line()])} mode="reading" onMode={(m) => void (chosen = m)} />);
    await userEvent.click(screen.getByRole("radio", { name: "羅馬字" }));
    expect(chosen).toBe("roman");
    expect(screen.getByRole("radio", { name: "假名" })).toHaveAttribute("aria-checked", "true");
    const { container } = render(<ReadingToggle lyrics={lyrics([line({ pieces: null })])} mode="off" onMode={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says heard lyrics are 聽寫, and marks a line that did not match", () => {
    const doubtful = line({ status: "uncertain", aligned: false, start: 0 });
    const heard = lyrics([{ ...doubtful, source: "heard" }], { source: "heard" });
    render(<HeardBadge lyrics={heard} />);
    expect(screen.getByText("聽寫")).toBeInTheDocument();
    render(<Lyrics lyrics={heard} now={0.5} loaded mode="off" />);
    // Heard lines are all unsure: the badge says so, the line gets no mark of its own.
    expect(screen.queryByTitle("這一行和聽到的不太一樣")).toBeNull();
    const { container } = render(<HeardBadge lyrics={lyrics([doubtful])} />);
    expect(container).toBeEmptyDOMElement();
    render(<Lyrics lyrics={lyrics([doubtful])} now={0.5} loaded mode="off" />);
    expect(screen.getByTitle("這一行和聽到的不太一樣")).toHaveTextContent("私は 歌う");
  });

  it("says so when there are no lyrics", () => {
    render(<Lyrics lyrics={null} now={0} loaded mode="off" />);
    expect(screen.getByText("沒有找到歌詞")).toBeInTheDocument();
  });
});
