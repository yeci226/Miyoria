// Karaoke rooms (docs/design/karaoke.md 「做了什麼第四步」): up to `room_singers` people sing the
// same song at the same moment, each in their own browser, while she is in a voice channel and
// hosts. `RoomDesk` holds the rooms in memory and keeps in the store only what the coins need
// across a restart (the room and its opening charge, its rounds, what a settled round pays).
//
//   lobby ──start──▶ countdown ──start_at──▶ singing ──all in / time──▶ results ──song──▶ lobby
//     └───────────── closed: the opener, empty, idle, she left voice, Core restarted ──────────┘
//
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
// * Who sees what is decided here, per connection, not in the page: a singer of the running round
//   only ever gets `trend` about themselves; everyone else gets the `board`.
// * Coins (the karaoke wallet): the opening is charged before the room exists (written first as
//   `charging`, so a crash in between still gives it back); a room ends owing it back unless a round
//   was sung through; a settled round writes what it pays in the same transaction as its ranking,
//   then pays it, keyed per room, round and person: a restart pays what is `due` again and the
//   wallet's key makes that the same payment.

import type {
  KaraokeAudioReply,
  KaraokeBoardLine,
  KaraokeClockReply,
  KaraokeRoomEvent,
  KaraokeRoomPlace,
  KaraokeRoomResult,
  KaraokeRooms,
  KaraokeRoomTerms,
  KaraokeRoomView,
  KaraokeSession,
  KaraokeVoiceCheck,
} from "@miyoria/contracts/api";
import type {
  KaraokeStageLine,
  KaraokeStageLyrics,
  KaraokeStageScene,
  KaraokeStageVoice,
} from "@miyoria/contracts/stage-link";
import {
  KARAOKE_FRAME_HZ,
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
  type KaraokeWallet,
  type KaraokeWorker,
  newId,
  type PersonId,
  safeName,
  toTimestamp,
} from "@miyoria/types";
import { type AirSinger, lyricGaps, RoomAir } from "./air.js";
import { commentContext, type KaraokeConfig } from "./config.js";
import { sungEnd } from "./lyrics/index.js";
import { type RoundLine, roomOpenedNote, roundResultNote, roundStartNote } from "./notes.js";
import {
  DEFAULT_TUNING,
  decodeTrack,
  encodeTrack,
  fromBase64,
  type ScoreResult,
  StreamScore,
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
/** A member not following the room (no open page) for this long has left. */
export const AWAY_MS = 60_000;
/** Frames of a singer's recent pitch on the board (1.5 s). */
const BOARD_PITCH_FRAMES = 75;
/** µ-law silence. */
const MULAW_SILENCE = 0xff;
/** What a room code is made of (no 0/O, 1/I/L). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const DAY_MS = 86_400_000;

const SAY = {
  closed: "現在沒有開放唱 K",
  noRooms: "現在沒有開放多人房間",
  noVoice: "她要在語音頻道裡才能開房間",
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
  /** She is in a voice channel now. */
  inVoice: () => boolean;
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
  estimate: StreamScore;
  final: { pitch: WorkersKaraokeVoicePitch; offset_ms: number } | null;
  trend: TrendTracker;
  shown: Trend | null;
  rank: number;
  total: number;
  source: "voice" | "estimate";
  ranAt: number;
  bestRank: number | null;
  worstRank: number | null;
  recent: { from: number; frames: (number | null)[] };
  /** Since the board before. */
  move: "up" | "down" | "same";
}

interface Round {
  n: number;
  song: SongRow;
  shift: number;
  startAt: number;
  endAt: number;
  settleBy: number;
  singers: Map<string, Singer>;
  /** The files to watch the round with, for the members not singing it (never submitted). */
  watch: Map<string, KaraokeSession>;
  ended: boolean;
  boardAt: number;
  /** The stream's voice of this round, while a scene is on (`null`: none). */
  air: RoomAir | null;
  /** The words, video and backing the stream plays it with, once found (`null` until then). */
  stage: KaraokeStageLyrics | null;
}

interface Follower {
  account: AccountRef;
  key: string;
  push: (event: KaraokeRoomEvent) => void;
}

