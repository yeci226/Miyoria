import {
  type AccountRef,
  type ActionId,
  type Attachment,
  type Clock,
  type ContextKey,
  type IncomingMessage,
  incomingText,
  systemClock,
  type TurnId,
  timestampMs,
  type VoiceParticipant,
} from "@miyoria/types";
import { accountId } from "./util.js";

/** A speaking signal older than this is treated as lost. */
const SPEAKING_STALE_MS = 30_000;

export interface HistoryEntry {
  /** Platform message id (`null` for her replies until their echo arrives). */
  id: string | null;
  /** Id of the message this one replies to. */
  replyTo: string | null;
  /**
   * The messages it replies to that are not in the history (the direct parent last), fetched
   * or delivered with the reply; shown as quoted lines before it.
   */
  parents: HistoryEntry[];
  author: string;
  account: AccountRef;
  /** Written by a bot account (not hers). */
  isBot: boolean;
  /** Text with stickers, embeds, attachments and forwards noted inline (`incomingText`). */
  text: string;
  /** Kept for the images she may look at. */
  attachments: Attachment[];
  /** Epoch ms. */
  ts: number;
  isSelf: boolean;
  /** Her message was submitted as this action and not yet seen echoed back. */
  pending: ActionId | null;
  /** Said out loud in a voice channel (a transcript, or her speech). */
  spoken: boolean;
  /** Her speech was cut off before she finished. */
  interrupted: boolean;
  /** The turn her speech belongs to. */
  turn: TurnId | null;
  /** The input defence flagged it, with this note: it is shown as data, beside the note. */
  flagged?: string | null;
  /** One of the messages the current turn answers (set on a copy while building the prompt). */
  current?: boolean;
  /** With `current`: how the focus block introduces it (`問你`, `回你`, `接著說`, `說`). */
  focusVerb?: string;
  /** A quoted parent whose time is not known (`ts` is the reply's), so no "how long ago". */
  undated?: boolean;
  /** On a quoted direct parent: the lines around it in its channel, shown with it. */
  around?: { before: HistoryEntry[]; after: HistoryEntry[] };
}

/** Someone else seen in a context (Rust `session::Participant`). */
export interface SessionParticipant {
  account: AccountRef;
  displayName: string;
  /** Epoch ms. */
  lastSeen: number;
}

/** Short-term working memory of one conversation context. */
export class Session {
  readonly context: ContextKey;
  readonly #limit: number;
  readonly #clock: Clock;
  readonly #history: HistoryEntry[] = [];
  /** Keyed by account; insertion order = most recently active last. */
  readonly #participants = new Map<string, SessionParticipant>();
  #lastSelfAt: number | null = null;
  /** Who is in the voice channel (voice contexts only). */
  #voiceMembers: VoiceParticipant[] = [];
  /** People currently speaking, with when they started (clock ms). */
  readonly #speaking = new Map<string, number>();
  /**
   * Earlier messages being fetched because the session started cold (`history.ts`), and when
   * the fetch started (clock ms). Turns wait for it, but not past the history timeout.
   */
  warmup: { done: Promise<void>; startedAt: number } | null = null;
  /** When the session started (clock ms): which example dialogues it shows (main line). */
  readonly startedAt: number;
  /**
   * Time of the first history line the main line's prompt shows (`null`: not set yet). It only
   * moves forward, and only in steps (`historyWindow`), so the prompt's prefix stays cached.
   */
  promptStart: number | null = null;

  constructor(context: ContextKey, limit: number, clock: Clock = systemClock) {
    this.context = context;
    this.#limit = Math.max(limit, 1);
    this.#clock = clock;
    this.startedAt = clock.now();
  }

  /**
   * Records a platform message. Her own messages that echo a submitted reply confirm the
   * existing entry instead of adding a duplicate.
   */
  recordMessage(msg: IncomingMessage, isSelf: boolean): void {
    this.#record(msg, isSelf, false);
  }

  /** Records a transcribed voice utterance of someone else. */
  recordUtterance(msg: IncomingMessage): void {
    this.#record(msg, false, true);
  }

  /** The input defence flagged message `id`. */
  flag(id: string, note: string): void {
    const entry = this.#history.findLast((e) => e.id === id);
    if (entry) entry.flagged = note;
  }

