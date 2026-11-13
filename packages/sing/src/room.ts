// Prompt section `voice_room` (「語音頻道現場」): who is in the voice channel she is in, who can
// hear her, who came in or left a moment ago, and which of the open songs each person asked for.
//
// 2026-11-11 she asked for it herself, in a text channel: a panel that shows who is listening,
// who asked for what and who just left, so she stops guessing who is still there and singing to
// nobody. A text turn had no view of the voice channel at all; a voice turn had the people but
// not who left or who asked for which song.
//
// The block is shown on every turn in the guild she is in voice in (text and voice). On a voice
// turn the people block already lists who is there, so the listener line is left out there.

import {
  type AccountRef,
  type ContextKey,
  type Event,
  type PromptContributor,
  type PromptRequest,
  type PromptSection,
  safeName,
  sameAccount,
  type VoiceParticipant,
} from "@miyoria/types";
import type { SongEntry } from "./setlist.js";

export const ROOM_PROMPT_KEY = "voice_room";
/** How long someone who came in or left is mentioned. */
export const ROOM_RECENT_MS = 15 * 60_000;
/** People named per line, at most. */
const MAX_NAMES = 12;
/** Comings and goings kept per guild. */
const MAX_MOVES = 6;

interface Member {
  account: AccountRef;
  name: string;
  deafened: boolean;
  /** When they came in; `null` when they were there before she came. */
  since: number | null;
}

interface Departure {
  account: AccountRef;
  name: string;
  at: number;
}

interface Room {
  context: ContextKey;
  members: Member[];
  left: Departure[];
}

/** The voice channels she is in, one per guild, from `voice.*` events. */
export class VoiceRoom {
  readonly #rooms = new Map<string, Room>();

  /** `now`: epoch milliseconds (the module's clock). */
  constructor(readonly now: () => number) {}

  onEvent(event: Event): void {
    switch (event.type) {
      case "voice_joined": {
        const { context, participants } = event.data;
        if (context.scope === null) return;
        this.#rooms.set(context.scope, {
          context,
          members: others(participants).map((p) => member(p, null)),
          left: [],
        });
        return;
      }
      case "voice_participants": {
        const { context, participants } = event.data;
        if (context.scope === null) return;
        const room = this.#rooms.get(context.scope);
        if (!room) {
          // Joined before this module saw it: everyone counts as already there.
          this.#rooms.set(context.scope, {
            context,
            members: others(participants).map((p) => member(p, null)),
            left: [],
          });
          return;
        }
        this.#update(room, context, others(participants));
        return;
      }
      case "voice_left": {
        const scope = event.data.context.scope;
        if (scope !== null) this.#rooms.delete(scope);
        return;
      }
      default:
        return;
    }
  }

  /** The room in `guild`, or `null` when she is not in voice there. */
  room(guild: string | null): Readonly<Room> | null {
    if (guild === null) return null;
    return this.#rooms.get(guild) ?? null;
  }

  /**
   * Whether `who` is in her voice channel of `guild`: `null` when she is not in voice there or
   * the account is of another platform (a web viewer is never in a Discord channel).
   */
  present(guild: string, who: AccountRef): boolean | null {
    const room = this.#rooms.get(guild);
    if (!room || who.platform !== room.context.platform) return null;
    return room.members.some((m) => sameAccount(m.account, who));
  }

  #update(room: Room, context: ContextKey, now: readonly VoiceParticipant[]): void {
    const at = this.now();
    if (room.context.channel !== context.channel) {
      // She moved to another channel of the guild: a new room.
      room.context = context;
      room.members = now.map((p) => member(p, null));
      room.left = [];
      return;
    }
    const next: Member[] = [];
    for (const p of now) {
      const before = room.members.find((m) => sameAccount(m.account, p.account));
      if (before) {
        next.push({ ...before, name: p.display_name, deafened: p.deafened });
      } else {
        next.push(member(p, at));
        // Back again: no longer "just left".
        room.left = room.left.filter((d) => !sameAccount(d.account, p.account));
      }
    }
    for (const m of room.members) {
      if (!now.some((p) => sameAccount(p.account, m.account))) {
        room.left = room.left.filter((d) => !sameAccount(d.account, m.account));
        room.left.push({ account: m.account, name: m.name, at });
      }
    }
    room.left = room.left.filter((d) => at - d.at < ROOM_RECENT_MS).slice(-MAX_MOVES);
    room.members = next;
  }
}

