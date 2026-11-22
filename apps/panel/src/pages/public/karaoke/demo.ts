// A dev-only stand-in for the Core and the audio, to look at the karaoke page without either:
// open the dev server at `/karaoke?karaoke-demo`. `main.tsx` loads this only when
// `import.meta.env.DEV` (so a production build has none of it) and the query asks for it.
//
// What is faked: every `/api/*` answer the page needs (a member, the song list, a song being
// prepared, the signed files, the result, the official score and her comment), and the audio: no
// backing track plays and no microphone opens; a made-up singer follows the reference a little late
// and a little off, and the "recording" is a few empty bytes. What is real: the page, the lane, the
// clock, `Take`, `LiveScore`, the encoded track, and the score (`scoreSinging` runs here on what the
// page sends, the way Core would).
//
// The songs: 紙船 has a video (a made-up test pattern, `demo-video.mp4`, which counts the
// seconds so its sync with the song shows); 夜空中最亮的星 says it has one but its link leads nowhere,
// so the stage falls back to the still; the others have none. A singing goes 預估 → 正在算 →
// 正式分數 (a little higher than the estimate, which stays shown small); the second of 最近唱的 had
// the backing in its recording (`bleed`).
//
// The reference editor (step 6): `?karaoke-demo=editor` makes the visitor a panel admin and opens
// the editor on 紙船 (its fourth line is the doubtful one, listed first); saves and restores are kept
// in memory and checked with the same rules Core uses, and the backing is a made-up WAV.
//
// Rooms (step 4) without a Core: `?karaoke-demo=lobby`, `=singer`, `=solo` (alone, on air), `=spectator` or `=results` opens
// the made-up room KTV888 in that scene (the address becomes `/karaoke/room/KTV888`); plain
// `?karaoke-demo` starts at the list, where 一起唱 opens a room of your own. The room's event stream
// is faked (`setRoomEventsFactory`): the singer's scene counts down five seconds and cycles their
// trend (上升中 → 保持 → 下降中, 正式 and 預估) with their own running total; the spectator's has
// four made-up singers whose ranking moves every second and whose pitch lines follow the tune, each a
// little off in its own way. After the song the room is 結算中 for a few seconds (waiting for two
// singers, then one, then no one) before the results, which have a winner, a 預估 line, a check and
// a note. The stream and pitch posts are
// answered `live` and 204; a room singer's result needs no recording upload (the stream held).
// Spectating: the spectator's scene gets each singer's latest pitch four times a second (`live`)
// between the boards, made-up watchers cheer the singers every couple of seconds, and the cheer
// buttons work (Core's wait is 1.5 s; the cheer comes back on the stream). The singer's scene gets
// a cheer for them now and then. `?karaoke-demo=novoice` opens the list while she is not in a voice
// channel: 開一間房 is off and says why, and she "joins" after six seconds (the button turns on by
// itself, the way the page follows Core).
//
// A room opens without a song; its queue (kept in memory) starts with a ready song, one being
// prepared (its progress moves until it is ready) and one that failed. Adding (from the list, or a
// link or words, which becomes a song being prepared; words with `limit` are refused as the day's
// limit), removing and moving work; a round plays the first ready entry and drops the failed ones.

import type {
  KaraokeBoardLine,
  KaraokeEditSave,
  KaraokeEditView,
  KaraokeOverview,
  KaraokeResult,
  KaraokeRoomEvent,
  KaraokeRoomMember,
  KaraokeRoomQueueEntry,
  KaraokeRoomResult,
  KaraokeRooms,
  KaraokeRoomView,
  KaraokeSession,
  KaraokeSongView,
  KaraokeSubmit,
} from "@miyoria/contracts/api";
import type {
  WorkersKaraokeLineV2,
  WorkersKaraokePiece,
  WorkersKaraokeReferenceV2,
} from "@miyoria/contracts/workers/karaoke";
import { composeReference, editedLines, validateEdit } from "@miyoria/play/karaoke/edit";
import { decodeTrack, encodeTrack, fromBase64, scoreSinging, TRACK_HZ, toBase64 } from "@miyoria/play/karaoke/score";
import { type KaraokeEngine, type MicStream, setEngineFactory } from "./audio";
// A 64 s test pattern with a seconds counter (ffmpeg's `testsrc`, 1280x720 at 12 fps, H.264, no
// sound, ~260 KB), so the video's cover and its sync with the song can be seen. Only this file
// refers to it, and this file is only in the dev server, so a production build has none of it.
import demoVideo from "./demo-video.mp4?url";
import type { StreamPiece } from "./mulaw";
import type { Detection } from "./pitch";
import { type RecorderState, type RecordingLimits, recordingOffsetMs, type VoiceRecorder, type VoiceTake } from "./recorder";
import { type RoomEventsHandlers, setRoomEventsFactory } from "./room-api";

// ---------------------------------------------------------------------------
// a made-up song: an original tune and words

const HZ = 50;
/** [start, length, midi] of each note; the words of each line. */
const TUNE: [number, number, number][] = [];
const WORDS = [
  "窗外的燈一盞一盞亮起來",
  "我把今天的心事折成紙船",
  "順著夜色慢慢地往前漂",
  "你說明天也會是晴天",
  "跟著拍子輕輕地唱",
  "把想說的話都交給風",
  "等到星星都睡著以後",
  "再一起回家吧",
];
const LINE_S = 7;
const FIRST = 2;
const SCALE = [0, 2, 4, 5, 7, 9, 11, 12];
/** The demo's own pinyin (the worker gives it with pypinyin). */
const PINYIN: Record<string, string> = Object.fromEntries(
  (
    "窗chuāng 外wài 的de 燈dēng 一yì 盞zhǎn 亮liàng 起qǐ 來lái 我wǒ 把bǎ 今jīn 天tiān 心xīn 事shì 折zhé " +
    "成chéng 紙zhǐ 船chuán 順shùn 著zhe 夜yè 色sè 慢màn 地de 往wǎng 前qián 漂piāo 你nǐ 說shuō 明míng 也yě " +
    "會huì 是shì 晴qíng 跟gēn 拍pāi 子zi 輕qīng 唱chàng 想xiǎng 話huà 都dōu 交jiāo 給gěi 風fēng 等děng 到dào " +
    "星xīng 睡shuì 以yǐ 後hòu 再zài 回huí 家jiā 吧ba"
  )
    .split(" ")
    .map((w) => [w.slice(0, 1), w.slice(1)]),
);
/** The fourth line is one the recogniser did not hear as written: shown, not aligned. */
const DOUBTFUL_LINE = 3;
const lines: WorkersKaraokeLineV2[] = WORDS.map((text, i) => {
  const start = FIRST + i * LINE_S;
  // Six notes a line, the last one held.
  let t = start;
  for (let k = 0; k < 6; k++) {
    const len = k === 5 ? 1.8 : 0.7;
    const degree = SCALE[(i * 3 + k * 2) % SCALE.length] as number;
    TUNE.push([t, len - 0.06, 62 + degree - (i % 2 === 0 ? 0 : 2)]);
    t += len;
  }
  const aligned = i !== DOUBTFUL_LINE;
  const chars = [...text];
  const step = (t - start - 0.3) / chars.length;
  const pieces: WorkersKaraokePiece[] = chars.map((c, k) => ({
    text: c,
    sung: true,
    start: aligned ? start + k * step : null,
    end: aligned ? start + (k + 1) * step : null,
    reading: PINYIN[c] ?? null,
    roman: null,
  }));
  return {
    start,
    end: t,
    text,
    status: aligned ? ("matched" as const) : ("uncertain" as const),
    source: "found" as const,
    similarity: aligned ? 1 : 0.62,
    heard: text,
    aligned,
    pieces,
    edited: false,
  };
});
const DURATION = FIRST + WORDS.length * LINE_S + 3;