interface Room {
  id: string;
  code: string;
  opener: string;
  state: "lobby" | "countdown" | "singing" | "results" | "closed";
  closedReason: string | null;
  song: SongRow | null;
  shift: number;
  members: Map<string, Member>;
  followers: Set<Follower>;
  rounds: number;
  round: Round | null;
  result: KaraokeRoomResult | null;
  activity: number;
  relay: { busy: boolean; failures: number; off: boolean; at: number };
  /** The opener's 「播出第一名的歌聲」 (rounds of two or more singers). */
  lead: boolean;
}

/** What the score makes of a microphone chunk (the reply has the stream's part too). */
type ScoreReply = Omit<KaraokeAudioReply, "relay">;

export class RoomDesk implements RoomLink {
  readonly #d: RoomDeps;
  readonly #rooms = new Map<string, Room>();
  /** Session id → the room and member singing it. */
  readonly #sessions = new Map<string, { room: Room; member: string }>();
  #moneyBusy: Promise<void> | null = null;
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

  /** Why a room cannot be opened or joined now (`null`: it can). */
  #why(admin: boolean): string | null {
    if (!this.#cfg.open && !admin) return SAY.closed;
    if (!this.#cfg.rooms) return SAY.noRooms;
    if (!this.#d.inVoice()) return SAY.noVoice;
    return null;
  }

  async overview(account: AccountRef, admin = false): Promise<KaraokeRooms> {
    this.#key(account);
    const reason = this.#why(admin);
    const wallet = this.#d.wallet();
    return {
      available: reason === null,
      reason,
      terms: this.#terms(),
      balance: wallet === null ? null : await wallet.balance(account),
      mine: this.#mine(account)?.code ?? null,
    };
  }

  /** Opens a room with a ready song, and charges the opener for it. */
  async open(
    account: AccountRef,
    name: string,
    songId: string,
    shift: number,
    admin = false,
  ): Promise<KaraokeRoomView> {
    const { key, who } = this.#key(account);
    const why = this.#why(admin);
    if (why !== null) throw new KaraokeError(409, why);
    if (this.#mine(account) !== null) throw new KaraokeError(409, SAY.already);
    if (this.#rooms.size >= this.#cfg.room_max) throw new KaraokeError(409, SAY.full);
    // The song and its files first: a refusal here costs nothing.
    const song = await this.#d.service.readySong(songId, shift);
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
      opener: key,
      state: "lobby",
      closedReason: null,
      song,
      shift,
      members: new Map([[key, member]]),
      followers: new Set(),
      rounds: 0,
      round: null,
      result: null,
      activity: now,
      relay: { busy: false, failures: 0, off: false, at: 0 },
      lead: this.#cfg.relay_lead,
    };
    this.#rooms.set(code, room);
    this.#d.log.info({ room: id, code, price }, "karaoke: a room opened");
    this.#note(`karaoke:room:${id}:open`, roomOpenedNote(name, code, song.title), true);
    return this.#view(room, account);
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

  /** The opener picks the next song (in the lobby, or once a round's results are in). */
  async song(
    code: string,
    account: AccountRef,
    songId: string,
    shift: number,
  ): Promise<KaraokeRoomView> {
    const { key } = this.#key(account);
    const room = this.#room(code);
    if (room.opener !== key) throw new KaraokeError(403, SAY.notOpener);
    if (room.state !== "lobby" && room.state !== "results") throw new KaraokeError(409, SAY.notNow);
    const song = await this.#d.service.readySong(songId, shift);
    if (room.state !== "lobby" && room.state !== "results") throw new KaraokeError(409, SAY.notNow);
    room.song = song;
    room.shift = shift;
    room.state = "lobby";
    for (const m of room.members.values()) m.ready = false;
    room.activity = this.#d.now();
    this.#changed(room);
    return this.#view(room, account);
  }

  /** The opener starts a round: everyone who is ready sings it, from one moment of Core's clock. */
  async start(code: string, account: AccountRef): Promise<KaraokeRoomView> {
    const { key } = this.#key(account);
    const room = this.#room(code);
    if (room.opener !== key) throw new KaraokeError(403, SAY.notOpener);
    if (room.state !== "lobby" || room.song === null) throw new KaraokeError(409, SAY.notNow);
    if (room.rounds >= this.#cfg.room_rounds) throw new KaraokeError(409, SAY.roundsUsed);
    if (!this.#d.inVoice()) throw new KaraokeError(409, SAY.noVoice);
    const ready = [...room.members.values()].filter((m) => m.role === "singer" && m.ready);
    if (ready.length === 0) throw new KaraokeError(409, SAY.noSingers);
    const song = room.song;
    const shift = room.shift;
    const reference = shiftKaraokeReference(await this.#d.service.reference(song.id), shift);
    // Each singer's session: the single-player one, bound to the room.
    const sessions = new Map<string, KaraokeSession>();
    for (const m of ready) {
      sessions.set(m.key, await this.#d.service.session(m.account, m.name, song, shift, room.id));
    }
    if (room.state !== "lobby") throw new KaraokeError(409, SAY.notNow);
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
      endAt: startAt + duration + END_GRACE_MS,
      settleBy: startAt + duration + END_GRACE_MS + SETTLE_WAIT_MS,
      singers: new Map(),
      watch: new Map(),
      ended: false,
      boardAt: 0,
      air: null,
      stage: null,
    };
    for (const m of room.members.values()) {
      if (sessions.has(m.key)) continue;
      round.watch.set(
        m.key,
        await this.#d.service.session(m.account, m.name, song, shift, room.id),
      );
    }
    if (room.state !== "lobby") throw new KaraokeError(409, SAY.notNow);
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
        final: null,
        trend: new TrendTracker(),
        shown: null,
        rank: 1,
        total: 0,
        source: "estimate",
        ranAt: 0,
        bestRank: null,
        worstRank: null,
        recent: { from: 0, frames: [] },
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
      const files = this.#stageFiles(room, round, reference.lyrics).finally(() =>
        this.#inflight.delete(files),
      );
      this.#inflight.add(files);
    }
    this.#changed(room);
    this.#note(
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

  /** The round's words, video and backing for the stream (fetched while it counts down). */
  async #stageFiles(room: Room, round: Round, lyrics: KaraokeStageLyrics["lyrics"]): Promise<void> {
    let files: Awaited<ReturnType<KaraokeService["streamFiles"]>>;
    try {
      files = await this.#d.service.streamFiles(round.song, round.shift);
    } catch {
      files = { backing: null, video: null };
    }
    if (room.round !== round || room.state === "closed") return;
    round.stage = {
      room: room.code,
      round: round.n,
      song: round.song.id.slice(0, 128),
      lyrics: lyricsForStage(lyrics),
      video: files.video,
      backing: this.#cfg.stream_backing ? files.backing : null,
    };
    // A scene that showed this round before its files came gets them now.
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
      };
    }
    const now = this.#d.now();
    const round = room.round;
    const running = room.state === "countdown" || room.state === "singing";
    const song = running && round !== null ? round.song : room.song;
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
      shift: running && round !== null ? round.shift : room.shift,
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
    };
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
        event = {
          type: "trend",
          round: round.n,
          trend: singer.trend.trend,
          source: singer.source,
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

  /** The browser's own detected pitch since `from` (50 Hz song time): the estimate. */
  pitch(code: string, account: AccountRef, from: number, track: string): void {
    const { singer } = this.#singer(code, account);
    const bytes = fromBase64(track);
    if (bytes === null || !Number.isInteger(from) || from < 0) {
      throw new KaraokeError(400, "音高軌的格式不對");
    }
    const frames = decodeTrack(bytes);
    singer.estimate.put(from, frames);
    const r = singer.recent;
    const all = [...r.frames];
    for (let k = 0; k < frames.length; k++) all[from + k - r.from] = frames[k] ?? null;
    const keepFrom = Math.max(r.from, from + frames.length - BOARD_PITCH_FRAMES);
    singer.recent = {
      from: keepFrom,
      frames: Array.from(all.slice(Math.max(0, keepFrom - r.from)), (m) => m ?? null),
    };
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
    if (at !== undefined) this.#trySettle(at.room);
  }

  // ---- the pass --------------------------------------------------------------------------------

  /** One look at every room (about four times a second). */
  async tick(): Promise<void> {
    const now = this.#d.now();
    if (this.#rooms.size > 0 && (!this.#cfg.rooms || !this.#d.inVoice())) {
      const reason = this.#cfg.rooms ? CLOSE.voice : CLOSE.off;
      for (const room of [...this.#rooms.values()]) this.#close(room, reason);
      return;
    }
    for (const room of [...this.#rooms.values()]) {
      // People with no page open for a while have left (not while they sing a round).
      const running = room.state === "countdown" || room.state === "singing";
      for (const m of [...room.members.values()]) {
        if ([...room.followers].some((f) => f.key === m.key)) m.seen = now;
        else if (now - m.seen > AWAY_MS && !(running && room.round?.singers.has(m.key))) {
          this.#leave(room, m.key);
        }
      }
      if (room.state === "closed") continue;
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
      // Streams that went quiet, and the end of the song.
      for (const s of round.singers.values()) {
        const a = s.audio;
        if (
          s.stream === "live" &&
          !a.ended &&
          now - Math.max(a.lastAt, round.startAt) > STREAM_QUIET_MS
        ) {
          this.#dropStream(s, new Uint8Array());
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
      this.#airTick(room, now);
      this.#trySettle(room);
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

  /** The running ranking: to the spectators as the board, to each singer as their trend. */
  #board(room: Room, now: number): void {
    const round = room.round;
    if (round === null) return;
    const singers = [...round.singers.values()];
    singers.forEach((s, i) => {
      // Staggered: half of them this second, the other half the next.
      if (now - s.ranAt < RUNNING_MS && s.ranAt !== 0 && i % 2 !== Math.floor(now / BOARD_MS) % 2)
        return;
      const useVoice = s.final !== null || (s.stream === "live" && s.voice.length > 0);
      const score = useVoice ? s.voice : s.estimate;
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
      const r = s.recent;
      return {
        member: s.member.id,
        name: s.member.name,
        color: s.member.color,
        rank: s.rank,
        total: s.total,
        source: s.source,
        move: s.rank < prev ? "up" : s.rank > prev ? "down" : "same",
        pitch:
          r.frames.length === 0 ? null : { from: r.from, track: toBase64(encodeTrack(r.frames)) },
      };
    });
    this.#deliver(room, lines, now);
    this.#forceScene = true;
    this.#stage();
  }

  // ---- the end of a round ----------------------------------------------------------------------

  /** Settles the round once every singer's result is in and official (or the wait is over). */
  #trySettle(room: Room): void {
    const round = room.round;
    if (round === null || room.state !== "singing") return;
    const now = this.#d.now();
    const rows = [...round.singers.values()].map((s) => this.#d.store.result(s.session.session));
    const allIn = rows.every(
      (r) => r !== null && r.voice_state !== "waiting" && r.voice_state !== "scoring",
    );
    if (!(allIn || now >= round.settleBy || (round.ended && now >= round.endAt + SETTLE_WAIT_MS))) {
      return;
    }
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
    let song: KaraokeRoomView["song"] = null;
    if (room.song !== null) {
      try {
        song = this.#d.service.song(account, room.song.id);
      } catch {
        song = null;
      }
    }
    return {
      code: room.code,
      state: room.state,
      closed_reason: room.closedReason,
      song,
      shift: room.shift,
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
    };
  }

  /** A note for her; she may speak (in the comment channel) when `speak` and comments are on. */
  #note(key: string, summary: string, speak: boolean): void {
    const context = speak && this.#cfg.comment ? commentContext(this.#cfg.comment_channel) : null;
    try {
      this.#d.tell({ summary, key, person: null, context });
    } catch (error) {
      this.#d.log.warn({ err: String(error) }, "karaoke: cannot tell her about a room");
    }
  }
}

/** Lyrics this long (as JSON) go to the stream without their pieces (the stage link's frame cap). */
const STAGE_LYRICS_MAX_CHARS = 600_000;

/** The lyrics as the stream gets them: as they are, or as whole lines when they would be too big. */
function lyricsForStage(lyrics: KaraokeStageLyrics["lyrics"]): KaraokeStageLyrics["lyrics"] {
  if (lyrics === null || JSON.stringify(lyrics).length <= STAGE_LYRICS_MAX_CHARS) return lyrics;
  return { ...lyrics, lines: lyrics.lines.map((l) => ({ ...l, pieces: null, aligned: false })) };
}
