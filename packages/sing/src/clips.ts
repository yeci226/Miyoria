// Song clips for the party game that guesses songs (`SongClipsKey`, packages/party). A clip is a
// short piece of a song she already covered, played in her voice channel through the same voice
// player as her singing, but it is not her singing:
//
// * no `SONG_TOPIC` cue, so the activity does not become "singing" (that would end the game, see
//   `PartyModule.#onActivity`), the stage shows no video and the economy counts no song;
// * it takes no place in the set list and never touches the song `Singer` is singing;
// * it starts only once her current line is spoken (`Singer.waitQuiet`), and a song that wants
//   the channel waits for the clip (`Singer.clipping`);
// * the abort signal fades it out.

import { errorMessage, getLogger } from "@miyoria/kernel";
import type {
  ClipOutcome,
  Clock,
  ContextKey,
  SongClipInfo,
  SongClips,
  VoicePlayer,
} from "@miyoria/types";
import type { SingWorker, SongMeta } from "./client.js";
import type { SingConfig } from "./config.js";
import { paced, sleep } from "./player.js";
import type { SongEntry } from "./setlist.js";

const log = getLogger("sing");

/** Shorter than this is not a song worth a guessing round (and could hardly hold a clip). */
const MIN_SONG_SECS = 20;
/** The clip fades out over this long when it ends by itself. */
const END_FADE_MS = 500;
/** A clip starts a little before the first sung line so the first word is not cut. */
const LEAD_IN_MS = 600;

/** What `SingClips` needs of the outside; narrow so tests need no module. */
export interface ClipDeps {
  cfg: SingConfig;
  clock: Clock;
  worker: SingWorker;
  /** The voice player of the voice node, `null` when it is not running. */
  voice: () => VoicePlayer | null;
  /** The set list's entries (songs just prepared are playable before the library is read). */
  entries: () => SongEntry[];
  /** Waits for her speech to end; `false` when it did not in time or `signal` aborted. */
  waitQuiet: (guild: string, expectMs: number, signal: AbortSignal) => Promise<boolean>;
  /** Marks a clip as playing in a guild (`+1`) or over (`-1`). */
  clipping: (guild: string, delta: 1 | -1) => void;
  /** A song of her own is being sung (or about to be). */
  singing: () => boolean;
}

/** How a song is told apart from its other versions (another key, another backing). */
function sameSong(song: SongMeta): string {
  return `${song.title.trim().toLowerCase()}\u0000${(song.artist ?? "").trim().toLowerCase()}`;
}

/** The first sung line, where a clip is worth guessing from; `0` without timed lyrics. */
export function clipStartOf(song: SongMeta): number {
  const lines = song.lyrics?.synced ? song.lyrics.lines : [];
  const first = lines.find((l) => l.text.trim() !== "");
  return first === undefined ? 0 : Math.max(0, Math.round(first.t * 1000) - LEAD_IN_MS);
}

/** Total length of a song in ms, from its audio when known. */
function lengthMs(song: SongMeta): number | null {
  const samples = song.play.samples;
  if (samples !== null && samples > 0) return Math.round((samples / song.play.sample_rate) * 1000);
  return song.duration_s === null ? null : Math.round(song.duration_s * 1000);
}

/** `[from, from + duration)` of `pcm`, the last `fadeMs` faded to silence. */
export function sliceClip(
  pcm: Int16Array,
  rate: number,
  fromMs: number,
  durationMs: number,
  fadeMs: number,
): Int16Array {
  const from = Math.min(pcm.length, Math.max(0, Math.round((fromMs / 1000) * rate)));
  const to = Math.min(pcm.length, from + Math.round((durationMs / 1000) * rate));
  const out = pcm.slice(from, to);
  const fade = Math.min(out.length, Math.round((fadeMs / 1000) * rate));
  for (let i = 0; i < fade; i++) {
    const at = out.length - fade + i;
    out[at] = Math.round((out[at] ?? 0) * (1 - (i + 1) / fade));
  }
  return out;
}

export class SingClips implements SongClips {
  readonly #d: ClipDeps;
  /** What the worker's library held when it was last read. */
  #library: SongMeta[] = [];

  constructor(deps: ClipDeps) {
    this.#d = deps;
  }

  /** Reads the worker's library again; a worker that does not answer leaves the last reading. */
  async refresh(signal?: AbortSignal): Promise<void> {
    try {
      this.#library = await this.#d.worker.songs(signal);
    } catch (error) {
      if (signal?.aborted) return;
      log.debug({ err: errorMessage(error) }, "could not read the song library");
    }
  }

