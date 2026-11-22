// @miyoria/play/karaoke/score: the karaoke score, shared by the singer's browser and Core
// (docs/design/karaoke.md §5.4). Plain TypeScript with no imports outside this folder, no DOM and
// no Node, so the panel takes it without pulling Core into its bundle.
//
// - `track.ts`: pitch tracks, their one-byte-a-frame form at 50 Hz, base64, resampling.
// - `curve.ts`: what is read off the reference curve (runs, onsets, held stretches, phrases).
// - `score.ts`: `scoreSinging`, the four parts, phrases and the facts her comment uses.
// - `expression.ts`: vibrato, long tones, scoops and falls.
// - `clean.ts`: the browser's detections cleaned the way the song worker cleans RMVPE's.
// - `live.ts`: `LiveScore` (the pitch part as it comes, and the octave) and `RunningScore` (the
//   number shown while singing: the score of the song so far).
// - `voice.ts`: placing a recording of the singer in song time, and the checks of its voice.
// - `stream.ts`: `StreamScore`, a room singer's official score while their voice streams in.
// - `judge.ts`: `NoteJudge`, each reference note as someone watching sees it go by (perfect, good
//   or miss by the same frame credit, the combo, a clean phrase): for the stream's lanes.

export { cleanPitch, cleanTrack } from "./clean.js";
export type { Span } from "./curve.js";
export type { Expression } from "./expression.js";
export {
  foldedCents,
  JUDGE_GOOD,
  JUDGE_KNOWN,
  JUDGE_MIN_FRAMES,
  JUDGE_PERFECT,
  type Judgement,
  type JudgeNote,
  NoteJudge,
  noteCredit,
  PHRASE_CREDIT,
  PHRASE_NOTES,
  type Verdict,
  verdictOf,
} from "./judge.js";
export { LiveScore, RunningScore } from "./live.js";
export {
  alignSung,
  DEFAULT_TUNING,
  frameCredit,
  PARTS,
  type PhraseScore,
  type PhraseTime,
  phraseSpans,
  pitchFraction,
  type ReferenceCurve,
  type RhythmFeel,
  type ScoreInput,
  type ScoreResult,
  type ScoreTuning,
  scoreSinging,
} from "./score.js";
export { StreamScore, type StreamScoreInput } from "./stream.js";
export {
  asSubmitted,
  decodeTrack,
  encodeTrack,
  fromBase64,
  type PitchFrames,
  type PitchTrack,
  resampleTrack,
  TRACK_HZ,
  TRACK_MIDI_BASE,
  TRACK_MIDI_TOP,
  TRACK_STEPS,
  TrackRecorder,
  toBase64,
} from "./track.js";
export {
  BLEED_SHARE,
  type Placement,
  placeRecording,
  QUIET_ABOVE_FLOOR_DB,
  QUIET_DB,
  recordingInSong,
  type VoiceCheck,
  type VoiceCheckResult,
  type VoiceLevels,
  voiceChecks,
} from "./voice.js";
