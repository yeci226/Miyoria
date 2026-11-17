// What the workers' protocols carry that is not JSON, so there is no schema for it: header names,
// form fields, file names and frame formats. The clients and the doc (`docs/protocols/voice-link.md`)
// point here. Header names are lower case, as `fetch` reads them.

/** Sample rate of the audio, in Hz. Sent with the raw PCM of `POST /turn` (the request), by the TTS worker on `POST /tts` (the response) and by the song worker on a `.pcm` file. */
export const WORKERS_SAMPLE_RATE_HEADER = "x-sample-rate";

/** TTS response: how long the request waited for the GPU lock, in ms (Core counts it into `tts_queue`). */
export const WORKERS_TTS_QUEUE_MS_HEADER = "x-tts-queue-ms";

/** TTS response: which reference audio was used (`ref`, `ref.ja`, `bank/ja/happy`). */
export const WORKERS_TTS_REFERENCE_HEADER = "x-tts-reference";

/** TTS response: `chunk` (audio per codec chunk inside a sentence) or `sentence` (whole sentences). */
export const WORKERS_TTS_STREAMING_HEADER = "x-tts-streaming";

/** TTS response: ms from the request to the first audio. */
export const WORKERS_TTS_FIRST_AUDIO_MS_HEADER = "x-tts-first-audio-ms";

/** ASR response: ms the model took, without the wait for the lock. */
export const WORKERS_ASR_INFERENCE_MS_HEADER = "x-inference-ms";

/**
 * Fields of the ASR request, a `multipart/form-data` body: `audio` is a WAV file (PCM s16le mono,
 * any rate), the rest are text. `priority` is `ahead` for audio that can wait behind the rest;
 * left out, it is `now`.
 */
export const WORKERS_ASR_FORM_FIELDS = {
  audio: "audio",
  language: "language",
  prompt: "prompt",
  priority: "priority",
} as const;

/** The only rate the end-of-turn worker takes (`POST /turn` and `WS /vad`), in Hz. */
export const WORKERS_TURN_SAMPLE_RATE = 16_000;

/**
 * `WS /vad`: the client sends binary messages of exactly this many samples (PCM s16le mono at
 * `WORKERS_TURN_SAMPLE_RATE`, 32 ms); the worker answers each with one text message, the speech
 * probability as a decimal with three digits (`"0.923"`). A frame of another size closes the
 * socket with code 1003, a model that is not loaded with 1011.
 */
export const WORKERS_VAD_FRAME_SAMPLES = 512;

/** The two PCM tracks of a song (`GET /songs/{id}/files/{name}`): s16le mono at `play.sample_rate`. */
export const WORKERS_SING_PCM_TRACKS = ["play_mix.pcm", "play_vocals.pcm"] as const;

/**
 * Fields of the lyrics request, a `multipart/form-data` body: `hints` (JSON, `WorkersLyricsHints`),
 * `duration` (seconds, optional), `fresh` (`0` or `1`, optional), `audio` (the lead vocal as a WAV
 * file, optional: the ASR spot check needs it).
 */
export const WORKERS_LYRICS_FORM_FIELDS = {
  hints: "hints",
  duration: "duration",
  fresh: "fresh",
  audio: "audio",
} as const;
