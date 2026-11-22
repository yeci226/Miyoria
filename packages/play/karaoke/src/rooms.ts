// Karaoke rooms (docs/design/karaoke.md 「做了什麼第四步」): up to `room_singers` people sing the
// same song at the same moment, each in their own browser, while she is in a voice channel and
// hosts. `RoomDesk` holds the rooms in memory and keeps in the store only what the coins need
// across a restart (the room and its opening charge, its rounds, what a settled round pays).
//
//   lobby ──start──▶ countdown ──start_at──▶ singing ──all in / time──▶ results ──start──▶ countdown
//     └───────────── closed: the opener, empty, idle, she left voice, Core restarted ──────────┘
//
// * A room opens with no song (「第四步之後的修改:先開房再點歌」). Everyone in it queues songs, in
//   the lobby and after a round: one from the list (ready, or still being prepared), or a link or a
//   search through the song request (with its daily limit). One still being prepared waits in its
//   place until it is ready; one whose preparation failed is skipped, and dropped when a round
//   starts. Each entry has its own key. Anyone takes out their own, the opener (or a panel admin)
//   any, and orders the queue. A round plays the first ready entry, which leaves the queue then;
//   once the room's rounds are used, the rest is dropped. The queue lives with the room, in memory.
// * A round's singers each get a session of their own (the single-player one, bound to the room);
//   their browser plays the backing from Core's `start_at` with its own latency taken off, and at
//   the end submits its track as alone. While they sing, each browser streams its microphone here
//   (µ-law 16 kHz, a chunk every few hundred ms); every half second the room sends one batch of
//   all its singers' new audio to one song worker, which answers 50 Hz pitch frames; those are
//   scored with the shared module (`StreamScore`) as the running official score, and a stream's
//   final curve is the official result. A stream that stops, falls behind, or a worker that is slow,
//   away or too old drops that singer (or the room) to the browser's estimate; the recording the
//   browser kept is then uploaded at the end, as alone. Audio is never stored or logged.
// * Her stream (step 5): the room the stream shows (`#stage`: a round being sung first, then the
//   latest results, then a lobby) goes to the stage as `karaoke.stage` on every change and with
//   every board; a round's words, video and backing once as `karaoke.stage.lyrics`. The stream's
//   scene plays the backing and at most one singer's voice (`air.ts`), on the room's fixed delay;
//   her own voice connection carries none of it. Whose voice: the round's one singer who asked
//   for it (「讓大家聽到我」), or with two or more singers the leader among those who did not opt
//   out, when the opener turned that on (「播出第一名的歌聲」). A singer of a round with two or
//   more singers is never told whose voice is on (it would tell them they lead).
// * Spectating (「卡拉 OK 第二次實測留下的」): each singer's browser posts its own detected pitch a few
//   times a second (`pitch`: the round's singers only, a few posts a second, within the song and
//   not ahead of Core's clock). It is the estimate's track, and the people watching (`live`, about
//   four times a second) and her stream's lanes (the scene) get its latest second, placed on the
//   reference by the singer's latency. None of it waits on the song worker: on a slow link the
//   board runs on the estimate and the lanes go on. The round's words and notes go to the stream
//   at the start, the video and the backing when they have come.
// * Cheers: someone in the room who is not singing the round cheers one of its singers
//   (`cheer`: 「加油」「好聽」「太強了」「安可」), at most one every `CHEER_GAP_MS` and
//   `CHEER_BURST` a `CHEER_WINDOW_MS` per person, `ROOM_CHEERS_PER_S` a second per room. It goes to
//   everyone not singing, to that singer (never to the other singers), and onto the stream's scene
//   beside that singer's lane.
// * Who sees what is decided here, per connection, not in the page: a singer of the running round
//   only ever gets `trend` about themselves (and the cheers for them); everyone else gets the
//   `board`.
// * Servers (phase 6, docs/design/v5-places.md §10): a room belongs to the Space it was opened in
//   (`RoomPlaces`; the opener's pick on the member page, the server of a command, else the
//   primary). It may open and start only while she is in a voice channel of that Space, and it
//   closes when she leaves that Space's voice; its notice and her notes go to that Space's comment
//   channel (`comment_channel` is per Space). A server first seen after the upgrade has no rooms
//   until its own comment channel is set. Who may join is the code's business, as before: a room
//   is joined by its code or link. The stream's scene is one stage for all of them.
// * Coins (the karaoke wallet): the opening is charged before the room exists (written first as
//   `charging`, so a crash in between still gives it back); a room ends owing it back unless a round
//   was sung through; a settled round writes what it pays in the same transaction as its ranking,
//   then pays it, keyed per room, round and person: a restart pays what is `due` again and the
//   wallet's key makes that the same payment.

import {
  KARAOKE_CHEERS,
  type KaraokeAudioReply,
  type KaraokeBoardLine,
  type KaraokeCheerKind,
  type KaraokeCheerReply,
  type KaraokeClockReply,
  type KaraokeLiveEvent,
  type KaraokeRoomEvent,
  type KaraokeRoomPlace,
  type KaraokeRoomQueueEntry,
  type KaraokeRoomResult,
  type KaraokeRooms,
  type KaraokeRoomTerms,
  type KaraokeRoomView,
  type KaraokeSession,
  type KaraokeVoiceCheck,
} from "@miyoria/contracts/api";
import {
  KARAOKE_BOARD_MAX,
  KARAOKE_CHEERS_MAX,
  KARAOKE_JOIN_URL_MAX,
  KARAOKE_NOTES_MAX,
  KARAOKE_PITCH_MAX_CHARS,
  KARAOKE_QUEUE_MAX,
  type KaraokeStageLine,
  type KaraokeStageLyrics,
  type KaraokeStageScene,
  type KaraokeStageVoice,
} from "@miyoria/contracts/stage-link";
import {
  KARAOKE_FRAME_HZ,
  KARAOKE_MAX_SHIFT,
  KARAOKE_STREAM_MAX_CHUNK,
  KARAOKE_STREAM_RATE,
  shiftKaraokeReference,
  type WorkersKaraokeStreamAnswer,
  type WorkersKaraokeStreamChunk,
  type WorkersKaraokeVoicePitch,
} from "@miyoria/contracts/workers";
import {
  type AccountRef,
  accountRefString,
  type ContextKey,
  type KaraokeWallet,
  type KaraokeWorker,
  newId,
  type PersonId,
  safeName,
  toTimestamp,
} from "@miyoria/types";
import { type AirSinger, lyricGaps, RoomAir } from "./air.js";
import { commentContext, type KaraokeConfig, siteLink } from "./config.js";
import { sungEnd } from "./lyrics/index.js";
import { type RoundLine, roomOpenedNote, roundResultNote, roundStartNote } from "./notes.js";
import {
  cleanPitch,
  DEFAULT_TUNING,
  decodeTrack,
  encodeTrack,
  fromBase64,
  recordingInSong,
  type ScoreResult,
  StreamScore,
  TRACK_HZ,
  toBase64,
} from "./score/index.js";
import {
  KaraokeError,
  type KaraokeNote,
  type KaraokeService,
  type KaraokeWho,
  type RoomLink,
} from "./service.js";
import type { KaraokeStore, PayoutRow, ResultRow, SongRow } from "./store.js";
import { type Trend, TrendTracker } from "./trend.js";

/** How often a room's new audio goes to the song worker. */
export const RELAY_MS = 500;
/** A batch not answered within this is given up (the link is slow: the room goes on). */
export const RELAY_TIMEOUT_MS = 2_500;
/** Batches in a row that fail before the room stops streaming (estimates from then on). */
export const RELAY_FAILURES = 3;
/** A singer whose audio stops this long is scored from their browser's estimate. */
export const STREAM_QUIET_MS = 3_000;
/** Audio waiting to be relayed beyond this (seconds) drops that singer to the estimate. */
const MAX_PENDING_S = 4;
/** A stream may run ahead of the wall clock by this much (seconds), no more. */
const AHEAD_S = 5;
/** One audio POST: at most this many bytes (two seconds of µ-law). */
export const MAX_AUDIO_BYTES = 2 * KARAOKE_STREAM_RATE;
/** Audio POSTs a singer may send per second. */
const AUDIO_PER_S = 8;
/** The board and the trends, this often. */
export const BOARD_MS = 1_000;
/** A singer's running score is recomputed this often (it is `scoreSinging` on the song so far). */
export const RUNNING_MS = 2_000;
/** After the song's length, this long for the last browsers to finish. */
export const END_GRACE_MS = 20_000;
/** After that, official scores are waited for this long at most before the round settles. */
export const SETTLE_WAIT_MS = 90_000;
/**
 * A singer whose live stream gave its final pitch and whose browser sent no result within this is
 * given the result from the stream alone (a hidden tab may never submit); at once after the song.
 */
export const OWN_RESULT_GRACE_MS = 5_000;
/** This long after the song's end on Core's clock, every stream still open is over. */
export const STREAM_END_MS = 5_000;
/** A member not following the room (no open page) for this long has left. */
export const AWAY_MS = 60_000;
/** Frames of a singer's recent pitch kept, and on the board and the stream's scene (2 s). */
const BOARD_PITCH_FRAMES = 100;
/** The pitch posts a singer may send a second (their browser sends about four). */
export const PITCH_PER_S = 8;
/** A pitch frame may be ahead of Core's song clock by this much (s): clocks differ a little. */
export const PITCH_AHEAD_S = 1.5;
/** The singers' latest pitch goes to the people watching (`live`) and the stream this often. */
export const LIVE_MS = 250;
/** Frames of each singer's latest pitch one `live` carries (1 s: a lost one leaves no gap). */
const LIVE_FRAMES = 50;
/**
 * The running official score is used for the board only while the stream's pitch is no more than
 * this far (frames) behind the browser's: a slow worker's lagging number is not shown.
 */
const VOICE_BEHIND_FRAMES = 4 * KARAOKE_FRAME_HZ;
/** One person's cheers: one every `CHEER_GAP_MS`, `CHEER_BURST` in any `CHEER_WINDOW_MS`. */
export const CHEER_GAP_MS = 1_500;
export const CHEER_BURST = 8;
export const CHEER_WINDOW_MS = 20_000;
/** A room's cheers a second, everyone together. */
export const ROOM_CHEERS_PER_S = 6;
/** A cheer stays on the stream's scene this long. */
const CHEER_SHOW_MS = 6_000;
/** µ-law silence. */
const MULAW_SILENCE = 0xff;
/** What a room code is made of (no 0/O, 1/I/L). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const DAY_MS = 86_400_000;

const SAY = {
  closed: "現在沒有開放唱 K",
  noRooms: "現在沒有開放多人房間",
  noVoice: "她要在語音頻道裡才能開房間",
  noVoiceHere: "她現在在別的伺服器的語音頻道裡,要在這個伺服器的語音頻道才能開房間",
  full: "現在開著的房間太多了,等一下再開",
  already: "你已經在另一間房間裡了,先離開那一間",
  noRoom: "沒有這間房間",
  notOpener: "只有開房的人可以這樣做",
  notNow: "現在不能這樣做",
  noSeat: "唱的人已經滿了,可以先旁觀",
  noSingers: "還沒有人準備好唱",
  roundsUsed: "這間房的歌都唱完了,要唱再開一間",
  noWallet: "現在不能付魚幣,等一下再開",
  notIn: "你不在這間房間裡",
  noMember: "房間裡沒有這個人",
  stranger: "她還不認識你,不能播你的聲音",
  opening: "正在開房,等一下",
  noEntry: "點歌的清單裡沒有這一首",
  notYours: "只有點這首的人和開房的人可以拿掉",
  noReady: "清單裡還沒有準備好的歌,先點一首",
  oneOf: "選一首歌,或貼連結、打歌名(只要一樣)",
  noSong: "沒有這首歌",
  failedSong: "這首準備失敗了,換一首或重新點",
  queueFull: "點歌的清單滿了,等唱完幾首再點",
  pitchShape: "音高軌的格式不對",
  pitchTime: "音高軌的時間不對",
  pitchFast: "音高送得太快了",
  cheerNotNow: "只有唱的時候可以加油",
  cheerSinging: "你正在唱,唱完再幫別人加油",
  cheerWho: "這一首沒有這個唱的人",
  cheerFast: "加油得太快了,休息一下再來",
  cheerRoom: "大家加油得太快了,等一下再來",
} as const;

/** Why no voice can go out on the stream (`air.relay.reason`). */
const AIR_SAY = {
  noScene: "直播沒有開唱 K 場景",
  noSolo: "一個人唱時不播歌聲(設定關掉了)",
  noLead: "開房的人沒有開「播出第一名的歌聲」",
  stranger: SAY.stranger,
} as const;

const CLOSE = {
  opener: "開房的人關了房間",
  empty: "大家都離開了",
  idle: "太久沒有開始唱,房間關了",
  voice: "她離開語音頻道了",
  restart: "Core 重新啟動,房間關了",
  off: "多人房間關掉了",
} as const;