  #record(msg: IncomingMessage, isSelf: boolean, spoken: boolean): void {
    const entry = historyEntry(msg, isSelf, spoken);
    if (isSelf) {
      const ts = entry.ts;
      this.#lastSelfAt = this.#lastSelfAt === null ? ts : Math.max(this.#lastSelfAt, ts);
      const echo = this.#history.find(
        (e) => e.pending !== null && e.text.trim() === entry.text.trim(),
      );
      if (echo) {
        echo.pending = null;
        echo.account = msg.author.account;
        echo.id = entry.id;
        return;
      }
    } else {
      this.#seen(msg.author.account, msg.author.display_name, entry.ts, true);
    }
    this.#push(entry);
  }

  #seen(account: AccountRef, displayName: string, ts: number, live: boolean): void {
    const key = accountId(account);
    const known = this.#participants.get(key);
    if (!live && known !== undefined) return;
    this.#participants.delete(key);
    this.#participants.set(key, { account, displayName, lastSeen: ts });
  }

  /**
   * Adds earlier messages fetched after the session started (`isSelf` tells which are hers).
   * Messages already in the history (same id) are skipped; the rest are merged in by time, and
   * the history stays within its limit (the oldest go). Returns how many were added.
   */
  backfill(messages: readonly [IncomingMessage, boolean][]): number {
    const known = new Set(this.#history.flatMap((e) => (e.id === null ? [] : [e.id])));
    const added: HistoryEntry[] = [];
    for (const [msg, isSelf] of messages) {
      if (known.has(msg.id.id)) continue;
      known.add(msg.id.id);
      const entry = historyEntry(msg, isSelf, false);
      if (isSelf) {
        this.#lastSelfAt =
          this.#lastSelfAt === null ? entry.ts : Math.max(this.#lastSelfAt, entry.ts);
      } else {
        this.#seen(msg.author.account, msg.author.display_name, entry.ts, false);
      }
      added.push(entry);
    }
    if (added.length === 0) return 0;
    // Stable: live entries keep their order, backfilled ones go before equal timestamps.
    const merged = [...added, ...this.#history]
      .map((e, i) => [e, i] as const)
      .sort(([a, i], [b, j]) => a.ts - b.ts || i - j)
      .map(([e]) => e);
    this.#history.splice(0, this.#history.length, ...merged);
    while (this.#history.length > this.#limit) this.#history.shift();
    return added.length;
  }

  /** The entry of platform message `id`, if it is in the history. */
  entry(id: string): HistoryEntry | undefined {
    return this.#history.find((e) => e.id === id);
  }

  /**
   * Notes the parents of message `id` that are not in the history (oldest first), to show them
   * as quoted lines before it.
   */
  setParents(id: string, parents: HistoryEntry[]): void {
    const entry = this.entry(id);
    if (entry) entry.parents = parents;
  }

  /** Records a reply she just submitted (`ts` epoch ms). */
  recordOwn(author: string, account: AccountRef, text: string, action: ActionId, ts: number): void {
    this.#lastSelfAt = ts;
    this.#push({ ...ownEntry(author, account, text, ts), pending: action });
  }

  /**
   * Records a sentence of hers that started playing. Sentences of the same turn are joined
   * into one entry.
   */
  recordSpeech(
    author: string,
    account: AccountRef,
    text: string,
    turn: TurnId | null,
    ts: number,
  ): void {
    this.noteSelfSpoke(ts);
    const trimmed = text.trim();
    if (trimmed === "") return;
    const last = this.#history.at(-1);
    if (last?.isSelf && last.spoken && !last.interrupted && turn !== null && last.turn === turn) {
      last.text += trimmed;
      return;
    }
    this.#push({ ...ownEntry(author, account, trimmed, ts), spoken: true, turn });
  }

  /**
   * Marks her speech of `turn` as cut off. Without a matching entry (the start was missed)
   * `text` is recorded as interrupted speech.
   */
  recordInterruption(
    author: string,
    account: AccountRef,
    text: string,
    turn: TurnId | null,
    ts: number,
  ): void {
    const found = this.#history.findLast(
      (e) => e.isSelf && e.spoken && turn !== null && e.turn === turn,
    );
    if (found) {
      found.interrupted = true;
    } else {
      this.recordSpeech(author, account, text, turn, ts);
      const last = this.#history.at(-1);
      if (last?.isSelf) last.interrupted = true;
    }
    this.noteSelfSpoke(ts);
  }

  /**
   * Of a sentence of `turn` only `heard` reached anyone: her history keeps that much of it (a
   * sentence nobody heard is taken out altogether, and an entry left empty with it).
   */
  keepHeard(turn: TurnId | null, text: string, heard: string): void {
    if (turn === null) return;
    const found = this.#history.findLast((e) => e.isSelf && e.spoken && e.turn === turn);
    const said = text.trim();
    if (!found || said === "") return;
    const at = found.text.lastIndexOf(said);
    if (at < 0) return;
    found.text = `${found.text.slice(0, at)}${heard}${found.text.slice(at + said.length)}`;
    if (found.text.trim() === "") this.#history.splice(this.#history.indexOf(found), 1);
  }

  /**
   * Her speech of `turn` was recorded with its spoken line (`spoken`, a line sent to TTS before
   * its written sentence existed): the written sentence replaces it. Returns whether it was
   * found.
   */
  replaceSpoken(turn: TurnId, spoken: string, written: string): boolean {
    const from = spoken.trim();
    if (from === "") return false;
    const found = this.#history.findLast(
      (e) => e.isSelf && e.spoken && e.turn === turn && e.text.includes(from),
    );
    if (!found) return false;
    found.text = found.text.replace(from, written.trim());
    return true;
  }

  /** She was talking at `ts` (start or end of her speech). */
  noteSelfSpoke(ts: number): void {
    this.#lastSelfAt = this.#lastSelfAt === null ? ts : Math.max(this.#lastSelfAt, ts);
  }

  /** Removes a submitted reply that was never delivered. */
  forgetAction(action: ActionId): void {
    for (let i = this.#history.length - 1; i >= 0; i--) {
      if (this.#history[i]?.pending === action) this.#history.splice(i, 1);
    }
    this.#lastSelfAt = this.#history.findLast((e) => e.isSelf)?.ts ?? null;
  }

  #push(entry: HistoryEntry): void {
    this.#history.push(entry);
    while (this.#history.length > this.#limit) this.#history.shift();
  }

  history(): readonly HistoryEntry[] {
    return this.#history;
  }

  /** The last `n` entries, oldest first. */
  recent(n: number): HistoryEntry[] {
    return this.#history.slice(Math.max(this.#history.length - n, 0));
  }

  /** Up to `before` lines before entry `id` and `after` lines after it (none if unknown). */
  around(
    id: string,
    before: number,
    after: number,
  ): { before: HistoryEntry[]; after: HistoryEntry[] } {
    const i = this.#history.findIndex((e) => e.id === id);
    if (i < 0) return { before: [], after: [] };
    return {
      before: this.#history.slice(Math.max(i - before, 0), i),
      after: this.#history.slice(i + 1, i + 1 + after),
    };
  }

  /** Epoch ms of her last words, if any. */
  lastSelfAt(): number | null {
    return this.#lastSelfAt;
  }

  /**
   * Her share of the last `window` messages. Short histories count as if padded to `window`,
   * so one early reply does not trip the limit.
   */
  selfShare(window: number): number {
    const w = Math.max(window, 1);
    const own = this.recent(w).filter((e) => e.isSelf).length;
    return own / w;
  }

  /** Other people seen in this context, most recently active first. */
  participants(): SessionParticipant[] {
    return [...this.#participants.values()].reverse().sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Replaces the voice channel roster; people who left stop speaking. */
  setVoiceMembers(members: VoiceParticipant[]): void {
    for (const key of [...this.#speaking.keys()]) {
      if (!members.some((m) => accountId(m.account) === key)) this.#speaking.delete(key);
    }
    this.#voiceMembers = members;
  }

  voiceMembers(): readonly VoiceParticipant[] {
    return this.#voiceMembers;
  }

  /**
   * The people in the voice channel who can hear her: not deafened. 2026-11-08: she finished a
   * song in an empty channel and said out loud that nobody seemed to have heard it.
   */
  listeners(): readonly VoiceParticipant[] {
    return this.#voiceMembers.filter((m) => !m.deafened);
  }

  setSpeaking(account: AccountRef, speaking: boolean): void {
    const key = accountId(account);
    if (speaking) {
      if (!this.#speaking.has(key)) this.#speaking.set(key, this.#clock.now());
    } else {
      this.#speaking.delete(key);
    }
  }

  /** Someone else is speaking right now (signals older than 30 s are considered lost). */
  someoneSpeaking(): boolean {
    const now = this.#clock.now();
    for (const since of this.#speaking.values()) {
      if (Math.max(now - since, 0) < SPEAKING_STALE_MS) return true;
    }
    return false;
  }
}

/** Message text as shown in history; attachments are noted inline. */
export function messageText(msg: IncomingMessage): string {
  return incomingText(msg);
}

/** A history entry for a platform message (no parents yet). */
export function historyEntry(msg: IncomingMessage, isSelf: boolean, spoken: boolean): HistoryEntry {
  return {
    id: msg.id.id,
    replyTo: msg.reply_to?.id ?? null,
    parents: [],
    author: msg.author.display_name,
    account: msg.author.account,
    isBot: msg.author.is_bot,
    text: messageText(msg),
    attachments: [...msg.attachments, ...(msg.forwarded ?? []).flatMap((f) => f.attachments)],
    ts: timestampMs(msg.ts),
    isSelf,
    pending: null,
    spoken,
    interrupted: false,
    turn: null,
  };
}

/** A line of hers (not yet confirmed by the platform). */
function ownEntry(author: string, account: AccountRef, text: string, ts: number): HistoryEntry {
  return {
    id: null,
    replyTo: null,
    parents: [],
    author,
    account,
    isBot: false,
    text,
    attachments: [],
    ts,
    isSelf: true,
    pending: null,
    spoken: false,
    interrupted: false,
    turn: null,
  };
}