function others(participants: readonly VoiceParticipant[]): VoiceParticipant[] {
  return participants.filter((p) => !p.is_self);
}

function member(p: VoiceParticipant, since: number | null): Member {
  return { account: p.account, name: p.display_name, deafened: p.deafened, since };
}

function ago(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60_000);
  return minutes < 1 ? "剛剛" : `${minutes} 分鐘前`;
}

function names(list: readonly string[]): string {
  const shown = list.slice(0, MAX_NAMES).join("、");
  return list.length > MAX_NAMES ? `${shown} 等 ${list.length} 人` : shown;
}

/** `#2(正在唱)、#4`: the open songs of one requester. */
function songsOf(entries: readonly SongEntry[], who: AccountRef): string {
  return entries
    .filter((e) => e.requester !== null && sameAccount(e.requester, who))
    .map((e) => `#${e.no}${e.state === "playing" ? "(正在唱)" : ""}`)
    .join("、");
}

/** The block's lines for a room at `now`; empty when there is nothing to say. */
export function roomLines(
  room: Readonly<Room>,
  entries: readonly SongEntry[],
  now: number,
  voice: boolean,
): string[] {
  const who = (name: string) => safeName(name, 24);
  const tagged = (m: Member) => {
    const songs = songsOf(entries, m.account);
    return songs === "" ? who(m.name) : `${who(m.name)}(點了 ${songs})`;
  };
  const lines: string[] = [];
  const hearing = room.members.filter((m) => !m.deafened);
  const deaf = room.members.filter((m) => m.deafened);
  if (room.members.length === 0) {
    lines.push("語音頻道裡除了你沒有別人,現在唱或說話都沒人聽得到。");
  } else if (!voice) {
    lines.push(
      hearing.length === 0
        ? "語音頻道裡的人都關了喇叭,現在沒人聽得到你。"
        : `在聽(${hearing.length} 人):${names(hearing.map(tagged))}`,
    );
  } else {
    // The people block names everyone; only who asked for which song is added here.
    const asked = hearing.filter((m) => songsOf(entries, m.account) !== "");
    if (asked.length > 0) lines.push(`點了歌的人:${names(asked.map(tagged))}`);
    if (hearing.length === 0) lines.push("語音頻道裡的人都關了喇叭,現在沒人聽得到你。");
  }
  if (deaf.length > 0 && hearing.length > 0) {
    lines.push(`關了喇叭、聽不到你:${names(deaf.map(tagged))}`);
  }
  // Each coming and going is a line of its own, newest first (she asked for it that way).
  const moves = [
    ...room.members.flatMap((m) =>
      m.since === null ? [] : [{ at: m.since, line: `${who(m.name)} 進來了` }],
    ),
    ...room.left.map((d) => {
      const songs = songsOf(entries, d.account);
      const note = songs === "" ? "" : `(點的 ${songs} 還沒唱完)`;
      return { at: d.at, line: `${who(d.name)} 離開了${note}` };
    }),
  ]
    .filter((m) => now - m.at < ROOM_RECENT_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_MOVES);
  if (moves.length > 0) {
    lines.push("剛剛的進出:");
    for (const m of moves) lines.push(`- ${ago(now - m.at)} ${m.line}`);
  }
  // Songs whose requester is not in the channel (left, or asked from a text channel).
  const away = entries.filter(
    (e) =>
      e.requester !== null &&
      !room.members.some((m) => e.requester !== null && sameAccount(m.account, e.requester)),
  );
  if (away.length > 0) {
    const list = away.map((e) => `#${e.no}(${who(e.requester_name)})`);
    lines.push(`點歌的人不在語音裡:${names(list)}。要唱可以先問一聲或等對方回來。`);
  }
  return lines;
}

/** The open songs, as the room block reads them. */
export interface RoomSongs {
  open(): readonly SongEntry[];
}

export class VoiceRoomPrompt implements PromptContributor {
  readonly key = ROOM_PROMPT_KEY;

  constructor(
    private readonly room: VoiceRoom,
    private readonly songs: RoomSongs,
  ) {}

  async contribute(request: PromptRequest): Promise<PromptSection[]> {
    const room = this.room.room(request.context.scope);
    if (room === null || room.context.platform !== request.context.platform) return [];
    const lines = roomLines(room, this.songs.open(), this.room.now(), request.voice);
    if (lines.length === 0) return [];
    return [{ key: ROOM_PROMPT_KEY, title: "語音頻道現場", body: lines.join("\n"), order: 47 }];
  }
}