const curve: (number | null)[] = Array.from({ length: Math.ceil(DURATION * HZ) }, (_, i) => {
  const t = i / HZ;
  const note = TUNE.find(([s, len]) => t >= s && t < s + len);
  if (!note) return null;
  const [s, len, midi] = note;
  const into = t - s;
  // A scoop into each note and vibrato on the held ones.
  const scoop = into < 0.06 ? -0.6 * (1 - into / 0.06) : 0;
  const vib = len > 1 && into > 0.5 ? 0.35 * Math.sin(2 * Math.PI * 5.6 * into) : 0;
  return midi + scoop + vib;
});

const REFERENCE: WorkersKaraokeReferenceV2 = {
  format: "miyoria.karaoke.reference",
  version: 2,
  id: "demo-song",
  title: "紙船",
  artist: "示範",
  duration_s: DURATION,
  backing: "karaoke.m4a",
  pitch: { hz: HZ, start: 0, midi: curve },
  notes: TUNE.map(([start, len, midi]) => ({
    start,
    end: start + len,
    midi,
    source: "pitch" as const,
    line: null,
    char: null,
  })),
  lyrics: {
    provider: "demo",
    source: "found",
    language: "zh",
    timing: "char",
    check: { matched: WORDS.length - 1, uncertain: 1, failed: 0, verdict: "kept" },
    lines,
  },
  quality: { ok: true, reason: null, voiced_ratio: 0.8, notes: TUNE.length, lead_split: true },
  made: { pitch: "demo", notes: "demo", lyrics: "demo", asr: "demo", aligner: "demo" },
};

// ---------------------------------------------------------------------------
// the Core

const song = (over: Partial<KaraokeSongView>): KaraokeSongView => ({
  id: "demo-song",
  title: "紙船",
  artist: "示範",
  duration_s: DURATION,
  state: "ready",
  stage: null,
  progress: 1,
  position: null,
  error: null,
  lyrics: true,
  lyrics_source: "found",
  notes: TUNE.length,
  video: false,
  mine: false,
  best: null,
  sung: 0,
  ...over,
});

let preparingPolls = 0;
const STAGES = ["queued", "download", "separate", "lead", "reference", "encode", "lyrics"];

function preparing(): KaraokeSongView {
  const n = preparingPolls++;
  const stage = STAGES[Math.min(STAGES.length - 1, 2 + Math.floor(n / 6))] as string;
  return song({
    id: "demo-prep",
    title: "春日影",
    artist: "示範樂團",
    state: "preparing",
    stage,
    progress: Math.min(0.95, 0.36 + n * 0.02),
    position: null,
    mine: true,
    duration_s: null,
  });
}

/** `?karaoke-demo=editor`: the visitor is a panel admin, and the page opens the editor on 紙船. */
let asAdmin = false;

function overview(): KaraokeOverview {
  return {
    open: true,
    admin: asAdmin,
    preparing: true,
    songs: [
      song({ best: 84.6, sung: 4, video: true }),
      song({ id: "d2", title: "夜空中最亮的星", artist: "逃跑計劃", duration_s: 252, best: 77.2, sung: 2, video: true }),
      song({ id: "d3", title: "群青", artist: "YOASOBI", duration_s: 248, lyrics_source: "heard" }),
      song({ id: "d4", title: "小幸運", artist: "田馥甄", duration_s: 265, lyrics: false, lyrics_source: null }),
      song({ id: "d5", title: "First Love", artist: "宇多田ヒカル", duration_s: 259, best: 69.8, sung: 1 }),
      preparing(),
      song({
        id: "demo-fail",
        title: "一首很長的歌",
        artist: null,
        state: "failed",
        error: "這首超過 8 分鐘,沒有準備",
        mine: true,
        duration_s: null,
      }),
    ],
    limits: { daily: 10, used: 3, max_minutes: 8 },
    tolerance_cents: 50,
    comments: true,
    recent: [
      { session: "demo-old", song: "demo-song", title: "紙船", total: 84.6, unranked: false, at: ago(26) },
      { session: "demo-old2", song: "d2", title: "夜空中最亮的星", total: 77.2, unranked: false, at: ago(60 * 20) },
    ],
  };
}

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const results = new Map<string, { result: KaraokeResult; polls: number; uploaded: boolean }>();
/** The key of each session, and of the one singing now (the made-up singer follows it). */
const keys = new Map<string, number>();
let singingKey = 0;
const COMMENT =
  "第三句那個長音拉得很穩,還帶了一點顫音,我有聽到喔。副歌開頭稍微搶拍了,下次跟著伴奏的鼓再等半拍就更好了。";

function scored(body: KaraokeSubmit, session: string): KaraokeResult {
  const bytes = fromBase64(body.track) ?? new Uint8Array();
  const shift = keys.get(session) ?? 0;
  const r = scoreSinging({
    reference: { hz: HZ, start: 0, midi: curve.map((m) => (m === null ? null : m + shift)) },
    sung: { hz: TRACK_HZ, midi: decodeTrack(bytes) },
    latency_ms: body.latency_ms,
    calibrated: body.calibrated,
    phrases: lines.map((l) => ({ start: l.start, end: l.end })),
  });
  return {
    ...r,
    session,
    source: "estimate",
    // A room's singer whose stream held: the official score comes from the stream, no upload.
    voice: roomSessions.has(session)
      ? { state: "scoring", estimate_total: null, checks: [], upload: false }
      : { state: body.recording ? "waiting" : "none", estimate_total: null, checks: [], upload: body.recording === true },
    song: { id: "demo-song", title: "紙船", artist: "示範" },
    at: new Date().toISOString(),
    phrases: r.phrases.map((p) => ({ ...p, text: WORDS[p.index] ?? null })),
    unranked: r.flags.too_perfect,
    client_total: body.client_total ?? null,
    latency_ms: body.latency_ms,
    best_before: 84.6,
    comment: { state: "waiting", text: null },
  } as unknown as KaraokeResult;
}

