// The avatar loop: emotion accents and poses, gestures, blinking, lip sync and procedural
// motion, composed into one `InjectParameterDataRequest` per tick.
//
// Cues from Core (emotion, speaking) are applied `latency_ms` late, like the lip-sync levels,
// so the face changes when viewers hear the sentence rather than when the player takes it.

import { errorMessage, getLogger, SerialQueue } from "@miyoria/kernel";
import type { Clock } from "@miyoria/types";
import type { AvatarProfile } from "./avatar.js";
import { type BlinkConfig, BlinkScheduler } from "./blink.js";
import { EmotionController, type VtsCommand } from "./emotion.js";
import { type GestureConfig, GestureController } from "./gesture.js";
import {
  type LevelSample,
  type Levels,
  type LipSyncConfig,
  type Mouth,
  MouthShaper,
  VOWELS,
} from "./lipsync.js";
import { type GazeConfig, IdleMotion, MOTION_PARAMS, type MotionConfig } from "./motion.js";
import { clampParam, type EmotionConfig, PoseBlender, paramRange } from "./pose.js";
import type { GazeTarget, GiftExpression } from "./protocol.js";
import { Random } from "./random.js";
import { type TouchConfig, type TouchPart, TouchReaction, touchParams } from "./touch.js";
import type { VtsClient, VtsConfig } from "./vts.js";
import type { Watch } from "./watch.js";

const log = getLogger("stage.avatar");

/** VTS inputs for the vowel estimate (the model maps them to `ParamA..ParamO`). */
export const VOWEL_PARAMS = {
  a: "VoiceA",
  i: "VoiceI",
  u: "VoiceU",
  e: "VoiceE",
  o: "VoiceO",
} as const;
export const SILENCE_PARAM = "VoiceSilence";
const EYE_PARAMS = ["EyeOpenLeft", "EyeOpenRight"] as const;

/** The parts of the Stage config the avatar loop uses. */
export interface AvatarLoopConfig {
  vts: VtsConfig;
  lipsync: LipSyncConfig;
  gaze: GazeConfig;
  motion: MotionConfig;
  blink: BlinkConfig;
  emotion: EmotionConfig;
  gesture: GestureConfig;
  touch: TouchConfig;
  avatar: AvatarProfile;
}

interface Cue {
  at: number;
  run: (now: number) => void;
}

/** Emotion, gestures, blinking, lip sync and motion, injected at `inject_hz`. */
export class AvatarLoop {
  readonly #config: AvatarLoopConfig;
  readonly #levels: Levels;
  readonly #vts: Watch<VtsClient | null>;
  readonly #clock: Clock;
  readonly #emotion: EmotionController;
  readonly #poser: PoseBlender;
  readonly #gestures: GestureController;
  readonly #blink: BlinkScheduler;
  readonly #mouth: MouthShaper;
  readonly #touch: TouchReaction;
  readonly #motion: IdleMotion;
  /** Expression / hotkey requests run in order. */
  readonly #commands = new SerialQueue();
  #cues: Cue[] = [];
  #speaking = false;
  #intensity = 1;
  #resting: { name: string; strength: number } | null = null;
  #known: Set<string> | null = null;
  /** Expression files (lowercase → as given) her emotions and gestures want on. */
  #wanted = new Map<string, string>();
  /** Expression files VTS has on, as far as the loop knows. */
  #live = new Map<string, string>();
  /** A gift expression holding her face: nothing else shows an expression until `until`. */
  #gift: { file: string; until: number } | null = null;
  #levelObserver: ((sample: LevelSample | null) => void) | null = null;

