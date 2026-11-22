// Scripted karaoke room for `?demo=karaoke` (or `?karaoke_demo=1`): the stream's karaoke scene
// without Core or a Stage, for design work and OBS previews. It speaks the same frames the Stage
// sends, in a loop: a lobby fills (nobody has asked for a song, then the opener does and the others
// queue theirs: one ready, one being prepared, one that failed; people join, choose singing or
// watching, get ready; the join QR code of a sample link beside the code), the round counts down, is
// sung (made-up lines with aligned pieces and readings, reference notes on the lanes and each
// singer's pitch on them: one on the notes, one an octave down, one flat, one wandering; a board
// whose ranks swap, estimate tags, one singer's voice on the stream and halfway another's; every
// other round the QR code stays in a corner), it settles (結算中, waiting for two, one, nobody), the
// results come (the four parts, a winner and coins, someone who did not finish, or a round without a
// prize and its note), and the next round's lobby. The songs and their words are made up.
//
// Spectating: the board comes four times a second with each singer's latest pitch (as Core sends
// it from their browsers), so the lanes judge the notes (Mia, 小明 an octave down and Kai land them,
// the cat misses many); people watching cheer the singers every second or two; someone comes in to
// watch partway and leaves again; the lead changes hands.
//
// It is heard too: a backing made here (a few soft chords and a beat, raw PCM like the worker's)
// and the "voice" of the singer on the stream (a plain tone on each sung piece, µ-law in pieces a
// quarter of a second long, half a second ahead, like Core's), both through the scene's player.
// A browser holds the sound until a click (the page says 「按一下開聲音」).
//
// The background video is the member page's test pattern (a counter, so its sync shows), in the
// dev server only: a production build has no video in it and shows the glass.

import type { WorkersKaraokeLineV2, WorkersKaraokeLyricsV2 } from "@miyoria/contracts/workers";
import type {
  FeedMessage,
  KaraokeAir,
  KaraokeCheer,
  KaraokeLine,
  KaraokeMember,
  KaraokeNote,
  KaraokeParts,
  KaraokePitch,
  KaraokeQueueEntry,
  KaraokeScene,
  KaraokeSong,
} from "./feed.js";
import { bytesBase64, encodeMulaw, VOICE_RATE } from "./karaoke-audio.js";
import { LANE_HZ } from "./lanes.js";

/** One piece: its text, its reading (kanji or Chinese), its romaji (Japanese). */
type Piece = [text: string, reading: string | null, roman: string | null];

interface DemoSong {
  id: string;
  title: string;
  artist: string;
  language: string;
  /** Seconds the backing runs. */
  seconds: number;
  /** When each line starts (s), and its pieces. */
  lines: [start: number, pieces: Piece[]][];
  /** The line index found but doubtful (dotted underline). */
  doubtful: number | null;
}

const SONGS: DemoSong[] = [
  {
    id: "demo-ja",
    title: "夜明けの約束",
    artist: "示範歌手",
    language: "ja",
    seconds: 36,
    doubtful: null,
    lines: [
      [2, [["星", "ほし", "hoshi"], ["の", null, "no"], ["降", "ふ", "fu"], ["る", null, "ru"], ["夜", "よる", "yoru"], ["に", null, "ni"]]],
      [7, [["小", "ちい", "chii"], ["さ", null, "sa"], ["な", null, "na"], ["声", "こえ", "koe"], ["で", null, "de"], ["歌", "うた", "uta"], ["う", null, "u"]]],
      [12, [["明日", "あした", "ashita"], ["の", null, "no"], ["空", "そら", "sora"], ["を", null, "o"], ["見", "み", "mi"], ["上", "あ", "a"], ["げ", null, "ge"], ["て", null, "te"]]],
      [17, [["君", "きみ", "kimi"], ["と", null, "to"], ["同", "おな", "ona"], ["じ", null, "ji"], ["道", "みち", "michi"], ["を", null, "o"], ["行", "ゆ", "yu"], ["こ", null, "ko"], ["う", null, "u"]]],
      [26, [["光", "ひかり", "hikari"], ["を", null, "o"], ["抱", "だ", "da"], ["い", null, "i"], ["て", null, "te"]]],
      [30, [["夜明", "よあ", "yoa"], ["け", null, "ke"], ["ま", null, "ma"], ["で", null, "de"]]],
    ],
  },
  {
    id: "demo-zh",
    title: "晚風的信",
    artist: "示範樂團",
    language: "zh",
    seconds: 34,
    doubtful: 4,
    lines: [
      [2, [["晚", "wǎn", null], ["風", "fēng", null], ["吹", "chuī", null], ["過", "guò", null], ["小", "xiǎo", null], ["巷", "xiàng", null]]],
      [7, [["燈", "dēng", null], ["光", "guāng", null], ["一", "yì", null], ["盞", "zhǎn", null], ["一", "yì", null], ["盞", "zhǎn", null], ["亮", "liàng", null]]],
      [12, [["我", "wǒ", null], ["們", "men", null], ["慢", "màn", null], ["慢", "màn", null], ["地", "de", null], ["走", "zǒu", null]]],
      [17, [["把", "bǎ", null], ["歌", "gē", null], ["唱", "chàng", null], ["給", "gěi", null], ["月", "yuè", null], ["亮", "liàng", null]]],
      [26, [["明", "míng", null], ["天", "tiān", null], ["還", "hái", null], ["會", "huì", null], ["再", "zài", null], ["見", "jiàn", null]]],
    ],
  },
];