/** The recording's score: a little higher than the estimate, which is kept to show beside it. */
function officially(r: KaraokeResult): KaraokeResult {
  const total = Math.min(100, Math.round((r.total + 4.6) * 10) / 10);
  return {
    ...r,
    source: "voice",
    total,
    pitch: { ...r.pitch, score: Math.min(r.pitch.max, Math.round((r.pitch.score + 4.6) * 10) / 10) },
    voice: { state: "scored", estimate_total: r.total, checks: [], upload: false },
  };
}

/** A full singing for the result opened from the list: a made-up track run through the score. */
function oldResult(session: string): KaraokeResult {
  const sung = curve.map((m, i) => (m === null ? null : m - 12 + 0.15 * Math.sin(i / 7) + (i > 1500 && i < 1800 ? 0.9 : 0)));
  const track = { hz: HZ, midi: sung.map((m, i) => sung[i + 4] ?? m) };
  const r = scoreSinging({
    reference: { hz: HZ, start: 0, midi: curve },
    sung: track,
    latency_ms: 0,
    calibrated: true,
    phrases: lines.map((l) => ({ start: l.start, end: l.end })),
  });
  // The second of the recent ones had the backing in its recording: not a best.
  const bleed = session === "demo-old2";
  return {
    ...r,
    session,
    source: "voice",
    voice: { state: "scored", estimate_total: Math.round((r.total - 3.1) * 10) / 10, checks: bleed ? ["bleed"] : [], upload: false },
    song: { id: "demo-song", title: "紙船", artist: "示範" },
    at: ago(26),
    phrases: r.phrases.map((p) => ({ ...p, text: WORDS[p.index] ?? null })),
    unranked: bleed,
    client_total: r.total,
    latency_ms: 140,
    best_before: 79.3,
    comment: { state: "said", text: COMMENT },
  } as unknown as KaraokeResult;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let sessions = 0;

/** A singing's signed links (the made-up ones). */
function newSession(songId: string, shift: number): KaraokeSession {
  const id = `demo-${++sessions}`;
  keys.set(id, shift);
  singingKey = shift;
  const backing = shift === 0 ? "karaoke.m4a" : `karaoke.k${shift > 0 ? "+" : "-"}${Math.abs(shift)}.m4a`;
  // 紙船 has a real (made-up) video; 夜空中最亮的星 "has" one whose link leads nowhere, so the
  // stage shows the still; the others have none.
  const video = songId === "demo-song" ? demoVideo : songId === "d2" ? `/karaoke-demo-missing-${id}.mp4` : null;
  return {
    session: id,
    song: song({ video: video !== null }),
    backing_url: `/api/member/karaoke/files/${id}/${backing}?exp=1&sig=demo`,
    reference_url: `/api/member/karaoke/files/${id}/reference.json?exp=1&sig=demo`,
    video_url: video,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    tolerance_cents: 50,
    frame_hz: TRACK_HZ,
    shift,
    recording: { max_bytes: 8 * 1024 * 1024, max_seconds: Math.ceil(DURATION) + 30 },
  };
}

// ---------------------------------------------------------------------------
// rooms

/** The room's code (letters people can read out), and Core's clock ahead of this one by a little. */
const ROOM = "KTV888";
const CORE_AHEAD_MS = 37;
const coreNow = () => Date.now() + CORE_AHEAD_MS;
const COUNTDOWN_MS = 5_000;
const TERMS = { currency: "魚幣", price: 20, prize: 15, finish: 3, rounds: 4, max_singers: 8 };
const ME = "m-me";

/** One entry of the room's queue: its song as the list shows it, who added it. */
interface DemoEntry {
  id: string;
  song: KaraokeSongView;
  shift: number;
  by: string;
  byName: string;
}

const QUEUE_LIMITS = { per_person: 2, max: 10 };
let entries = 0;

interface DemoRoom {
  state: KaraokeRoomView["state"];
  closed_reason: string | null;
  /** The running round's song and key (from the queue's first ready entry at the start). */
  song: KaraokeSongView | null;
  shift: number;
  queue: DemoEntry[];
  members: KaraokeRoomMember[];
  /** `null`: not in it (they may join). */
  me: string | null;
  round: number;
  start_at_ms: number | null;
  result: KaraokeRoomResult | null;
  session: KaraokeSession | null;
  /** The opener's 「播出第一名的歌聲」. */
  lead: boolean;
  /** 結算中: the song is over, these singers' results are waited for. */
  settling: KaraokeRoomView["settling"];
}

const roomSessions = new Set<string>();
let demoRoom: DemoRoom | null = null;
const listeners = new Set<RoomEventsHandlers>();
let roomTimers: number[] = [];

const others: KaraokeRoomMember[] = [
  { id: "m-a", name: "海苔", role: "singer", ready: true, opener: false, color: 1, hear: false, skip: false },
  { id: "m-b", name: "鯨魚寶寶", role: "singer", ready: false, opener: false, color: 2, hear: false, skip: false },
  { id: "m-c", name: "Akari", role: "singer", ready: true, opener: false, color: 3, hear: false, skip: false },
  { id: "m-d", name: "路過的人", role: "spectator", ready: false, opener: false, color: 4, hear: false, skip: false },
];

/** The voice on her stream, as Core tells this person: a singer of a round of several never learns it. */
function roomAir(r: DemoRoom, me: KaraokeRoomMember | null, running: boolean): KaraokeRoomView["air"] {
  const singers = r.members.filter((m) => m.role === "singer");
  const solo = singers.length <= 1;
  const heard = solo ? (singers.find((m) => m.hear) ?? null) : r.lead ? (singers.find((m) => !m.skip) ?? null) : null;
  const hidden = !solo && running && me?.role === "singer";
  const member = heard && !hidden ? heard.id : null;
  return {
    backing: true,
    delay_ms: 2_000,
    lead: r.lead,
    singers: singers.length,
    relay: { allowed: true, reason: null, member, live: member !== null && r.state === "singing" },
  };
}

/** The queue's first ready entry: the next round's song. */
const nextOf = (r: DemoRoom) => r.queue.find((e) => e.song.state === "ready") ?? null;

function roomView(r: DemoRoom): KaraokeRoomView {
  const me = r.members.find((m) => m.id === r.me) ?? null;
  const running = r.state === "countdown" || r.state === "singing";
  const next = nextOf(r);
  const queue: KaraokeRoomQueueEntry[] = r.queue.map((e) => ({
    id: e.id,
    song: e.song,
    shift: e.shift,
    by: { member: r.members.some((m) => m.id === e.by) ? e.by : null, name: e.byName },
    mine: e.by === r.me,
  }));
  return {
    code: ROOM,
    state: r.state,
    closed_reason: r.closed_reason,
    song: running ? r.song : (next?.song ?? null),
    shift: running ? r.shift : (next?.shift ?? 0),
    queue,
    next: next?.id ?? null,
    queue_limits: QUEUE_LIMITS,
    members: r.members,
    me:
      me === null
        ? null
        : {
            id: me.id,
            role: me.role,
            opener: me.opener,
            singing: running && me.role === "singer",
            // A spectator gets files to watch with, a singer their own singing.
            session: running ? r.session : null,
          },
    round: r.round,
    rounds_left: TERMS.rounds - r.round,
    start_at_ms: running ? r.start_at_ms : null,
    result: r.result,
    terms: TERMS,
    air: roomAir(r, me, running),
    settling: running ? r.settling : null,
  };
}

function emit(e: KaraokeRoomEvent): void {
  for (const h of listeners) h.onEvent(e);
}

function changed(): KaraokeRoomView | null {
  if (!demoRoom) return null;
  const v = roomView(demoRoom);
  emit({ type: "room", room: v });
  return v;
}

function later(ms: number, fn: () => void): void {
  roomTimers.push(window.setTimeout(fn, ms));
}

function every(ms: number, fn: () => void): void {
  roomTimers.push(window.setInterval(fn, ms));
}

function clearRoomTimers(): void {
  for (const t of roomTimers) {
    window.clearTimeout(t);
    window.clearInterval(t);
  }
  roomTimers = [];
}

/** A made-up singer's pitch at frame `i`: the tune, a little off in their own way. */
function fakePitch(k: number, i: number): number | null {
  const ref = curve[i];
  if (ref === null || ref === undefined) return null;
  // Now and then a breath.
  if ((i + k * 37) % 97 < 4) return null;
  const off = [0.1, -12.2, 0.6, -0.35][k] ?? 0;
  const lag = [2, 4, 1, 6][k] ?? 2;
  const late = curve[i - lag] ?? ref;
  return (late ?? ref) + off + 0.18 * Math.sin((i + k * 13) / (5 + k));
}

const BOARD_SINGERS = [
  { member: "m-b", name: "鯨魚寶寶", color: 2 },
  { member: "m-a", name: "海苔", color: 1 },
  { member: "m-c", name: "Akari", color: 3 },
  { member: "m-e", name: "很長很長的名字的人", color: 5 },
];

/** The board now: running totals that move, a pitch line each for the last 1.5 s. */
function boardNow(r: DemoRoom, previous: Map<string, number>): KaraokeBoardLine[] {
  const t = r.start_at_ms === null ? 0 : (coreNow() - r.start_at_ms) / 1000;
  const nowFrame = Math.max(0, Math.floor(t * HZ));
  const from = Math.max(0, nowFrame - 75);
  const rows = BOARD_SINGERS.map((s, k) => {
    const base = [78, 74, 81, 69][k] ?? 70;
    const total = Math.max(0, Math.min(100, base + 4 * Math.sin(t / (4 + k) + k) + (k === 3 ? t / 20 : 0)));
    const frames: (number | null)[] = [];
    for (let i = from; i < nowFrame; i++) frames.push(fakePitch(k, i));
    return { ...s, total: Math.round(total * 10) / 10, source: k === 2 ? ("estimate" as const) : ("voice" as const), frames };
  });
  const ranked = [...rows].sort((a, b) => b.total - a.total);
  return rows.map((row) => {
    const rank = ranked.indexOf(row) + 1;
    const before = previous.get(row.member);
    previous.set(row.member, rank);
    return {
      member: row.member,
      name: row.name,
      color: row.color,
      rank,
      total: row.total,
      source: row.source,
      move: before === undefined || before === rank ? ("same" as const) : before > rank ? ("up" as const) : ("down" as const),
      pitch: nowFrame > from ? { from, track: toBase64(encodeTrack(row.frames)) } : null,
      cheers: cheersFor.get(row.member) ?? 0,
    };
  });
}

/** Cheers each made-up singer got this round, and the room's cheer count (for their ids). */
const cheersFor = new Map<string, number>();
let cheerCount = 0;

/** A cheer on the room's stream (to everyone watching, and to the singer it is for). */
function demoCheer(member: string, by: { name: string; color: number }, kind: "cheer" | "nice" | "wow" | "encore"): void {
  const r = demoRoom;
  if (!r) return;
  cheerCount++;
  cheersFor.set(member, (cheersFor.get(member) ?? 0) + 1);
  emit({ type: "cheer", round: r.round, id: `demo-${r.round}-${cheerCount}`, member, by, kind });
}

/** The singers' last second of pitch, as Core sends it between boards. */
function liveNow(r: DemoRoom): KaraokeRoomEvent {
  const t = r.start_at_ms === null ? 0 : (coreNow() - r.start_at_ms) / 1000;
  const nowFrame = Math.max(0, Math.floor(t * HZ));
  const from = Math.max(0, nowFrame - HZ);
  const lines = BOARD_SINGERS.map((s, k) => {
    const frames: (number | null)[] = [];
    for (let i = from; i < nowFrame; i++) frames.push(fakePitch(k, i));
    return { member: s.member, pitch: { from, track: toBase64(encodeTrack(frames)) } };
  });
  return { type: "live", round: r.round, at_ms: coreNow(), lines: nowFrame > from ? lines : [] };
}

/** `?karaoke-demo=novoice`: she is not in a voice channel until this moment. */
let voiceAt = 0;

function demoResult(r: DemoRoom): KaraokeRoomResult {
  const place = (o: Partial<KaraokeRoomResult["places"][number]> & { member: string; name: string; color: number }) => ({
    rank: null,
    total: null,
    pitch: null,
    stability: null,
    rhythm: null,
    expression: null,
    source: null,
    finished: true,
    checks: [],
    coins: 0,
    winner: false,
    note: null,
    ...o,
  });
  return {
    round: Math.max(1, r.round),
    song: { id: "demo-song", title: "紙船", artist: "示範" },
    settling: false,
    note: null,
    places: [
      place({ member: "m-c", name: "Akari", color: 3, rank: 1, total: 86.4, pitch: 52.1, stability: 13.2, rhythm: 12.8, expression: 8.3, source: "voice", coins: 18, winner: true }),
      place({ member: ME, name: "小魚乾", color: 0, rank: 2, total: 81.7, pitch: 49.6, stability: 12.4, rhythm: 12.1, expression: 7.6, source: "voice", coins: 3 }),
      place({ member: "m-a", name: "海苔", color: 1, rank: 3, total: 74.9, pitch: 45.0, stability: 11.8, rhythm: 11.0, expression: 7.1, source: "estimate", coins: 3, note: "這次是預估分數,不能拿獎" }),
      place({ member: "m-b", name: "鯨魚寶寶", color: 2, rank: 4, total: 61.2, pitch: 36.2, stability: 10.1, rhythm: 9.4, expression: 5.5, source: "voice", checks: ["bleed"], coins: 3 }),
      place({ member: "m-e", name: "很長很長的名字的人", color: 5, finished: false, note: "沒有唱到一半" }),
    ],
  };
}

/** The round runs: countdown, singing (the spectators' board or the singer's trend), results. */
function startRound(r: DemoRoom, opts: { startIn: number; scene: "singer" | "spectator" }): void {
  clearRoomTimers();
  r.round++;
  r.result = null;
  r.settling = null;
  r.state = "countdown";
  r.start_at_ms = coreNow() + opts.startIn;
  // The queue's first ready entry leaves the queue as the round starts; failed ones go with it.
  const next = nextOf(r);
  if (next) {
    r.song = next.song;
    r.shift = next.shift;
  }
  r.queue = r.queue.filter((e) => e !== next && e.song.state !== "failed");
  r.session = newSession(r.song?.id ?? "demo-song", r.shift);
  roomSessions.add(r.session.session);
  later(Math.max(0, opts.startIn), () => {
    r.state = "singing";
    changed();
  });
  if (opts.scene === "singer") {
    const cycle = [
      { trend: "rising", source: "voice" },
      { trend: "holding", source: "voice" },
      { trend: "dropping", source: "voice" },
      { trend: "rising", source: "estimate" },
      { trend: "holding", source: "estimate" },
    ] as const;
    let n = 0;
    every(3_000, () => {
      if (r.state !== "singing" || r.settling !== null) return;
      const c = cycle[n++ % cycle.length] as (typeof cycle)[number];
      // Their own running total only: the first trend has none yet.
      const t = r.start_at_ms === null ? 0 : (coreNow() - r.start_at_ms) / 1000;
      const total = n === 1 ? null : Math.round((72 + 6 * Math.sin(t / 5)) * 10) / 10;
      emit({ type: "trend", round: r.round, trend: c.trend, source: c.source, total });
      // Now and then someone watching cheers them.
      if (n % 2 === 0) demoCheer(ME, { name: "路過的人", color: 4 }, n % 4 === 0 ? "encore" : "cheer");
    });
  } else {
    const ranks = new Map<string, number>();
    cheersFor.clear();
    let ticks = 0;
    every(250, () => {
      if (r.state !== "singing" && r.state !== "countdown") return;
      ticks++;
      if (ticks % 4 === 0) emit({ type: "board", round: r.round, at_ms: coreNow(), lines: boardNow(r, ranks) });
      else if (r.state === "singing") emit(liveNow(r));
      // Made-up watchers cheer every couple of seconds.
      if (r.state === "singing" && ticks % 9 === 0) {
        const to = BOARD_SINGERS[(ticks / 9) % BOARD_SINGERS.length] as (typeof BOARD_SINGERS)[number];
        const kinds = ["cheer", "nice", "wow", "encore"] as const;
        demoCheer(to.member, ticks % 2 ? { name: "路過的人", color: 4 } : { name: "Kai", color: 6 }, kinds[(ticks / 9) % 4] ?? "cheer");
      }
    });
  }
  // The song ends for everyone: 結算中 (two results waited for, then one, then none), the ranking.
  const over = opts.startIn + (DURATION + 0.5) * 1000;
  const settle = (waiting: string[]) => {
    r.settling = { waiting, until_ms: (r.start_at_ms ?? coreNow()) + (DURATION + 110) * 1000 };
    changed();
  };
  later(over, () => settle(["海苔", "Akari"]));
  later(over + 2_000, () => settle(["Akari"]));
  later(over + 4_000, () => settle([]));
  later(over + 5_500, () => {
    clearRoomTimers();
    r.state = "results";
    r.start_at_ms = null;
    r.settling = null;
    r.result = demoResult(r);
    changed();
  });
  changed();
}

function entry(s: KaraokeSongView, by: KaraokeRoomMember | { id: string; name: string }, shift = 0): DemoEntry {
  return { id: `q${++entries}`, song: s, shift, by: by.id, byName: by.name };
}

/** A song asked for by a link or words: prepared in memory, a step every 1.5 s, then ready. */
function preparingEntry(r: DemoRoom, e: DemoEntry): DemoEntry {
  const id = window.setInterval(() => {
    if (demoRoom !== r || !r.queue.includes(e)) return window.clearInterval(id);
    const progress = Math.min(1, e.song.progress + 0.08);
    const stage = STAGES[Math.min(STAGES.length - 1, Math.floor(progress * STAGES.length))] as string;
    e.song =
      progress >= 1
        ? { ...e.song, state: "ready", stage: null, progress: 1, duration_s: 241, lyrics: true, lyrics_source: "found" }
        : { ...e.song, stage, progress };
    if (progress >= 1) window.clearInterval(id);
    changed();
  }, 1_500);
  return e;
}

/** The lobby's queue: a ready song (someone else's), one being prepared (theirs), one that failed. */
function demoQueue(r: DemoRoom): DemoEntry[] {
  const a = others[0] as KaraokeRoomMember;
  const c = others[2] as KaraokeRoomMember;
  const me = { id: ME, name: "小魚乾" };
  const prep = song({ id: "d6", title: "春日影", artist: "示範樂團", state: "preparing", stage: "separate", progress: 0.42, duration_s: null });
  const failed = song({ id: "demo-fail", title: "一首很長的歌", artist: null, state: "failed", error: "這首超過 8 分鐘,沒有準備", duration_s: null });
  return [entry(song({ video: true }), a), preparingEntry(r, entry(prep, me, -2)), entry(failed, c)];
}

function lobbyRoom(opener: boolean): DemoRoom {
  return {
    state: "lobby",
    closed_reason: null,
    song: null,
    shift: 0,
    queue: [],
    members: [{ id: ME, name: "小魚乾", role: "singer", ready: false, opener, color: 0, hear: false, skip: false }, ...others.map((m) => ({ ...m, opener: false }))],
    lead: true,
    me: ME,
    round: 0,
    start_at_ms: null,
    result: null,
    session: null,
    settling: null,
  };
}

/** Puts the room in a scene. */
function roomScene(scene: string): void {
  const r = lobbyRoom(true);
  demoRoom = r;
  r.queue = demoQueue(r);
  if (scene === "singer") startRound(r, { startIn: COUNTDOWN_MS, scene: "singer" });
  if (scene === "solo") {
    // Alone, with their voice on the stream.
    r.members = r.members.filter((m) => m.id === ME || m.role === "spectator");
    (r.members[0] as KaraokeRoomMember).hear = true;
    startRound(r, { startIn: COUNTDOWN_MS, scene: "singer" });
  }
  if (scene === "spectator") {
    const me = r.members[0] as KaraokeRoomMember;
    me.role = "spectator";
    me.opener = false;
    (r.members[1] as KaraokeRoomMember).opener = true;
    r.members.push({ id: "m-e", name: "很長很長的名字的人", role: "singer", ready: true, opener: false, color: 5, hear: false, skip: false });
    startRound(r, { startIn: -8_000, scene: "spectator" });
  }
  if (scene === "results") {
    r.round = 1;
    r.state = "results";
    r.result = demoResult(r);
    r.queue.push(entry(song({ id: "d2", title: "夜空中最亮的星", artist: "逃跑計劃", duration_s: 252, video: true }), others[2] as KaraokeRoomMember, 1));
  }
}

function rooms(): KaraokeRooms {
  const mine = demoRoom?.me && demoRoom.state !== "closed" ? ROOM : null;
  if (Date.now() < voiceAt) return { available: false, reason: "她要在語音頻道裡才能開房間", terms: TERMS, balance: 128, mine };
  return { available: true, reason: null, terms: TERMS, balance: 128, mine };
}

/** The room's queue: add (a song on the list, or a link or words), remove, move. */
function queueAnswer(r: DemoRoom, method: string, id: string | null, move: boolean, body: unknown): Response {
  const me = r.members.find((x) => x.id === ME);
  if (!me) return json({ error: "你不在這個房間裡" }, 409);
  const opener = me.opener || asAdmin;
  if (id === null && method === "POST") {
    if (r.state !== "lobby" && r.state !== "results") return json({ error: "現在不能這樣做" }, 409);
    const b = body as { song?: string; text?: string; shift?: number };
    const live = r.queue.filter((e) => e.song.state !== "failed");
    if (live.filter((e) => e.by === ME).length >= QUEUE_LIMITS.per_person) {
      return json({ error: `你已經點了 ${QUEUE_LIMITS.per_person} 首在等,唱完再點` }, 409);
    }
    if (live.length >= QUEUE_LIMITS.max) return json({ error: "點歌的清單滿了,等唱完幾首再點" }, 409);
    if ((b.song === undefined) === (b.text === undefined)) return json({ error: "選一首歌,或貼連結、打歌名(只要一樣)" }, 400);
    if (b.text !== undefined) {
      if (b.text.includes("limit")) return json({ error: "今天已經準備了 10 首,明天再來" }, 409);
      const title = /^https?:/i.test(b.text) ? "" : b.text.slice(0, 40);
      const s = song({ id: `ask-${entries + 1}`, title, artist: null, state: "preparing", stage: "queued", progress: 0, duration_s: null });
      r.queue.push(preparingEntry(r, entry(s, me, b.shift ?? 0)));
      return json(changed());
    }
    const found = overview().songs.find((x) => x.id === b.song);
    if (!found) return json({ error: "沒有這首歌" }, 404);
    if (found.state === "failed") return json({ error: "這首準備失敗了,換一首或重新點" }, 409);
    r.queue.push(entry(found, me, b.shift ?? 0));
    return json(changed());
  }
  const at = r.queue.findIndex((e) => e.id === id);
  const e = r.queue[at];
  if (!e) return json({ error: "點歌的清單裡沒有這一首" }, 404);
  if (move && method === "POST") {
    if (!opener) return json({ error: "只有開房的人可以這樣做" }, 403);
    const to = Math.max(0, Math.min(r.queue.length - 1, (body as { to: number }).to));
    r.queue.splice(at, 1);
    r.queue.splice(to, 0, e);
    return json(changed());
  }
  if (!move && method === "DELETE") {
    if (e.by !== ME && !opener) return json({ error: "只有點這首的人和開房的人可以拿掉" }, 403);
    r.queue.splice(at, 1);
    return json(changed());
  }
  return json({ error: "no such endpoint" }, 404);
}

function roomAnswer(method: string, path: string, body: unknown): Response | null {
  if (path === "/api/member/karaoke/rooms") {
    if (method !== "POST") return json(rooms());
    clearRoomTimers();
    // Opens with no song: the queue starts empty.
    demoRoom = lobbyRoom(true);
    demoRoom.members = demoRoom.members.slice(0, 1);
    later(1_500, () => {
      if (!demoRoom) return;
      demoRoom.members.push({ ...(others[0] as KaraokeRoomMember) });
      changed();
    });
    return json(changed());
  }
  const m = /^\/api\/member\/karaoke\/rooms\/([^/]+)(?:\/([a-z]+))?(?:\/([0-9a-z]+)(?:\/(move))?)?$/.exec(path);
  if (!m) return null;
  if (m[1] !== ROOM || !demoRoom) return json({ error: "沒有這個房間" }, 404);
  const r = demoRoom;
  const what = m[2];
  if (what === "queue") return queueAnswer(r, method, m[3] ?? null, m[4] === "move", body);
  if (!what) return json(roomView(r));
  if (what === "clock") return json({ t0: (body as { t0: number }).t0, server_ms: coreNow() });
  if (what === "audio") return json({ stream: "live", relay: false });
  if (what === "pitch") return new Response(null, { status: 204 });
  if (what === "cheer") {
    const b = body as { member: string; kind: "cheer" | "nice" | "wow" | "encore" };
    const me = r.members.find((x) => x.id === ME);
    demoCheer(b.member, { name: me?.name ?? "小魚乾", color: me?.color ?? 0 }, b.kind);
    return json({ wait_ms: 1_500 });
  }
  const me = r.members.find((x) => x.id === ME);
  if (what === "join") {
    const as = (body as { as?: "singer" | "spectator" }).as ?? "singer";
    if (me) me.role = as;
    else r.members.push({ id: ME, name: "小魚乾", role: as, ready: false, opener: false, color: 6, hear: false, skip: false });
    r.me = ME;
    return json(changed());
  }
  if (what === "leave") {
    r.members = r.members.filter((x) => x.id !== ME);
    r.me = null;
    clearRoomTimers();
    return json(changed());
  }
  if (what === "relay" && me) {
    const b = body as { hear?: boolean; skip?: boolean; lead?: boolean; member?: string };
    if (b.hear !== undefined) me.hear = b.hear;
    if (b.skip !== undefined) me.skip = b.skip;
    if (b.lead !== undefined && me.opener) r.lead = b.lead;
    const cut = b.member ? r.members.find((x) => x.id === b.member) : undefined;
    if (cut && me.opener) {
      cut.hear = false;
      cut.skip = true;
    }
    return json(changed());
  }
  if (what === "ready" && me) {
    me.ready = (body as { ready: boolean }).ready;
    return json(changed());
  }
  if (what === "start") {
    if (!nextOf(r)) return json({ error: "清單裡還沒有準備好的歌,先點一首" }, 409);
    if (!r.members.some((x) => x.role === "singer" && x.ready)) return json({ error: "還沒有人準備好唱" }, 409);
    startRound(r, { startIn: COUNTDOWN_MS, scene: me?.role === "singer" ? "singer" : "spectator" });
    return json(roomView(r));
  }
  if (what === "close") {
    clearRoomTimers();
    r.state = "closed";
    r.closed_reason = "房主關掉了這間房";
    return json(changed());
  }
  return json({ error: "no such endpoint" }, 404);
}

// ---------------------------------------------------------------------------
// the reference editor (`?karaoke-demo=editor`): 紙船's reference, saved and restored in memory,
// and a made-up backing (a soft chord under each line and a tick on every beat) to play

const editor = {
  revision: 0,
  /** The highest revision ever saved: a restore does not reuse it. */
  top: 0,
  shift: 0,
  saved: null as WorkersKaraokeReferenceV2 | null,
  savedAt: null as string | null,
  history: [] as KaraokeEditView["history"],
};

function editorView(): KaraokeEditView {
  const reference = editor.saved ?? REFERENCE;
  return {
    song: { id: REFERENCE.id, title: REFERENCE.title, artist: REFERENCE.artist, duration_s: DURATION },
    reference,
    original: { lyrics: REFERENCE.lyrics, notes: REFERENCE.notes, pitch_shift: 0 },
    edit: {
      revision: editor.revision,
      pitch_shift: editor.shift,
      saved_by: editor.saved ? "小魚乾" : null,
      saved_at: editor.savedAt,
      worker_changed: false,
    },
    history: editor.history,
    results: 4,
    backing_url: `/api/member/karaoke/edit/${REFERENCE.id}/backing`,
  };
}

function editorAnswer(method: string, path: string, body: unknown): Response | null {
  if (path === `/api/member/karaoke/edit/${REFERENCE.id}/backing`) {
    return new Response(demoBacking(), { headers: { "content-type": "audio/wav" } });
  }
  const m = /^\/api\/member\/karaoke\/songs\/([^/]+)\/edit(\/restore)?$/.exec(path);
  if (!m) return null;
  if (m[1] !== REFERENCE.id) return json({ error: "這首在示範裡不能改" }, 404);
  if (method === "GET" && !m[2]) return json(editorView());
  const asked = body as KaraokeEditSave;
  if (asked.revision !== editor.revision) return json({ error: "有人在你之後存過了,重新載入再改" }, 409);
  const at = new Date().toISOString();
  if (m[2]) {
    if (editor.revision === 0) return json({ error: "這首沒有改過" }, 409);
    Object.assign(editor, { revision: 0, shift: 0, saved: null, savedAt: null });
    editor.history = [{ action: "restore", name: "小魚乾", at, revision: 0, lines: 0, notes: REFERENCE.notes.length, pitch_shift: 0 }, ...editor.history];
    return json(editorView());
  }
  const doc = { lyrics: asked.lyrics, notes: asked.notes, pitch_shift: asked.pitch_shift };
  const problems = validateEdit(doc, { duration_s: DURATION, curve: REFERENCE.pitch.midi });
  if (problems.length > 0) {
    const more = problems.length - 3;
    return json({ error: `${problems.slice(0, 3).map((p) => p.message).join("；")}${more > 0 ? `(還有 ${more} 個問題)` : ""}` }, 400);
  }
  const saved = composeReference(REFERENCE, doc);
  editor.top += 1;
  Object.assign(editor, { revision: editor.top, shift: doc.pitch_shift, saved, savedAt: at });
  editor.history = [
    {
      action: "save",
      name: "小魚乾",
      at,
      revision: editor.top,
      lines: editedLines(saved.lyrics?.lines ?? []),
      notes: saved.notes.length,
      pitch_shift: doc.pitch_shift,
    },
    ...editor.history,
  ];
  return json(editorView());
}

let backing: Blob | null = null;

/** A plain backing for 紙船 as a WAV: a soft chord a fifth under each note's line, a tick on each beat. */
function demoBacking(): Blob {
  if (backing) return backing;
  const rate = 22_050;
  const n = Math.ceil(DURATION * rate);
  const pcm = new Int16Array(n);
  for (const [start, len, midi] of TUNE) {
    const f = 440 * 2 ** ((midi - 12 - 69) / 12);
    const from = Math.floor(start * rate);
    const to = Math.min(n, Math.floor((start + len) * rate));
    for (let i = from; i < to; i++) {
      const t = (i - from) / rate;
      const env = Math.min(1, t / 0.03) * Math.min(1, (to - i) / rate / 0.05);
      const v = 0.16 * env * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.5 * t));
      pcm[i] = Math.max(-32_767, Math.min(32_767, (pcm[i] ?? 0) + v * 32_767));
    }
  }
  for (let beat = 0; beat < DURATION * 2; beat++) {
    const from = Math.floor(beat * 0.5 * rate);
    for (let i = from; i < Math.min(n, from + 600); i++) {
      const v = 0.12 * Math.exp(-(i - from) / 120) * Math.sin(2 * Math.PI * 1800 * ((i - from) / rate));
      pcm[i] = Math.max(-32_767, Math.min(32_767, (pcm[i] ?? 0) + v * 32_767));
    }
  }
  const header = new DataView(new ArrayBuffer(44));
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) header.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  header.setUint32(4, 36 + n * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, n * 2, true);
  backing = new Blob([header.buffer, pcm.buffer], { type: "audio/wav" });
  return backing;
}

