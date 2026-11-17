// Time together in her voice channel and the songs people heard her sing, read off the bus
// (`voice.joined`, `voice.participants`, `voice.left`, `sing.cue`) as the economy's earnings read
// them. Each becomes evidence for her nightly reflection on the person (docs/design/v5-heart.md
// §2.3): one `voice_together` per person and stay in her voice channel (from when both were there
// to when either left, in whole minutes), and one `heard_song` per person who was there when a
// song started and still was when she sang it to the end.
//
// Pure bookkeeping on the times it is given; the module resolves accounts and writes.

import {
  type AccountRef,
  accountRefString,
  type ContextKey,
  contextKeyEquals,
  type VoiceParticipant,
} from "@miyoria/types";

/** A stay shorter than this is not evidence of anything. */
export const MIN_TOGETHER_MS = 60_000;

/** One person's stay in her voice channel that ended. */
export interface StayEnded {
  account: AccountRef;
  context: ContextKey;
  minutes: number;
  /** Epoch ms it ended. */
  at: number;
}

/** One person who heard a song to the end. */
export interface SongHeard {
  account: AccountRef;
  context: ContextKey;
  title: string;
  at: number;
}

interface Voice {
  context: ContextKey;
  /** Account key → the account and when the stay with her began. */
  since: Map<string, { account: AccountRef; at: number }>;
}

/** Who is with her in voice, and since when. */
export class Together {
  #voice: Voice | null = null;
  /** Who was there when the song now playing started. */
  #listening: Set<string> | null = null;
  #title = "";

  /** Whose stay with her ended. */
  constructor(private readonly ended: (stay: StayEnded) => void) {}

  /** She joined `context` with `participants` (a stay elsewhere ends first). */
  joined(context: ContextKey, participants: readonly VoiceParticipant[], now: number): void {
    if (this.#voice !== null) this.#endAll(now);
    this.#voice = { context, since: new Map() };
    this.#update(participants, now);
  }

  /**
   * Who is in her voice channel now. A list of another channel means she was moved there: every
   * stay in the old one ends, and the new one's begin.
   */
  participants(context: ContextKey, participants: readonly VoiceParticipant[], now: number): void {
    if (this.#voice !== null && !contextKeyEquals(this.#voice.context, context)) {
      this.#endAll(now);
      this.#voice = null;
      this.#listening = null;
    }
    if (this.#voice === null) this.#voice = { context, since: new Map() };
    this.#update(participants, now);
  }

  /** She left `context`: every stay there ends. */
  left(context: ContextKey, now: number): void {
    if (this.#voice === null || !contextKeyEquals(this.#voice.context, context)) return;
    this.#endAll(now);
    this.#voice = null;
    this.#listening = null;
  }

  /** A song started: who is there now may hear it. */
  songStarted(title: string): void {
    this.#title = title;
    this.#listening = new Set(this.#voice?.since.keys() ?? []);
  }

  /** The song ended; with `finished`, whoever was there for all of it heard it. */
  songEnded(finished: boolean, title: string, now: number): SongHeard[] {
    const listening = this.#listening;
    const voice = this.#voice;
    this.#listening = null;
    if (!finished || listening === null || voice === null) return [];
    const out: SongHeard[] = [];
    for (const key of listening) {
      const stay = voice.since.get(key);
      if (stay === undefined) continue;
      out.push({
        account: stay.account,
        context: voice.context,
        title: title || this.#title,
        at: now,
      });
    }
    return out;
  }

  #update(participants: readonly VoiceParticipant[], now: number): void {
    const voice = this.#voice;
    if (voice === null) return;
    const present = new Map<string, AccountRef>();
    for (const p of participants) {
      if (p.is_self) continue;
      present.set(accountRefString(p.account), p.account);
    }
    for (const [key, stay] of voice.since) {
      if (present.has(key)) continue;
      voice.since.delete(key);
      this.#end(stay.account, voice.context, stay.at, now);
    }
    for (const [key, account] of present) {
      if (!voice.since.has(key)) voice.since.set(key, { account, at: now });
    }
  }

  #endAll(now: number): void {
    const voice = this.#voice;
    if (voice === null) return;
    for (const stay of voice.since.values()) this.#end(stay.account, voice.context, stay.at, now);
    voice.since.clear();
  }

  #end(account: AccountRef, context: ContextKey, from: number, now: number): void {
    const ms = now - from;
    if (ms < MIN_TOGETHER_MS) return;
    this.ended({ account, context, minutes: Math.round(ms / 60_000), at: now });
  }
}