/** Seconds each line's pieces take. */
const LINE_SUNG_S = 4.2;
const COUNTDOWN_MS = 6_000;
const CURRENCY = "魚幣";
const ROUNDS = 4;

/** The made-up reference's lyrics for `song`, every line aligned piece by piece. */
export function demoLyrics(song: DemoSong): WorkersKaraokeLyricsV2 {
  const lines: WorkersKaraokeLineV2[] = song.lines.map(([start, pieces], i) => {
    const step = LINE_SUNG_S / pieces.length;
    return {
      start,
      end: start + LINE_SUNG_S + 0.3,
      text: pieces.map(([t]) => t).join(""),
      status: i === song.doubtful ? "uncertain" : "matched",
      source: "found",
      similarity: i === song.doubtful ? 0.6 : 0.95,
      heard: null,
      aligned: true,
      pieces: pieces.map(([text, reading, roman], k) => ({
        text,
        sung: true,
        start: Math.round((start + k * step) * 100) / 100,
        end: Math.round((start + (k + 1) * step - 0.04) * 100) / 100,
        reading,
        roman,
      })),
      edited: false,
    };
  });
  return { provider: "demo", source: "found", language: song.language, timing: "char", check: null, lines };
}

/** The people of the demo room, in the order they come in. */
const PEOPLE: KaraokeMember[] = [
  { name: "Mia", color: 0, role: "singer", ready: false, opener: true },
  { name: "小明", color: 1, role: "singer", ready: false, opener: false },
  { name: "阿翔", color: 3, role: "spectator", ready: false, opener: false },
  { name: "Kai", color: 2, role: "singer", ready: false, opener: false },
  { name: "一隻路過的貓", color: 5, role: "singer", ready: false, opener: false },
];

/** Nothing on the stream (lobby, results). */
const QUIET: KaraokeAir = { backing: false, relay: null, delayMs: 0, backingGain: 0, voiceGain: 0, duckGain: 0 };
/** The owner's gains in the demo. */
const ON_AIR: Omit<KaraokeAir, "relay"> = { backing: true, delayMs: 2_000, backingGain: 0.7, voiceGain: 0.9, duckGain: 0.35 };

/** Sample rate of the demo's backing. */
const BACKING_RATE = 16_000;
/** Length of one voice piece (ms) and how far ahead of the song it comes (ms). */
const VOICE_PIECE_MS = 250;
const VOICE_AHEAD_MS = 500;

/** A backing for `seconds`: soft triads changing every two seconds and a light beat, raw s16le. */
export function demoBacking(seconds: number): Uint8Array<ArrayBuffer> {
  const n = Math.round(seconds * BACKING_RATE);
  const out = new Uint8Array(n * 2);
  const view = new DataView(out.buffer);
  // I – vi – IV – V in C, as frequencies.
  const chords = [
    [261.63, 329.63, 392.0],
    [220.0, 261.63, 329.63],
    [174.61, 220.0, 261.63],
    [196.0, 246.94, 293.66],
  ];
  const beat = 60 / 96;
  for (let i = 0; i < n; i++) {
    const t = i / BACKING_RATE;
    const chord = chords[Math.floor(t / 2) % chords.length] as number[];
    let v = 0;
    for (const f of chord) v += Math.sin(2 * Math.PI * f * t);
    v *= 0.05;
    // A soft low thump on every beat.
    const sinceBeat = t % beat;
    v += 0.22 * Math.sin(2 * Math.PI * 60 * sinceBeat) * Math.exp(-sinceBeat * 18);
    view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32_767), true);
  }
  return out;
}