function installRoomEvents(): void {
  setRoomEventsFactory((_url, h) => {
    listeners.add(h);
    const first = window.setTimeout(() => {
      h.onLink?.("open");
      if (demoRoom) h.onEvent({ type: "room", room: roomView(demoRoom) });
    }, 150);
    return () => {
      window.clearTimeout(first);
      listeners.delete(h);
    };
  });
}

function answer(method: string, path: string, body: unknown): Response | null {
  if (path === "/api/auth/methods") return json({ token: true, discord: true });
  if (path === "/api/auth/session") return json({ error: "no" }, 401);
  if (path === "/api/public/status") {
    return json({
      state: "idle",
      live: false,
      in_voice: false,
      game: null,
      today: { songs_sung: 0, hours_live: 0, hours_in_voice: 0 },
    });
  }
  if (path === "/api/member/session") return json({ name: "小魚乾", avatar_url: null });
  if (path === "/api/member/karaoke") return json(overview());
  if (path === "/api/member/karaoke/songs" && method === "POST") {
    const text = (body as { text?: string }).text ?? "";
    if (text.includes("limit")) return json({ error: "今天已經準備了 10 首,明天再來" }, 409);
    return json({ song: preparing(), created: true });
  }
  if (path === "/api/member/karaoke/songs/demo-prep") return json(preparing());
  const edit = editorAnswer(method, path, body);
  if (edit) return edit;
  const room = roomAnswer(method, path, body);
  if (room) return room;
  const start = /^\/api\/member\/karaoke\/songs\/([^/]+)\/sessions$/.exec(path);
  if (start && method === "POST") {
    const shift = (body as { shift?: number } | undefined)?.shift ?? 0;
    return json(newSession(start[1] as string, shift));
  }

  const voice = /^\/api\/member\/karaoke\/sessions\/([^/]+)\/voice$/.exec(path);
  if (voice && method === "POST") {
    const kept = results.get(voice[1] as string);
    if (!kept || kept.uploaded) return json({ error: "這次的錄音已經收過了" }, 409);
    kept.uploaded = true;
    kept.polls = 0;
    kept.result = { ...kept.result, voice: { ...kept.result.voice, state: "scoring", upload: false } };
    return json({ state: "scoring" }, 202);
  }
  if (/\/reference\.json$/.test(path)) return json(REFERENCE);
  const submit = /^\/api\/member\/karaoke\/sessions\/([^/]+)\/result$/.exec(path);
  if (submit && method === "POST") {
    const id = submit[1] as string;
    const result = scored(body as KaraokeSubmit, id);
    results.set(id, { result, polls: 0, uploaded: false });
    return json(result);
  }
  const one = /^\/api\/member\/karaoke\/sessions\/([^/]+)$/.exec(path);
  if (one) {
    const id = one[1] as string;
    const kept = results.get(id);
    if (!kept) return json(oldResult(id));
    kept.polls++;
    const r = kept.result;
    // The recording is scored on the third look after it arrived; her comment comes after that.
    if (r.voice.state === "scoring" && kept.polls >= 3) {
      kept.result = officially(r);
      kept.polls = 0;
    } else if (r.voice.state !== "waiting" && r.voice.state !== "scoring" && kept.polls >= 2) {
      kept.result = { ...r, comment: { state: "said", text: COMMENT } };
    }
    return json(kept.result);
  }
  if (path.startsWith("/api/")) return json({ error: "no such endpoint" }, 404);
  return null;
}

