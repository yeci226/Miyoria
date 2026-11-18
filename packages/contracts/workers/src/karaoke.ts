import { z } from "zod";

// What the song worker makes for karaoke (`POST /jobs` with `purpose: "karaoke"`,
// docs/design/karaoke.md 「做了什麼(第一步)」「做了什麼第二步」): a backing track to sing over and
// `reference.json`, the reference the singing is compared with. This file is the one definition of
// that format; the worker writes it, Core reads it from the worker and hands it to the singer's
// browser.
//
// Times are seconds from the start of the backing track. Everything about the song (title,
// artist, lyrics) comes from YouTube, lrclib or a speech recogniser and is untrusted.
//
// Version 1 (the first milestone): the lead vocal's pitch curve, notes cut from the pitch alone,
// lyrics with line times. Version 2 (the second): every line of looked-up lyrics is checked against
// what the recogniser heard in the lead (`status`), or, without lyrics, the lyrics are what it heard
// (`source: "heard"`); lines that hold are force-aligned, so each piece of a line has its time and
// the notes of those lines are cut one per character or mora (`source: "lyric"`). Readers accept
// both versions (`WorkersKaraokeReferenceSchema`) and work on the second's shape
// (`karaokeReferenceV2`).

/** The value of `format`. */
export const KARAOKE_REFERENCE_FORMAT = "miyoria.karaoke.reference";
/** The version the worker writes now. */
export const KARAOKE_REFERENCE_VERSION = 2;
/** Frames per second of the reference pitch curve (and of a singer's submitted track). */
export const KARAOKE_FRAME_HZ = 50;
/** The files of a prepared karaoke song (`GET /karaoke/{id}/files/{name}`). */
export const KARAOKE_FILES = ["karaoke.m4a", "reference.json"] as const;

/**
 * The lead vocal's pitch, one frame every `1 / hz` seconds from `start`: MIDI note numbers with a
 * fraction (60 = C4, 60.5 = a quarter tone above), `null` where the lead is not voiced (the voiced
 * flag). Made by `made.pitch` (RMVPE) on the lead vocal after the lead / backing split.
 */
export const WorkersKaraokePitchSchema = z
  .object({
    hz: z.number().int().positive(),
    start: z.number(),
    midi: z.array(z.number().nullable()),
  })
  .meta({ id: "WorkersKaraokePitch" });
export type WorkersKaraokePitch = z.output<typeof WorkersKaraokePitchSchema>;

/**
 * One bar of the guide. Only a guide on screen: the score compares the pitch curves, so a note cut
 * wrong costs nobody anything (owner 2026-11-17).
 *
 * `source`: `pitch`, cut from the pitch curve alone (stable-pitch runs); `lyric`, one per
 * character or mora of an aligned line (version 2). `line` / `char`: the lyric line and, in
 * version 2, the index of the piece in its `pieces` a `lyric` note sings (a piece may have several
 * notes: one per mora, or a run the pitch moves through); `null` for `pitch`.
 */
export const WorkersKaraokeNoteSchema = z
  .object({
    start: z.number(),
    end: z.number(),
    midi: z.number(),
    source: z.enum(["pitch", "lyric"]),
    line: z.number().int().nullable(),
    char: z.number().int().nullable(),
  })
  .meta({ id: "WorkersKaraokeNote" });
export type WorkersKaraokeNote = z.output<typeof WorkersKaraokeNoteSchema>;

/** One character of a line with its time (version 1: never filled). */
export const WorkersKaraokeCharSchema = z
  .object({ text: z.string(), start: z.number(), end: z.number() })
  .meta({ id: "WorkersKaraokeChar" });
export type WorkersKaraokeChar = z.output<typeof WorkersKaraokeCharSchema>;

/**
 * One line of lyrics in version 1. `end`: when the next line starts (or the lead's last voice),
 * `null` when nothing tells. `check`: always `unchecked` (the looked-up text as it is);
 * `confidence` and `chars` always `null`.
 */
export const WorkersKaraokeLineSchema = z
  .object({
    start: z.number(),
    end: z.number().nullable(),
    text: z.string(),
    check: z.enum(["unchecked", "matched", "uncertain", "failed"]),
    confidence: z.number().nullable(),
    chars: z.array(WorkersKaraokeCharSchema).nullable(),
  })
  .meta({ id: "WorkersKaraokeLine" });
export type WorkersKaraokeLine = z.output<typeof WorkersKaraokeLineSchema>;