export interface RoomDeps {
  config: KaraokeConfig;
  store: KaraokeStore;
  service: KaraokeService;
  worker: () => KaraokeWorker | null;
  wallet: () => KaraokeWallet | null;
  /**
   * She is in a voice channel now: of the Space `space` (identity's id), or of any server when
   * `space` is `null` (rooms of no Space: a store without identity).
   */
  inVoice: (space: string | null) => boolean;
  /** Which server a room is in, and that server's settings. Left out: every room is of no Space. */
  places?: RoomPlaces;
  who: (account: AccountRef) => KaraokeWho;
  tell: (note: KaraokeNote) => void;
  together: (person: PersonId, detail: string, at: number, session: string) => void;
  now: () => number;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  random?: () => number;
  /** Her stream's karaoke scene (the stage link carries these); left out, nothing is sent. */
  stage?: {
    scene(scene: KaraokeStageScene): void;
    lyrics(lyrics: KaraokeStageLyrics): void;
    voice(voice: KaraokeStageVoice): void;
  };
  /**
   * A room's notice in the comment channel (`room_announce`): `post` it when the room opens (its
   * message id, `null` when it could not be posted), `edit` it when the room closes. Left out,
   * nothing is posted.
   */
  announce?: {
    post(channel: RoomChannel, notice: RoomNotice): Promise<string | null>;
    edit(channel: RoomChannel, message: string, notice: RoomNotice): Promise<void>;
  };
}

/** Where rooms are (phase 6): the Spaces, and the settings of each. */
export interface RoomPlaces {
  /** The Space a room opens in when none is named (the primary); `null`: she is in none. */
  fallback(): string | null;
  /** The Space of a context (a command's server); `null`: a DM, or a server she does not know. */
  at(context: ContextKey): string | null;
  /**
   * Why rooms cannot be in `space` (she is not there, or a new server that has no comment
   * channel of its own yet); `null`: they can.
   */
  why(space: string): string | null;
  /** The settings in `space` (the comment channel is per Space); `null`: the cluster's. */
  config(space: string | null): KaraokeConfig;
}

/** The comment channel a room's notice goes to. */
export type RoomChannel = NonNullable<ReturnType<typeof commentContext>>;

/** What a room's notice in the comment channel says (no names but the opener's, no pings). */
export interface RoomNotice {
  code: string;
  opener: string;
  state: "open" | "ended";
  /** Why it closed, a sentence (`ended` only). */
  reason: string | null;
}

/** One room open now, as `/me play karaoke` lists it. */
export interface RoomBrief {
  code: string;
  state: "lobby" | "countdown" | "singing" | "results";
  /** The song sung now, else the next ready one in the queue (`null`: none). */
  song: string | null;
  singers: number;
  max_singers: number;
  members: number;
  /** The songs waiting, in order (titles and names are untrusted). */
  queue: { title: string; by: string; state: "ready" | "preparing" | "failed" }[];
}

interface Member {
  id: string;
  key: string;
  account: AccountRef;
  person: PersonId | null;
  name: string;
  role: "singer" | "spectator";
  ready: boolean;
  color: number;
  latency_ms: number;
  calibrated: boolean;
  joined: number;
  seen: number;
  /** 「讓大家聽到我」 (their voice on the stream when they sing alone); off again every round. */
  hear: boolean;
  /** 「不要播我的聲音」 (never relayed as the leader). */
  skip: boolean;
  /** When they cheered lately (their cheers' limits). */
  cheerAt: number[];
}

/** One cheer of a round: whom (their key in the room, name and colour), from whom, which. */
interface Cheer {
  id: string;
  at: number;
  kind: KaraokeCheerKind;
  to: { key: string; name: string; color: number };
  by: { name: string; color: number };
}

interface Audio {
  /** Song time (ms) of the stream's first sample, from the first chunk. */
  startMs: number | null;
  /** Wall time of the first chunk, and its `at`. */
  firstAt: number;
  base: number;
  /** Samples received (the next chunk's `at`). */
  received: number;
  /** Samples the worker has. */
  sent: number;
  /** Received, not sent yet. */
  pending: Uint8Array[];
  pendingSamples: number;
  ended: boolean;
  endSent: boolean;
  lastAt: number;
  posts: number[];
}

interface Singer {
  member: Member;
  session: KaraokeSession;
  stream: "live" | "estimate";
  dropped: boolean;
  audio: Audio;
  voice: StreamScore;
  /** The browser's detections as they came (cleaned when scored, as the browser does). */
  estimate: StreamScore;
  input: ReturnType<KaraokeService["scoreInput"]>;
  final: { pitch: WorkersKaraokeVoicePitch; offset_ms: number } | null;
  /** When the final pitch came. */
  finalAt: number;
  /** The result made from the stream when the browser's did not come (`done`: a result is in). */
  own: "none" | "making" | "done" | "failed";
  trend: TrendTracker;
  shown: Trend | null;
  rank: number;
  total: number;
  source: "voice" | "estimate";
  ranAt: number;
  bestRank: number | null;
  worstRank: number | null;
  recent: { from: number; frames: (number | null)[] };
  /** When their pitch posts came lately (their limit), and whether one came since the last `live`. */
  pitchAt: number[];
  pitchNew: boolean;
  /** Cheers they got this round. */
  cheers: number;
  /** Since the board before. */
  move: "up" | "down" | "same";
}

interface Round {
  n: number;
  song: SongRow;
  shift: number;
  startAt: number;
  /** The song's end on Core's clock (the start and its length). */
  songEnd: number;
  endAt: number;
  settleBy: number;
  /** The longest track a result may have (the song and a few seconds, at `TRACK_HZ`). */
  maxFrames: number;
  /** The waiting list last sent while settling (JSON), `null` before it started. */
  settling: string | null;
  singers: Map<string, Singer>;
  /** The files to watch the round with, for the members not singing it (never submitted). */
  watch: Map<string, KaraokeSession>;
  ended: boolean;
  boardAt: number;
  /** The stream's voice of this round, while a scene is on (`null`: none). */
  air: RoomAir | null;
  /**
   * The words, notes, video and backing the stream plays it with (`null` without a scene): the
   * words and notes from the start, the files once they have come.
   */
  stage: KaraokeStageLyrics | null;
  /** When the singers' latest pitch last went out (`live`). */
  liveAt: number;
  /** The round's latest cheers (the last few seconds), and how many it had. */
  cheers: Cheer[];
  cheered: number;
}

/** One song waiting in a room's queue. */
interface Entry {
  id: string;
  song: string;
  shift: number;
  /** Who added it: their key in the room, and their name. */
  by: string;
  byName: string;
}

interface Follower {
  account: AccountRef;
  key: string;
  push: (event: KaraokeRoomEvent) => void;
}

interface Room {
  id: string;
  code: string;
  /** The Space it was opened in (identity's id); `null`: none (a store without identity). */
  space: string | null;
  opener: string;
  state: "lobby" | "countdown" | "singing" | "results" | "closed";
  closedReason: string | null;
  /** The songs waiting, in order. */
  queue: Entry[];
  /** How the queue's songs' preparation looked at the last look (it moves on its own). */
  queueSeen: string;
  members: Map<string, Member>;
  followers: Set<Follower>;
  rounds: number;
  round: Round | null;
  result: KaraokeRoomResult | null;
  activity: number;
  relay: { busy: boolean; failures: number; off: boolean; at: number };
  /** The opener's 「播出第一名的歌聲」 (rounds of two or more singers). */
  lead: boolean;
  /** Its notice in the comment channel: where, and the message once posted. */
  notice: { channel: RoomChannel; message: Promise<string | null>; opener: string } | null;
  /** When anyone in it cheered lately (the room's limit). */
  cheerAt: number[];
}

/** What the score makes of a microphone chunk (the reply has the stream's part too). */
type ScoreReply = Omit<KaraokeAudioReply, "relay">;

export class RoomDesk implements RoomLink {
  readonly #d: RoomDeps;
  readonly #rooms = new Map<string, Room>();
  /** Session id → the room and member singing it. */
  readonly #sessions = new Map<string, { room: Room; member: string }>();
  #moneyBusy: Promise<void> | null = null;
  /** People whose room is being opened now (a second press waits for nothing: it is refused). */
  readonly #opening = new Set<string>();
  /** Batches on their way to the song worker. */
  readonly #inflight = new Set<Promise<void>>();
  /** The room and round the stream shows (`null`: none), and the JSON of the scene last sent. */
  #featured: { code: string; round: number | null } | null = null;
  #sceneSent: string | null = null;

  constructor(deps: RoomDeps) {
    this.#d = deps;
  }

