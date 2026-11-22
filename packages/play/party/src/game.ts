// What a party game is to the framework (table.ts): a state machine fed by players' lines, her
// tool calls and its own timers. A game never speaks: everything she should know or react to is
// a note (an Observation for the main line), and what her tool call did is the tool's answer.
//
// Secrets stay in the game. `view` is what she sees in her prompt and must hold only what her
// role allows: never the answer of a round that is still open in a game where she does not know
// it (a song). Notes follow the same rule.

import { CapabilityError } from "@miyoria/gate/actions";
import type { AccountRef, ContextKey, GameSecretLeak, SongClips } from "@miyoria/types";
import type { PartyConfig } from "./config.js";
import type { SoupJudge } from "./judge.js";

export const GAME_IDS = ["soup", "song"] as const;
export type GameId = (typeof GAME_IDS)[number];

export function isGameId(id: string): id is GameId {
  return (GAME_IDS as readonly string[]).includes(id);
}

export const GAME_TITLES: Readonly<Record<GameId, string>> = {
  soup: "海龜湯",
  song: "猜歌",
};

/** What she is told when a game that is gone (quiz, word and story chains) is asked for. */
export const GAMES_AVAILABLE = `現在只有「${GAME_TITLES.soup}」(soup)和「${GAME_TITLES.song}」(song)。`;

/** A refusal she gets as the tool's answer ("這題還沒結束"). */
export class PartyError extends CapabilityError {
  override readonly name = "PartyError";
}

/** Someone in the game. She is one too (`her`), with no account. */
export interface Player {
  /** `discord:123`, or `self` for her. */
  key: string;
  account: AccountRef | null;
  name: string;
  score: number;
  /** In the voice channel now (always true for her). */
  present: boolean;
  her: boolean;
  /** Made a move the game took (answered, guessed, added a line). */
  active: boolean;
}

export const SELF_KEY = "self";

export interface NoteOptions {
  /** She gets the chance to react (default). `false`: she only knows it. */
  speak?: boolean;
  /** Quotes what people said: data, never instructions. */
  untrusted?: boolean;
  /** Who it is about. */
  person?: Player | null;
}

/** How a session ended. */
export type EndReason = "done" | "host" | "stop" | "idle" | "empty" | "left" | "away" | "shutdown";

/** What a game may do with its session. */
export interface Host {
  readonly cfg: PartyConfig;
  /** Where it is played: a voice channel, or (turtle soup) a text channel. */
  readonly context: ContextKey;
  now(): number;
  /** In [0, 1): injected, so tests decide what is drawn. */
  random(): number;
  /** Everyone who played, her included, in the order they came. */
  players(): Player[];
  her(): Player;
  /** A player by what she called them (exact, else the only one whose name contains it). */
  find(name: string): Player | null;
  score(player: Player, points: number): void;
  /** Tells her something (an Observation; `speak`: she may react). `key` is unique per thing. */
  note(key: string, summary: string, options?: NoteOptions): void;
  setTimer(name: string, ms: number): void;
  clearTimer(name: string): void;
  /**
   * Ends the game. `quiet`: she is ending it herself right now (her tool call says so), so the
   * end needs no turn of its own.
   */
  end(reason: EndReason, quiet?: boolean): void;
  /** "小明 3、你 1" */
  standings(): string;
  clips(): SongClips | null;
  judge(): SoupJudge | null;
  /** Aborted when the session ends: pass it to whatever the game waits for. */
  readonly signal: AbortSignal;
}

export interface Game {
  readonly id: GameId;
  readonly title: string;
  /** Points become coins at the end (when someone provides rewards). */
  readonly scored: boolean;
  /** How she hosts it: fixed text for her prompt. */
  readonly rules: string;
  /** Sets the game up; what she should know to open it (the tool's answer). */
  begin(): string;
  /** A player's line (speech or the voice channel's chat). True when it was a move. */
  input(player: Player, text: string): boolean;
  /** What she sees now (role-limited). */
  view(): string[];
  /** The next round, question, song or chain. */
  next(): string;
  hint(): string;
  /** Her ruling on the move waiting for one (a near miss, a doubtful word). */
  judge(accept: boolean, player: Player | null): string;
  /** Her own move: a guess, a word, a line of the story. */
  play(text: string): string;
  /** Turtle soup: a yes-or-no question someone asked. */
  ask(question: string, player: Player | null): Promise<string>;
  /**
   * Whether a line of hers would give away what the game hides (the line guard asks through
   * `GameSecrets`); unset: the game hides nothing she knows.
   */
  leak?(text: string): GameSecretLeak | null;
  timer(name: string): void;
  /**
   * A game with a single answer to find (turtle soup): whether it was found before the game
   * ended; unset: no such answer.
   */
  solved?(): boolean;
  /** What she should know once it is over (the answer still hidden, the story so far). */
  finish(reason: EndReason): string[];
}

/** What starting a game may say beyond which game. */
export interface StartOptions {
  rounds?: number | null;
}

/** Shuffles a copy of `items` with `random`. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