  constructor(
    config: AvatarLoopConfig,
    levels: Levels,
    vts: Watch<VtsClient | null>,
    clock: Clock,
    random: Random = new Random(config.motion.seed ?? undefined),
  ) {
    this.#config = config;
    this.#levels = levels;
    this.#vts = vts;
    this.#clock = clock;
    const now = clock.now();
    this.#emotion = new EmotionController(
      config.avatar,
      config.vts.emotion_hold_ms,
      config.vts.after_speech_ms,
    );
    this.#poser = new PoseBlender(config.avatar, config.emotion);
    this.#gestures = new GestureController(config.avatar, config.gesture, random.fork(), now);
    this.#blink = new BlinkScheduler(config.blink, random.fork());
    this.#mouth = new MouthShaper(config.lipsync);
    this.#touch = new TouchReaction(config.touch);
    this.#motion = new IdleMotion(config.gaze, config.motion, random.fork());
  }

  /** Every input parameter the loop may inject. */
  parameters(): string[] {
    const c = this.#config;
    const names = new Set<string>();
    if (c.vts.idle_motion) for (const p of MOTION_PARAMS) names.add(p);
    for (const p of this.#poser.params()) names.add(p);
    if (c.blink.enabled) for (const p of EYE_PARAMS) names.add(p);
    for (const p of touchParams(c.touch)) names.add(p);
    if (c.avatar.lipsync === "inject") {
      names.add(c.avatar.mouthOpen);
      if (c.avatar.mouthForm !== null) names.add(c.avatar.mouthForm);
      if (c.avatar.jaw !== null) names.add(c.avatar.jaw);
      if (c.avatar.vowels) {
        for (const v of VOWELS) names.add(VOWEL_PARAMS[v]);
        names.add(SILENCE_PARAM);
      }
      for (const shape of c.avatar.shapes.values()) for (const p of shape.keys()) names.add(p);
    }
    return [...names].sort();
  }

  #later(run: (now: number) => void): void {
    const now = this.#clock.now();
    const at = now + this.#config.lipsync.latency_ms;
    if (at <= now) run(now);
    else this.#cues.push({ at, run });
  }

  /** An emotion marker (applied `latency_ms` later). */
  emotion(name: string, intensity = 1): void {
    this.#later((now) => this.#applyEmotion(name, intensity, now));
  }

  #applyEmotion(name: string, intensity: number, now: number): void {
    const strength = Math.min(Math.max(Number.isFinite(intensity) ? intensity : 1, 0), 1);
    this.#send(this.#emotion.onEmotion(name, now, strength));
    this.#intensity = strength;
    this.#poser.set(this.#emotion.current(), strength, now);
    this.#send(this.#gestures.onEmotion(name, strength, now));
  }

  /**
   * How she looks while no emotion marker is shown: a pose only, weaker than the marker's, with no
   * accent and no gesture. `neutral` (or a name the avatar does not know) is her plain rest.
   */
  resting(name: string, intensity: number): void {
    const face = name.trim().toLowerCase();
    const level = Math.min(Math.max(Number.isFinite(intensity) ? intensity : 0, 0), 1);
    const strength = level * this.#config.emotion.resting_strength;
    this.#resting = this.#config.avatar.knownEmotions().has(face) ? { name: face, strength } : null;
    if (this.#emotion.current() !== null) return;
    const target = this.#poseTarget();
    this.#poser.set(target.name, target.strength, this.#clock.now());
  }

  /** What the pose should be now: the marker's emotion, else her resting face. */
  #poseTarget(): { name: string | null; strength: number } {
    const name = this.#emotion.current();
    if (name !== null) return { name, strength: this.#intensity };
    return this.#resting ?? { name: null, strength: this.#intensity };
  }

  /** She started / stopped speaking a sentence (applied `latency_ms` later). */
  speaking(speaking: boolean): void {
    this.#later((now) => {
      this.#speaking = speaking;
      this.#emotion.setSpeaking(speaking, now);
      this.#gestures.setSpeaking(speaking, now);
      if (speaking) {
        this.#motion.sentenceStart();
        this.#blink.onSpeech();
      }
    });
  }

  /**
   * A viewer touched her (`head`, `face` or `body`; `screen` does nothing): a short reaction on
   * parameters (see touch.ts), and the part's gift expression when one is configured. Touches
   * close together extend one reaction.
   */
  touch(part: TouchPart): void {
    if (!this.#touch.touch(part, this.#clock.now())) return;
    const expression = this.#touch.expression();
    if (expression === null) return;
    this.gift(expression.name, expression.seconds).catch((error: unknown) =>
      log.debug({ err: errorMessage(error) }, "cannot show the touch expression"),
    );
  }

  gaze(target: GazeTarget): void {
    this.#motion.setTarget(target);
  }

  /**
   * The beat of the song she sings (`times_ms` from its start, `offset_ms` into it now), applied
   * `latency_ms` later like her mouth; empty `times_ms` stops it.
   */
  beat(times: readonly number[], offsetMs: number): void {
    this.#later(() => this.#motion.setBeat(times, offsetMs));
  }

  #send(commands: VtsCommand[]): void {
    const fade = this.#config.vts.expression_fade;
    for (const cmd of commands) {
      if (cmd.type === "expression") {
        const key = cmd.file.toLowerCase();
        if (cmd.active) this.#wanted.set(key, cmd.file);
        else this.#wanted.delete(key);
        // A gift holds the face: what she wants is remembered and comes back after it.
        if (this.#gift !== null) continue;
        if (cmd.active) this.#live.set(key, cmd.file);
        else this.#live.delete(key);
      }
      void this.#commands.run(async () => {
        const client = this.#vts.get();
        if (!client || client.isClosed()) return;
        try {
          if (cmd.type === "expression") await client.setExpression(cmd.file, cmd.active, fade);
          else await client.triggerHotkey(cmd.name);
        } catch (error) {
          log.warn({ err: errorMessage(error), cmd }, "VTube Studio request failed");
        }
      });
    }
  }

  /**
   * Shows a gift expression for `seconds` (her own expressions are taken off for the time, then
   * put back). Resolves once it is on; rejects when VTube Studio is not connected or refuses it.
   * A newer gift replaces the one showing.
   */
  async gift(expression: GiftExpression, seconds: number): Promise<void> {
    const file = this.#config.avatar.giftExpressions.get(expression);
    if (file === undefined) throw new Error(`no expression file is set for \`${expression}\``);
    const client = this.#vts.get();
    if (!client || client.isClosed()) throw new Error("VTube Studio is not connected");
    const fade = this.#config.vts.expression_fade;
    const key = file.toLowerCase();
    const previous = this.#gift;
    this.#gift = { file, until: this.#clock.now() + seconds * 1000 };
    try {
      await this.#commands.run(async () => {
        for (const [k, f] of [...this.#live]) {
          if (k === key) continue;
          await client.setExpression(f, false, fade);
          this.#live.delete(k);
        }
        await client.setExpression(file, true, fade);
        this.#live.set(key, file);
      });
    } catch (error) {
      this.#gift = previous;
      if (previous === null) this.#endGift();
      throw error;
    }
  }

  /** Takes the gift expression off and puts back what her emotions and gestures want. */
  #endGift(): void {
    this.#gift = null;
    const out: VtsCommand[] = [];
    for (const [k, f] of this.#live) {
      if (!this.#wanted.has(k)) out.push({ type: "expression", file: f, active: false });
    }
    for (const [k, f] of this.#wanted) {
      if (!this.#live.has(k)) out.push({ type: "expression", file: f, active: true });
    }
    this.#send(out);
  }

  #tickGift(now: number): void {
    if (this.#gift !== null && now >= this.#gift.until) this.#endGift();
  }

  #onClient(client: VtsClient | null): void {
    this.#known = null;
    // A new connection starts from nothing: no gift, no expression on.
    this.#gift = null;
    this.#wanted.clear();
    this.#live.clear();
    if (!client) return;
    this.#send([...this.#gestures.reset(), ...this.#emotion.rest()]);
    this.#poser.set(null, 0, this.#clock.now());
    void this.#prepare(client).catch((error: unknown) =>
      log.debug({ err: errorMessage(error) }, "cannot prepare the VTS input parameters"),
    );
  }

  /** Creates the custom parameters, then learns which inputs exist. */
  async #prepare(client: VtsClient): Promise<void> {
    const before = await client.inputParameterLists();
    for (const name of this.#config.vts.custom_params) {
      if (before.defaults.has(name)) continue;
      const [lo, hi] = paramRange(name);
      try {
        await client.createParameter(
          name,
          lo,
          hi,
          clampParam(name, this.#poser.rest(name)),
          "Miyoria avatar control",
        );
      } catch (error) {
        log.debug({ parameter: name, err: errorMessage(error) }, "cannot create a VTS parameter");
      }
    }
    const params = await client.inputParameters();
    for (const name of this.parameters()) {
      if (!params.has(name)) {
        log.warn({ parameter: name }, "VTube Studio has no such input parameter; not injecting it");
      }
    }
    if (this.#vts.get() === client) this.#known = params;
  }

  /** Receives every frame's level sample (`null`: no audio), e.g. for the overlay's waveform. */
  observeLevels(observer: ((sample: LevelSample | null) => void) | null): void {
    this.#levelObserver = observer;
  }

  /** Mouth opening the motion reacts to. */
  #mouthFrame(dt: number, now: number): Mouth | null {
    if (this.#config.avatar.lipsync !== "inject") return null;
    const sample = this.#levels.take(now);
    this.#levelObserver?.(sample);
    return this.#mouth.update(sample, dt);
  }

  /** One frame of parameter values (clamped, unfiltered). */
  frame(dt: number, now: number): Map<string, number> {
    const c = this.#config;
    const a = c.avatar;
    for (const cue of this.#cues.filter((q) => q.at <= now)) cue.run(now);
    this.#cues = this.#cues.filter((q) => q.at > now);
    this.#tickGift(now);
    this.#send(this.#emotion.tick(now));
    const target = this.#poseTarget();
    if (this.#poser.current() !== target.name) this.#poser.set(target.name, target.strength, now);
    this.#send(this.#gestures.tick(now));

    const mouth = this.#mouthFrame(dt, now);
    const values = new Map<string, number>();
    const pose = this.#poser.update(dt, now);
    if (c.vts.idle_motion) {
      const motion = this.#motion.update(dt, { speaking: this.#speaking, open: mouth?.open ?? 0 });
      for (const [name, v] of Object.entries(motion)) {
        values.set(name, v + (pose.offsets.get(name) ?? 0));
      }
    }
    for (const [name, v] of pose.values) values.set(name, v);
    if (c.blink.enabled) {
      this.#blink.setRate(pose.blink);
      const open = this.#blink.update(dt);
      for (const name of EYE_PARAMS)
        values.set(name, (values.get(name) ?? this.#poser.rest(name)) * open);
    }
    if (mouth) {
      values.set(a.mouthOpen, mouth.open);
      if (a.mouthForm !== null && !values.has(a.mouthForm)) {
        values.set(a.mouthForm, this.#poser.rest(a.mouthForm));
      }
      if (a.jaw !== null) values.set(a.jaw, mouth.jaw);
      if (a.vowels && mouth.vowels) {
        for (const v of VOWELS) values.set(VOWEL_PARAMS[v], mouth.vowels[v]);
        values.set(SILENCE_PARAM, mouth.silence);
      }
      // Vowel shapes: offsets weighted by the vowel and how open the mouth is. The shaped
      // parameters are always sent, so they settle back when the mouth closes.
      const shaped = new Map<string, number>();
      for (const [vowel, shape] of a.shapes) {
        const w = mouth.weights[vowel] * mouth.open;
        for (const [name, offset] of shape) shaped.set(name, (shaped.get(name) ?? 0) + offset * w);
      }
      for (const [name, offset] of shaped) {
        values.set(name, (values.get(name) ?? this.#poser.rest(name)) + offset);
      }
    }
    for (const [name, offset] of this.#touch.update(dt, now)) {
      values.set(name, (values.get(name) ?? this.#poser.rest(name)) + offset);
    }
    for (const [name, v] of values) values.set(name, clampParam(name, v));
    return values;
  }

  /**
   * Injects until `signal` aborts. While `active` says no (nobody is watching), nothing is
   * computed or sent and pending cues are dropped: the model goes back to VTS's own idle.
   */
  run(signal: AbortSignal, active: () => boolean = () => true): Promise<void> {
    const hz = Math.min(Math.max(this.#config.vts.inject_hz, 1), 120);
    let last = this.#clock.now();
    let paused = false;
    const unsubscribe = this.#vts.subscribe((client) => this.#onClient(client));
    this.#onClient(this.#vts.get());
    const tick = () => {
      const now = this.#clock.now();
      const dt = Math.min(Math.max(now - last, 0), 200);
      last = now;
      // A gift ends on time even while nobody watches.
      this.#tickGift(now);
      if (!active()) {
        if (!paused) log.info("not streaming; the avatar rests");
        paused = true;
        this.#cues = [];
        return;
      }
      if (paused) log.info("streaming; driving the avatar again");
      paused = false;
      const values = this.frame(dt, now);
      const client = this.#vts.get();
      const known = this.#known;
      if (!client || client.isClosed() || known === null) return;
      const batch: [string, number][] = [];
      for (const [name, v] of values) if (known.has(name)) batch.push([name, v]);
      client.inject(batch, this.#config.vts.face_found);
    };
    const timer = setInterval(tick, 1000 / hz);
    return new Promise<void>((resolve) => {
      const stop = () => {
        clearInterval(timer);
        unsubscribe();
        resolve();
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
  }
}
