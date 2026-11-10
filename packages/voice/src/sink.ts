// Speaking: `VoiceSink` → TTS → voice node playback.

import { errorMessage, type ModuleContext, sleep } from "@miyoria/kernel";
import {
  type AudioChunk,
  isOffloaded,
  SpeechError,
  type SpeechService,
  type TtsPriority,
} from "@miyoria/speech";
import {
  ActuatorExecutorKey,
  AffectStateKey,
  type ContextKey,
  contextKeyString,
  customEvent,
  type EventData,
  type MessageRef,
  ModerationKey,
  type OutputPath,
  type PlaybackState,
  SPEECH_SYNTH_TOPIC,
  type SpeakOutcome,
  SpeechPauseKey,
  TurnFocusViewKey,
  type TurnId,
  VOICE_BARGE_IN_TOPIC,
  VOICE_UPCOMING_TOPIC,
  VoiceFloorKey,
  type VoiceSink,
} from "@miyoria/types";
import type { BargeIn } from "./barge.js";
import type { VoiceConfig, VoiceProfile } from "./config.js";
import type { E2eLatency, E2eMeasure } from "./e2e.js";
import type { SelfEchoGuard } from "./echo.js";
import { VoiceLinkError } from "./link/conn.js";
import type { VoiceLink } from "./link/link.js";
import type { Playback } from "./link/playback.js";
import { BufferedAudio, type LinePrefetch, type PreparedLine, type Producer } from "./prefetch.js";
import { stripTags } from "./text.js";
import { LATENCY_TOPIC } from "./topics.js";
import type { SpeechTranslator } from "./translate.js";
import type { TurnGate } from "./turn.js";
import { aborted, deferred } from "./util.js";

export interface SpeakerDeps {
  ctx: ModuleContext;
  link: VoiceLink;
  speech: SpeechService;
  profile: VoiceProfile;
  config: VoiceConfig;
  barge: BargeIn;
  /** Set when she speaks in another language than she writes (`tts_translate`). */
  translator: SpeechTranslator | null;
  /** The LLM session of a conversation, which its translations share. */
  session(context: ContextKey): string;
  /** Remembers what she says, so her own voice coming back is not taken for somebody. */
  echo: SelfEchoGuard;
  /** Lines synthesized ahead of their turn; `null` when `tts_prefetch` is 0. */
  prefetch: LinePrefetch | null;
  /** End-to-end latency of replies to human speech (`speech_end → first audio played`). */
  e2e: E2eLatency;
  /** Lines wait here until the people they answer are done; `null` without a turn model. */
  gate: TurnGate | null;
}

/** While a song or the GPU loan holds the floor, how often it is looked at again. */
const FLOOR_POLL_MS = 250;

/** What the output review made of a text on its way to TTS. */
interface Reviewed {
  text: string;
  /** The rule that replaced it. */
  blocked: string | null;
}

/** A line prepared ahead (`prepare`), waiting to be announced before the one playing ends. */
interface PendingLine {
  context: ContextKey;
  text: string;
  emotion: string | null;
  at: number;
}

/** Lines remembered per guild for the subtitle lead (more are dropped, oldest first). */
const PENDING_MAX = 8;
/** How often a playing line's length is looked at again while its audio is still arriving. */
const LENGTH_POLL_MS = 100;
/** The TTS wait (speak → first audio) assumed until one is measured, ms. */
const FIRST_AUDIO_PRIOR_MS = 700;

/** What a playback event says beyond its state. */
type PlaybackFacts = Pick<EventData<"voice_playback">, "heard_ms" | "total_ms" | "blocked">;

/** The `VoiceSink` provided by the `voice` module. */
export class Speaker implements VoiceSink {
  readonly #d: SpeakerDeps;
  readonly speaksIn: string | null;
  /** The emotion of the last line spoken per guild: the likely one of the next line. */
  readonly #lastEmotion = new Map<string, string | null>();
  /** Lines playing per guild: while one does, a line synthesized now is one for later. */
  readonly #playing = new Map<string, number>();
  /** Every playback of hers going on, for the emergency stop. */
  readonly #live = new Set<Playback>();
  /** Lines announced as upcoming per guild (their text) and not started yet. */
  readonly #announced = new Map<string, Set<string>>();
  /** Lines prepared ahead per guild, in order. */
  readonly #pending = new Map<string, PendingLine[]>();
  /** speak → first audio, learned (ms): when the first line of a reply plays. */
  #firstAudioMs = FIRST_AUDIO_PRIOR_MS;
  /** The line playing per guild: its turn, and when it ends once its length is known. */
  readonly #current = new Map<
    string,
    { playback: Playback; turn: TurnId | null; endsAt: number | null }
  >();