/**
 * The lyrics in version 1: where they came from (`lrclib`, `netease`, ...), whether lines or
 * characters have times (`timing`), and the lines. `null` in the reference when none were found.
 */
export const WorkersKaraokeLyricsSchema = z
  .object({
    provider: z.string().nullable(),
    timing: z.enum(["line", "char"]),
    lines: z.array(WorkersKaraokeLineSchema),
  })
  .meta({ id: "WorkersKaraokeLyrics" });
export type WorkersKaraokeLyrics = z.output<typeof WorkersKaraokeLyricsSchema>;

/**
 * Whether the song can be sung: `ok` false with a `reason` when the lead is voiced in less than
 * the worker's share of the song, or there are too few notes (docs/design/karaoke.md §3.2).
 */
export const WorkersKaraokeQualitySchema = z
  .object({
    ok: z.boolean(),
    reason: z.string().nullable(),
    /** Voiced frames of the reference over all frames. */
    voiced_ratio: z.number(),
    notes: z.number().int(),
    /** The lead was split from the backing voices (else the whole vocal stem was used). */
    lead_split: z.boolean(),
  })
  .meta({ id: "WorkersKaraokeQuality" });
export type WorkersKaraokeQuality = z.output<typeof WorkersKaraokeQualitySchema>;

/** How each part was made, so a later milestone can tell what to redo: `rmvpe`, `pitch-runs-1`, `line` / `none`. */
export const WorkersKaraokeMadeSchema = z
  .object({ pitch: z.string(), notes: z.string(), lyrics: z.string() })
  .meta({ id: "WorkersKaraokeMade" });
export type WorkersKaraokeMade = z.output<typeof WorkersKaraokeMadeSchema>;

/** `reference.json` version 1. */
export const WorkersKaraokeReferenceV1Schema = z
  .object({
    format: z.literal(KARAOKE_REFERENCE_FORMAT),
    version: z.literal(1),
    id: z.string(),
    title: z.string(),
    artist: z.string().nullable(),
    duration_s: z.number(),
    /** The backing track: the instrumental with the backing voices kept, AAC in MP4. */
    backing: z.string(),
    pitch: WorkersKaraokePitchSchema,
    notes: z.array(WorkersKaraokeNoteSchema),
    lyrics: WorkersKaraokeLyricsSchema.nullable(),
    quality: WorkersKaraokeQualitySchema,
    made: WorkersKaraokeMadeSchema,
  })
  .meta({ id: "WorkersKaraokeReferenceV1" });
export type WorkersKaraokeReferenceV1 = z.output<typeof WorkersKaraokeReferenceV1Schema>;

// ---- version 2 -------------------------------------------------------------------------------

/**
 * A piece of a line as it is shown: the pieces of a line, joined, are its text. A sung piece is
 * one Chinese character, one English word, or for Japanese one kana (a mora) or one word written
 * with kanji; spaces and punctuation are pieces that are not sung. `start` / `end`: when it is
 * sung, from the forced alignment; `null` when the line was not aligned. `reading`: Japanese, the
 * hiragana of a word written with kanji (furigana); Chinese, the pinyin with tone marks; else
 * `null`. `roman`: Japanese romaji (Hepburn) of the piece; else `null`.
 */
export const WorkersKaraokePieceSchema = z
  .object({
    text: z.string(),
    sung: z.boolean(),
    start: z.number().nullable(),
    end: z.number().nullable(),
    reading: z.string().nullable(),
    roman: z.string().nullable(),
  })
  .meta({ id: "WorkersKaraokePiece" });
export type WorkersKaraokePiece = z.output<typeof WorkersKaraokePieceSchema>;

/**
 * How a line was checked. For looked-up lyrics (`source: "found"`), the similarity of the line to
 * what the recogniser heard in its window: `matched` (at least the matched threshold, 0.75 by
 * default), `uncertain` (at least 0.5), `failed` (below). For heard lyrics (`source: "heard"`),
 * always `uncertain`: nothing checks a transcription. `unchecked`: the check could not run (no
 * recogniser on the worker's machine), the looked-up text as it is.
 */
export const WorkersKaraokeLineStatusSchema = z
  .enum(["matched", "uncertain", "failed", "unchecked"])
  .meta({ id: "WorkersKaraokeLineStatus" });
export type WorkersKaraokeLineStatus = z.output<typeof WorkersKaraokeLineStatusSchema>;

