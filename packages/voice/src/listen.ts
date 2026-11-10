// Listening: audio streams → consent filter → segmentation → ASR → `voice_utterance` events.
//
// With `turn_engine = "smart-turn"` silence is measured on the clock, not on the audio: Discord
// stops sending packets when somebody stops talking, and the voice node closes the stream after
// `SILENCE_MS`. So while a speaker has an utterance open, the gaps are filled with silence, and the
// utterance outlives its stream: a speaker who pauses longer than the node waits comes back on
// a new stream and carries on in the same utterance, instead of being cut in two.

import { errorMessage, interval, type ModuleContext } from "@miyoria/kernel";
import {
  type AsrHint,
  durationMs,
  isOffloaded,
  type SpeechService,
  type Transcript,
} from "@miyoria/speech";
import {
  type AccountRef,
  accountRefString,
  contextKeyEquals,
  customEvent,
  type JsonValue,
  newId,
  SpeechPauseKey,
  sameAccount,
  TurnFocusViewKey,
  toTimestamp,
  VoiceFloorKey,
} from "@miyoria/types";
import type { BargeIn, BargeWho, SpeakerRole } from "./barge.js";
import type { ClipRecorder } from "./clips.js";
import { segmenterConfig, type VoiceConfig } from "./config.js";
import type { Consent } from "./consent.js";
import type { E2eLatency, TurnEnd } from "./e2e.js";
import { looksLikeHintEcho, matchCore, type SelfEchoGuard } from "./echo.js";
import type { AudioEvent, StreamInfo, VoiceLink } from "./link/link.js";
import { Segmenter, type TurnCandidate, type TurnVerdict, type Utterance } from "./segment.js";
import {
  type AsrAliases,
  applyAliases,
  cleanTranscript,
  compileAliases,
  echoesHint,
} from "./text.js";
import { LATENCY_TOPIC } from "./topics.js";
import type { TurnAnswer, TurnGate, TurnJudge } from "./turn.js";
import type { Semaphore } from "./util.js";
import { createVad, type Vad } from "./vad.js";

/** Streams without frames for this long are closed. */
const STALE_STREAM_MS = 30_000;
const SWEEP_MS = 5_000;
/** How often open utterances are looked at for silence (turn mode). */
const FILL_TICK_MS = 20;
/** A gap this long is silence, not packet jitter. */
const FILL_AFTER_MS = 100;
/** What Smart Turn is trained on. */
const TURN_SAMPLE_RATE = 16_000;

/** A question to the model whose outcome is not known yet. */
interface Asked {
  id: number;
  samples: Int16Array;
  /** The model's answer, once it came. */
  probability: number | null;
}

/** The transcript of a pause, in case it turns out to be the end. */
interface Early {
  id: number;
  transcript: Promise<[string, Transcript]>;
  cancel(): void;
}

interface Stream {
  info: StreamInfo;
  /** `null` when the speaker is not listened to (no consent, self). */
  segmenter: Segmenter<Vad> | null;
  vad: Vad | null;
  lastFrame: number;
  /** Clock time the audio pushed so far reaches (turn mode). */
  filled: number;
  /** Their voice activity is on (barge-in was told they talk). */
  talking: boolean;
  /** The segmenter asks a model about this stream. */
  turn: boolean;
  /** The gate holds their turn. */
  holding: boolean;
  asked: Asked | null;
  early: Early | null;
  /** The model called the last turn over at this clock time, with this probability. */
  ended: { at: number; probability: number | null } | null;
}