  /** Reads the library now and then until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.refresh(signal);
      await sleep(this.#d.cfg.clip_refresh_secs * 1000, signal);
    }
  }

  /** Every song a clip can be played of: the library plus what the set list prepared. */
  #songs(): SongMeta[] {
    const fromList = this.#d
      .entries()
      .flatMap((e) =>
        e.song !== null && (e.state === "ready" || e.state === "done") ? [e.song] : [],
      );
    const byId = new Map<string, SongMeta>();
    for (const song of [...this.#library, ...fromList]) {
      const length = lengthMs(song);
      if (length !== null && length < MIN_SONG_SECS * 1000) continue;
      if (!byId.has(song.id)) byId.set(song.id, song);
    }
    // The same song in several versions is one round; the plain one wins (a cappella has no band).
    const byName = new Map<string, SongMeta>();
    for (const song of byId.values()) {
      const key = sameSong(song);
      const have = byName.get(key);
      const plain = (s: SongMeta) => s.backing !== "acapella";
      if (have === undefined || (!plain(have) && plain(song))) byName.set(key, song);
    }
    return [...byName.values()].filter((s) => s.title.trim() !== "");
  }

  list(): SongClipInfo[] {
    if (this.#d.voice() === null) return [];
    return this.#songs().map((song) => {
      const artist = song.artist?.trim();
      const start = clipStartOf(song);
      return {
        id: song.id,
        title: song.title.trim(),
        artist: artist ? artist : null,
        ...(start > 0 ? { clipStartMs: start } : {}),
      };
    });
  }

  async play(
    context: ContextKey,
    id: string,
    clip: { startMs: number; durationMs: number },
    signal?: AbortSignal,
  ): Promise<ClipOutcome> {
    const d = this.#d;
    const guild = context.scope;
    const voice = d.voice();
    const song = this.#songs().find((s) => s.id === id) ?? null;
    if (guild === null || voice === null || voice.channel(guild) === null || song === null) {
      return "failed";
    }
    // Her own song has the channel; a clip over it would end the game anyway.
    if (d.singing()) return "failed";
    const stop = signal ?? new AbortController().signal;
    if (stop.aborted) return "stopped";
    const rate = song.play.sample_rate;
    let marked = false;
    try {
      const [mix, vocals] = await Promise.all([
        d.worker.audio(song.id, "play_mix.pcm", stop),
        d.cfg.lip_sync_vocals ? d.worker.audio(song.id, "play_vocals.pcm", stop) : null,
      ]);
      if (stop.aborted) return "stopped";
      // The clip waits for the line she is saying; a song clip over her words is the one thing
      // it must not do. Running out of patience is a failure, not a clip over her.
      if (!(await d.waitQuiet(guild, d.cfg.clip_wait_ms, stop))) {
        return stop.aborted ? "stopped" : "failed";
      }
      if (d.singing()) return "failed";
      const total = Math.round((mix.length / rate) * 1000);
      const durationMs = Math.min(clip.durationMs, total);
      if (durationMs <= 0) return "failed";
      // A clip asked for past the end moves back so it is still full length.
      const startMs = Math.max(0, Math.min(clip.startMs, total - durationMs));
      const pcm = sliceClip(mix, rate, startMs, durationMs, END_FADE_MS);
      const levels =
        vocals === null ? null : sliceClip(vocals, rate, startMs, durationMs, END_FADE_MS);
      // From here a song of hers that wants the channel waits for this clip.
      d.clipping(guild, 1);
      marked = true;
      return await this.#stream(voice, guild, rate, pcm, levels, stop);
    } catch (error) {
      if (stop.aborted) return "stopped";
      log.warn({ song: id, err: errorMessage(error) }, "could not play a song clip");
      return "failed";
    } finally {
      if (marked) d.clipping(guild, -1);
    }
  }

  async #stream(
    voice: VoicePlayer,
    guild: string,
    rate: number,
    pcm: Int16Array,
    levels: Int16Array | null,
    signal: AbortSignal,
  ): Promise<ClipOutcome> {
    const d = this.#d;
    const streaming = new AbortController();
    const handle = await voice.play(
      guild,
      rate,
      paced(pcm, levels, rate, d.cfg.lead_ms, d.clock, AbortSignal.any([signal, streaming.signal])),
      { levels: levels !== null },
    );
    const onAbort = () => handle.stop(d.cfg.fade_ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      const state = await handle.wait();
      if (signal.aborted) return "stopped";
      return state === "finished" ? "finished" : state === "interrupted" ? "stopped" : "failed";
    } finally {
      signal.removeEventListener("abort", onAbort);
      streaming.abort();
    }
  }
}
