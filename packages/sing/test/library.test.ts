// The songs kept on Core, by name: what a request names, and the line of her prompt.

import { describe, expect, it } from "vitest";
import type { SongMeta } from "../src/index.js";
import { findKept, keptLine, MAX_KEPT_LISTED } from "../src/library.js";

function song(id: string, title: string, artist: string | null = null): SongMeta {
  return {
    id,
    title,
    artist,
    duration_s: 1,
    lyrics: null,
    play: { sample_rate: 48_000, samples: 48_000 },
    pitch: {},
    timings: {},
    peak_vram_mb: null,
    has_video: false,
    video: null,
  };
}

const SONGS = [
  song("yt-1", "朋友的酒", "李翊君"),
  song("yt-2", "夜に駆ける", "YOASOBI"),
  song("yt-3", "Lemon", "米津玄師"),
  song("yt-4", "Lemon Tree"),
];

describe("songs kept on Core", () => {
  it("finds_a_song_by_title_title_and_artist_or_id_whatever_the_case_and_spaces", () => {
    expect(findKept("朋友的酒", SONGS)?.id).toBe("yt-1");
    expect(findKept("朋友的酒 - 李翊君", SONGS)?.id).toBe("yt-1");
    expect(findKept("ｌｅｍｏｎ", SONGS)?.id).toBe("yt-3");
    expect(findKept("YT-2", SONGS)?.id).toBe("yt-2");
  });

  it("finds_a_part_of_a_title_only_when_one_song_has_it", () => {
    expect(findKept("駆ける", SONGS)?.id).toBe("yt-2");
    expect(findKept("Lem", SONGS)).toBeNull();
    expect(findKept("酒", SONGS)).toBeNull();
    expect(findKept("一首新歌", SONGS)).toBeNull();
    expect(findKept("  ", SONGS)).toBeNull();
  });

  it("lists_them_for_her_with_the_rest_counted", () => {
    expect(keptLine(SONGS)).toContain("「朋友的酒」 - 李翊君、「夜に駆ける」 - YOASOBI");
    const many = Array.from({ length: MAX_KEPT_LISTED + 3 }, (_, i) => song(`s${i}`, `歌${i}`));
    expect(keptLine(many)).toMatch(/還有 3 首$/);
    expect(keptLine([])).toContain("還沒有做好的歌");
  });
});