  /** Every batch on its way and the coins being paid are done (tests, and stopping). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#inflight]);
    await this.#moneyBusy;
  }

  get #cfg(): KaraokeConfig {
    return this.#d.config;
  }

  #terms(): KaraokeRoomTerms {
    const c = this.#cfg;
    return {
      currency: this.#d.wallet()?.currency ?? "魚幣",
      price: c.room_price,
      prize: c.room_prize,
      finish: c.room_finish,
      rounds: c.room_rounds,
      max_singers: c.room_singers,
    };
  }

  /** Who `account` is in a room: their person when known, else the account. */
  #key(account: AccountRef): { key: string; who: KaraokeWho } {
    const who = this.#d.who(account);
    if (who.blocked) throw new KaraokeError(403, "現在不能唱");
    return { key: who.person ?? accountRefString(account), who };
  }

  #room(code: string): Room {
    const room = this.#rooms.get(code.toUpperCase());
    if (room === undefined) throw new KaraokeError(404, SAY.noRoom);
    return room;
  }

  #mine(account: AccountRef): Room | null {
    const { key } = this.#key(account);
    for (const room of this.#rooms.values()) if (room.members.has(key)) return room;
    return null;
  }

  // ---- what a member asks ---------------------------------------------------------------------

  /**
   * The Space a call is about: `space` as given (`null`: none), else (left out) the fallback, the
   * primary. Without `places` every room is of no Space.
   */
  #spaceOf(space: string | null | undefined): string | null {
    const places = this.#d.places;
    if (places === undefined) return null;
    return space === undefined ? places.fallback() : space;
  }

  /** The Space of a command's context: its server, else (a DM) the fallback. */
  spaceAt(context: ContextKey): string | null {
    const places = this.#d.places;
    if (places === undefined) return null;
    return places.at(context) ?? places.fallback();
  }

  /** The settings a room of `space` goes by (its comment channel). */
  #cfgOf(space: string | null): KaraokeConfig {
    return this.#d.places?.config(space) ?? this.#cfg;
  }

  /** Why a room cannot be opened in `space` now (`null`: it can). */
  #why(admin: boolean, space: string | null): string | null {
    if (!this.#cfg.open && !admin) return SAY.closed;
    if (!this.#cfg.rooms) return SAY.noRooms;
    if (space !== null) {
      const why = this.#d.places?.why(space) ?? null;
      if (why !== null) return why;
    }
    if (!this.#d.inVoice(space)) {
      return space !== null && this.#d.inVoice(null) ? SAY.noVoiceHere : SAY.noVoice;
    }
    return null;
  }

  /**
   * Whether a room can be opened in `space` (left out: the primary) and at what price, the
   * person's coins, and the room they are in (in any server: one room at a time).
   */
  async overview(account: AccountRef, admin = false, space?: string | null): Promise<KaraokeRooms> {
    this.#key(account);
    const reason = this.#why(admin, this.#spaceOf(space));
    const wallet = this.#d.wallet();
    return {
      available: reason === null,
      reason,
      terms: this.#terms(),
      balance: wallet === null ? null : await wallet.balance(account),
      mine: this.#mine(account)?.code ?? null,
    };
  }

  /**
   * Opens a room, with no song, and charges the opener for it. `songId` (and its `shift`): what
   * clients from before the queue send; that song is checked first (a refusal costs nothing) and
   * queued as the first entry. One opening per person at a time: a second press while the first is
   * on its way is refused (it could otherwise charge twice). `space`: the server it opens in (left
   * out: the primary).
   */
  async open(
    account: AccountRef,
    name: string,
    songId: string | null = null,
    shift = 0,
    admin = false,
    space?: string | null,
  ): Promise<KaraokeRoomView> {
    const { key } = this.#key(account);
    if (this.#opening.has(key)) throw new KaraokeError(409, SAY.opening);
    this.#opening.add(key);
    try {
      return await this.#open(account, name, songId, shift, admin, this.#spaceOf(space));
    } finally {
      this.#opening.delete(key);
    }
  }

  async #open(
    account: AccountRef,
    name: string,
    songId: string | null,
    shift: number,
    admin: boolean,
    space: string | null,
  ): Promise<KaraokeRoomView> {
    const { key, who } = this.#key(account);
    const why = this.#why(admin, space);
    if (why !== null) throw new KaraokeError(409, why);
    if (this.#mine(account) !== null) throw new KaraokeError(409, SAY.already);
    if (this.#rooms.size >= this.#cfg.room_max) throw new KaraokeError(409, SAY.full);
    // An old client's song and its files first: a refusal here costs nothing.
    const song = songId === null ? null : await this.#d.service.readySong(songId, shift);
    const price = this.#cfg.room_price;
    const wallet = this.#d.wallet();
    if (price > 0 && wallet === null) throw new KaraokeError(503, SAY.noWallet);
    const now = this.#d.now();
    const id = newId();
    const code = this.#code();
    // Written before the charge: a crash in between still knows to give back what was taken.
    this.#d.store.addRoom({
      id,
      code,
      opener_person: who.person,
      opener_platform: account.platform,
      opener_account: account.id,
      opener_name: safeName(name, 60),
      state: "open",
      charge: price > 0 ? "charging" : "free",
      price,
      created_at: toTimestamp(now),
      space_id: space,
    });
    if (price > 0 && wallet !== null) {
      let paid: Awaited<ReturnType<KaraokeWallet["charge"]>>;
      try {
        paid = await wallet.charge(account, price, id, `karaoke_room:${code}`);
      } catch (error) {
        // Not known whether it was taken: the room ends owing it back (a refund of nothing is 0).
        this.#d.store.closeRoom(id, "開房時付款出錯", this.#d.now());
        void this.settleMoney();
        this.#d.log.warn({ room: id, err: String(error) }, "karaoke: opening a room failed");
        throw new KaraokeError(503, SAY.noWallet);
      }
      if (!paid.ok) {
        this.#d.store.setCharge(id, "failed");
        this.#d.store.closeRoom(id, "沒有付成", this.#d.now());
        if (paid.reason === "insufficient") {
          throw new KaraokeError(
            402,
            `開房要 ${price} ${wallet.currency}${paid.balance === null ? "" : `,你有 ${paid.balance}`}`,
          );
        }
        throw new KaraokeError(403, paid.message);
      }
      this.#d.store.setCharge(id, "charged");
    }
    const member = this.#member(key, account, who, name, "singer", 0, now);
    const room: Room = {
      id,
      code,
      space,
      opener: key,
      state: "lobby",
      closedReason: null,
      queue: [],
      queueSeen: "",
      members: new Map([[key, member]]),
      followers: new Set(),
      rounds: 0,
      round: null,
      result: null,
      activity: now,
      relay: { busy: false, failures: 0, off: false, at: 0 },
      lead: this.#cfg.relay_lead,
      notice: null,
      cheerAt: [],
    };
    if (song !== null) room.queue.push(this.#entry(song.id, shift, member));
    room.queueSeen = this.#queueLook(room);
    this.#rooms.set(code, room);
    this.#d.log.info({ room: id, code, price }, "karaoke: a room opened");
    this.#note(room, `karaoke:room:${id}:open`, roomOpenedNote(name, code), true);
    this.#announce(room, member.name);
    this.#stage();
    return this.#view(room, account);
  }

  /**
   * The room's notice in its server's comment channel, when `room_announce` is on and one is set.
   */
  #announce(room: Room, opener: string): void {
    const announce = this.#d.announce;
    const channel = commentContext(this.#cfgOf(room.space).comment_channel);
    if (announce === undefined || channel === null || !this.#cfg.room_announce) return;
    const message = announce
      .post(channel, { code: room.code, opener, state: "open", reason: null })
      .catch((error: unknown) => {
        this.#d.log.warn({ room: room.id, err: String(error) }, "karaoke: no room notice");
        return null;
      });
    room.notice = { channel, message, opener };
    this.#track(message);
  }

  /** A room that closed: its notice says so. */
  #unannounce(room: Room, reason: string): void {
    const notice = room.notice;
    const announce = this.#d.announce;
    if (notice === null || announce === undefined) return;
    room.notice = null;
    const done = notice.message
      .then((id) =>
        id === null
          ? undefined
          : announce.edit(notice.channel, id, {
              code: room.code,
              opener: notice.opener,
              state: "ended",
              reason,
            }),
      )
      .catch((error: unknown) => {
        this.#d.log.warn({ room: room.id, err: String(error) }, "karaoke: room notice not ended");
      });
    this.#track(done);
  }

  /** Work in the background that `idle()` waits for. */
  #track(work: Promise<unknown>): void {
    const tracked: Promise<void> = work
      .then(() => undefined)
      .finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }

  #code(): string {
    const random = this.#d.random ?? Math.random;
    for (;;) {
      let code = "";
      for (let i = 0; i < 6; i++)
        code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
      if (!this.#rooms.has(code)) return code;
    }
  }

  #member(
    key: string,
    account: AccountRef,
    who: KaraokeWho,
    name: string,
    role: Member["role"],
    color: number,
    now: number,
  ): Member {
    return {
      id: newId().slice(-10).toLowerCase(),
      key,
      account,
      person: who.person,
      name: safeName(name, 60),
      role,
      ready: false,
      color,
      latency_ms: 0,
      calibrated: false,
      joined: now,
      seen: now,
      hear: false,
      skip: false,
      cheerAt: [],
    };
  }

  view(code: string, account: AccountRef): KaraokeRoomView {
    this.#key(account);
    return this.#view(this.#room(code), account);
  }

  async join(
    code: string,
    account: AccountRef,
    name: string,
    as: "singer" | "spectator",
    admin = false,
  ): Promise<KaraokeRoomView> {
    const { key, who } = this.#key(account);
    const room = this.#room(code);
    if (!this.#cfg.open && !admin) throw new KaraokeError(409, SAY.closed);
    const now = this.#d.now();
    const there = room.members.get(key);
    const elsewhere = this.#mine(account);
    if (elsewhere !== null && elsewhere !== room) throw new KaraokeError(409, SAY.already);
    // Late: a round is on, so they watch it.
    const running = room.state === "countdown" || room.state === "singing";
    const singers = [...room.members.values()].filter((m) => m.role === "singer").length;
    let role: Member["role"] = as;
    if (
      as === "singer" &&
      (running || (there?.role !== "singer" && singers >= this.#cfg.room_singers))
    ) {
      if (!running) throw new KaraokeError(409, SAY.noSeat);
      role = "spectator";
    }
    if (there !== undefined) {
      there.role = role;
      there.ready = role === "singer" ? there.ready : false;
      there.seen = now;
    } else {
      const used = new Set([...room.members.values()].map((m) => m.color));
      const color = [0, 1, 2, 3, 4, 5, 6, 7].find((c) => !used.has(c)) ?? room.members.size % 8;
      room.members.set(key, this.#member(key, account, who, name, role, color, now));
    }
    room.activity = now;
    // Late to a round: the files to watch it with.
    const round = room.round;
    if (running && round !== null && !round.singers.has(key) && !round.watch.has(key)) {
      const watch = await this.#d.service.session(account, name, round.song, round.shift, room.id);
      round.watch.set(key, watch);
    }
    this.#changed(room);
    return this.#view(room, account);
  }

  leave(code: string, account: AccountRef): KaraokeRoomView {
    const { key } = this.#key(account);
    const room = this.#room(code);
    this.#leave(room, key);
    return this.#view(room, account);
  }

  #leave(room: Room, key: string): void {
    if (!room.members.delete(key)) return;
    // A singer who leaves mid-round still has their result counted if it comes.
    if (room.opener === key) {
      const next = [...room.members.values()].sort((a, b) => a.joined - b.joined)[0];
      if (next !== undefined) room.opener = next.key;
    }
    if (room.members.size === 0) {
      this.#close(room, CLOSE.empty);
      return;
    }
    this.#changed(room);
  }

  ready(
    code: string,
    account: AccountRef,
    body: { ready: boolean; latency_ms: number; calibrated: boolean },
  ): KaraokeRoomView {
    const { key } = this.#key(account);
    const room = this.#room(code);
    const m = room.members.get(key);
    if (m === undefined) throw new KaraokeError(409, SAY.notIn);
    if (m.role !== "singer") throw new KaraokeError(409, SAY.notNow);
    m.ready = body.ready;
    m.latency_ms = Math.max(-500, Math.min(1500, Math.round(body.latency_ms)));
    m.calibrated = body.calibrated;
    m.seen = this.#d.now();
    this.#changed(room);
    return this.#view(room, account);
  }

  // ---- the queue -------------------------------------------------------------------------------

  #entry(song: string, shift: number, by: Member): Entry {
    return {
      id: newId().slice(-12).toLowerCase(),
      song,
      shift,
      by: by.key,
      byName: by.name,
    };
  }

  /** The state of an entry's song now (`failed` too when the song is gone). */
  #stateOf(entry: Entry): "ready" | "preparing" | "failed" {
    const status = this.#d.store.song(entry.song)?.status;
    return status === "ready" || status === "preparing" ? status : "failed";
  }

  /** The entry the next round plays: the first whose song is ready (`null`: none). */
  #next(room: Room): Entry | null {
    return room.queue.find((e) => this.#stateOf(e) === "ready") ?? null;
  }

  /** The song (and key) a view shows: the running round's, else the next ready entry's. */
  #shown(room: Room): { song: SongRow; shift: number } | null {
    const round = room.round;
    if ((room.state === "countdown" || room.state === "singing") && round !== null) {
      return { song: round.song, shift: round.shift };
    }
    const next = this.#next(room);
    const song = next === null ? null : this.#d.store.song(next.song);
    return next === null || song === null ? null : { song, shift: next.shift };
  }

  /** How the queue's songs' preparation looks now (a change of it is pushed). */
  #queueLook(room: Room): string {
    return room.queue
      .map((e) => {
        const v = this.#d.service.songView(e.song);
        return v === null ? `${e.id}:-` : `${e.id}:${v.state}:${v.stage}:${v.progress}:${v.title}`;
      })
      .join("|");
  }

  /** Entries waiting (not failed), all of them or one person's. */
  #waiting(room: Room, by?: string): number {
    return room.queue.filter(
      (e) => (by === undefined || e.by === by) && this.#stateOf(e) !== "failed",
    ).length;
  }

  /**
   * Anyone in the room queues a song, in the lobby or after a round: exactly one of `song` (a song
   * on the list, ready or still being prepared) or `text` (a link or a search, through the song
   * request and its daily limit), in `shift` (a ready song's backing in that key is made now).
   * The entry shows the name they have in the room (the caller's `_name` is not used: they are in
   * it already).
   */
  async queueAdd(
    code: string,
    account: AccountRef,
    _name: string,
    body: { song?: string; text?: string; shift?: number },
    admin = false,
  ): Promise<KaraokeRoomView> {
    const { key } = this.#key(account);
    const room = this.#room(code);
    const c = this.#cfg;
    if (!c.open && !admin) throw new KaraokeError(409, SAY.closed);
    const check = (): Member => {
      const me = room.members.get(key);
      if (me === undefined) throw new KaraokeError(409, SAY.notIn);
      if (room.state !== "lobby" && room.state !== "results")
        throw new KaraokeError(409, SAY.notNow);
      if (room.rounds >= c.room_rounds) throw new KaraokeError(409, SAY.roundsUsed);
      if (this.#waiting(room, key) >= c.room_queue_per_person) {
        throw new KaraokeError(409, `你已經點了 ${c.room_queue_per_person} 首在等,唱完再點`);
      }
      if (this.#waiting(room) >= c.room_queue_max) throw new KaraokeError(409, SAY.queueFull);
      return me;
    };
    check();
    const shift = body.shift ?? 0;
    if (!Number.isInteger(shift) || Math.abs(shift) > KARAOKE_MAX_SHIFT) {
      throw new KaraokeError(400, `升降調最多 ${KARAOKE_MAX_SHIFT} 個半音`);
    }
    const text = body.text?.trim() ?? "";
    const hasSong = body.song !== undefined && body.song !== "";
    if (hasSong === (text !== "")) throw new KaraokeError(400, SAY.oneOf);
    let songId: string;
    if (hasSong) {
      const row = this.#d.store.song(body.song as string);
      if (row === null) throw new KaraokeError(404, SAY.noSong);
      if (row.status === "failed") throw new KaraokeError(409, SAY.failedSong);
      songId = row.id;
    } else {
      // The song request's own way and limits (a known song is that song, a new one is prepared).
      songId = (await this.#d.service.request(account, text, admin)).song.id;
    }
    // A ready song: its files, and its backing in that key, now (a refusal here adds nothing).
    if (this.#d.store.song(songId)?.status === "ready") {
      await this.#d.service.readySong(songId, shift);
    }
    const me = check();
    room.queue.push(this.#entry(songId, shift, me));
    room.queueSeen = this.#queueLook(room);
    room.activity = this.#d.now();
    me.seen = room.activity;
    this.#changed(room);
    return this.#view(room, account);
  }

  /** Takes an entry out: the one who added it, the opener or a panel admin. */
  queueRemove(code: string, account: AccountRef, entry: string, admin = false): KaraokeRoomView {
    const { key } = this.#key(account);
    const room = this.#room(code);
    const at = room.queue.findIndex((e) => e.id === entry);
    if (at < 0) throw new KaraokeError(404, SAY.noEntry);
    const e = room.queue[at] as Entry;
    if (e.by !== key && room.opener !== key && !admin) throw new KaraokeError(403, SAY.notYours);
    room.queue.splice(at, 1);
    room.queueSeen = this.#queueLook(room);
    room.activity = this.#d.now();
    this.#changed(room);
    return this.#view(room, account);
  }

  /** Moves an entry to place `to` (0 the first): the opener or a panel admin. */
  queueMove(
    code: string,
    account: AccountRef,
    entry: string,
    to: number,
    admin = false,
  ): KaraokeRoomView {
    const { key } = this.#key(account);
    const room = this.#room(code);
    if (room.opener !== key && !admin) throw new KaraokeError(403, SAY.notOpener);
    const at = room.queue.findIndex((e) => e.id === entry);
    if (at < 0) throw new KaraokeError(404, SAY.noEntry);
    const [e] = room.queue.splice(at, 1) as [Entry];
    const place = Math.max(
      0,
      Math.min(room.queue.length, Math.floor(Number.isFinite(to) ? to : 0)),
    );
    room.queue.splice(place, 0, e);
    room.queueSeen = this.#queueLook(room);
    room.activity = this.#d.now();
    this.#changed(room);
    return this.#view(room, account);
  }

  /** The opener starts a round: everyone who is ready sings it, from one moment of Core's clock. */
  async start(code: string, account: AccountRef): Promise<KaraokeRoomView> {
    const { key } = this.#key(account);
    const room = this.#room(code);
    if (room.opener !== key) throw new KaraokeError(403, SAY.notOpener);
    const between = () => room.state === "lobby" || room.state === "results";
    if (!between()) throw new KaraokeError(409, SAY.notNow);
    if (room.rounds >= this.#cfg.room_rounds) throw new KaraokeError(409, SAY.roundsUsed);
    if (!this.#d.inVoice(room.space)) throw new KaraokeError(409, SAY.noVoice);
    const ready = [...room.members.values()].filter((m) => m.role === "singer" && m.ready);
    if (ready.length === 0) throw new KaraokeError(409, SAY.noSingers);
    // The first ready entry (one still being prepared keeps its place); its files and key now.
    const entry = this.#next(room);
    if (entry === null) throw new KaraokeError(409, SAY.noReady);
    const shift = entry.shift;
    const song = await this.#d.service.readySong(entry.song, shift);
    if (!between() || !room.queue.includes(entry)) throw new KaraokeError(409, SAY.notNow);
    const reference = shiftKaraokeReference(await this.#d.service.reference(song.id), shift);
    // Each singer's session: the single-player one, bound to the room.
    const sessions = new Map<string, KaraokeSession>();
    for (const m of ready) {
      sessions.set(m.key, await this.#d.service.session(m.account, m.name, song, shift, room.id));
    }
    if (!between() || !room.queue.includes(entry)) throw new KaraokeError(409, SAY.notNow);
    const now = this.#d.now();
    const n = room.rounds + 1;
    const startAt = now + this.#cfg.room_countdown_secs * 1000;
    const duration = song.duration_ms ?? reference.duration_s * 1000;
    const maxS = reference.duration_s + 30;
    const round: Round = {
      n,
      song,
      shift,
      startAt,
      songEnd: startAt + duration,
      endAt: startAt + duration + END_GRACE_MS,
      settleBy: startAt + duration + END_GRACE_MS + SETTLE_WAIT_MS,
      maxFrames: Math.ceil(reference.duration_s * TRACK_HZ) + 4 * TRACK_HZ,
      settling: null,
      singers: new Map(),
      watch: new Map(),
      ended: false,
      boardAt: 0,
      air: null,
      stage: null,
      liveAt: 0,
      cheers: [],
      cheered: 0,
    };
    for (const m of room.members.values()) {
      if (sessions.has(m.key)) continue;
      round.watch.set(
        m.key,
        await this.#d.service.session(m.account, m.name, song, shift, room.id),
      );
    }
    if (!between() || !room.queue.includes(entry)) throw new KaraokeError(409, SAY.notNow);
    // The entry leaves the queue as its round starts; failed ones are dropped with it.
    room.queue = room.queue.filter((e) => e !== entry && this.#stateOf(e) !== "failed");
    room.queueSeen = this.#queueLook(room);
    for (const m of ready) {
      const session = sessions.get(m.key) as KaraokeSession;
      const input = this.#d.service.scoreInput(reference, m.latency_ms, m.calibrated);
      round.singers.set(m.key, {
        member: m,
        session,
        stream: this.#streaming() ? "live" : "estimate",
        dropped: false,
        audio: {
          startMs: null,
          firstAt: 0,
          base: 0,
          received: 0,
          sent: 0,
          pending: [],
          pendingSamples: 0,
          ended: false,
          endSent: false,
          lastAt: startAt,
          posts: [],
        },
        voice: new StreamScore(input, maxS),
        estimate: new StreamScore(input, maxS),
        input,
        final: null,
        finalAt: 0,
        own: "none",
        trend: new TrendTracker(),
        shown: null,
        rank: 1,
        total: 0,
        source: "estimate",
        ranAt: 0,
        bestRank: null,
        worstRank: null,
        recent: { from: 0, frames: [] },
        pitchAt: [],
        pitchNew: false,
        cheers: 0,
        move: "same",
      });
      this.#sessions.set(session.session, { room, member: m.key });
    }
    this.#d.store.addRound({
      room_id: room.id,
      round: n,
      song_id: song.id,
      shift,
      started_at: toTimestamp(now),
    });
    room.rounds = n;
    room.round = round;
    room.result = null;
    room.relay = { busy: false, failures: 0, off: false, at: 0 };
    room.state = "countdown";
    room.activity = now;
    if (this.#cfg.stream_scene) {
      const lines = reference.lyrics?.lines ?? [];
      round.air = new RoomAir({
        startAt,
        delayMs: this.#cfg.stream_delay_ms,
        holdMs: this.#cfg.relay_hold_secs * 1000,
        fadeMs: this.#cfg.relay_fade_ms,
        solo: round.singers.size === 1,
        durationMs: duration,
        gaps: lyricGaps(lines.map((l) => ({ start: l.start, end: sungEnd(l) }))),
        send: (piece) => this.#voice(room, round, piece),
      });
      // The words and the notes are Core's own: on the stream from the countdown on. The video
      // and the backing come from the song worker and may take long on a slow link; they follow.
      round.stage = {
        room: room.code,
        round: round.n,
        song: round.song.id.slice(0, 128),
        lyrics: lyricsForStage(reference.lyrics),
        video: null,
        backing: null,
        notes: notesForStage(reference.notes),
      };
      const files = this.#stageFiles(room, round).finally(() => this.#inflight.delete(files));
      this.#inflight.add(files);
    }
    this.#changed(room);
    this.#note(
      room,
      `karaoke:room:${room.id}:round:${n}:start`,
      roundStartNote(
        room.code,
        n,
        song.title,
        ready.map((m) => m.name),
      ),
      true,
    );
    return this.#view(room, account);
  }

  /** Whether rounds stream their singers' voices now. */
  #streaming(): boolean {
    const worker = this.#d.worker();
    return this.#cfg.room_stream && worker !== null && worker.stream !== undefined;
  }

  close(code: string, account: AccountRef): KaraokeRoomView {
    const { key } = this.#key(account);
    const room = this.#room(code);
    if (room.opener !== key) throw new KaraokeError(403, SAY.notOpener);
    this.#close(room, CLOSE.opener);
    return this.#view(room, account);
  }

  #close(room: Room, reason: string): void {
    if (room.state === "closed") return;
    const now = this.#d.now();
    this.#d.store.closeRoom(room.id, reason, now);
    // A round still on is void: its streams go, its sessions are alone from now on.
    const round = room.round;
    if (round !== null && room.state !== "results") {
      const drop = [...round.singers.values()].map((s) => s.session.session);
      const worker = this.#d.worker();
      if (worker?.stream !== undefined && drop.length > 0 && !room.relay.off) {
        void worker.stream({ room: room.id, chunks: [], drop }).catch(() => {});
      }
    }
    if (round !== null) {
      for (const s of round.singers.values()) {
        for (const chunk of s.audio.pending) chunk.fill(0);
        s.audio.pending = [];
      }
      this.#endAir(room, round);
    }
    room.state = "closed";
    room.closedReason = reason;
    this.#changed(room);
    for (const f of room.followers) {
      try {
        f.push({ type: "room", room: this.#view(room, f.account) });
      } catch {
        // gone
      }
    }
    room.followers.clear();
    this.#rooms.delete(room.code);
    for (const [session, at] of this.#sessions)
      if (at.room === room) this.#sessions.delete(session);
    this.#d.log.info({ room: room.id, reason }, "karaoke: a room closed");
    this.#unannounce(room, reason);
    this.#stage();
    void this.settleMoney();
  }

  /** The round's stream voice is over: its figures to the log (no audio), its buffers zeroed. */
  #endAir(room: Room, round: Round): void {
    const air = round.air;
    if (air === null) return;
    const stats = air.stats();
    if (stats.length > 0) {
      this.#d.log.info(
        {
          room: room.id,
          round: round.n,
          delay_ms: this.#cfg.stream_delay_ms,
          singers: stats.map((x) => ({
            color: round.singers.get(x.key)?.member.color ?? null,
            path_ms_p90: x.delay_ms === null ? null : Math.round(x.delay_ms),
            late_ms: x.late_ms,
          })),
        },
        "karaoke: the stream's voice of a round",
      );
    }
    air.close();
    round.air = null;
  }

  // ---- her stream: whose voice, the scene --------------------------------------------------------

  /**
   * 「讓大家聽到我」 / 「不要播我的聲音」 for oneself, the opener's 「播出第一名的歌聲」, or the opener
   * (or a panel admin) turning someone's voice off (`member`). Takes effect at once, mid-round too.
   */
  relay(
    code: string,
    account: AccountRef,
    body: { hear?: boolean; skip?: boolean; lead?: boolean; member?: string },
    admin = false,
  ): KaraokeRoomView {
    const { key } = this.#key(account);
    const room = this.#room(code);
    if (body.member !== undefined) {
      if (room.opener !== key && !admin) throw new KaraokeError(403, SAY.notOpener);
      const target = [...room.members.values()].find((m) => m.id === body.member);
      if (target === undefined) throw new KaraokeError(404, SAY.noMember);
      target.hear = false;
      target.skip = true;
    } else {
      const me = room.members.get(key);
      if (me === undefined) throw new KaraokeError(409, SAY.notIn);
      if (body.lead !== undefined) {
        if (room.opener !== key) throw new KaraokeError(403, SAY.notOpener);
        if (room.state !== "lobby" && room.state !== "results") {
          throw new KaraokeError(409, SAY.notNow);
        }
        room.lead = body.lead;
      }
      if (body.hear !== undefined) {
        if (me.role !== "singer") throw new KaraokeError(409, SAY.notNow);
        if (body.hear && me.person === null) throw new KaraokeError(403, SAY.stranger);
        me.hear = body.hear;
      }
      if (body.skip !== undefined) me.skip = body.skip;
      me.seen = this.#d.now();
    }
    room.activity = this.#d.now();
    this.#changed(room);
    return this.#view(room, account);
  }

  /** Whether `m`'s voice may go out on the stream this round (they allow it; she knows them). */
  #mayAir(room: Room, m: Member): boolean {
    const round = room.round;
    if (round?.air == null || m.person === null || !round.singers.has(m.key)) return false;
    if (round.singers.size === 1) return this.#cfg.relay_solo && m.hear;
    return room.lead && !m.skip;
  }

  /** The stream's voice: the wish of who allows it and is heard, then the mix up to its lead. */
  #airTick(room: Room, now: number): void {
    const air = room.round?.air ?? null;
    const round = room.round;
    if (air === null || round === null) return;
    const singers: AirSinger[] = [...round.singers.values()].map((s) => ({
      key: s.member.key,
      eligible: this.#mayAir(room, s.member) && air.heard(s.member.key, now),
      total: s.total,
      order: s.member.joined,
    }));
    const before = air.onAir();
    air.tick(now, singers);
    if (air.onAir() !== before) this.#changed(room, true);
  }

  /** A piece of the stream's voice, when this room is the one the stream shows. */
  #voice(room: Room, round: Round, piece: { at_ms: number; audio: string }): void {
    const f = this.#featured;
    if (f === null || f.code !== room.code || f.round !== round.n) return;
    this.#d.stage?.voice({ room: room.code, round: round.n, ...piece });
  }

  /** The round's video and backing for the stream (fetched while it counts down, or later). */
  async #stageFiles(room: Room, round: Round): Promise<void> {
    let files: Awaited<ReturnType<KaraokeService["streamFiles"]>>;
    try {
      files = await this.#d.service.streamFiles(round.song, round.shift);
    } catch {
      files = { backing: null, video: null };
    }
    if (room.round !== round || room.state === "closed" || round.stage === null) return;
    const backing = this.#cfg.stream_backing ? files.backing : null;
    if (files.video === null && backing === null) return;
    round.stage = { ...round.stage, video: files.video, backing };
    // A scene that shows this round already gets its words again, now with the files.
    const f = this.#featured;
    if (f !== null && f.code === room.code && f.round === round.n) {
      this.#d.stage?.lyrics(round.stage);
    }
    this.#stage();
  }

  /**
   * The room the stream shows, and its scene (when it changed): a round being sung first, then the
   * latest results, then a lobby; nobody when the scene is off. A newly shown round gets its words
   * again.
   */
  #stage(): void {
    const stage = this.#d.stage;
    if (stage === undefined) return;
    const rooms = this.#cfg.stream_scene
      ? [...this.#rooms.values()].filter((r) => r.state !== "closed")
      : [];
    const order = (r: Room) =>
      r.state === "countdown" || r.state === "singing" ? 0 : r.state === "results" ? 1 : 2;
    const room = rooms.sort((a, b) => order(a) - order(b) || b.activity - a.activity)[0] ?? null;
    const round = room?.round ?? null;
    const showsRound =
      room !== null && round !== null && (room.state !== "lobby" || room.result !== null);
    const next =
      room === null ? null : { code: room.code, round: showsRound ? (round?.n ?? null) : null };
    const before = this.#featured;
    this.#featured = next;
    if (
      next !== null &&
      next.round !== null &&
      round?.stage != null &&
      (before?.code !== next.code || before.round !== next.round)
    ) {
      stage.lyrics(round.stage);
    }
    const scene = this.#scene(room);
    const text = JSON.stringify({ ...scene, position_ms: null });
    // The position moves every time: the scene goes again when anything else changed, and with
    // every board (`#board` asks with `force`).
    if (text === this.#sceneSent && !this.#forceScene) return;
    this.#forceScene = false;
    this.#sceneSent = text;
    stage.scene(scene);
  }

  #forceScene = false;

  #scene(room: Room | null): KaraokeStageScene {
    const c = this.#cfg;
    const terms = this.#terms();
    if (room === null) {
      return {
        room: null,
        state: null,
        round: 0,
        rounds_left: 0,
        song: null,
        shift: 0,
        members: [],
        position_ms: null,
        board: [],
        note: null,
        currency: terms.currency.slice(0, 16),
        air: this.#airScene(null),
        queue: [],
        join_url: null,
        qr_while_singing: false,
        settling: null,
        cheers: [],
      };
    }
    const now = this.#d.now();
    const round = room.round;
    const running = room.state === "countdown" || room.state === "singing";
    const shown = this.#shown(room);
    const song = shown?.song ?? null;
    const onAir = running ? (round?.air?.onAir() ?? null) : null;
    let board: KaraokeStageLine[] = [];
    if (running && round !== null) {
      board = [...round.singers.values()]
        .sort((a, b) => a.rank - b.rank || a.member.joined - b.member.joined)
        .map((s) => ({
          name: s.member.name,
          color: s.member.color,
          rank: s.total > 0 ? s.rank : null,
          total: s.total > 0 ? Math.round(s.total * 10) / 10 : null,
          source: s.total > 0 ? s.source : null,
          move: s.move,
          winner: false,
          coins: 0,
          finished: false,
          on_air: onAir === s.member.key,
          parts: null,
          pitch: this.#piece(s, BOARD_PITCH_FRAMES),
          cheers: s.cheers,
        }));
    } else if (room.state === "results" && room.result !== null) {
      board = room.result.places.map((p) => ({
        name: p.name,
        color: p.color,
        rank: p.rank,
        total: p.total === null ? null : Math.min(110, Math.max(0, p.total)),
        source: p.source,
        move: "same",
        winner: p.winner,
        coins: Math.max(0, p.coins),
        finished: p.finished,
        on_air: false,
        parts:
          p.total === null
            ? null
            : {
                pitch: p.pitch,
                stability: p.stability,
                rhythm: p.rhythm,
                expression: p.expression,
              },
        pitch: null,
        cheers:
          [...(round?.singers.values() ?? [])].find((s) => s.member.id === p.member)?.cheers ?? 0,
      }));
    }
    return {
      room: room.code,
      state: room.state === "closed" ? null : room.state,
      round: room.rounds,
      rounds_left: Math.max(0, c.room_rounds - room.rounds),
      song:
        song === null
          ? null
          : {
              id: song.id.slice(0, 128),
              title: song.title.slice(0, 200),
              artist: song.artist === null ? null : song.artist.slice(0, 200),
              duration_ms:
                song.duration_ms !== null && song.duration_ms > 0 ? song.duration_ms : null,
            },
      shift: shown?.shift ?? 0,
      members: [...room.members.values()]
        .sort((a, b) => a.joined - b.joined)
        .slice(0, 64)
        .map((m) => ({
          name: m.name,
          color: m.color,
          role: m.role,
          ready: m.ready,
          opener: m.key === room.opener,
        })),
      position_ms: running && round !== null ? now - (round.startAt + c.stream_delay_ms) : null,
      board: board.slice(0, 16),
      note: room.state === "results" ? (room.result?.note ?? null) : null,
      currency: terms.currency.slice(0, 16),
      air: this.#airScene(
        onAir === null ? null : (round?.singers.get(onAir)?.member.name ?? null),
        running && round?.stage?.backing != null,
      ),
      queue: this.#sceneQueue(room, running),
      join_url: this.#joinUrl(room),
      qr_while_singing: c.stream_qr_while_singing,
      settling: this.#sceneSettling(room),
      cheers: running && round !== null ? this.#sceneCheers(round, now) : [],
    };
  }

  /** The round's cheers of the last few seconds, oldest first, as the stream's scene has them. */
  #sceneCheers(round: Round, now: number): KaraokeStageScene["cheers"] {
    return round.cheers
      .filter((c) => now - c.at < CHEER_SHOW_MS)
      .slice(-KARAOKE_CHEERS_MAX)
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        to: { name: c.to.name.slice(0, 60), color: c.to.color },
        by: { name: c.by.name.slice(0, 60), color: c.by.color },
      }));
  }

  /** The next few songs waiting after the one the scene shows (it is not repeated). */
  #sceneQueue(room: Room, running: boolean): KaraokeStageScene["queue"] {
    const next = running ? null : this.#next(room);
    return room.queue
      .filter((e) => e !== next)
      .slice(0, KARAOKE_QUEUE_MAX)
      .map((e) => {
        const row = this.#d.store.song(e.song);
        return {
          title: (row?.title || row?.source || "").slice(0, 200),
          artist: row?.artist == null ? null : row.artist.slice(0, 200),
          by: e.byName.slice(0, 60),
          state: this.#stateOf(e),
        };
      });
  }

  /** The room's join link for the stream's QR code, when the site's address is set and it is on. */
  #joinUrl(room: Room): string | null {
    if (!this.#cfg.stream_qr) return null;
    const url = siteLink(this.#cfg, `/karaoke/room/${room.code}`);
    return url === null || url.length > KARAOKE_JOIN_URL_MAX ? null : url;
  }

  /**
   * The last `frames` of a singer's pitch, placed on the reference (their device's latency taken
   * off, as the score does), for the board, `live` and the stream's lanes; `null` without any.
   */
  #piece(s: Singer, frames: number): KaraokeStageLine["pitch"] {
    const r = s.recent;
    const tail = r.frames.slice(Math.max(0, r.frames.length - frames));
    const late = Math.round((s.member.latency_ms / 1000) * TRACK_HZ);
    const from = r.from + (r.frames.length - tail.length) - late;
    const kept = tail.slice(Math.max(0, -from));
    if (kept.length === 0) return null;
    const track = toBase64(encodeTrack(kept));
    return track.length > KARAOKE_PITCH_MAX_CHARS ? null : { from: Math.max(0, from), track };
  }

  /** The stream's side of settling: whom it waits for, names only. */
  #sceneSettling(room: Room): KaraokeStageScene["settling"] {
    const settling = this.#settling(room);
    return settling === null
      ? null
      : { waiting: settling.waiting.slice(0, KARAOKE_BOARD_MAX).map((n) => n.slice(0, 60)) };
  }

  #airScene(relay: string | null, backing = false): KaraokeStageScene["air"] {
    const c = this.#cfg;
    return {
      backing,
      relay,
      delay_ms: c.stream_delay_ms,
      backing_gain: c.stream_backing_gain,
      voice_gain: c.stream_voice_gain,
      duck_gain: c.stream_duck_gain,
    };
  }

  /** What `me` may know of the stream's voice (a singer of a round of two or more: never whose). */
  #air(room: Room, me: Member | null): KaraokeRoomView["air"] {
    const c = this.#cfg;
    const round = room.round;
    const running = room.state === "countdown" || room.state === "singing";
    const singers =
      running && round !== null
        ? round.singers.size
        : [...room.members.values()].filter((m) => m.role === "singer").length;
    const solo = singers <= 1;
    let reason: string | null = null;
    if (!c.stream_scene) reason = AIR_SAY.noScene;
    else if (solo && !c.relay_solo) reason = AIR_SAY.noSolo;
    else if (!solo && !room.lead) reason = AIR_SAY.noLead;
    else if (me !== null && me.role === "singer" && me.person === null) reason = AIR_SAY.stranger;
    const singing = running && me !== null && (round?.singers.has(me.key) ?? false);
    let member: string | null = null;
    let live = false;
    if (!(singing && !solo)) {
      if (running && round !== null) {
        const on = round.air?.onAir() ?? null;
        member = on === null ? null : (round.singers.get(on)?.member.id ?? null);
        live = member !== null;
      } else if (solo) {
        member = [...room.members.values()].find((m) => m.role === "singer" && m.hear)?.id ?? null;
      }
    }
    return {
      backing: c.stream_scene && c.stream_backing,
      delay_ms: c.stream_delay_ms,
      lead: room.lead,
      singers,
      relay: { allowed: reason === null, reason, member, live },
    };
  }

  /** The stream's scene ends (the module stops). */
  endScene(): void {
    this.#featured = null;
    this.#sceneSent = null;
    this.#d.stage?.scene(this.#scene(null));
  }

  // ---- the event stream ------------------------------------------------------------------------

  /**
   * Follows a room: `push` gets this person's view now and whenever it changes, and the board or
   * their trend while a round is sung. What they get is decided here: a singer of the running
   * round never gets the board. Returns how to stop.
   */
  follow(code: string, account: AccountRef, push: (event: KaraokeRoomEvent) => void): () => void {
    const { key } = this.#key(account);
    const room = this.#room(code);
    const follower: Follower = { account, key, push };
    room.followers.add(follower);
    const m = room.members.get(key);
    if (m !== undefined) m.seen = this.#d.now();
    push({ type: "room", room: this.#view(room, account) });
    return () => {
      room.followers.delete(follower);
    };
  }

  /**
   * Everyone following `room` gets their view again. `quiet`: not the singers of a round of two or
   * more (a change only of whose voice is on would tell them something by its timing alone).
   */
  #changed(room: Room, quiet = false): void {
    const round = room.round;
    const hush = quiet && round !== null && round.singers.size >= 2;
    for (const f of room.followers) {
      if (hush && round?.singers.has(f.key)) continue;
      try {
        f.push({ type: "room", room: this.#view(room, f.account) });
      } catch (error) {
        this.#d.log.warn({ err: String(error) }, "karaoke: a room follower failed");
        room.followers.delete(f);
      }
    }
    this.#stage();
  }

  /** The board to everyone who is not singing the round; to each singer, their own trend only. */
  #deliver(room: Room, board: KaraokeBoardLine[], at: number): void {
    const round = room.round;
    if (round === null) return;
    for (const f of room.followers) {
      const singer = round.singers.get(f.key);
      let event: KaraokeRoomEvent;
      if (singer !== undefined) {
        // Their own running number only: never a rank, never anyone else's.
        event = {
          type: "trend",
          round: round.n,
          trend: singer.trend.trend,
          source: singer.source,
          total: singer.total > 0 ? Math.round(singer.total * 10) / 10 : null,
        };
      } else event = { type: "board", round: round.n, at_ms: at, lines: board };
      try {
        f.push(event);
      } catch {
        room.followers.delete(f);
      }
    }
  }

  clock(t0: number): KaraokeClockReply {
    return { t0, server_ms: this.#d.now() };
  }

  // ---- a singer's microphone and pitch ---------------------------------------------------------

  #singer(code: string, account: AccountRef): { room: Room; singer: Singer } {
    const { key } = this.#key(account);
    const room = this.#room(code);
    const singer = room.round?.singers.get(key);
    if (singer === undefined || (room.state !== "countdown" && room.state !== "singing")) {
      throw new KaraokeError(409, SAY.notNow);
    }
    return { room, singer };
  }

  /**
   * A chunk of a singer's microphone: µ-law 16 kHz mono, `at` its first sample in the stream,
   * `songMs` the song time of that sample on the browser's audio clock, `end` the last chunk.
   * Never stored, never logged; only relayed to the song worker.
   */
  audio(
    code: string,
    account: AccountRef,
    at: number,
    songMs: number,
    end: boolean,
    bytes: Uint8Array,
  ): KaraokeAudioReply {
    const { room, singer } = this.#singer(code, account);
    const a = singer.audio;
    const now = this.#d.now();
    if (bytes.length > MAX_AUDIO_BYTES || !Number.isInteger(at) || at < 0) {
      bytes.fill(0);
      throw new KaraokeError(400, "聲音的格式不對");
    }
    a.posts = a.posts.filter((t) => t > now - 1000);
    if (a.posts.length >= AUDIO_PER_S) {
      bytes.fill(0);
      throw new KaraokeError(429, "送得太快了");
    }
    a.posts.push(now);
    // The stream's copy first (decoded into its own buffer): it may go out whatever the score does.
    const relay = this.#mayAir(room, singer.member);
    const air = room.round?.air ?? null;
    if (relay && air !== null && Number.isFinite(songMs)) {
      air.put(singer.member.key, songMs, singer.member.latency_ms, bytes, now);
    }
    return { ...this.#scoreAudio(room, singer, at, songMs, end, bytes, now), relay };
  }

  /** The score's side of a microphone chunk: queued for the song worker while the stream is live. */
  #scoreAudio(
    room: Room,
    singer: Singer,
    at: number,
    songMs: number,
    end: boolean,
    bytes: Uint8Array,
    now: number,
  ): ScoreReply {
    const a = singer.audio;
    if (singer.stream !== "live" || singer.final !== null) {
      bytes.fill(0);
      return { stream: "estimate" };
    }
    // Over (the song ended on Core's clock): what comes after is not the song.
    if (a.ended) {
      bytes.fill(0);
      return { stream: "live" };
    }
    a.lastAt = now;
    if (a.startMs === null) {
      if (!Number.isFinite(songMs) || Math.abs(songMs) > 60_000 + at / 16) {
        bytes.fill(0);
        throw new KaraokeError(400, "聲音的時間不對");
      }
      a.startMs = songMs - (at * 1000) / KARAOKE_STREAM_RATE;
      a.firstAt = now;
      a.base = at;
      a.received = at;
      a.sent = at;
    }
    // Only what is new: a repeat is skipped, a gap is silence (up to two seconds).
    let chunk = bytes;
    if (at < a.received) chunk = bytes.subarray(Math.min(bytes.length, a.received - at));
    else if (at > a.received) {
      const gap = at - a.received;
      if (gap > 2 * KARAOKE_STREAM_RATE) return this.#dropStream(singer, bytes);
      this.#queue(a, new Uint8Array(gap).fill(MULAW_SILENCE));
    }
    if (chunk.length > 0) this.#queue(a, chunk.slice());
    bytes.fill(0);
    // Caps: no longer than the song and half a minute, never far ahead of the wall clock (a
    // stream made beforehand), and never far behind the worker (a slow link: the estimate).
    const longestS = (room.round?.song.duration_ms ?? this.#cfg.max_song_secs * 1000) / 1000 + 30;
    if (
      a.received - a.base > longestS * KARAOKE_STREAM_RATE ||
      a.received - a.sent > MAX_PENDING_S * KARAOKE_STREAM_RATE ||
      a.received - a.base > ((now - a.firstAt) / 1000 + AHEAD_S) * KARAOKE_STREAM_RATE
    ) {
      return this.#dropStream(singer, new Uint8Array());
    }
    if (end) a.ended = true;
    return { stream: "live" };
  }

  #queue(a: Audio, bytes: Uint8Array): void {
    a.pending.push(bytes);
    a.pendingSamples += bytes.length;
    a.received += bytes.length;
  }

  /** This singer is scored from their browser from now on; their recording is wanted at the end. */
  #dropStream(singer: Singer, bytes: Uint8Array): ScoreReply {
    bytes.fill(0);
    if (singer.stream === "live") {
      singer.stream = "estimate";
      singer.dropped = true;
      for (const chunk of singer.audio.pending) chunk.fill(0);
      singer.audio.pending = [];
      singer.audio.pendingSamples = 0;
      this.#d.service.streamLost(singer.session.session);
    }
    return { stream: "estimate" };
  }

  /**
   * The browser's own detected pitch since `from` (50 Hz song time): the estimate, and what the
   * people watching and her stream see of this singer. Only the round's singers (`#singer`), at
   * most `PITCH_PER_S` posts a second, within the round's longest track and never ahead of Core's
   * own song clock by more than `PITCH_AHEAD_S` (a track made beforehand is refused).
   */
  pitch(code: string, account: AccountRef, from: number, track: string): void {
    const { room, singer } = this.#singer(code, account);
    const round = room.round as Round;
    const now = this.#d.now();
    const bytes = fromBase64(track);
    if (bytes === null || !Number.isInteger(from) || from < 0) {
      throw new KaraokeError(400, SAY.pitchShape);
    }
    const end = from + bytes.length;
    const songS = (now - round.startAt) / 1000;
    if (end > round.maxFrames || end / TRACK_HZ > songS + PITCH_AHEAD_S) {
      throw new KaraokeError(400, SAY.pitchTime);
    }
    singer.pitchAt = singer.pitchAt.filter((t) => t > now - 1000);
    if (singer.pitchAt.length >= PITCH_PER_S) throw new KaraokeError(429, SAY.pitchFast);
    singer.pitchAt.push(now);
    if (bytes.length === 0) return;
    const frames = decodeTrack(bytes);
    singer.estimate.put(from, frames);
    singer.pitchNew = true;
    const r = singer.recent;
    const all = [...r.frames];
    for (let k = 0; k < frames.length; k++) all[from + k - r.from] = frames[k] ?? null;
    const keepFrom = Math.max(r.from, from + frames.length - BOARD_PITCH_FRAMES);
    singer.recent = {
      from: keepFrom,
      frames: Array.from(all.slice(Math.max(0, keepFrom - r.from)), (m) => m ?? null),
    };
  }

  // ---- cheers ------------------------------------------------------------------------------------

  /**
   * Someone in the room who is not singing the round cheers `member`, one of its singers, during
   * the countdown or the round. Limited per person (`CHEER_GAP_MS`, `CHEER_BURST` a
   * `CHEER_WINDOW_MS`) and per room (`ROOM_CHEERS_PER_S`): a 429 says to wait. It goes to everyone
   * not singing, to that singer, and onto the stream's scene; nothing is kept after the round.
   */
  cheer(
    code: string,
    account: AccountRef,
    body: { member: string; kind: KaraokeCheerKind },
  ): KaraokeCheerReply {
    const { key } = this.#key(account);
    const room = this.#room(code);
    const round = room.round;
    const me = room.members.get(key);
    if (me === undefined) throw new KaraokeError(409, SAY.notIn);
    const now = this.#d.now();
    // While it counts down and is sung (not once the song is over and it settles).
    const on = room.state === "countdown" || room.state === "singing";
    if (round === null || !on || now >= round.songEnd) {
      throw new KaraokeError(409, SAY.cheerNotNow);
    }
    if (round.singers.has(key)) throw new KaraokeError(409, SAY.cheerSinging);
    if (!KARAOKE_CHEERS.includes(body.kind)) throw new KaraokeError(400, SAY.notNow);
    const to = [...round.singers.values()].find((s) => s.member.id === body.member);
    if (to === undefined) throw new KaraokeError(404, SAY.cheerWho);
    me.cheerAt = me.cheerAt.filter((t) => t > now - CHEER_WINDOW_MS);
    const last = me.cheerAt.at(-1);
    if ((last !== undefined && now - last < CHEER_GAP_MS) || me.cheerAt.length >= CHEER_BURST) {
      throw new KaraokeError(429, SAY.cheerFast);
    }
    room.cheerAt = room.cheerAt.filter((t) => t > now - 1000);
    if (room.cheerAt.length >= ROOM_CHEERS_PER_S) throw new KaraokeError(429, SAY.cheerRoom);
    me.cheerAt.push(now);
    room.cheerAt.push(now);
    me.seen = now;
    round.cheered++;
    to.cheers++;
    const cheer: Cheer = {
      id: `c${round.n}-${round.cheered}`,
      at: now,
      kind: body.kind,
      to: { key: to.member.key, name: to.member.name, color: to.member.color },
      by: { name: me.name, color: me.color },
    };
    round.cheers = [...round.cheers.filter((c) => now - c.at < CHEER_SHOW_MS), cheer].slice(
      -KARAOKE_CHEERS_MAX,
    );
    const event: KaraokeRoomEvent = {
      type: "cheer",
      round: round.n,
      id: cheer.id,
      member: to.member.id,
      by: cheer.by,
      kind: cheer.kind,
    };
    for (const f of room.followers) {
      // The other singers never hear of it (it would say something about how they compare).
      if (round.singers.has(f.key) && f.key !== to.member.key) continue;
      try {
        f.push(event);
      } catch {
        room.followers.delete(f);
      }
    }
    this.#stage();
    // The next one may come after the gap, or when the oldest of a full burst has gone.
    const burstFull = me.cheerAt.length >= CHEER_BURST;
    const wait = burstFull
      ? Math.max(CHEER_GAP_MS, (me.cheerAt[0] as number) + CHEER_WINDOW_MS - now)
      : CHEER_GAP_MS;
    return { wait_ms: Math.round(wait) };
  }

  // ---- RoomLink: what the service asks of a room's session --------------------------------------

  streams(session: string): boolean {
    const at = this.#sessions.get(session);
    const singer = at?.room.round?.singers.get(at.member);
    if (singer === undefined) return false;
    return singer.final !== null || (singer.stream === "live" && !singer.dropped);
  }

  finalOf(session: string): { pitch: WorkersKaraokeVoicePitch; offset_ms: number } | null {
    const at = this.#sessions.get(session);
    return at?.room.round?.singers.get(at.member)?.final ?? null;
  }

  changed(session: string): void {
    const at = this.#sessions.get(session);
    if (at === undefined) return;
    this.#trySettle(at.room);
    const round = at.room.round;
    if (round !== null) this.#settlingTick(at.room, round, this.#d.now());
  }

  // ---- the pass --------------------------------------------------------------------------------

  /** One look at every room (about four times a second). */
  async tick(): Promise<void> {
    const now = this.#d.now();
    if (this.#rooms.size > 0 && !this.#cfg.rooms) {
      for (const room of [...this.#rooms.values()]) this.#close(room, CLOSE.off);
      return;
    }
    for (const room of [...this.#rooms.values()]) {
      // She left the voice of the room's server (another server's voice does not keep it open).
      if (!this.#d.inVoice(room.space)) {
        this.#close(room, CLOSE.voice);
        continue;
      }
      // People with no page open for a while have left (not while they sing a round).
      const running = room.state === "countdown" || room.state === "singing";
      for (const m of [...room.members.values()]) {
        if ([...room.followers].some((f) => f.key === m.key)) m.seen = now;
        else if (now - m.seen > AWAY_MS && !(running && room.round?.singers.has(m.key))) {
          this.#leave(room, m.key);
        }
      }
      if (room.state === "closed") continue;
      // The queue's songs being prepared move on their own: everyone sees it (and a room waiting
      // for its song to be prepared is not idle).
      if (room.queue.length > 0) {
        const look = this.#queueLook(room);
        if (look !== room.queueSeen) {
          room.queueSeen = look;
          room.activity = now;
          this.#changed(room);
        }
      }
      const idle = this.#cfg.room_idle_mins * 60_000;
      if ((room.state === "lobby" || room.state === "results") && now - room.activity > idle) {
        this.#close(room, CLOSE.idle);
        continue;
      }
      const round = room.round;
      if (round === null) continue;
      if (room.state === "countdown" && now >= round.startAt) {
        room.state = "singing";
        this.#changed(room);
      }
      if (room.state !== "singing") continue;
      // Streams that went quiet, and the end of the song. A stream that ran into the song's last
      // seconds and stopped is over, not lost (a browser may stop without its last chunk: its
      // final is asked for all the same); a few seconds after the song every stream is over.
      for (const s of round.singers.values()) {
        const a = s.audio;
        if (s.stream !== "live" || a.ended) continue;
        if (now >= round.songEnd + STREAM_END_MS) a.ended = true;
        else if (now - Math.max(a.lastAt, round.startAt) > STREAM_QUIET_MS) {
          if (a.startMs !== null && a.lastAt >= round.songEnd - STREAM_QUIET_MS) a.ended = true;
          else this.#dropStream(s, new Uint8Array());
        }
      }
      if (!round.ended && now >= round.endAt) {
        round.ended = true;
        for (const s of round.singers.values()) s.audio.ended = true;
      }
      if (now - room.relay.at >= RELAY_MS && !room.relay.busy) {
        room.relay.at = now;
        const relay = this.#relay(room).finally(() => this.#inflight.delete(relay));
        this.#inflight.add(relay);
      }
      if (now - round.boardAt >= BOARD_MS) {
        round.boardAt = now;
        this.#board(room, now);
      }
      if (now - round.liveAt >= LIVE_MS && [...round.singers.values()].some((s) => s.pitchNew)) {
        round.liveAt = now;
        this.#live(room, round, now);
      }
      this.#airTick(room, now);
      this.#ownResults(room, round, now);
      this.#trySettle(room);
      this.#settlingTick(room, round, now);
    }
  }

  /** One batch of the room's new audio to its song worker, and its pitch into the scores. */
  async #relay(room: Room): Promise<void> {
    const round = room.round;
    const worker = this.#d.worker();
    if (round === null || room.relay.off) return;
    const live = [...round.singers.values()].filter((s) => s.stream === "live" && s.final === null);
    if (live.length === 0) return;
    if (worker?.stream === undefined || !this.#cfg.room_stream) {
      this.#relayOff(room, "no stream");
      return;
    }
    const chunks: WorkersKaraokeStreamChunk[] = [];
    const taken = new Map<Singer, number>();
    for (const s of live) {
      const a = s.audio;
      if (a.startMs === null) continue;
      const n = Math.min(a.pendingSamples, KARAOKE_STREAM_MAX_CHUNK);
      const last = a.ended && n === a.pendingSamples;
      if (n === 0 && !last) continue;
      if (n === 0 && a.endSent) continue;
      const bytes = new Uint8Array(n);
      let o = 0;
      for (const chunk of a.pending) {
        if (o >= n) break;
        const part = chunk.subarray(0, n - o);
        bytes.set(part, o);
        o += part.length;
      }
      chunks.push({ stream: s.session.session, at: a.sent, audio: toBase64(bytes), end: last });
      bytes.fill(0);
      taken.set(s, n);
    }
    if (chunks.length === 0) return;
    room.relay.busy = true;
    let answer: WorkersKaraokeStreamAnswer;
    try {
      answer = await worker.stream(
        { room: room.id, chunks, drop: [] },
        AbortSignal.timeout(RELAY_TIMEOUT_MS),
      );
    } catch (error) {
      room.relay.busy = false;
      const status = (error as { status?: unknown }).status;
      room.relay.failures++;
      if (status === 404 || status === 400 || room.relay.failures >= RELAY_FAILURES) {
        this.#relayOff(room, status === 404 ? "the worker has no stream endpoint" : String(error));
      }
      return;
    }
    room.relay.busy = false;
    room.relay.failures = 0;
    if (room.state === "closed" || room.round !== round) return;
    for (const [s, n] of taken) {
      const a = s.audio;
      let left = n;
      while (left > 0 && a.pending.length > 0) {
        const head = a.pending[0] as Uint8Array;
        if (head.length <= left) {
          head.fill(0);
          a.pending.shift();
          left -= head.length;
        } else {
          head.subarray(0, left).fill(0);
          a.pending[0] = head.subarray(left);
          left = 0;
        }
      }
      a.pendingSamples -= n;
      a.sent += n;
      if (a.ended && a.pendingSamples === 0) a.endSent = true;
    }
    const byStream = new Map([...round.singers.values()].map((s) => [s.session.session, s]));
    for (const lost of answer.lost) {
      const s = byStream.get(lost);
      if (s !== undefined) this.#dropStream(s, new Uint8Array());
    }
    for (const f of answer.streams) {
      const s = byStream.get(f.stream);
      if (s === undefined || s.dropped || s.audio.startMs === null) continue;
      const offset = Math.round((s.audio.startMs / 1000) * KARAOKE_FRAME_HZ);
      const at = offset + f.from;
      const skip = Math.max(0, -at);
      s.voice.put(Math.max(0, at), f.midi.slice(skip), f.final);
      if (f.final) {
        s.voice.finish();
        s.final = {
          pitch: {
            hz: KARAOKE_FRAME_HZ,
            midi: f.midi,
            seconds: f.seconds,
            level_db: f.level_db,
            floor_db: f.floor_db,
            device: answer.device,
            method: answer.method,
          },
          offset_ms: s.audio.startMs,
        };
        s.finalAt = this.#d.now();
        this.#d.service.streamFinal(s.session.session, s.final.pitch, s.final.offset_ms);
      }
    }
  }

  /** The room stops streaming: every singer still live is scored from the estimate. */
  #relayOff(room: Room, why: string): void {
    if (room.relay.off) return;
    room.relay.off = true;
    this.#d.log.info({ room: room.id, why }, "karaoke: the room's voices are not streamed");
    for (const s of room.round?.singers.values() ?? []) {
      if (s.final === null) this.#dropStream(s, new Uint8Array());
    }
  }

  /**
   * The singers' latest pitch (the last second of each whose browser sent more since the last
   * time) to everyone not singing the round, and the stream's scene with it.
   */
  #live(room: Room, round: Round, now: number): void {
    const lines: KaraokeLiveEvent["lines"] = [];
    for (const s of round.singers.values()) {
      if (!s.pitchNew) continue;
      s.pitchNew = false;
      const pitch = this.#piece(s, LIVE_FRAMES);
      if (pitch !== null) lines.push({ member: s.member.id, pitch });
    }
    if (lines.length > 0) {
      const event: KaraokeLiveEvent = { type: "live", round: round.n, at_ms: now, lines };
      for (const f of room.followers) {
        if (round.singers.has(f.key)) continue;
        try {
          f.push(event);
        } catch {
          room.followers.delete(f);
        }
      }
    }
    this.#stage();
  }

  /** The running ranking: to the spectators as the board, to each singer as their trend. */
  #board(room: Room, now: number): void {
    const round = room.round;
    if (round === null) return;
    const singers = [...round.singers.values()];
    singers.forEach((s, i) => {
      // Staggered: half of them this second, the other half the next.
      if (now - s.ranAt < RUNNING_MS && s.ranAt !== 0 && i % 2 !== Math.floor(now / BOARD_MS) % 2)
        return;
      // The stream's official number while it keeps up with the browser's; else the estimate
      // (a slow worker never leaves the board behind or empty).
      const useVoice =
        s.final !== null ||
        (s.stream === "live" &&
          s.voice.length > 0 &&
          s.voice.length >= s.estimate.length - VOICE_BEHIND_FRAMES);
      const score = useVoice ? s.voice : this.#cleanEstimate(s);
      s.total = score.length > 0 ? score.score().total : 0;
      s.source = useVoice ? "voice" : "estimate";
      s.ranAt = now;
    });
    const before = new Map(singers.map((s) => [s, s.rank]));
    const order = [...singers].sort((a, b) => b.total - a.total);
    for (const s of order) s.rank = 1 + order.filter((o) => o.total > s.total).length;
    for (const s of singers) {
      if (s.total > 0) {
        s.bestRank = s.bestRank === null ? s.rank : Math.min(s.bestRank, s.rank);
        s.worstRank = s.worstRank === null ? s.rank : Math.max(s.worstRank, s.rank);
      }
      s.trend.push(now, s.rank, s.total);
    }
    for (const s of singers) {
      const prev = before.get(s) ?? s.rank;
      s.move = s.rank < prev ? "up" : s.rank > prev ? "down" : "same";
    }
    const lines: KaraokeBoardLine[] = order.map((s) => {
      const prev = before.get(s) ?? s.rank;
      return {
        member: s.member.id,
        name: s.member.name,
        color: s.member.color,
        rank: s.rank,
        total: s.total,
        source: s.source,
        move: s.rank < prev ? "up" : s.rank > prev ? "down" : "same",
        pitch: this.#piece(s, BOARD_PITCH_FRAMES),
        cheers: s.cheers,
      };
    });
    this.#deliver(room, lines, now);
    this.#forceScene = true;
    this.#stage();
  }

  /**
   * The browser's detections so far cleaned the way the browser's own running number cleans them
   * (`RunningScore`: octave slips folded, spikes filtered), so the board and the singer's screen
   * read the same singing alike.
   */
  #cleanEstimate(s: Singer): StreamScore {
    const raw = s.estimate.track;
    const clean = new StreamScore(s.input, raw.midi.length / TRACK_HZ + 1);
    clean.put(0, cleanPitch(raw.midi, TRACK_HZ));
    return clean;
  }

  // ---- the end of a round ----------------------------------------------------------------------

  /**
   * Singers whose live stream gave its final pitch but whose browser sent no result (within
   * `OWN_RESULT_GRACE_MS` of the final, or by the end of the round's grace): their result is made
   * from the stream, through the same submit as the browser's (scored officially from the stream
   * right after), so a round never waits on a page that stopped.
   */
  #ownResults(room: Room, round: Round, now: number): void {
    for (const s of round.singers.values()) {
      if (s.final === null || s.own !== "none") continue;
      if (!round.ended && now < s.finalAt + OWN_RESULT_GRACE_MS) continue;
      if (this.#d.store.result(s.session.session) !== null) {
        s.own = "done";
        continue;
      }
      s.own = "making";
      this.#track(this.#streamResult(room, round, s));
    }
  }

  async #streamResult(room: Room, round: Round, s: Singer): Promise<void> {
    const final = s.final;
    if (final === null) return;
    const session = s.session.session;
    // The stream's pitch in song time, as the browser's track would be (its samples are on the
    // browser's own audio clock), no longer than a result may be.
    const frames = recordingInSong(
      { hz: final.pitch.hz, midi: final.pitch.midi },
      final.offset_ms,
    ).slice(0, round.maxFrames);
    try {
      await this.#d.service.submit(s.member.account, session, {
        track: toBase64(encodeTrack(frames)),
        latency_ms: s.member.latency_ms,
        calibrated: s.member.calibrated,
        client_total: null,
        browser: "live stream",
        recording: false,
      });
      s.own = "done";
      this.#d.log.info(
        { room: room.id, round: round.n, session },
        "karaoke: a singer's result made from their live stream (no result from the browser)",
      );
    } catch (error) {
      s.own = this.#d.store.result(session) === null ? "failed" : "done";
      if (s.own === "failed") {
        this.#d.log.warn(
          { room: room.id, round: round.n, session, err: String(error) },
          "karaoke: no result from a singer's live stream",
        );
      }
    }
    this.#trySettle(room);
    if (room.round === round) this.#settlingTick(room, round, this.#d.now());
  }

  /** Whether a singer's result is in and final (not waiting for an official score). */
  #settled(s: Singer): boolean {
    const r = this.#d.store.result(s.session.session);
    return r !== null && r.voice_state !== "waiting" && r.voice_state !== "scoring";
  }

  /** While settling: the names of the singers still waited for and the latest moment, else `null`. */
  #settling(room: Room): { waiting: string[]; until_ms: number } | null {
    const round = room.round;
    if (round === null || room.state !== "singing" || this.#d.now() < round.songEnd) return null;
    const waiting = [...round.singers.values()]
      .filter((s) => !this.#settled(s))
      .sort((a, b) => a.member.joined - b.member.joined)
      .map((s) => s.member.name);
    return { waiting, until_ms: round.settleBy };
  }

  /** Everyone is told when settling starts and whenever whom it waits for changes. */
  #settlingTick(room: Room, round: Round, now: number): void {
    if (room.round !== round || room.state !== "singing" || now < round.songEnd) return;
    const key = JSON.stringify(this.#settling(room)?.waiting ?? []);
    if (key === round.settling) return;
    round.settling = key;
    this.#changed(room);
  }

  /**
   * Settles the round at once when every singer's result is in and final (official, or no official
   * score is coming); else at the last-resort wait (`settleBy`), which only a singer with neither a
   * stream's final nor a browser's result can make it wait for.
   */
  #trySettle(room: Room): void {
    const round = room.round;
    if (round === null || room.state !== "singing") return;
    const now = this.#d.now();
    const allIn = [...round.singers.values()].every((s) => this.#settled(s));
    if (!(allIn || now >= round.settleBy)) return;
    this.#settle(room, round, now);
  }

  #settle(room: Room, round: Round, now: number): void {
    const c = this.#cfg;
    const entries = [...round.singers.values()].map((s) => {
      const row = this.#d.store.result(s.session.session);
      const result =
        row === null ? null : (JSON.parse(row.detail) as { result: ScoreResult }).result;
      return { s, row, result };
    });
    const totals = entries.filter((e) => e.row !== null).map((e) => (e.row as ResultRow).total);
    const rankOf = (total: number) => 1 + totals.filter((t) => t > total).length;
    // Sung through: voiced over `room_finish_share` of the song's voice, and closer to it than
    // noise gets (the pitch share's floor), so humming anything does not count.
    const finished = (e: (typeof entries)[number]) =>
      e.result !== null &&
      e.result.facts.coverage >= c.room_finish_share &&
      e.result.pitch.hit > DEFAULT_TUNING.pitch_floor;
    const eligible = (e: (typeof entries)[number]) =>
      finished(e) && e.row?.source === "voice" && !e.row.unranked;
    const finishers = entries.filter(finished).length;
    const pool = entries.filter(eligible);
    const best =
      pool.length === 0 ? null : Math.max(...pool.map((e) => (e.row as ResultRow).total));
    const prizeOn = c.room_prize > 0 && finishers >= 2 && best !== null;
    let roundNote: string | null = null;
    if (c.room_prize > 0 && finishers < 2) roundNote = "不到兩個人唱完,這一首沒有第一名獎勵";
    else if (c.room_prize > 0 && best === null)
      roundNote = "沒有人拿到正式分數,這一首沒有第一名獎勵";
    const payouts: Omit<PayoutRow, "state" | "paid" | "paid_at">[] = [];
    const places: KaraokeRoomPlace[] = entries.map((e) => {
      const m = e.s.member;
      const isWinner = prizeOn && eligible(e) && (e.row as ResultRow).total === best;
      const done = finished(e);
      const madeUp = e.result?.flags.too_perfect ?? false;
      let coins = 0;
      let note: string | null = null;
      const checks = e.row === null ? [] : (JSON.parse(e.row.checks) as KaraokeVoiceCheck[]);
      if (e.row === null) note = "沒有交出分數";
      else if (!done) note = "沒有算唱完";
      else if (e.row.source !== "voice") note = "預估分數不能拿第一名獎勵";
      else if (checks.includes("bleed")) note = "收到喇叭的伴奏,不能拿第一名獎勵";
      else if (checks.includes("quiet")) note = "聲音太小,不能拿第一名獎勵";
      else if (e.row.unranked) note = "這一次沒有驗證,不能拿獎勵";
      if (m.person === null && done) note = "她還不認識你,沒有魚幣";
      const base = {
        room_id: room.id,
        round: round.n,
        person_id: m.person as string,
        platform: m.account.platform,
        account_id: m.account.id,
        created_at: toTimestamp(now),
      };
      if (m.person !== null && isWinner) {
        payouts.push({ ...base, kind: "prize", amount: c.room_prize });
        coins += c.room_prize;
      }
      if (m.person !== null && done && !madeUp && c.room_finish > 0) {
        payouts.push({ ...base, kind: "finish", amount: c.room_finish });
        coins += c.room_finish;
      }
      return {
        member: m.id,
        name: m.name,
        color: m.color,
        rank: e.row === null ? null : rankOf(e.row.total),
        total: e.row?.total ?? null,
        pitch: e.row?.pitch ?? null,
        stability: e.row?.stability ?? null,
        rhythm: e.row?.rhythm ?? null,
        expression: e.row?.expression ?? null,
        source: e.row === null ? null : e.row.source === "voice" ? "voice" : "estimate",
        finished: done,
        checks,
        coins,
        winner: isWinner,
        note,
      };
    });
    places.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    const result: KaraokeRoomResult = {
      round: round.n,
      song: { id: round.song.id, title: round.song.title, artist: round.song.artist },
      settling: false,
      places,
      note: roundNote,
    };
    if (!this.#d.store.settleRound(room.id, round.n, JSON.stringify(result), payouts, now)) return;
    room.result = result;
    room.state = "results";
    room.activity = now;
    for (const s of round.singers.values()) this.#sessions.delete(s.session.session);
    // A singing that never gave a result takes none from now on (not left open).
    this.#d.store.expireSessions(
      entries.filter((e) => e.row === null).map((e) => e.s.session.session),
      now,
    );
    // Everyone readies again for the next round; with no rounds left, nothing more is sung.
    for (const m of room.members.values()) m.ready = false;
    if (room.rounds >= c.room_rounds) room.queue = [];
    room.queueSeen = this.#queueLook(room);
    this.#endAir(room, round);
    // 「讓大家聽到我」 is asked for again every round.
    for (const m of room.members.values()) m.hear = false;
    this.#d.log.info(
      { room: room.id, round: round.n, finishers, payouts: payouts.length },
      "karaoke: a round settled",
    );
    this.#changed(room);
    // Her: the results, with the official numbers and what stood out.
    const lines: RoundLine[] = entries.map((e) => {
      const place = places.find((p) => p.member === e.s.member.id) as KaraokeRoomPlace;
      const bestPhrase = e.result?.facts.best ?? null;
      const p = bestPhrase === null ? undefined : e.result?.phrases[bestPhrase];
      return {
        name: e.s.member.name,
        rank: place.rank,
        total: place.total,
        source: place.source,
        finished: place.finished,
        coins: place.coins,
        winner: place.winner,
        bestRank: e.s.bestRank,
        worstRank: e.s.worstRank,
        vibrato_s: e.result?.expression.vibrato_s ?? null,
        best: p === undefined ? null : `第 ${p.index + 1} 句(${p.score} 分)`,
      };
    });
    this.#note(
      room,
      `karaoke:room:${room.id}:round:${round.n}:result`,
      roundResultNote(room.code, round.n, round.song.title, lines, roundNote),
      true,
    );
    for (const e of entries) {
      const person = e.s.member.person;
      if (person !== null && finished(e)) {
        this.#d.together(
          person,
          `在唱 K 房間和大家一起唱「${safeName(round.song.title, 40)}」${e.row?.total ?? 0} 分`,
          now,
          e.s.session.session,
        );
      }
    }
    void this.settleMoney().then(() => this.#coins(room, round.n));
  }

  /** The coins a settled round actually paid, onto its result. */
  #coins(room: Room, n: number): void {
    const result = room.result;
    if (result === null || result.round !== n) return;
    const rows = this.#d.store.payoutsOf(room.id, n);
    const round = room.round;
    for (const place of result.places) {
      const member = [...(round?.singers.values() ?? [])].find((s) => s.member.id === place.member);
      const person = member?.member.person;
      if (person === undefined || person === null) continue;
      const mine = rows.filter((r) => r.person_id === person);
      if (mine.some((r) => r.state === "due")) continue;
      place.coins = mine.reduce((sum, r) => sum + r.paid, 0);
      if (mine.some((r) => r.state === "capped")) place.note = "今天拿獎勵的次數到了";
      if (mine.some((r) => r.state === "refused")) place.note = "這個帳號現在不能拿魚幣";
    }
    this.#changed(room);
  }

  // ---- coins ------------------------------------------------------------------------------------

  /**
   * Gives back the openings owed and pays the payouts due, each once (the wallet's keys make a
   * retry the same row). Runs one at a time; what cannot be done now (no wallet) is tried again.
   */
  settleMoney(): Promise<void> {
    if (this.#moneyBusy !== null) {
      return this.#moneyBusy.then(() => this.#moneyBusy ?? this.settleMoney());
    }
    const run = this.#money().finally(() => {
      this.#moneyBusy = null;
    });
    this.#moneyBusy = run;
    return run;
  }

  async #money(): Promise<void> {
    const wallet = this.#d.wallet();
    const store = this.#d.store;
    if (wallet === null) return;
    for (const room of store.refundsDue()) {
      try {
        const back = await wallet.refund(
          { platform: room.opener_platform, id: room.opener_account },
          room.id,
        );
        store.refundDone(room.id);
        this.#d.log.info({ room: room.id, back }, "karaoke: a room's opening given back");
      } catch (error) {
        this.#d.log.warn({ room: room.id, err: String(error) }, "karaoke: a refund failed");
      }
    }
    for (const p of store.payoutsDue()) {
      try {
        const paid = await wallet.pay(
          { platform: p.platform, id: p.account_id },
          p.kind as "prize" | "finish",
          p.amount,
          `${p.room_id}:${p.round}:${p.person_id}`,
          `karaoke:${p.room_id}`,
          { since: toTimestamp(this.#dayStart(Date.parse(p.created_at))), perDay: this.#perDay(p) },
        );
        const state = paid.status === "duplicate" ? "paid" : paid.status;
        store.payoutDone(
          p,
          state,
          paid.status === "duplicate" ? p.amount : paid.paid,
          this.#d.now(),
        );
      } catch (error) {
        this.#d.log.warn({ room: p.room_id, err: String(error) }, "karaoke: a payout failed");
      }
    }
  }

  #perDay(p: PayoutRow): number {
    return p.kind === "prize" ? this.#cfg.room_prizes_per_day : this.#cfg.room_finishes_per_day;
  }

  /** The start of her local day containing `ms`. */
  #dayStart(ms: number): number {
    const offset = this.#cfg.utc_offset_minutes * 60_000;
    return Math.floor((ms + offset) / DAY_MS) * DAY_MS - offset;
  }

  /**
   * On start: every room left open by the last run is closed (its round void, its opening owed
   * back unless a round was sung through), and what is owed is paid.
   */
  async recover(): Promise<void> {
    const now = this.#d.now();
    for (const row of this.#d.store.openRooms()) {
      this.#d.store.closeRoom(row.id, CLOSE.restart, now);
      this.#d.log.info({ room: row.id }, "karaoke: a room left open was closed");
    }
    await this.settleMoney();
  }

  /** Every room closes (the module stops, or rooms were switched off). */
  closeAll(reason: string = CLOSE.off): void {
    for (const room of [...this.#rooms.values()]) this.#close(room, reason);
  }

  /**
   * The rooms open now (`/me play karaoke`), the most recently active first: those of `space`
   * (left out: of every server).
   */
  briefs(space?: string | null): RoomBrief[] {
    return [...this.#rooms.values()]
      .filter((r) => r.state !== "closed" && (space === undefined || r.space === space))
      .sort((a, b) => b.activity - a.activity)
      .map((room) => {
        const running = room.state === "countdown" || room.state === "singing";
        const round = room.round;
        const song = this.#shown(room)?.song ?? null;
        return {
          code: room.code,
          state: room.state as RoomBrief["state"],
          song: song === null ? null : song.title || null,
          singers:
            running && round !== null
              ? round.singers.size
              : [...room.members.values()].filter((m) => m.role === "singer").length,
          max_singers: this.#cfg.room_singers,
          members: room.members.size,
          queue: room.queue.map((e) => {
            const row = this.#d.store.song(e.song);
            return {
              title: row?.title || row?.source || "",
              by: e.byName,
              state: this.#stateOf(e),
            };
          }),
        };
      });
  }

  /** For the card: rooms open now and people in them. */
  counts(): { rooms: number; people: number } {
    let people = 0;
    for (const room of this.#rooms.values()) people += room.members.size;
    return { rooms: this.#rooms.size, people };
  }

  // ---- views and notes --------------------------------------------------------------------------

  #view(room: Room, account: AccountRef): KaraokeRoomView {
    const key = this.#d.who(account).person ?? accountRefString(account);
    const me = room.members.get(key) ?? null;
    const round = room.round;
    const running = room.state === "countdown" || room.state === "singing";
    const shown = this.#shown(room);
    let song: KaraokeRoomView["song"] = null;
    if (shown !== null) {
      try {
        song = this.#d.service.song(account, shown.song.id);
      } catch {
        song = null;
      }
    }
    const next = this.#next(room);
    // Each entry's song as anyone sees it: nobody's score is in it.
    const queue: KaraokeRoomQueueEntry[] = [];
    for (const e of room.queue) {
      const view = this.#d.service.songView(e.song);
      if (view === null) continue;
      queue.push({
        id: e.id,
        song: view,
        shift: e.shift,
        by: { member: room.members.get(e.by)?.id ?? null, name: e.byName },
        mine: e.by === key,
      });
    }
    return {
      code: room.code,
      state: room.state,
      closed_reason: room.closedReason,
      song,
      shift: shown?.shift ?? 0,
      queue,
      next: next?.id ?? null,
      members: [...room.members.values()]
        .sort((a, b) => a.joined - b.joined)
        .map((m) => ({
          id: m.id,
          name: m.name,
          role: m.role,
          ready: m.ready,
          opener: m.key === room.opener,
          color: m.color,
          hear: m.hear,
          skip: m.skip,
        })),
      me:
        me === null
          ? null
          : {
              id: me.id,
              role: me.role,
              opener: me.key === room.opener,
              singing: running && (round?.singers.has(me.key) ?? false),
              session: running
                ? (round?.singers.get(me.key)?.session ?? round?.watch.get(me.key) ?? null)
                : null,
            },
      round: room.rounds,
      rounds_left: Math.max(0, this.#cfg.room_rounds - room.rounds),
      start_at_ms: running && round !== null ? round.startAt : null,
      result: room.result,
      terms: this.#terms(),
      air: this.#air(room, me),
      queue_limits: {
        per_person: this.#cfg.room_queue_per_person,
        max: this.#cfg.room_queue_max,
      },
      settling: this.#settling(room),
    };
  }

  /**
   * A note for her about `room`; she may speak (in its server's comment channel) when `speak` and
   * comments are on.
   */
  #note(room: Room, key: string, summary: string, speak: boolean): void {
    const cfg = this.#cfgOf(room.space);
    const context = speak && cfg.comment ? commentContext(cfg.comment_channel) : null;
    try {
      this.#d.tell({ summary, key, person: null, context });
    } catch (error) {
      this.#d.log.warn({ err: String(error) }, "karaoke: cannot tell her about a room");
    }
  }
}

/** The round's reference notes for the stream's lanes (song seconds, MIDI), at most the cap. */
function notesForStage(
  notes: readonly { start: number; end: number; midi: number }[],
): KaraokeStageLyrics["notes"] {
  return notes
    .filter((n) => Number.isFinite(n.start) && Number.isFinite(n.end) && Number.isFinite(n.midi))
    .filter((n) => n.end > 0)
    .slice(0, KARAOKE_NOTES_MAX)
    .map((n) => {
      const start = Math.max(0, n.start);
      return { start, end: Math.max(start, n.end), midi: n.midi };
    });
}

/** Lyrics this long (as JSON) go to the stream without their pieces (the stage link's frame cap). */
const STAGE_LYRICS_MAX_CHARS = 600_000;

/** The lyrics as the stream gets them: as they are, or as whole lines when they would be too big. */
function lyricsForStage(lyrics: KaraokeStageLyrics["lyrics"]): KaraokeStageLyrics["lyrics"] {
  if (lyrics === null || JSON.stringify(lyrics).length <= STAGE_LYRICS_MAX_CHARS) return lyrics;
  return { ...lyrics, lines: lyrics.lines.map((l) => ({ ...l, pieces: null, aligned: false })) };
}