  constructor(deps: SpeakerDeps) {
    this.#d = deps;
    this.speaksIn = deps.translator?.language ?? null;
  }

  #playbackEvent(
    context: ContextKey,
    turn: TurnId | null,
    state: PlaybackState,
    text: string,
    emotion: string | null,
    facts: PlaybackFacts = {},
  ) {
    this.#d.ctx.publish(
      { type: "voice_playback", data: { context, turn, state, text, emotion, ...facts } },
      { turn },
    );
  }

  /** The line's subtitle goes up now (`VOICE_UPCOMING_TOPIC`), once per line. */
  #announce(context: ContextKey, turn: TurnId | null, text: string, emotion: string | null): void {
    const guild = context.scope;
    if (guild === null || this.#d.config.subtitle_lead_ms <= 0 || text === "") return;
    const seen = this.#announced.get(guild) ?? new Set<string>();
    if (seen.has(text)) return;
    seen.add(text);
    this.#announced.set(guild, seen);
    this.#d.ctx.publish(
      customEvent(VOICE_UPCOMING_TOPIC, { context: { ...context }, turn, text, emotion }),
      { turn },
    );
  }

  /** `text` is being said now: it is neither pending nor waiting for its start any more. */
  #settle(guild: string, text: string): void {
    this.#announced.get(guild)?.delete(text);
    const pending = this.#pending.get(guild);
    const i = pending?.findIndex((p) => p.text === text) ?? -1;
    if (pending && i >= 0) pending.splice(i, 1);
  }

  /**
   * While `playback` plays, the next prepared line is announced `subtitle_lead_ms` before it
   * ends. Its length is known once all of its audio is there.
   */
  #leadNext(
    guild: string,
    turn: TurnId | null,
    playback: Playback,
    line: PreparedLine,
    startedAt: number,
  ): void {
    const lead = this.#d.config.subtitle_lead_ms;
    if (lead <= 0) return;
    const { clock } = this.#d.ctx;
    this.#current.set(guild, { playback, turn, endsAt: null });
    const fire = () => {
      if (!this.#live.has(playback)) return;
      const now = clock.now();
      const next = (this.#pending.get(guild) ?? []).find(
        (p) =>
          now - p.at <= this.#d.config.tts_prefetch_ttl_ms &&
          !this.#announced.get(guild)?.has(p.text),
      );
      if (next) this.#announce(next.context, turn, next.text, next.emotion);
    };
    const check = () => {
      if (!this.#live.has(playback)) return;
      const total = line.audio.totalMs;
      if (total === null) {
        setTimeout(check, LENGTH_POLL_MS).unref?.();
        return;
      }
      const cur = this.#current.get(guild);
      if (cur?.playback === playback) cur.endsAt = startedAt + total;
      const wait = startedAt + total - lead - clock.now();
      if (wait <= 0) fire();
      else setTimeout(fire, wait).unref?.();
    };
    check();
  }

  /** The emergency stop is on. */
  get #muted(): boolean {
    return this.#d.ctx.services.get(ActuatorExecutorKey)?.paused === true;
  }

  /** The output review of text about to be said: this sink is the last stop before a voice. */
  #review(context: ContextKey, turn: TurnId | null, text: string, path: OutputPath): Reviewed {
    const moderation = this.#d.ctx.services.get(ModerationKey);
    const verdict = moderation?.screen({ path, voice: text, context, turn });
    if (verdict === undefined || verdict.ok) return { text, blocked: null };
    return { text: verdict.voice ?? text, blocked: verdict.blocked[0]?.rule ?? null };
  }

  /** Whether `text` is what moderation puts in place of a line (a turn replaced it already). */
  #filtered(text: string): boolean {
    const moderation = this.#d.ctx.services.get(ModerationKey);
    return text === moderation?.filteredLine || text === moderation?.filteredVoiceLine;
  }

  /**
   * Synthesizes `text`: translation, TTS, and a buffer that fills in the background. Resolves
   * once the first audio is there, so the line can start playing while the rest still arrives.
   */
  #producer(
    context: ContextKey,
    text: string,
    emotion: string | null,
    priority: TtsPriority,
    turn: TurnId | null,
  ): Producer {
    return async (signal) => {
      const { speech, profile, config, translator, session } = this.#d;
      const written = this.#review(context, turn, text, "tts");
      // What was blocked is not translated, and a translation can say what its source did not.
      const { text: said, blocked } =
        translator === null || written.blocked !== null
          ? written
          : this.#review(
              context,
              turn,
              await translator.translate(written.text, signal, session(context)),
              "translation",
            );
      // The translation and the LLM could run ahead; the GPU waits for the turn to be confirmed.
      await this.#turnConfirmed(context, signal);
      const request = {
        text: said,
        language: translator?.language ?? config.tts_language,
        emotion: profile.referenceFor(emotion),
        instruct: profile.instructFor(emotion),
        voice: profile.voice,
        priority,
      };
      const requestAt = this.#d.ctx.clock.now();
      const [provider, stream] = await speech.synthesize(request, signal);
      const it = stream[Symbol.asyncIterator]();
      let first: AudioChunk;
      try {
        for (;;) {
          const r = await it.next();
          if (r.done) throw new SpeechError("TTS returned no audio");
          if (r.value.samples.length > 0) {
            first = r.value;
            break;
          }
        }
      } catch (error) {
        Promise.resolve(it.return?.()).catch(() => undefined);
        throw error;
      }
      const timing = {
        requestAt,
        firstAudioAt: this.#d.ctx.clock.now(),
        ...(stream.queueMs === undefined ? {} : { queueMs: stream.queueMs }),
      };
      const stop = deferred<void>();
      const audio = new BufferedAudio(() => stop.resolve());
      signal.addEventListener("abort", () => stop.resolve(), { once: true });
      audio.push(first);
      const done = (async () => {
        try {
          let whole = false;
          for (;;) {
            const r = await Promise.race([it.next(), stop.promise.then(() => null)]);
            if (r === null) break;
            if (r.done) {
              whole = true;
              break;
            }
            audio.push(r.value);
          }
          audio.end(whole);
        } catch (error) {
          audio.fail(error);
        } finally {
          Promise.resolve(it.return?.()).catch(() => undefined);
        }
      })();
      const line = { provider, said, blocked, sampleRate: first.sampleRate, audio, timing };
      return { line, done };
    };
  }

  /** Waits until the people the turn in flight answers are done talking. */
  async #turnConfirmed(context: ContextKey, signal: AbortSignal): Promise<void> {
    const { gate, config, ctx } = this.#d;
    if (gate === null || context.scope === null) return;
    const accounts = ctx.services.get(TurnFocusViewKey)?.current(context)?.addressed_accounts ?? [];
    await gate.wait(context.scope, accounts, config.turn_gate_max_ms, signal);
  }

  #key(context: ContextKey, text: string, emotion: string | null): string {
    return `${contextKeyString(context)}\u0000${emotion ?? ""}\u0000${text}`;
  }

  async #start(
    context: ContextKey,
    guild: string,
    text: string,
    emotion: string | null,
    turn: TurnId | null,
    signal: AbortSignal | undefined,
    measure: E2eMeasure | null,
  ): Promise<{ playback: Playback; line: PreparedLine }> {
    const { ctx, link, prefetch } = this.#d;
    const t0 = ctx.clock.now();
    // The overlay says she is getting her line ready until it plays (or fails).
    ctx.publish(customEvent(SPEECH_SYNTH_TOPIC, { context: { ...context }, turn }), { turn });
    let line: PreparedLine | null = null;
    let prefetched = false;
    const taken = prefetch?.take(this.#key(context, text, emotion)) ?? null;
    if (taken !== null) {
      try {
        line = await raceAbort(taken, signal);
        prefetched = true;
      } catch (error) {
        if (signal?.aborted) throw error;
        ctx.log.debug({ err: errorMessage(error) }, "prefetched line failed, synthesizing again");
      }
    }
    if (line === null) {
      const production = await this.#producer(
        context,
        text,
        emotion,
        "now",
        turn,
      )(signal ?? new AbortController().signal);
      line = production.line;
    }
    measure?.tts(line.timing ?? null, prefetched, line.provider);
    const firstAudioMs = Math.max(0, ctx.clock.now() - t0);
    ctx.publish(
      {
        type: "custom",
        data: {
          topic: LATENCY_TOPIC,
          payload: {
            stage: "tts",
            context: { ...context },
            turn,
            provider: line.provider,
            chars: [...line.said].length,
            first_audio_ms: firstAudioMs,
            prefetched,
          },
        },
      },
      { turn },
    );
    try {
      const playback = await link.play(guild, line.sampleRate, line.audio);
      // The node says when the audio is audible: record it without waiting for it here.
      if (measure !== null) this.#watchPlayback(playback, guild, turn, measure);
      return { playback, line };
    } catch (error) {
      measure?.fail(signal?.aborted ? "cancelled" : "playback_failed");
      void line.audio[Symbol.asyncIterator]().return?.();
      throw error;
    }
  }

  /** What the turn in flight answers, from the agent's focus view (memory only). */
  #focusOf(context: ContextKey, turn: TurnId | null): readonly MessageRef[] {
    const view = this.#d.ctx.services.get(TurnFocusViewKey);
    if (!view) return [];
    if (turn === null) return view.current(context)?.focus ?? [];
    return view.all().find((f) => f.turn === turn)?.focus ?? [];
  }

  /** Ends `measure` with the node's first report on `playback`, whenever it comes. */
  #watchPlayback(
    playback: Playback,
    guild: string,
    turn: TurnId | null,
    measure: E2eMeasure,
  ): void {
    void playback.state$
      .waitFor((s) => s !== null)
      .then((state) => {
        if (state === "started" || state === "finished") measure.played();
        else if (state === "interrupted") {
          measure.fail(this.#d.barge.isStopped(guild, turn) ? "barge_in" : "interrupted");
        } else measure.fail("playback_failed");
      });
  }

  /** A line without an `<emo:…>` of its own is said the way she shows she feels now. */
  #tone(emotion: string | null): string | null {
    return emotion ?? this.#d.ctx.services.get(AffectStateKey)?.snapshot().shown?.tag ?? null;
  }

  /** Whether `emotion` is the one a prepared line should be synthesized with. */
  #prefetchEmotion(guild: string, emotion: string | null | undefined): string | null | undefined {
    if (emotion !== undefined) return this.#tone(emotion);
    // The reply's emotion carries on from line to line until it changes.
    return this.#lastEmotion.get(guild);
  }

  /** Drops every line prefetched for `guild` (somebody stopped her, a song took the floor). */
  cancelPrefetch(guild: string): void {
    this.#d.prefetch?.cancelGroup(guild);
  }

  /** `VoiceSink.silence`: lines that came here without the scheduler stop too. */
  silence(): void {
    for (const playback of this.#live) playback.stop(0);
    this.#d.prefetch?.clear();
  }

  /**
   * `emotion` (optional): the emotion the line will be spoken with, so it can be synthesized
   * ahead; when the caller does not know it, the previous line's is assumed.
   */
  prepare(context: ContextKey, rawText: string, spoken?: string, emotion?: string | null): void {
    const text = stripTags(rawText);
    if (text === "") return;
    // The first text of a reply is here: the clock for `llm_first` stops.
    this.#d.e2e.textReady(this.#focusOf(context, null));
    const said = spoken === undefined ? "" : stripTags(spoken);
    const session = this.#d.session(context);
    if (said !== "") this.#d.translator?.provide(text, said, session);
    else this.#d.translator?.prepare(text, session);
    const lineEmotion = this.#prefetchEmotion(context.scope ?? "", emotion);
    this.#remember(context, text, lineEmotion ?? null);
    this.#prefetch(context, text, lineEmotion);
  }

  /** A prepared line, for the subtitle lead of the line before it. */
  #remember(context: ContextKey, text: string, emotion: string | null): void {
    const guild = context.scope;
    if (guild === null || this.#d.config.subtitle_lead_ms <= 0) return;
    const pending = this.#pending.get(guild) ?? [];
    if (pending.some((p) => p.text === text)) return;
    const now = this.#d.ctx.clock.now();
    pending.push({ context, text, emotion, at: now });
    while (pending.length > PENDING_MAX) pending.shift();
    this.#pending.set(guild, pending);
    // Prepared in the lead of the line playing: the next one, announced now.
    const cur = this.#current.get(guild);
    const next = pending[0];
    const lead = this.#d.config.subtitle_lead_ms;
    if (
      cur &&
      this.#live.has(cur.playback) &&
      cur.endsAt !== null &&
      cur.endsAt - now <= lead &&
      next
    ) {
      this.#announce(next.context, cur.turn, next.text, next.emotion);
    }
  }

  #prefetch(context: ContextKey, text: string, emotion: string | null | undefined): void {
    const { prefetch, speech, link, ctx } = this.#d;
    const guild = context.scope;
    if (prefetch === null || guild === null || emotion === undefined) return;
    if (this.#muted || !speech.hasTts() || !link.isConnected()) return;
    if (this.#held(guild) !== null) return;
    const key = this.#key(context, text, emotion);
    if (prefetch.has(key)) return;
    // The first line of a reply is the one she is waiting for; the others have time.
    const ahead = prefetch.size > 0 || (this.#playing.get(guild) ?? 0) > 0;
    prefetch.start(key, guild, async (signal) => {
      try {
        return await this.#producer(context, text, emotion, ahead ? "ahead" : "now", null)(signal);
      } catch (error) {
        if (!signal.aborted) ctx.log.debug({ err: errorMessage(error) }, "TTS prefetch failed");
        throw error;
      }
    });
  }

  /** Why her speech cannot play now: a song holds the channel, or the GPU is lent out. */
  #held(guild: string): string | null {
    const { services } = this.#d.ctx;
    // A song holds the channel: the line would wait behind it in the node and come out late.
    const holder = services.get(VoiceFloorKey)?.holder(guild) ?? null;
    if (holder !== null) return holder;
    // The GPU is the song worker's for now: the TTS worker has no model to speak with.
    return services.get(SpeechPauseKey)?.paused() ?? null;
  }

  /**
   * Waits while the floor is held. Her lines queue up behind it (the scheduler runs them one
   * after the other) and are spoken when it is free, unless the wait gets longer than
   * `speech_hold_max_ms`: then the line is stale and dropped. Returns whether she may speak.
   */
  async #waitForFloor(
    context: ContextKey,
    guild: string,
    turn: TurnId | null,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const { ctx, config, barge } = this.#d;
    let held = this.#held(guild);
    if (held === null) return true;
    const since = ctx.clock.now();
    ctx.log.debug({ guild, holder: held }, "voice floor is held; her line waits");
    while (held !== null) {
      if (ctx.clock.now() - since >= config.speech_hold_max_ms) {
        ctx.log.debug({ guild, holder: held }, "voice floor held too long; dropping her line");
        ctx.publish(
          customEvent(VOICE_BARGE_IN_TOPIC, {
            context: { ...context },
            turn,
            account: null,
            action: "stop",
            reason: "floor",
          }),
          { turn },
        );
        return false;
      }
      await sleep(FLOOR_POLL_MS, signal);
      if (barge.isStopped(guild, turn)) return false;
      held = this.#held(guild);
    }
    return true;
  }

  async speak(
    context: ContextKey,
    rawText: string,
    emotion: string | null,
    turn: TurnId | null,
    signal?: AbortSignal,
  ): Promise<SpeakOutcome> {
    const guild = context.scope;
    if (guild === null) {
      throw new VoiceLinkError(`voice context \`${contextKeyString(context)}\` has no guild`);
    }
    const stripped = stripTags(rawText);
    if (stripped === "") return "completed";
    if (this.#muted) return "interrupted";
    // Subtitles and her history follow what is said here: a blocked line is gone from them too.
    const { text, blocked } = this.#review(context, turn, stripped, "tts");
    // Only the first line of a reply that answers somebody's speech is measured.
    const measure = this.#d.e2e.begin(context, turn, this.#focusOf(context, turn));
    try {
      return await this.#speak(
        context,
        guild,
        text,
        blocked,
        this.#tone(emotion),
        turn,
        signal,
        measure,
      );
    } finally {
      // Whatever ended the call early (an error, a cancel) ends the measurement too.
      measure?.fail("cancelled");
    }
  }

  async #speak(
    context: ContextKey,
    guild: string,
    text: string,
    screened: string | null,
    emotion: string | null,
    turn: TurnId | null,
    signal: AbortSignal | undefined,
    measure: E2eMeasure | null,
  ): Promise<SpeakOutcome> {
    const { barge, echo } = this.#d;
    // Somebody stopped this turn's speech: the rest of its lines are not said.
    if (barge.isStopped(guild, turn)) {
      measure?.fail("barge_in");
      return "interrupted";
    }
    if (!(await this.#waitForFloor(context, guild, turn, signal))) {
      measure?.fail(barge.isStopped(guild, turn) ? "barge_in" : "floor");
      return "interrupted";
    }
    this.#lastEmotion.set(guild, emotion);
    // The first line of a reply (nothing of hers playing): its subtitle goes up the lead before
    // the TTS wait is expected to end. Later lines were announced by the line before them.
    const lead = this.#d.config.subtitle_lead_ms;
    const speakAt = this.#d.ctx.clock.now();
    let early: ReturnType<typeof setTimeout> | null = null;
    if (lead > 0 && (this.#playing.get(guild) ?? 0) === 0) {
      const wait = Math.max(0, this.#firstAudioMs - lead);
      if (wait === 0) this.#announce(context, turn, text, emotion);
      else early = setTimeout(() => this.#announce(context, turn, text, emotion), wait);
    }
    let playback: Playback;
    let line: PreparedLine;
    try {
      ({ playback, line } = await this.#start(
        context,
        guild,
        text,
        emotion,
        turn,
        signal,
        measure,
      ));
    } catch (error) {
      measure?.fail(signal?.aborted ? "cancelled" : "tts_failed");
      const err = errorMessage(error);
      if (isOffloaded(err)) this.#d.ctx.log.debug({ err }, "cannot start speech: TTS is offloaded");
      else this.#d.ctx.log.warn({ err }, "cannot start speech");
      this.#playbackEvent(context, turn, "failed", text, emotion);
      throw error;
    } finally {
      if (early !== null) clearTimeout(early);
    }
    const startedAt = this.#d.ctx.clock.now();
    this.#firstAudioMs = Math.round(this.#firstAudioMs * 0.7 + (startedAt - speakAt) * 0.3);
    this.#settle(guild, text);
    const blocked = screened ?? line.blocked ?? (this.#filtered(text) ? text : null);
    const facts = blocked === null ? {} : { blocked };
    this.#playbackEvent(context, turn, "started", text, emotion, facts);
    echo.started(guild, [text, line.said]);
    this.#playing.set(guild, (this.#playing.get(guild) ?? 0) + 1);
    this.#live.add(playback);
    this.#leadNext(guild, turn, playback, line, startedAt);
    const token = barge.register(guild, playback, { context, turn });
    let state: PlaybackState;
    try {
      // The stop may have come while the line was still being synthesized.
      if (this.#muted) playback.stop(0);
      // Cancelling `speak` (the Floor cutting the line short, the scheduler timing it out, the
      // emergency stop) stops the playback. The line ends like any line cut off: with what of it
      // was heard, for her history and the ledger.
      const cancelled = signal ? aborted(signal).then(() => null) : new Promise<null>(() => {});
      state = (await Promise.race([playback.wait(), cancelled])) ?? "interrupted";
    } finally {
      barge.unregister(guild, token);
      echo.ended(guild);
      this.#playing.set(guild, Math.max(0, (this.#playing.get(guild) ?? 0) - 1));
      this.#live.delete(playback);
      if (this.#current.get(guild)?.playback === playback) this.#current.delete(guild);
      playback.stop(0);
    }
    this.#playbackEvent(context, turn, state, text, emotion, {
      ...facts,
      heard_ms: playback.heardMs(),
      total_ms: line.audio.totalMs,
    });
    // A no-op when the node reported the audio first.
    if (state === "interrupted") {
      measure?.fail(barge.isStopped(guild, turn) ? "barge_in" : "interrupted");
    } else if (state === "failed") measure?.fail("playback_failed");
    switch (state) {
      case "finished":
        return "completed";
      case "interrupted":
        return "interrupted";
      default:
        throw new VoiceLinkError("playback failed");
    }
  }
}

/** `promise`, or the rejection with `signal.reason` once `signal` aborts first. */
async function raceAbort(
  promise: Promise<PreparedLine>,
  signal: AbortSignal | undefined,
): Promise<PreparedLine> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.then(abandon, () => undefined);
    throw signal.reason;
  }
  const cancelled = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } catch (error) {
    if (signal.aborted) promise.then(abandon, () => undefined);
    throw error;
  }
}

/** Lets go of a line nobody plays (stops synthesizing it). */
function abandon(line: PreparedLine): void {
  void line.audio[Symbol.asyncIterator]().return?.();
}