/**
 * Where lyrics came from: `found`, looked up (lrclib, NetEase); `heard`, what the recogniser
 * heard in the lead vocal (shown as 「聽寫」: it may be wrong).
 */
export const WorkersKaraokeLyricsSourceSchema = z
  .enum(["found", "heard"])
  .meta({ id: "WorkersKaraokeLyricsSource" });
export type WorkersKaraokeLyricsSource = z.output<typeof WorkersKaraokeLyricsSourceSchema>;

/**
 * One line of lyrics in version 2. `start` / `end`: the line's time (looked up: from the synced
 * lyrics, `end` when the next starts; heard: from its first to its last aligned piece).
 * `similarity`: 0..1, what `status` was decided on, `null` when nothing was compared. `heard`:
 * what the recogniser heard in the line's window (for an editor later), `null` when it was not
 * asked. `aligned`: the pieces have times and passed the checks (each one voiced, none absurdly
 * short or long, in order); only aligned lines have notes of their own. `pieces`: `null` when
 * the worker could not split the text (no language tools). `edited`: changed by hand (an editor
 * later); the worker writes `false`.
 */
export const WorkersKaraokeLineV2Schema = z
  .object({
    start: z.number(),
    end: z.number().nullable(),
    text: z.string(),
    status: WorkersKaraokeLineStatusSchema,
    source: WorkersKaraokeLyricsSourceSchema,
    similarity: z.number().nullable(),
    heard: z.string().nullable(),
    aligned: z.boolean(),
    pieces: z.array(WorkersKaraokePieceSchema).nullable(),
    edited: z.boolean(),
  })
  .meta({ id: "WorkersKaraokeLineV2" });
export type WorkersKaraokeLineV2 = z.output<typeof WorkersKaraokeLineV2Schema>;

/**
 * The check of looked-up lyrics as a whole: lines per status and the verdict. `kept`: at least
 * the keep share (0.5) of the lines matched; `doubtful`: fewer, but at least the wrong-song share
 * (0.2), the lines are kept with their statuses; `wrong_song`: fewer than that, the looked-up
 * lyrics were dropped and the lyrics are what was heard. `unchecked`: the check did not run.
 */
export const WorkersKaraokeLyricsCheckSchema = z
  .object({
    matched: z.number().int(),
    uncertain: z.number().int(),
    failed: z.number().int(),
    verdict: z.enum(["kept", "doubtful", "wrong_song", "unchecked"]),
  })
  .meta({ id: "WorkersKaraokeLyricsCheck" });
export type WorkersKaraokeLyricsCheck = z.output<typeof WorkersKaraokeLyricsCheckSchema>;

/**
 * The lyrics in version 2. `provider`: who had the looked-up lyrics (also kept when they were
 * dropped as the wrong song), `null` when none were found. `source`: of the lines. `language`:
 * `ja`, `zh`, `en` or `null` (not known). `timing`: `char` when at least one line is aligned.
 * `check`: of the looked-up lyrics, `null` when there were none.
 */
export const WorkersKaraokeLyricsV2Schema = z
  .object({
    provider: z.string().nullable(),
    source: WorkersKaraokeLyricsSourceSchema,
    language: z.string().nullable(),
    timing: z.enum(["line", "char"]),
    check: WorkersKaraokeLyricsCheckSchema.nullable(),
    lines: z.array(WorkersKaraokeLineV2Schema),
  })
  .meta({ id: "WorkersKaraokeLyricsV2" });
export type WorkersKaraokeLyricsV2 = z.output<typeof WorkersKaraokeLyricsV2Schema>;

/**
 * How each part was made in version 2: besides version 1's, `asr` (the recogniser that checked
 * or transcribed the lyrics, e.g. `qwen3-asr-1.7b`) and `aligner` (`mms` or `w2v`), `null` when
 * that step did not run.
 */
export const WorkersKaraokeMadeV2Schema = z
  .object({
    pitch: z.string(),
    notes: z.string(),
    lyrics: z.string(),
    asr: z.string().nullable(),
    aligner: z.string().nullable(),
  })
  .meta({ id: "WorkersKaraokeMadeV2" });
export type WorkersKaraokeMadeV2 = z.output<typeof WorkersKaraokeMadeV2Schema>;