/**
 * The relayed "voice" from `fromMs` for `ms`: a tone on every sung piece (a step of the scale per
 * piece, a little vibrato; `low` a fifth lower for the second singer), silence between, µ-law.
 */
export function demoVoice(lyrics: WorkersKaraokeLyricsV2, fromMs: number, ms: number, low: boolean): Uint8Array {
  const n = Math.round((ms / 1000) * VOICE_RATE);
  const out = new Uint8Array(n);
  const pieces = lyrics.lines.flatMap((l) => l.pieces ?? []);
  for (let i = 0; i < n; i++) {
    const t = fromMs / 1000 + i / VOICE_RATE;
    const k = pieces.findIndex((p) => p.start !== null && p.end !== null && t >= p.start && t < p.end);
    let v = 0;
    if (k >= 0) {
      const semis = (SCALE[k % SCALE.length] as number) - (low ? 7 : 0);
      const f = 440 * 2 ** (semis / 12) * (1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t));
      v = 0.18 * Math.sin(2 * Math.PI * f * t);
    }
    out[i] = encodeMulaw(v);
  }
  return out;
}

/** Each singer's running score at `t` seconds into the song: a few curves that cross. */
function running(name: string, t: number, round: number): number {
  const x = Math.max(t, 0);
  const shape: Record<string, number> = { Mia: 0, 小明: 1.7, Kai: 3.1, 一隻路過的貓: 4.6 };
  const k = (shape[name] ?? 0) + round * 0.9;
  const base = 72 + 8 * Math.sin(k);
  return Math.max(0, Math.min(100, base + 9 * Math.sin(x / 4.5 + k) + Math.min(x, 20) * 0.25));
}

/** The scale step of the voice's `k`th piece, as `demoVoice` sings it (MIDI 69 is its 440 Hz). */
const SCALE = [0, 2, 4, 7, 9, 12, 9, 7];

/** The made-up reference notes: one per sung piece, on the voice's scale (the lanes' grey bars). */
export function demoNotes(lyrics: WorkersKaraokeLyricsV2): KaraokeNote[] {
  const pieces = lyrics.lines.flatMap((l) => l.pieces ?? []);
  const out: KaraokeNote[] = [];
  pieces.forEach((p, k) => {
    if (p.start === null || p.end === null) return;
    out.push({ start: p.start, end: p.end, midi: 69 + (SCALE[k % SCALE.length] as number) });
  });
  return out;
}

/**
 * A singer's made-up pitch at song time `t` (MIDI, `null` when not singing): Mia on the notes with a
 * little vibrato, 小明 an octave down (the lanes fold it back), Kai a bit flat and late, the cat
 * wandering and dropping out now and then.
 */
export function demoPitch(notes: readonly KaraokeNote[], name: string, t: number): number | null {
  const late = name === "Kai" ? 0.08 : name === "一隻路過的貓" ? 0.12 : 0.02;
  const note = notes.find((n) => t - late >= n.start && t - late < n.end + 0.03);
  if (note === undefined) return null;
  const vibrato = 0.12 * Math.sin(2 * Math.PI * 5.5 * t);
  switch (name) {
    case "Mia":
      return note.midi + vibrato;
    case "小明":
      return note.midi - 12 + 0.25 + vibrato;
    case "Kai":
      return note.midi - 0.45 + 0.6 * vibrato;
    default:
      // Drops out for a second now and then, and wanders around the note.
      if (Math.sin(t * 0.9) > 0.8) return null;
      return note.midi + 1.1 * Math.sin(1.3 * t) + vibrato;
  }
}

