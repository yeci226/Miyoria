import type {
  AccountRef,
  ClipOutcome,
  ContextKey,
  SongClipInfo,
  SongClips,
  VoiceParticipant,
} from "@miyoria/types";
import { defaultPartyConfig, type PartyConfig } from "../src/config.js";
import { bareTitle } from "../src/games/song.js";
import type { SoupCase, SoupJudge, SoupVerdict } from "../src/judge.js";
import {
  type PartyEnded,
  type PartyNote,
  type PartyOutput,
  type Speaker,
  Table,
  type TableDeps,
} from "../src/table.js";

export const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
/** The text chat of the voice channel: same channel id, kind `channel`. */
export const VOICE_CHAT: ContextKey = { ...VOICE, kind: "channel" };
export const OTHER_VOICE: ContextKey = { ...VOICE, channel: "v2" };
/** A text channel of the same server where turtle soup can be played. */
export const TEXT: ContextKey = {
  platform: "discord",
  scope: "g1",
  channel: "t1",
  kind: "channel",
};
export const SONGS: SongClipInfo[] = [
  { id: "s1", title: "晴天 (Live)", artist: null },
  { id: "s2", title: "小幸運", artist: null },
];

export const HER: AccountRef = { platform: "discord", id: "100" };
export const AMY: AccountRef = { platform: "discord", id: "1" };
export const BOB: AccountRef = { platform: "discord", id: "2" };

export const amy: Speaker = { account: AMY, name: "Amy" };
export const bob: Speaker = { account: BOB, name: "Bob" };

export function member(account: AccountRef, name: string, self = false): VoiceParticipant {
  return { account, display_name: name, is_self: self, muted: false, deafened: false };
}

export const ROOM: VoiceParticipant[] = [
  member(HER, "Miyo", true),
  member(AMY, "Amy"),
  member(BOB, "Bob"),
];

/** What the table told her. */
export class Recorder implements PartyOutput {
  readonly notes: PartyNote[] = [];
  readonly ends: PartyEnded[] = [];

  note(note: PartyNote): void {
    this.notes.push(note);
  }

  ended(info: PartyEnded): void {
    this.ends.push(info);
  }

  /** Notes she may react to. */
  spoken(): PartyNote[] {
    return this.notes.filter((n) => n.speak);
  }

  last(): PartyNote | undefined {
    return this.notes.at(-1);
  }

  /** Everything she was told, as one text. */
  text(): string {
    return this.notes.map((n) => n.summary).join("\n");
  }
}

/** Plays nothing: records the clips and ends them when the test says so. */
export class FakeClips implements SongClips {
  readonly played: { context: ContextKey; id: string; startMs: number; durationMs: number }[] = [];
  readonly #ends: ((o: ClipOutcome) => void)[] = [];
  constructor(readonly songs: SongClipInfo[]) {}

  list(): SongClipInfo[] {
    return this.songs;
  }

  play(
    context: ContextKey,
    id: string,
    clip: { startMs: number; durationMs: number },
    signal?: AbortSignal,
  ): Promise<ClipOutcome> {
    this.played.push({ context, id, startMs: clip.startMs, durationMs: clip.durationMs });
    return new Promise((resolve) => {
      this.#ends.push(resolve);
      signal?.addEventListener("abort", () => resolve("stopped"), { once: true });
    });
  }

  /** The title of the song whose clip played last, as people say it. */
  current(): string {
    const id = this.played.at(-1)?.id;
    const song = this.songs.find((s) => s.id === id);
    if (!song) throw new Error("no clip is playing");
    return bareTitle(song.title);
  }

  /** The clip playing ends with `outcome`. */
  end(outcome: ClipOutcome): void {
    this.#ends.shift()?.(outcome);
  }
}

/** A referee whose verdicts the test decides. */
export class FakeJudge implements SoupJudge {
  readonly cases: SoupCase[] = [];
  readonly #waiting: { resolve: (v: SoupVerdict) => void; reject: (e: Error) => void }[] = [];
  /** Answers at once when set. */
  verdict: SoupVerdict | null = "yes";

  judge(soup: SoupCase): Promise<SoupVerdict> {
    this.cases.push(soup);
    if (this.verdict !== null) return Promise.resolve(this.verdict);
    return new Promise((resolve, reject) => this.#waiting.push({ resolve, reject }));
  }

  answer(verdict: SoupVerdict): void {
    this.#waiting.shift()?.resolve(verdict);
  }

  fail(): void {
    this.#waiting.shift()?.reject(new Error("model down"));
  }
}

export interface Rig {
  table: Table;
  out: Recorder;
  cfg: PartyConfig;
  /** The songs and the referee the table was given (unless a test passed its own). */
  clips: FakeClips;
  judge: FakeJudge;
}

/**
 * A table with her in `VOICE` with Amy and Bob, two songs to play and a referee that says yes.
 * Use with `vi.useFakeTimers()`.
 */
export function rig(
  overrides: Partial<Omit<TableDeps, "output" | "config">> & {
    config?: Partial<PartyConfig>;
  } = {},
): Rig {
  const out = new Recorder();
  const cfg = { ...defaultPartyConfig(), ...overrides.config };
  const clips = new FakeClips(SONGS);
  const judge = new FakeJudge();
  const table = new Table({
    clock: { now: () => Date.now() },
    random: () => 0,
    clips: () => clips,
    judge: () => judge,
    ...overrides,
    config: cfg,
    output: out,
  });
  table.members(VOICE, ROOM);
  return { table, out, cfg, clips, judge };
}
