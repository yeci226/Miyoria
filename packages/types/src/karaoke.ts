// How karaoke reaches the song workers (docs/design/karaoke.md §3, §13): a port the singing module
// provides over the workers it already follows (the registry's `sing` endpoints, with their
// failover), and the karaoke plugin (`@miyoria/play/karaoke`) uses, so neither package depends on
// the other and there is one worker client.

import type {
  WorkersKaraokeStreamAnswer,
  WorkersKaraokeStreamRequest,
  WorkersKaraokeVoicePitch,
  WorkersSingJob,
} from "@miyoria/contracts/workers";
import type { AccountRef } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/**
 * A karaoke file of a prepared song (`KARAOKE_FILES` of the worker contract), or its backing in
 * another key (`karaokeBackingName`: `karaoke.k+3.m4a`).
 */
export type KaraokeFileName =
  | "karaoke.m4a"
  | "reference.json"
  | "video.mp4"
  | `karaoke.k${"+" | "-"}${number}.m4a`
  /** The backing as the voice node plays it (`karaokePlayName`), made by the worker when asked. */
  | "play_karaoke.pcm"
  | `play_karaoke.k${"+" | "-"}${number}.pcm`;

/** How a song's lyrics are checked and aligned (`WorkersKaraokeLyricsOptions`). */
export interface KaraokeLyricsOptions {
  aligner: "w2v" | "mms";
  matched: number;
  uncertain: number;
  keep_share: number;
  wrong_share: number;
}

/** What a karaoke preparation is asked for: a link (the worker's allowed hosts) or a search. */
export interface KaraokeQuery {
  url?: string;
  query?: string;
  title?: string;
  artist?: string;
  /** Make it again even when the worker has it. */
  force?: boolean;
  /** How its lyrics are checked and aligned; left out, the worker's defaults. */
  lyrics?: KaraokeLyricsOptions;
  /** Keep the source's picture as a background video (`video.mp4`); left out, yes. */
  video?: boolean;
}

/** A singer's recording, sent once to have its pitch read (`POST /karaoke/voice`). */
export interface KaraokeVoice {
  bytes: Uint8Array;
  /** `audio/webm`, `audio/ogg`, `audio/mp4` (or `audio/wav`). */
  type: string;
}

export interface KaraokeWorker {
  /** Starts a karaoke job (`purpose: "karaoke"`) on the first worker that answers. */
  prepare(query: KaraokeQuery, signal?: AbortSignal): Promise<WorkersSingJob>;
  /** A job's state; once `done`, `job.karaoke` is the song. A 404 error: the worker lost it. */
  job(id: string, signal?: AbortSignal): Promise<WorkersSingJob>;
  cancel(id: string): Promise<void>;
  /** Saves one of a karaoke song's files to `dest`, from the worker that made it. */
  file(song: string, name: KaraokeFileName, dest: string, signal?: AbortSignal): Promise<void>;
  /**
   * Has the worker that made the song render its backing `semitones` away (made once, kept with
   * the song); the answer names the file to fetch with `file`.
   */
  key(song: string, semitones: number, signal?: AbortSignal): Promise<{ file: string }>;
  /**
   * The pitch of a singer's recording (RMVPE on any worker that answers, 50 Hz from its first
   * sample). The worker deletes the recording before it answers.
   */
  voice(voice: KaraokeVoice, signal?: AbortSignal): Promise<WorkersKaraokeVoicePitch>;
  /**
   * One batch of a room's live voice streams (`POST /karaoke/stream`), always to the same worker
   * for the same room (the streams live there). Throws `{ status: 404 }` when that worker has no
   * such endpoint (older code): the room then scores from estimates and recordings.
   */
  stream?(
    request: WorkersKaraokeStreamRequest,
    signal?: AbortSignal,
  ): Promise<WorkersKaraokeStreamAnswer>;
}

export const KaraokeWorkerKey = serviceKey<KaraokeWorker>("KaraokeWorker");

// ---- coins of karaoke rooms (docs/design/karaoke.md 「做了什麼第四步」) ----------------------------

/** The ledger reasons of karaoke rooms (statements and the health table read them). */
export const KARAOKE_REASONS = {
  /** Opening a room: burned. */
  room: "karaoke_room",
  /** The opening given back (no round of the room was sung through). */
  roomRefund: "karaoke_room_refund",
  /** The winner of a round. */
  prize: "karaoke_prize",
  /** Singing a round through. */
  finish: "karaoke_finish",
} as const;

/** What a payout of a round is. */
export type KaraokePayoutKind = "prize" | "finish";

/** A charge: `receipt` is its ledger row, or why not (as `MarketCharge`). */
export type KaraokeCharge =
  | { ok: true; receipt: string; balance: number }
  | { ok: false; reason: "insufficient"; balance: number | null }
  | { ok: false; reason: "refused"; message: string };

/**
 * What became of a payout: `paid` now, `duplicate` (paid before under this key), `capped` (the
 * person's daily count of this kind is reached: nothing paid), `refused` (a stranger or someone
 * she blocked: nothing paid).
 */
export type KaraokePaid = { status: "paid" | "duplicate" | "capped" | "refused"; paid: number };

/**
 * The wallet karaoke rooms are paid through, provided by the economy (the market wallet's pattern):
 * every movement is one ledger row of its own reason, keyed so a retry is the same row, run in
 * turn with every other spend. Coins are only earned, never bought; nothing here buys bond.
 */
export interface KaraokeWallet {
  readonly currency: string;
  /** Their balance; `null` when their wallet cannot be used (a stranger, blocked). */
  balance(account: AccountRef): Promise<number | null>;
  /** Takes `amount` to open a room under `key` (the room); the same key is the same charge. */
  charge(
    account: AccountRef,
    amount: number,
    key: string,
    ref: string | null,
  ): Promise<KaraokeCharge>;
  /** Whether the charge under `key` stands (taken and not given back). */
  charged(account: AccountRef, key: string): Promise<boolean>;
  /**
   * Gives back the charge under `key`, once: the coins given back (0 when nothing was charged or
   * it was given back already). Reaches someone blocked since: what was taken is theirs.
   */
  refund(account: AccountRef, key: string): Promise<number>;
  /**
   * Pays `amount` of `kind` under `key` (room, round and person), once; at most `perDay` rows of
   * that kind for the person since `since`.
   */
  pay(
    account: AccountRef,
    kind: KaraokePayoutKind,
    amount: number,
    key: string,
    ref: string | null,
    cap: { since: Timestamp; perDay: number },
  ): Promise<KaraokePaid>;
}

export const KaraokeWalletKey = serviceKey<KaraokeWallet>("KaraokeWallet");