/** A board line's recent pitch: frames from `fromS` to `toS` song seconds, as Core sends it. */
function pitchPiece(notes: readonly KaraokeNote[], name: string, fromS: number, toS: number): KaraokePitch {
  const from = Math.max(0, Math.floor(fromS * LANE_HZ));
  const to = Math.floor(toS * LANE_HZ);
  const midi: (number | null)[] = [];
  for (let i = from; i < to; i++) {
    const m = demoPitch(notes, name, i / LANE_HZ);
    // Quarter semitones, as the one-byte track carries it.
    midi.push(m === null ? null : Math.round(m * 4) / 4);
  }
  return { from, midi };
}

/** The four parts of a made-up result that add up to about `total`. */
function demoParts(name: string, total: number): KaraokeParts {
  const k = name.length * 0.7;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const pitch = Math.min(60, Math.max(0, total * 0.62 + 1.5 * Math.sin(k)));
  const stability = Math.min(15, Math.max(0, total * 0.15 + Math.cos(k)));
  // The cat never calibrated its delay: no rhythm part.
  const rhythm = name === "一隻路過的貓" ? null : Math.min(15, Math.max(0, total * 0.14 - Math.sin(k)));
  const expression = Math.min(10, Math.max(0, total - pitch - stability - (rhythm ?? 0)));
  return { pitch: r1(pitch), stability: r1(stability), rhythm: rhythm === null ? null : r1(rhythm), expression: r1(expression) };
}

/** Who cheers in the demo (the room's watchers), and with what. */
const CHEERERS = [
  { name: "阿翔", color: 3 },
  { name: "小雨", color: 4 },
];
const CHEER_KINDS: KaraokeCheer["kind"][] = ["cheer", "nice", "wow", "encore"];
/** Someone who comes in to watch partway through a round, and leaves again. */
const VISITOR: KaraokeMember = { name: "小雨", color: 4, role: "spectator", ready: false, opener: false };

/** Songs people put in the queue (only the two above are ever sung). */
const ASKED: KaraokeQueueEntry[] = [
  { title: "星屑ステップ", artist: "示範歌手", by: "小明", state: "ready" },
  { title: "海邊的夏天", artist: "示範樂團", by: "Kai", state: "preparing" },
  { title: "壊れたテープ", artist: null, by: "一隻路過的貓", state: "failed" },
];

const songOf = (song: DemoSong): KaraokeSong => ({ id: song.id, title: song.title, artist: song.artist, durationMs: song.seconds * 1000 });