/** `reference.json` version 2. */
export const WorkersKaraokeReferenceV2Schema = z
  .object({
    format: z.literal(KARAOKE_REFERENCE_FORMAT),
    version: z.literal(2),
    id: z.string(),
    title: z.string(),
    artist: z.string().nullable(),
    duration_s: z.number(),
    /** The backing track: the instrumental with the backing voices kept, AAC in MP4. */
    backing: z.string(),
    pitch: WorkersKaraokePitchSchema,
    notes: z.array(WorkersKaraokeNoteSchema),
    lyrics: WorkersKaraokeLyricsV2Schema.nullable(),
    quality: WorkersKaraokeQualitySchema,
    made: WorkersKaraokeMadeV2Schema,
  })
  .meta({ id: "WorkersKaraokeReferenceV2" });
export type WorkersKaraokeReferenceV2 = z.output<typeof WorkersKaraokeReferenceV2Schema>;

/** `reference.json` as a reader takes it: version 1 or 2. */
export const WorkersKaraokeReferenceSchema = z
  .discriminatedUnion("version", [WorkersKaraokeReferenceV1Schema, WorkersKaraokeReferenceV2Schema])
  .meta({ id: "WorkersKaraokeReference" });
export type WorkersKaraokeReference = z.output<typeof WorkersKaraokeReferenceSchema>;

/**
 * A reference in version 2's shape, whichever version it was written in. A version 1 line is
 * found lyrics as they were, `unchecked`, without pieces.
 */
export function karaokeReferenceV2(ref: WorkersKaraokeReference): WorkersKaraokeReferenceV2 {
  if (ref.version === 2) return ref;
  const lyrics = ref.lyrics;
  return {
    ...ref,
    version: 2,
    lyrics:
      lyrics === null
        ? null
        : {
            provider: lyrics.provider,
            source: "found",
            language: null,
            timing: "line",
            check: null,
            lines: lyrics.lines.map((l) => ({
              start: l.start,
              end: l.end,
              text: l.text,
              status: l.check,
              source: "found",
              similarity: l.confidence,
              heard: null,
              aligned: false,
              pieces: null,
              edited: false,
            })),
          },
    made: { ...ref.made, asr: null, aligner: null },
  };
}

/**
 * How a karaoke job checks and aligns its lyrics (`POST /jobs` `karaoke_lyrics`; Core's module
 * settings). `aligner`: `mms` (the default), torchaudio's MMS_FA weights (CC-BY-NC-4.0:
 * non-commercial use only), far better on hard songs; `w2v`, a wav2vec2 CTC model per language
 * (Apache-2.0).
 * `matched` / `uncertain`: a line's similarity thresholds; `keep_share` / `wrong_share`: of the
 * lines matched, at least this many keeps the looked-up lyrics, fewer than this many is the wrong
 * song.
 */
export const WorkersKaraokeLyricsOptionsSchema = z
  .object({
    aligner: z.enum(["w2v", "mms"]).default("mms"),
    matched: z.number().min(0).max(1).default(0.75),
    uncertain: z.number().min(0).max(1).default(0.5),
    keep_share: z.number().min(0).max(1).default(0.5),
    wrong_share: z.number().min(0).max(1).default(0.2),
  })
  .meta({ id: "WorkersKaraokeLyricsOptions" });
export type WorkersKaraokeLyricsOptions = z.output<typeof WorkersKaraokeLyricsOptionsSchema>;

/** The body of `POST /karaoke/{id}/keys`: the backing track in another key. */
export const WorkersKaraokeKeyRequestSchema = z
  .object({ semitones: z.number().int().min(-6).max(6) })
  .meta({ id: "WorkersKaraokeKeyRequest" });
export type WorkersKaraokeKeyRequest = z.output<typeof WorkersKaraokeKeyRequestSchema>;

/**
 * The answer: the file to fetch (`GET /karaoke/{id}/files/{file}`), made now or before (`cached`).
 * `method`: how the key was moved (`rubberband`).
 */
export const WorkersKaraokeKeyReplySchema = z
  .object({
    file: z.string(),
    semitones: z.number().int(),
    cached: z.boolean(),
    method: z.string(),
  })
  .meta({ id: "WorkersKaraokeKeyReply" });
export type WorkersKaraokeKeyReply = z.output<typeof WorkersKaraokeKeyReplySchema>;

/** Semitones a singer may move the key by, either way (the backing is rendered for each). */
export const KARAOKE_MAX_SHIFT = 6;

/**
 * The reference moved by `semitones` (the key the backing was rendered in): the pitch curve and
 * the notes follow; nothing else changes.
 */