/** Everything the listening loop and its ASR tasks need. */
export interface ListenerDeps {
  ctx: ModuleContext;
  link: VoiceLink;
  speech: SpeechService;
  consent: Consent;
  config: VoiceConfig;
  barge: BargeIn;
  asrSlots: Semaphore;
  /** Remembers her own lines, to tell her voice coming back from somebody talking. */
  echo: SelfEchoGuard;
  /** Words that call her (config `names` plus the profile's), lower-case not required. */
  names: readonly string[];
  /** Starts the end-to-end latency measurement of each accepted utterance. */
  e2e: E2eLatency;
  /** Judges the end of a turn; `null` with `turn_engine = "silence"`. */
  turn: TurnJudge | null;
  /** Her speech waits here for a turn to be confirmed; `null` with `turn_engine = "silence"`. */
  gate: TurnGate | null;
  /** Keeps clips of what was said; `null` unless `clip_dir` is set. */
  clips: ClipRecorder | null;
}

export class Listener {
  readonly #d: ListenerDeps;
  readonly #streams = new Map<number, Stream>();
  /** Streams that closed while their speaker's turn was still open, by speaker. */
  readonly #parked = new Map<string, Stream>();
  readonly #aliases: AsrAliases;

  constructor(deps: ListenerDeps) {
    this.#d = deps;
    this.#aliases = compileAliases(deps.config.asr_aliases, deps.config.to_traditional);
  }

  /** Consumes `audio` until it ends or `signal` aborts. */
  async run(audio: AsyncIterable<AudioEvent>, signal: AbortSignal): Promise<void> {
    const sweep = this.#sweep(signal);
    const fill = this.#d.turn === null ? Promise.resolve() : this.#fillLoop(signal);
    try {
      for await (const event of audio) {
        if (signal.aborted) break;
        switch (event.type) {
          case "stream_open": {
            const stream = await this.#open(event.info);
            const old = this.#streams.get(event.info.stream);
            this.#streams.set(event.info.stream, stream);
            if (old) this.#close(old);
            break;
          }
          case "frame": {
            const s = this.#streams.get(event.stream);
            if (s) this.#frame(s, event.samples);
            break;
          }
          case "stream_close": {
            const s = this.#streams.get(event.stream);
            this.#streams.delete(event.stream);
            if (s) this.#close(s);
            break;
          }
        }
      }
    } finally {
      await sweep;
      await fill;
      for (const s of [...this.#streams.values(), ...this.#parked.values()]) this.#dispose(s);
      this.#parked.clear();
    }
  }

  /** Silence on the clock becomes silence in the audio. */
  async #fillLoop(signal: AbortSignal): Promise<void> {
    for await (const _ of interval(FILL_TICK_MS, signal)) {
      const now = this.#d.ctx.clock.now();
      for (const s of [...this.#streams.values(), ...this.#parked.values()]) {
        if (!s.turn || s.segmenter === null || !s.segmenter.isActive()) continue;
        const gap = now - s.filled;
        if (gap < FILL_AFTER_MS) continue;
        s.filled = now;
        this.#advance(s, new Int16Array(Math.floor((gap * s.info.sampleRate) / 1000)));
      }
      for (const [key, s] of this.#parked) {
        if (s.segmenter?.isActive() !== true) {
          this.#parked.delete(key);
          this.#dispose(s);
        }
      }
    }
  }

  async #sweep(signal: AbortSignal): Promise<void> {
    for await (const _ of interval(SWEEP_MS, signal)) {
      const now = this.#d.ctx.clock.now();
      for (const [id, s] of this.#streams) {
        if (now - s.lastFrame > STALE_STREAM_MS) {
          this.#d.ctx.log.debug({ stream: id }, "closing stale audio stream");
          this.#streams.delete(id);
          this.#close(s);
        }
      }
    }
  }

  async #open(info: StreamInfo): Promise<Stream> {
    const { link, consent, config, ctx } = this.#d;
    const parked = this.#parked.get(accountRefString(info.speaker));
    if (parked !== undefined && contextKeyEquals(parked.info.context, info.context)) {
      // They came back before the turn ended: the utterance goes on.
      this.#parked.delete(accountRefString(info.speaker));
      const now = ctx.clock.now();
      parked.info = info;
      parked.lastFrame = now;
      return parked;
    }
    let listen: boolean;
    if (link.isSelf(info.speaker)) {
      listen = false;
    } else if (!(await consent.allowed(info.speaker))) {
      ctx.log.debug({ speaker: info.speaker.id }, "no voice consent, dropping stream");
      listen = false;
    } else if (info.sampleRate < 8_000) {
      ctx.log.warn({ sample_rate: info.sampleRate }, "unsupported capture sample rate");
      listen = false;
    } else {
      listen = true;
    }
    const vad = listen
      ? createVad(
          {
            engine: config.vad_engine,
            sampleRate: info.sampleRate,
            sileroModel: config.vad_silero_model,
            sileroThreshold: config.vad_silero_threshold,
            url: config.turn_url,
          },
          (engine) =>
            ctx.log.warn({ engine }, "VAD engine is not available: using the energy detector"),
        )
      : null;
    const turn = this.#d.turn !== null && info.sampleRate === TURN_SAMPLE_RATE;
    const segmenter =
      vad === null
        ? null
        : new Segmenter(vad, {
            ...segmenterConfig(config),
            sampleRate: info.sampleRate,
            ...(turn ? {} : { turn: null }),
          });
    const now = ctx.clock.now();
    return {
      info,
      segmenter,
      vad,
      lastFrame: now,
      filled: now,
      talking: false,
      turn,
      holding: false,
      asked: null,
      early: null,
      ended: null,
    };
  }