export function startKaraokeDemo(emit: (m: FeedMessage) => void): () => void {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });

  // The test pattern, in the dev server only (the branch is dropped from a production build).
  let video: string | null = null;
  if (import.meta.env.DEV) {
    void import("./karaoke-demo-video.js").then((m) => {
      video = m.default;
    });
  }

  let room = "K7PQ2M";
  let state: KaraokeScene = blank(room);
  /** The current round's made-up backing, as a URL the player fetches. */
  let backingUrl: string | null = null;
  const send = (patch: Partial<KaraokeScene>): void => {
    state = { ...state, ...patch };
    emit({ type: "karaoke", scene: state });
  };

  void (async () => {
    emit({ type: "status", status: { core: true, vts: true, obs: true, scene: "唱 K", streaming: true } });
    for (let loop = 0; !stopped; loop++) {
      const round = (loop % ROUNDS) + 1;
      if (round === 1 && loop > 0) {
        room = loop % (ROUNDS * 2) === 0 ? "K7PQ2M" : "TVR8HN";
        state = blank(room);
      }
      const song = SONGS[loop % SONGS.length] as DemoSong;
      await lobby(song, round, loop);
      if (stopped) return;
      await sing(song, round, loop);
      if (stopped) return;
      await settle();
      if (stopped) return;
      await results(round, loop);
    }
  })();

  async function lobby(song: DemoSong, round: number, loop: number): Promise<void> {
    const left = ROUNDS - round + 1;
    // Everyone stays for the next round, not ready again; the first lobby fills from nobody.
    const members =
      round === 1 ? [{ ...(PEOPLE[0] as KaraokeMember) }] : state.members.map((m) => ({ ...m, ready: false }));
    send({
      state: "lobby",
      round: round - 1,
      roundsLeft: left,
      song: round === 1 ? null : songOf(song),
      shift: loop % 3 === 2 ? -2 : 0,
      members,
      positionMs: null,
      board: [],
      note: null,
      air: QUIET,
      settling: null,
      queue: round === 1 ? [] : state.queue,
    });
    if (round === 1) {
      // Nobody has asked for a song yet; then the opener does, and the others queue theirs.
      await wait(2200);
      send({ song: songOf(song) });
      for (const [i, person] of PEOPLE.slice(1).entries()) {
        await wait(1300);
        if (stopped) return;
        const asked = ASKED[i];
        send({ members: [...state.members, { ...person }], queue: asked === undefined ? state.queue : [...state.queue, { ...asked }] });
      }
    }
    // They get ready one by one, and the song being prepared is done meanwhile.
    for (const name of ["Mia", "小明", "Kai", "一隻路過的貓"]) {
      await wait(900);
      if (stopped) return;
      send({
        members: state.members.map((m) => (m.name === name ? { ...m, ready: true } : m)),
        queue: name === "Kai" ? state.queue.map((e) => (e.state === "preparing" ? { ...e, state: "ready" } : e)) : state.queue,
      });
    }
    await wait(1800);
  }

  async function sing(song: DemoSong, round: number, loop: number): Promise<void> {
    const lyrics = demoLyrics(song);
    const notes = demoNotes(lyrics);
    if (backingUrl !== null) URL.revokeObjectURL(backingUrl);
    backingUrl = URL.createObjectURL(new Blob([demoBacking(song.seconds)], { type: "application/octet-stream" }));
    const backing = { url: backingUrl, format: "pcm" as const, rate: BACKING_RATE };
    emit({ type: "karaoke_lyrics", lyrics: { room, round, song: song.id, lyrics, video, backing, notes } });
    const singers = state.members.filter((m) => m.role === "singer");
    // One singer's voice is on the stream, and halfway another's (Core crossfades the change).
    const first = loop % 2 === 0 ? "Mia" : "Kai";
    const relayAt = (t: number) => (t < song.seconds / 2 ? first : "小明");
    const start = performance.now() + COUNTDOWN_MS;
    send({
      state: "countdown",
      round,
      roundsLeft: ROUNDS - round,
      song: songOf(song),
      positionMs: -COUNTDOWN_MS,
      board: [],
      air: { ...ON_AIR, relay: first },
      // Every other round the QR code stays in a corner while it is sung.
      qrWhileSinging: loop % 2 === 1,
    });
    // The voice, a quarter of a second at a time, half a second ahead of the song.
    let nextAt = 0;
    const voices = setInterval(() => {
      const position = performance.now() - start;
      while (!stopped && nextAt < song.seconds * 1000 && nextAt <= position + VOICE_AHEAD_MS) {
        const low = relayAt(nextAt / 1000) === "小明";
        const audio = bytesBase64(demoVoice(lyrics, nextAt, VOICE_PIECE_MS, low));
        emit({ type: "karaoke_voice", voice: { room, round, atMs: nextAt, audio } });
        nextAt += VOICE_PIECE_MS;
      }
    }, VOICE_PIECE_MS / 2);
    let ranks = new Map<string, number>();
    let scored = singers.map((m) => ({ m, total: 0 }));
    const cheered = new Map<string, number>();
    let cheers: KaraokeCheer[] = [];
    let nextCheer = 3;
    let cheerId = 0;
    // The countdown, then the board four times a second (the ranks and scores move once a second).
    for (let tick = 0; ; tick++) {
      await wait(250);
      const position = performance.now() - start;
      if (stopped || position >= song.seconds * 1000) break;
      if (position < 0) {
        // The countdown's board lists who sings the round, with no score yet.
        const lined = singers.map((m) => ({ ...unscored(m), pitch: null }));
        if (tick % 4 === 0) send({ state: "countdown", positionMs: position, board: lined, cheers: [] });
        continue;
      }
      const t = position / 1000;
      const relay = relayAt(t);
      const second = tick % 4 === 0;
      if (second) {
        ranks = new Map(scored.map((s, i) => [s.m.name, i + 1]));
        scored = singers.map((m) => ({ m, total: running(m.name, t, round) })).sort((a, b) => b.total - a.total);
      }
      // Someone comes in to watch for a while; the watchers cheer now and then.
      const visiting = t > 7 && t < song.seconds - 8;
      const here = state.members.some((m) => m.name === VISITOR.name);
      const members = visiting === here ? state.members : visiting ? [...state.members, { ...VISITOR }] : state.members.filter((m) => m.name !== VISITOR.name);
      if (t >= nextCheer) {
        const by = (CHEERERS[cheerId % (visiting ? 2 : 1)] ?? CHEERERS[0]) as { name: string; color: number };
        const to = singers[(cheerId * 3 + round) % singers.length] as KaraokeMember;
        cheerId++;
        cheered.set(to.name, (cheered.get(to.name) ?? 0) + 1);
        cheers = [...cheers, { id: `demo-${round}-${cheerId}`, kind: CHEER_KINDS[cheerId % 4] ?? "cheer", to: { name: to.name, color: to.color }, by }].slice(-6);
        nextCheer = t + 1.1 + ((cheerId * 7) % 10) / 10;
      }
      const board: KaraokeLine[] = scored.map(({ m, total }, i) => {
        const rank = i + 1;
        const before = ranks.get(m.name);
        return {
          name: m.name,
          color: m.color,
          rank,
          total: t < 1.5 ? null : Math.round(total * 10) / 10,
          // The cat's stream dropped: its score is the browser's estimate.
          source: t < 1.5 ? null : m.name === "一隻路過的貓" ? "estimate" : "voice",
          move: before === undefined || before === rank ? "same" : rank < before ? "up" : "down",
          winner: false,
          coins: 0,
          finished: false,
          onAir: m.name === relay,
          parts: null,
          // The singers are ahead of the stream: each frame brings the last second they sang, up to
          // a second past where the stream is.
          pitch: pitchPiece(notes, m.name, t, t + 1),
          cheers: cheered.get(m.name) ?? 0,
        };
      });
      send({ state: "singing", positionMs: position, board, members, cheers, air: { ...ON_AIR, relay } });
    }
    clearInterval(voices);
  }

  /** The song is over: the results come in one by one (結算中…), then it is about done. */
  async function settle(): Promise<void> {
    const board = state.board.map((l) => ({ ...l, pitch: null, onAir: false }));
    const members = state.members.filter((m) => m.name !== VISITOR.name);
    for (const waiting of [["Kai", "一隻路過的貓"], ["一隻路過的貓"], []]) {
      send({ state: "singing", positionMs: null, board, members, air: QUIET, settling: { waiting }, cheers: [] });
      await wait(1500);
      if (stopped) return;
    }
  }

  async function results(round: number, loop: number): Promise<void> {
    const prize = loop % 2 === 0;
    const board = state.board.map((l, i) => {
      const finished = l.name !== "一隻路過的貓" || loop % 3 === 0;
      const winner = prize && i === 0;
      const total = l.total === null ? null : Math.round((l.total + (l.source === "voice" ? 1.2 : 0)) * 10) / 10;
      return {
        ...l,
        move: "same" as const,
        onAir: false,
        total,
        winner,
        finished,
        coins: (winner ? 15 : 0) + (finished ? 3 : 0),
        parts: total === null ? null : demoParts(l.name, total),
        pitch: null,
      };
    });
    // The scene names the next song by now.
    const next = SONGS[(loop + 1) % SONGS.length] as DemoSong;
    send({
      state: "results",
      positionMs: null,
      board,
      note: prize ? null : "正式分數的人不到兩個,這一首沒有第一名",
      air: QUIET,
      roundsLeft: ROUNDS - round,
      settling: null,
      song: round < ROUNDS ? songOf(next) : null,
    });
    await wait(10_000);
  }

  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (backingUrl !== null) URL.revokeObjectURL(backingUrl);
  };
}

function blank(room: string): KaraokeScene {
  return {
    room,
    state: "lobby",
    round: 0,
    roundsLeft: ROUNDS,
    song: null,
    shift: 0,
    members: [],
    positionMs: null,
    board: [],
    note: null,
    currency: CURRENCY,
    air: QUIET,
    queue: [],
    // A sample link: the demo's QR code opens nothing real.
    joinUrl: `https://example.com/karaoke/room/${room}`,
    qrWhileSinging: false,
    settling: null,
    cheers: [],
  };
}

/** A singer on the countdown's board: in the round, no score yet. */
function unscored(m: KaraokeMember): Omit<KaraokeLine, "pitch"> {
  return {
    name: m.name,
    color: m.color,
    rank: null,
    total: null,
    source: null,
    move: "same",
    winner: false,
    coins: 0,
    finished: false,
    onAir: false,
    parts: null,
    cheers: 0,
  };
}