export function shiftKaraokeReference<R extends WorkersKaraokeReference>(
  ref: R,
  semitones: number,
): R {
  if (semitones === 0) return ref;
  const up = (m: number) => Math.round((m + semitones) * 100) / 100;
  return {
    ...ref,
    pitch: { ...ref.pitch, midi: ref.pitch.midi.map((m) => (m === null ? null : up(m))) },
    notes: ref.notes.map((n) => ({ ...n, midi: up(n.midi) })),
  };
}

/** The backing track's file name in a key `semitones` away (`karaoke.m4a` itself at 0). */
export function karaokeBackingName(semitones: number): string {
  if (semitones === 0) return "karaoke.m4a";
  return `karaoke.k${semitones > 0 ? "+" : "-"}${Math.abs(semitones)}.m4a`;
}

/** Sample rate of the backing as the voice node plays it (`karaokePlayName`). */
export const KARAOKE_PLAY_RATE = 48_000;

/**
 * The backing `semitones` away as raw PCM for the voice node: s16le mono at `KARAOKE_PLAY_RATE`
 * (`play_karaoke.pcm`, `play_karaoke.k+3.pcm`), what Core plays in her voice channel during a
 * room's round (docs/design/karaoke.md 「做了什麼第五步」). The worker decodes it from the
 * matching `karaokeBackingName` file the first time it is asked for, and keeps it with the song;
 * an older worker answers 404 and the round has no backing in voice.
 */
export function karaokePlayName(semitones: number): string {
  if (semitones === 0) return "play_karaoke.pcm";
  return `play_karaoke.k${semitones > 0 ? "+" : "-"}${Math.abs(semitones)}.pcm`;
}

/**
 * A finished karaoke job (`job.karaoke`): the song's id among the worker's karaoke songs (not one
 * of her covers: it is never listed by `GET /songs`), and what `reference.json` says of it.
 */
export const WorkersKaraokeSongSchema = z
  .object({
    id: z.string(),
    title: z.string().catch(""),
    artist: z.string().nullable().catch(null),
    duration_s: z.number().nullable().catch(null),
    quality: WorkersKaraokeQualitySchema.nullable().catch(null),
    /**
     * The song has `video.mp4` (`KARAOKE_VIDEO_FILE`): the source's picture, no sound, at most
     * 720p, on the backing's timeline (docs/design/karaoke.md 「做了什麼第三步」). A worker
     * predating it, or a song without one: `false`.
     */
    video: z.boolean().catch(false).default(false),
  })
  .meta({ id: "WorkersKaraokeSong" });
export type WorkersKaraokeSong = z.output<typeof WorkersKaraokeSongSchema>;

/** A karaoke song's background video (`GET /karaoke/{id}/files/video.mp4`), when it has one. */
export const KARAOKE_VIDEO_FILE = "video.mp4";

/** Largest recording of a singer the worker takes (`POST /karaoke/voice`), in bytes. */
export const KARAOKE_VOICE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The answer of `POST /karaoke/voice` (body: one recording of a singer's microphone, compressed,
 * `content-type` `audio/webm`, `audio/ogg` or `audio/mp4`): RMVPE's pitch of it, gated by its own
 * loudness and cleaned as a reference is (octave jumps, spikes), at 50 Hz from the recording's
 * first sample. The worker deletes the recording before it answers, and never logs it.
 *
 * - `midi`: MIDI (fractional) a frame, `null` where nothing was sung.
 * - `seconds`: the recording's length.
 * - `level_db`: the median loudness (dBFS) of the voiced frames; `floor_db`: the 10th percentile
 *   of all frames. Core's checks of a quiet or far-away voice (a singer on speakers) read them.
 * - `device`: where RMVPE ran (`cuda` or `cpu`); `method`: `rmvpe`.
 */
export const WorkersKaraokeVoicePitchSchema = z
  .object({
    hz: z.literal(KARAOKE_FRAME_HZ),
    midi: z.array(z.number().nullable()),
    seconds: z.number(),
    level_db: z.number().nullable(),
    floor_db: z.number().nullable(),
    device: z.string(),
    method: z.string(),
  })
  .meta({ id: "WorkersKaraokeVoicePitch" });
export type WorkersKaraokeVoicePitch = z.output<typeof WorkersKaraokeVoicePitchSchema>;

