/**
 * Topic of latency measurements (`custom` events), with `stage` = `asr` (`asr_ms`,
 * `transcribe_ms`), `tts` (`first_audio_ms`) or `e2e` (`E2eRecord`: `speech_end →
 * first_audio_played` and its six `segments`, one per reply that answers human speech).
 */
export const LATENCY_TOPIC = "voice.latency";

/**
 * Topic of `VoiceBargeIn` custom events: somebody talked while she spoke and her speech was
 * ducked, paused, resumed or stopped (`@miyoria/types`).
 */
export { VOICE_BARGE_IN_TOPIC } from "@miyoria/types";
