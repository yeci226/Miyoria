// The songs kept on Core (`SongAudio.library`): what she can sing while no song worker answers
// (the machine with the GPU is off). New songs need a worker; these were made before and their
// audio and meta sit in `audio_dir`. Her prompt lists them by title, and a request that names
// one of them is sung from Core without asking any worker.

import { safeName } from "@miyoria/types";
import type { SongMeta } from "./client.js";

/** Titles listed in her prompt, at most. */
export const MAX_KEPT_LISTED = 20;

/** Case, width, spaces and punctuation do not tell two names apart. */
function norm(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * The kept song a request names: its id, its title, or its title with its artist, else the one
 * song whose title holds the request (or the request its title), else `null`.
 */
export function findKept(query: string, songs: readonly SongMeta[]): SongMeta | null {
  const q = norm(query);
  if (q === "") return null;
  for (const song of songs) {
    const title = norm(song.title);
    const artist = norm(song.artist ?? "");
    const names = [norm(song.id), title, title + artist, artist + title];
    if (title !== "" && names.includes(q)) return song;
  }
  if ([...q].length < 2) return null;
  const near = songs.filter((song) => {
    const title = norm(song.title);
    return [...title].length >= 2 && (title.includes(q) || q.includes(title));
  });
  return near.length === 1 ? (near[0] ?? null) : null;
}

/** The line of her prompt while no worker answers. */
export function keptLine(songs: readonly SongMeta[]): string {
  if (songs.length === 0) {
    return "歌曲工作站現在沒開,做不了新歌,也還沒有做好的歌可以唱。";
  }
  const titles = songs.slice(0, MAX_KEPT_LISTED).map((s) => {
    const artist = s.artist?.trim();
    return `「${safeName(s.title, 60)}」${artist ? ` - ${safeName(artist, 40)}` : ""}`;
  });
  const more = songs.length > MAX_KEPT_LISTED ? `,還有 ${songs.length - MAX_KEPT_LISTED} 首` : "";
  return `歌曲工作站現在沒開,做不了新歌;能唱的是已經做好的這些(用 sing_request 寫歌名):${titles.join("、")}${more}`;
}