  /** A song holds the channel (only an utterance that calls her counts then). */
  #music(guild: string): boolean {
    if (!this.#d.config.music_gate) return false;
    return (this.#d.ctx.services.get(VoiceFloorKey)?.holder(guild) ?? null) !== null;
  }

  /** How `speaker` relates to the turn in flight in `context`. */
  #who(info: StreamInfo, guild: string): BargeWho {
    const turn = this.#d.ctx.services.get(TurnFocusViewKey)?.current(info.context) ?? null;
    let role: SpeakerRole = "unknown";
    if (turn !== null) {
      role = turn.addressed_accounts.some((a) => sameAccount(a, info.speaker)) ? "focus" : "other";
    }
    return {
      speaker: info.speaker,
      role,
      context: info.context,
      turn: turn === null ? null : { id: turn.turn, phase: turn.phase },
      music: this.#music(guild),
    };
  }

  /** The transcript calls her. */
  #named(text: string): boolean {
    const heard = matchCore(text);
    return this.#d.names.some((n) => {
      const name = matchCore(n);
      return name !== "" && heard.includes(name);
    });
  }

  #frame(stream: Stream, samples: Int16Array): void {
    const now = this.#d.ctx.clock.now();
    stream.lastFrame = now;
    stream.filled = now;
    this.#advance(stream, samples);
  }

  /** `samples` of audio (or of silence put in for a gap) went by on `stream`. */
  #advance(stream: Stream, samples: Int16Array): void {
    const seg = stream.segmenter;
    if (!seg) return; // Not listened to: the audio is discarded right here.
    const utterances = seg.push(samples);
    const guild = stream.info.context.scope;
    if (guild !== null) {
      const run = seg.speechRunMs();
      if (run > 0) {
        stream.talking = true;
        this.#d.barge.observe(guild, run, this.#who(stream.info, guild));
      } else if (stream.talking) {
        stream.talking = false;
        this.#d.barge.speechEnded(guild, stream.info.speaker);
      }
    }
    for (const u of utterances) this.#finished(stream, u);
    if (stream.turn) this.#followTurn(stream, seg);
  }

  /** What the segmenter's turn state means for the model, the gate and the clips. */
  #followTurn(stream: Stream, seg: Segmenter<Vad>): void {
    const candidate = seg.takeCandidate();
    if (candidate !== null) this.#askTurn(stream, seg, candidate);
    if (stream.asked !== null && seg.askedId() !== stream.asked.id) {
      // They went on: the moment the model was asked about was not the end.
      this.#d.clips?.save("resumed", stream.asked.samples, stream.info.sampleRate);
      stream.asked = null;
      stream.early?.cancel();
      stream.early = null;
    }
    const ended = stream.ended;
    if (ended !== null && seg.isActive()) {
      stream.ended = null;
      const now = this.#d.ctx.clock.now();
      if (now - ended.at <= this.#d.config.turn_confirm_ms) {
        this.#publishTurn(stream, { stage: "turn_resumed", after_ms: now - ended.at, ...ended });
      }
    }
    this.#holdTurn(stream, seg.isActive());
  }

  /** The gate follows the speaker: held while the turn is open, settling once it closed. */
  #holdTurn(stream: Stream, open: boolean): void {
    const { gate, config } = this.#d;
    const guild = stream.info.context.scope;
    if (gate === null || guild === null || open === stream.holding) return;
    stream.holding = open;
    if (open) gate.hold(guild, stream.info.speaker);
    else gate.settle(guild, stream.info.speaker, config.turn_confirm_ms);
  }

  #publishTurn(stream: Stream, fields: Record<string, JsonValue>): void {
    this.#d.ctx.publish(
      customEvent(LATENCY_TOPIC, { context: { ...stream.info.context }, ...fields }),
    );
  }

  /** Asks the model about the pause, off the audio path. */
  #askTurn(stream: Stream, seg: Segmenter<Vad>, candidate: TurnCandidate): void {
    const { ctx, turn } = this.#d;
    if (turn === null) return;
    stream.asked = { id: candidate.id, samples: candidate.samples, probability: null };
    const t0 = ctx.clock.now();
    void turn
      .ask(candidate.samples, stream.info.sampleRate, ctx.signal)
      .then((answer) => this.#answered(stream, seg, candidate.id, answer, t0));
  }

  #answered(
    stream: Stream,
    seg: Segmenter<Vad>,
    id: number,
    answer: TurnAnswer | null,
    askedAt: number,
  ): void {
    if (this.#d.ctx.signal.aborted) return;
    if (stream.asked?.id === id) stream.asked.probability = answer?.probability ?? null;
    const verdict: TurnVerdict =
      answer === null ? "unknown" : answer.complete ? "complete" : "incomplete";
    this.#publishTurn(stream, {
      stage: "turn",
      verdict,
      probability: answer?.probability ?? null,
      judge_ms: Math.max(0, this.#d.ctx.clock.now() - askedAt),
    });
    const u = seg.resolve(id, verdict);
    if (u !== null) this.#finished(stream, u);
    else if (verdict === "incomplete" && seg.askedId() === id)
      this.#transcribeAhead(stream, seg, id);
    this.#followTurn(stream, seg);
  }

  /** The model says they are not done. Should that be wrong, the transcript will be ready. */
  #transcribeAhead(stream: Stream, seg: Segmenter<Vad>, id: number): void {
    const { ctx, config, speech, asrSlots } = this.#d;
    if (!config.turn_early_asr || ctx.services.get(SpeechPauseKey)?.paused()) return;
    const controller = new AbortController();
    const audio = { sampleRate: stream.info.sampleRate, samples: seg.peek() };
    const hint = this.#hint(stream.info.context.scope ?? "");
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    const transcript = (async () => {
      const release = await asrSlots.acquire(signal);
      try {
        return await speech.transcribe(audio, hint, signal);
      } finally {
        release();
      }
    })();
    // Whoever takes it handles the failure; nobody may take it.
    transcript.catch(() => undefined);
    stream.early = { id, transcript, cancel: () => controller.abort() };
  }

  /** An utterance is over, one way or the other. */
  #finished(stream: Stream, u: Utterance): void {
    const asked = stream.asked;
    stream.asked = null;
    const early = stream.early;
    stream.early = null;
    const usable = early !== null && early.id === u.candidate ? early : null;
    if (usable === null) early?.cancel();
    if (asked !== null) this.#d.clips?.save("ended", asked.samples, stream.info.sampleRate);
    const probability = asked?.probability ?? null;
    if (stream.turn && u.endedBy === "turn") {
      stream.ended = { at: this.#d.ctx.clock.now(), probability };
    }
    const end = stream.turn ? { ended_by: u.endedBy, probability } : undefined;
    this.#transcribe(stream.info, u, this.#d.ctx.clock.now(), end, usable?.transcript ?? null);
  }

  #close(stream: Stream): void {
    const guild = stream.info.context.scope;
    if (guild !== null && stream.talking) {
      stream.talking = false;
      this.#d.barge.speechEnded(guild, stream.info.speaker);
    }
    if (stream.turn && stream.segmenter?.isActive() === true) {
      // The stream is over, their turn is not: the silence goes on being counted.
      this.#parked.set(accountRefString(stream.info.speaker), stream);
      return;
    }
    const u = stream.segmenter?.finish() ?? null;
    // Frames stopped a while before the stream closed: that is when they stopped talking.
    if (u) this.#transcribe(stream.info, u, stream.lastFrame);
    this.#dispose(stream);
  }

  #dispose(stream: Stream): void {
    if (stream.holding) this.#holdTurn(stream, false);
    stream.early?.cancel();
    stream.vad?.close?.();
  }

  /**
   * Runs ASR in the background (bounded by `asr_concurrency`). `detected`: when the speaker was
   * last known to be there, what the utterance's trailing silence counts back from.
   */
  #transcribe(
    info: StreamInfo,
    utterance: Utterance,
    detected: number,
    turn?: TurnEnd,
    early: Promise<[string, Transcript]> | null = null,
  ): void {
    // The ASR worker gave its model to the song worker: drop what was said, do not queue it up.
    const paused = this.#d.ctx.services.get(SpeechPauseKey)?.paused() ?? null;
    if (paused !== null && !this.#d.config.asr_while_paused) {
      this.#d.ctx.log.debug(
        { speaker: info.speaker.id, speech_ms: utterance.speechMs, reason: paused },
        "speech is paused; dropping an utterance",
      );
      this.#letGo(info.context.scope, info.speaker, "timeout");
      return;
    }
    const guild = info.context.scope;
    if (guild !== null) this.#d.barge.utterance(guild, info.speaker);
    const endedAt = detected - utterance.trailingSilenceMs;
    const startedAt = endedAt - utterance.speechMs;
    this.#d.ctx.spawn("asr", async (signal) => {
      try {
        await this.#asr(info, utterance, startedAt, endedAt, signal, turn, early);
      } catch (error) {
        if (!signal.aborted) {
          this.#d.ctx.log.warn({ err: errorMessage(error) }, "ASR task failed");
        }
      }
    });
  }

  /** The speaker's utterance came to nothing: barge-in need not wait for it. */
  #letGo(guild: string | null, speaker: AccountRef, reason: "echo" | "music" | "timeout"): void {
    if (guild !== null) this.#d.barge.dropped(guild, speaker, reason);
  }

  #hint(guild: string): AsrHint {
    const { config, link } = this.#d;
    let prompt =
      config.asr_prompt !== null && config.asr_prompt.trim() !== "" ? config.asr_prompt : null;
    if (config.asr_prompt_participants) {
      const names = link
        .participants(guild)
        .map((p) => p.display_name)
        .filter((n) => n !== "");
      if (names.length > 0) {
        const joined = names.join("、");
        prompt = prompt === null ? joined : `${prompt} ${joined}`;
      }
    }
    return { language: config.asr_language, prompt };
  }

  async #asr(
    info: StreamInfo,
    utterance: Utterance,
    startedAt: number,
    endedAt: number,
    signal: AbortSignal,
    turn: TurnEnd | undefined,
    early: Promise<[string, Transcript]> | null,
  ): Promise<void> {
    const { ctx, speech, config, link, asrSlots, barge, echo, e2e, clips } = this.#d;
    // A transcript made ahead has its own slot: waiting for it here must not hold another.
    const release = early === null ? await asrSlots.acquire(signal) : () => undefined;
    const guild = info.context.scope ?? "";
    // Barge-in waits for this transcript; whatever happens, it must not wait forever.
    let settled = false;
    const letGo = (reason: "echo" | "music" | "timeout") => {
      settled = true;
      this.#letGo(info.context.scope, info.speaker, reason);
    };
    try {
      const hint = this.#hint(guild);
      const audio = { sampleRate: info.sampleRate, samples: utterance.samples };
      const audioMs = durationMs(audio);
      const t0 = ctx.clock.now();
      let provider: string;
      let transcript: Awaited<ReturnType<SpeechService["transcribe"]>>[1];
      try {
        // A transcript made ahead failed: this is the attempt the utterance would have had anyway.
        const ahead = early?.catch(() => speech.transcribe(audio, hint, signal));
        [provider, transcript] = await (ahead ?? speech.transcribe(audio, hint, signal));
      } catch (error) {
        if (signal.aborted) return;
        const err = errorMessage(error);
        if (isOffloaded(err)) ctx.log.debug({ err, speaker: info.speaker.id }, "ASR is offloaded");
        else ctx.log.warn({ err, speaker: info.speaker.id }, "ASR failed");
        return;
      }
      const now = ctx.clock.now();
      const transcribeMs = Math.max(0, now - t0);
      const asrMs = Math.max(0, now - endedAt);
      const cleaned = cleanTranscript(
        transcript.text,
        config.to_traditional,
        config.hallucinations,
      );
      const text = cleaned === null ? null : applyAliases(cleaned, this.#aliases);
      if (text === null) {
        ctx.log.debug({ raw: transcript.text }, "dropped empty or hallucinated transcript");
        letGo("echo");
        return;
      }
      if (echoesHint(text, hint.prompt) || looksLikeHintEcho(text, hint.prompt)) {
        ctx.log.debug(
          { raw: transcript.text },
          "dropped a transcript that only repeats the ASR hint",
        );
        letGo("echo");
        return;
      }
      if (echo.isEcho(guild, text)) {
        ctx.log.debug({ raw: transcript.text }, "dropped a transcript of her own voice");
        letGo("echo");
        return;
      }
      const named = this.#named(text);
      const who = this.#who(info, guild);
      if (who.music === true && !named) {
        ctx.log.debug({ raw: transcript.text }, "dropped a transcript while a song plays");
        letGo("music");
        return;
      }
      // Stops her (or lets her go on) before the utterance travels on to the agent.
      settled = true;
      barge.verdict(guild, { ...who, text, named, echo: false });
      const id = newId();
      // The person stopped talking at `endedAt`; a length-capped utterance never did.
      e2e.heard({
        context: info.context,
        utterance: id,
        speechEndAt: utterance.endedBy === "length" ? null : endedAt,
        sentAt: t0,
        transcriptAt: now,
        ...(turn ? { turn } : {}),
      });
      clips?.save("utterance", utterance.samples, info.sampleRate, text);
      const displayName =
        link.participants(guild).find((p) => sameAccount(p.account, info.speaker))?.display_name ||
        info.displayName;
      ctx.log.info({ speaker: displayName, text, asr_ms: asrMs }, "voice utterance");
      ctx.publish({
        type: "voice_utterance",
        data: {
          id,
          context: info.context,
          speaker: { account: info.speaker, display_name: displayName, is_bot: false },
          text,
          language: transcript.language,
          emotion: transcript.emotion,
          audio_events: transcript.audio_events,
          started_at: toTimestamp(startedAt),
          ended_at: toTimestamp(endedAt),
          asr_ms: asrMs,
          ...(turn ? { turn } : {}),
        },
      });
      ctx.publish({
        type: "custom",
        data: {
          topic: LATENCY_TOPIC,
          payload: {
            stage: "asr",
            context: { ...info.context },
            speaker: { ...info.speaker },
            provider,
            audio_ms: audioMs,
            transcribe_ms: transcribeMs,
            asr_ms: asrMs,
          },
        },
      });
    } finally {
      if (!settled) letGo("timeout");
      release();
    }
  }
}