function installFetch(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, window.location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let body: unknown;
    const raw = init?.body ?? (input instanceof Request && method !== "GET" ? await input.clone().text() : undefined);
    if (typeof raw === "string" && raw !== "") body = JSON.parse(raw);
    await new Promise((r) => setTimeout(r, 120));
    return answer(method, url.pathname, body) ?? real(input, init);
  };
}

// ---------------------------------------------------------------------------
// the audio: a made-up singer, a little late and a little off

class DemoEngine implements KaraokeEngine {
  #playing: { at: number; offset: number } | null = null;
  #beeps: number[] = [];
  #timer = 0;
  #floor = 0.002;
  readonly #listeners = new Set<(d: Detection) => void>();

  now(): number {
    return performance.now() / 1000;
  }
  heard(): number {
    return this.now() - 0.02;
  }
  estimateLatencyMs(): number {
    return 45;
  }
  async openMic() {
    if (!this.#timer) this.#timer = window.setInterval(() => this.#emit(), 10);
    return { groupId: "demo-mic" };
  }
  setFloor(rms: number): void {
    this.#floor = rms;
  }
  onDetection(fn: (d: Detection) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
  async loadBacking(): Promise<number> {
    await new Promise((r) => setTimeout(r, 900));
    return DURATION;
  }
  play(offset: number): number {
    const at = this.now() + 0.12;
    this.#playing = { at, offset };
    return at;
  }
  playAt(at: number, offset: number): { at: number; offset: number } {
    let when = at;
    let from = offset;
    const earliest = this.now() + 0.05;
    if (when < earliest) {
      from += earliest - when;
      when = earliest;
    }
    this.#playing = { at: when, offset: from };
    return { at: when, offset: from };
  }
  async micStream(): Promise<MicStream | null> {
    let timer = 0;
    let index = 0;
    return {
      start: (onPiece: (p: StreamPiece) => void) => {
        index = 0;
        const began = this.now();
        timer = window.setInterval(() => {
          // A tenth of a second of near silence, µ-law (0xff is zero).
          onPiece({ index, t: began + index / 16_000, bytes: new Uint8Array(1_600).fill(0xff) });
          index += 1_600;
        }, 100);
      },
      stop: () => window.clearInterval(timer),
    };
  }
  stop(): void {
    this.#playing = null;
  }
  beeps(at: readonly number[]): void {
    this.#beeps = [...at];
  }
  recorder(limits: RecordingLimits, songTime: () => number): VoiceRecorder {
    return new DemoRecorder(limits, songTime);
  }
  close(): void {
    window.clearInterval(this.#timer);
    this.#timer = 0;
    this.#listeners.clear();
  }

  #emit(): void {
    const t = this.now() - 0.03;
    let midi: number | null = null;
    let level = 0.0012 + 0.0004 * Math.random();
    // A clap 130 ms after each beep.
    if (this.#beeps.some((b) => t >= b + 0.13 && t < b + 0.2)) level = 0.08;
    const p = this.#playing;
    if (p && t >= p.at) {
      // The singer hears the song 30 ms late and answers 50 ms after that.
      const s = p.offset + (t - p.at) - 0.08;
      const ref = curve[Math.round(s * HZ)];
      // An octave below, a little flat, rushing the second half of line 4.
      const line = Math.floor((s - FIRST) / LINE_S);
      const wobble = 0.12 * Math.sin(t * 9) + (Math.random() - 0.5) * 0.15;
      const off = line === 3 ? 0.8 : -0.1;
      if (ref !== null && ref !== undefined && Math.random() > 0.04) {
        midi = ref - 12 + singingKey + off + wobble;
        level = 0.05;
      }
    }
    const d: Detection = {
      t,
      midi: level > this.#floor * 2 ? midi : null,
      clarity: midi === null ? 0.4 : 0.96,
      rms: level,
      level,
      levelT: t,
    };
    for (const fn of this.#listeners) fn(d);
  }
}

/** No microphone: a "recording" of empty bytes, about as large as a real one would be. */
class DemoRecorder implements VoiceRecorder {
  #state: RecorderState = "idle";
  #offset: number | null = null;
  #began = 0;
  #timer = 0;
  readonly #limits: RecordingLimits;
  readonly #songTime: () => number;

  constructor(limits: RecordingLimits, songTime: () => number) {
    this.#limits = limits;
    this.#songTime = songTime;
  }
  get state(): RecorderState {
    return this.#state;
  }
  start(): void {
    window.clearTimeout(this.#timer);
    this.#state = "recording";
    this.#offset = null;
    // A real recorder says it began a moment after it was asked.
    this.#timer = window.setTimeout(() => {
      this.#offset = recordingOffsetMs(this.#songTime());
      this.#began = performance.now();
    }, 30);
  }
  async stop(): Promise<VoiceTake | null> {
    window.clearTimeout(this.#timer);
    const seconds = (performance.now() - this.#began) / 1000;
    const offset = this.#offset;
    const was = this.#state;
    this.#state = "idle";
    if (was !== "recording" || offset === null || seconds > this.#limits.max_seconds) return null;
    const blob = new Blob([new Uint8Array(Math.max(1, Math.round(seconds * 4000)))], { type: "audio/webm" });
    return { blob, type: "audio/webm", offset_ms: offset };
  }
  cancel(): void {
    window.clearTimeout(this.#timer);
    this.#state = "idle";
  }
}

export function installDemo(): void {
  installFetch();
  installRoomEvents();
  setEngineFactory(() => new DemoEngine());
  // A room's scene: the room's own address, the scene kept in the query.
  const scene = new URLSearchParams(window.location.search).get("karaoke-demo") ?? "";
  if (scene === "editor") {
    asAdmin = true;
    window.history.replaceState(null, "", `/karaoke?karaoke-demo=editor&edit=${REFERENCE.id}`);
  }
  if (scene === "novoice") voiceAt = Date.now() + 6_000;
  if (["lobby", "singer", "solo", "spectator", "results"].includes(scene)) {
    roomScene(scene);
    window.history.replaceState(null, "", `/karaoke/room/${ROOM}?karaoke-demo=${scene}`);
  }
  // The page checks for Web Audio first; the demo needs none.
  const w = window as unknown as Record<string, unknown>;
  w.AudioWorkletNode ??= function AudioWorkletNode() {};
}