// ---- the live voice of a room's singers (docs/design/karaoke.md 「做了什麼第四步」) -------------
//
// `POST /karaoke/stream` (JSON both ways): while a room sings, Core relays each singer's
// microphone to one song worker in small batches (about every half second, all the room's singers
// in one request); the worker keeps each stream's audio in memory only, runs RMVPE on a window
// around what is new and answers 50 Hz pitch frames (`WorkersKaraokeStreamFrames`). Frames near the
// end may still change: each answer starts at `from`, and replaces what an earlier one said from
// there. A chunk with `end: true` closes its stream: the worker answers its whole curve made at
// once from everything it read (`final: true`, the same treatment as `POST /karaoke/voice`) and
// forgets the audio. A stream nobody sends to for a while is forgotten too. Nothing is written to
// disk or logged. A worker without this endpoint answers 404: rooms then score from the browser's
// estimate and the one recording each singer uploads at the end.

/** Samples per second of a stream: 16 kHz mono (RMVPE reads 16 kHz). */
export const KARAOKE_STREAM_RATE = 16_000;
/** Bytes per sample: G.711 µ-law, one byte a sample (128 kbit/s). */
export const KARAOKE_STREAM_BYTES_PER_SAMPLE = 1;
/** Streams in one request (a room's singers). */
export const KARAOKE_STREAM_MAX_STREAMS = 8;
/** Samples in one chunk: at most four seconds (a batch late by that much is dropped by Core). */
export const KARAOKE_STREAM_MAX_CHUNK = 4 * KARAOKE_STREAM_RATE;

/** A stream (one singer of one round) or a room: letters, digits, `-` and `_`. */
const streamId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * New audio of one stream. `at`: the sample of the stream its first sample is (0 = the stream's
 * first). A chunk that starts past what the worker has is padded with silence; what it already has
 * is not read again (a retry is harmless).
 */
export const WorkersKaraokeStreamChunkSchema = z
  .object({
    stream: streamId,
    at: z.number().int().min(0),
    /** µ-law, 16 kHz mono, base64; may be empty (only `end`). */
    audio: z.string(),
    end: z.boolean().default(false),
  })
  .meta({ id: "WorkersKaraokeStreamChunk" });
export type WorkersKaraokeStreamChunk = z.input<typeof WorkersKaraokeStreamChunkSchema>;

/** Body of `POST /karaoke/stream`. `room`: the streams belong to it (they are counted per room). */
export const WorkersKaraokeStreamRequestSchema = z
  .object({
    room: streamId,
    chunks: z.array(WorkersKaraokeStreamChunkSchema).max(KARAOKE_STREAM_MAX_STREAMS),
    /** Streams to forget without an answer (a singer who left). */
    drop: z.array(streamId).max(KARAOKE_STREAM_MAX_STREAMS).default([]),
  })
  .meta({ id: "WorkersKaraokeStreamRequest" });
export type WorkersKaraokeStreamRequest = z.input<typeof WorkersKaraokeStreamRequestSchema>;

/**
 * One stream's pitch: frames `from`, `from + 1`, ... at 50 Hz from the stream's first sample
 * (MIDI, `null` not voiced), replacing what earlier answers said from `from` on. `final`: the whole
 * curve from 0, made at once from everything read, with its loudness figures (as
 * `WorkersKaraokeVoicePitch`); the stream is gone after it.
 */
export const WorkersKaraokeStreamFramesSchema = z
  .object({
    stream: z.string(),
    from: z.number().int().min(0),
    midi: z.array(z.number().nullable()),
    final: z.boolean(),
    /** Seconds of audio read so far. */
    seconds: z.number(),
    level_db: z.number().nullable(),
    floor_db: z.number().nullable(),
  })
  .meta({ id: "WorkersKaraokeStreamFrames" });
export type WorkersKaraokeStreamFrames = z.output<typeof WorkersKaraokeStreamFramesSchema>;

/** The answer of `POST /karaoke/stream`: a stream the worker refused or lost is in `lost`. */
export const WorkersKaraokeStreamAnswerSchema = z
  .object({
    hz: z.literal(KARAOKE_FRAME_HZ),
    streams: z.array(WorkersKaraokeStreamFramesSchema),
    /** Streams it does not have (forgotten, over a cap): Core scores them from the estimate. */
    lost: z.array(z.string()).default([]),
    device: z.string(),
    method: z.string(),
  })
  .meta({ id: "WorkersKaraokeStreamAnswer" });
export type WorkersKaraokeStreamAnswer = z.output<typeof WorkersKaraokeStreamAnswerSchema>;
