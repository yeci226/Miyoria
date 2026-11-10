// Procedural head, eye and body motion around a pose that follows the gaze target.
//
// * Head: two-octave seeded noise per axis (never the same loop twice), bigger while she
//   speaks, plus small nods on syllable onsets and a tilt / nod at each sentence start.
// * Eyes: saccades — quick jumps to a new point near the gaze target every so often, sometimes
//   a bigger glance that the head partly follows.
// * Body: a lagged, smaller copy of the head plus its own drift, on custom parameters
//   (`MiyoriaBodyX/Y/Z`) the model maps to its body (see the docs for the VTS mapping).

import { z } from "zod";
import { BODY_PARAMS } from "./pose.js";
import type { GazeTarget } from "./protocol.js";
import { approach, clamp, Drift, Random } from "./random.js";

/** Head angles (degrees, VTS range -30..30) and eye direction (-1..1). */
export const GazePoseSchema = z.object({
  face_x: z.number().default(0),
  face_y: z.number().default(0),
  face_z: z.number().default(0),
  eye_x: z.number().default(0),
  eye_y: z.number().default(0),
});
export type GazePose = z.output<typeof GazePoseSchema>;

const CHAT_POSE: GazePose = { face_x: -12, face_y: -6, face_z: 2, eye_x: -0.6, eye_y: -0.3 };
const GAME_POSE: GazePose = { face_x: 8, face_y: -10, face_z: 0, eye_x: 0.3, eye_y: -0.5 };
const CAMERA_POSE: GazePose = { face_x: 0, face_y: 0, face_z: 0, eye_x: 0, eye_y: 0 };

/** `[gaze]` section of the Stage config: one pose per target. */
export const GazeConfigSchema = z.object({
  chat: GazePoseSchema.default(CHAT_POSE),
  game: GazePoseSchema.default(GAME_POSE),
  camera: GazePoseSchema.default(CAMERA_POSE),
  /** Scale of all procedural motion; 0 holds the pose still. */
  idle_amount: z.number().default(1.0),
  /** Time constant for turning towards a new target (ms). */
  turn_ms: z.number().default(600),
});
export type GazeConfig = z.output<typeof GazeConfigSchema>;

/** `[motion]` section of the Stage config. */
export const MotionConfigSchema = z.object({
  /** Random seed (`null`: a new one every start). */
  seed: z.number().int().nullable().default(null),
  /** Head drift amplitude per axis (degrees). */
  drift_x: z.number().default(8),
  drift_y: z.number().default(5),
  drift_z: z.number().default(5),
  /** Typical drift period (ms). */
  drift_ms: z.number().positive().default(3_500),
  /** Head motion multiplier while she speaks. */
  speech_motion: z.number().nonnegative().default(1.8),
  /** Mean gap between saccades (ms), and the shortest one. */
  saccade_mean_ms: z.number().positive().default(1_400),
  saccade_min_ms: z.number().nonnegative().default(250),
  /** Saccade size (eye units, -1..1 range). */
  saccade_amount: z.number().nonnegative().default(0.12),
  /** Chance that a saccade is a bigger glance, and its size. */
  glance_chance: z.number().min(0).max(1).default(0.18),
  glance_amount: z.number().nonnegative().default(0.4),
  /** Saccade travel time constant (ms). */
  saccade_ms: z.number().nonnegative().default(25),
  /** Head degrees per eye unit the head follows a glance with. */
  head_follow_deg: z.number().default(12),
  /** Nod size on a syllable onset (degrees, down). */
  nod_deg: z.number().default(4),
  /** Opening the mouth must rise past to count as an onset. */
  nod_threshold: z.number().default(0.3),
  /** Least time between two onset nods (ms). */
  nod_gap_ms: z.number().nonnegative().default(380),
  /** Tilt / nod at a sentence start (degrees). */
  sentence_deg: z.number().default(7),
  /** Body follows this share of the head. */
  body_follow: z.number().default(0.6),
  /** Body lag behind the head (ms). */
  body_lag_ms: z.number().nonnegative().default(450),
  /** Body drift amplitude (degrees). */
  body_drift: z.number().default(3.5),
});
export type MotionConfig = z.output<typeof MotionConfigSchema>;

export function gazePose(config: GazeConfig, target: GazeTarget): GazePose {
  return config[target];
}

/** VTS input parameters driven by `IdleMotion`. */
export const MOTION_PARAMS = [
  "FaceAngleX",
  "FaceAngleY",
  "FaceAngleZ",
  "EyeLeftX",
  "EyeLeftY",
  "EyeRightX",
  "EyeRightY",
  ...BODY_PARAMS,
] as const;

/** One frame of motion, keyed by `MOTION_PARAMS`. */
export type MotionFrame = Record<(typeof MOTION_PARAMS)[number], number>;

/** What the motion reacts to. */
export interface MotionInput {
  speaking: boolean;
  /** Current mouth opening (0..1). */
  open: number;
}

/** A pulse that rises and falls back: `a·(t/τ)·e^(1−t/τ)` (peaks at τ with `a`). */
interface Pulse {
  axis: "x" | "y" | "z";
  amount: number;
  tau: number;
  t: number;
}

export class IdleMotion {
  readonly #gaze: GazeConfig;
  readonly #c: MotionConfig;
  readonly #random: Random;
  #target: GazeTarget = "camera";
  readonly #pose: GazePose;
  readonly #drift: [Drift, Drift, Drift];
  readonly #bodyDrift: [Drift, Drift, Drift];
  #speech = 0;
  /** Current saccade offset and where it is heading. */
  #eye = { x: 0, y: 0, tx: 0, ty: 0 };
  #nextSaccade: number;
  /** Head following the last glance (degrees). */
  #follow = { x: 0, y: 0, tx: 0, ty: 0 };
  #pulses: Pulse[] = [];
  /** Sentence-start tilt / nod: target offsets that relax back. */
  #lean = { y: 0, z: 0, ty: 0, tz: 0 };
  #prevOpen = 0;
  #sinceNod = Number.POSITIVE_INFINITY;
  #body = { x: 0, y: 0, z: 0 };

  constructor(
    gaze: GazeConfig,
    motion: MotionConfig = MotionConfigSchema.parse({}),
    random?: Random,
  ) {
    this.#gaze = gaze;
    this.#c = motion;
    this.#random = random ?? new Random(motion.seed ?? undefined);
    this.#pose = { ...gaze.camera };
    const r = this.#random;
    const p = motion.drift_ms;
    this.#drift = [new Drift(r, p), new Drift(r, p * 1.3), new Drift(r, p * 1.7)];
    this.#bodyDrift = [new Drift(r, p * 2), new Drift(r, p * 2.4), new Drift(r, p * 2.9)];
    this.#nextSaccade = this.#saccadeGap();
  }

  target(): GazeTarget {
    return this.#target;
  }

  setTarget(target: GazeTarget): void {
    this.#target = target;
  }

  /** A sentence starts: a small tilt or nod that relaxes over a few seconds. */
  sentenceStart(): void {
    const deg = this.#c.sentence_deg;
    if (this.#random.chance(0.55))
      this.#lean.tz = this.#random.sign() * deg * this.#random.range(0.5, 1);
    else this.#lean.ty = -deg * this.#random.range(0.4, 0.9);
    if (this.#random.chance(0.5)) this.#saccade(true);
  }

  #saccadeGap(): number {
    return this.#c.saccade_min_ms + this.#random.exponential(this.#c.saccade_mean_ms);
  }

  #saccade(glance: boolean): void {
    const amount = glance ? this.#c.glance_amount : this.#c.saccade_amount;
    this.#eye.tx = clamp(this.#random.gaussian(amount), -2 * amount, 2 * amount);
    this.#eye.ty = clamp(this.#random.gaussian(amount * 0.6), -1.2 * amount, 1.2 * amount);
    const follow = glance ? this.#c.head_follow_deg : this.#c.head_follow_deg * 0.3;
    this.#follow.tx = this.#eye.tx * follow;
    this.#follow.ty = this.#eye.ty * follow;
  }

  /** Advances by `dtMs`; returns values for `MOTION_PARAMS`. */
  update(dtMs: number, input: MotionInput = { speaking: false, open: 0 }): MotionFrame {
    const c = this.#c;
    const dt = Math.max(dtMs, 0);
    const goal = gazePose(this.#gaze, this.#target);
    const turn = Math.max(this.#gaze.turn_ms, 1);
    const p = this.#pose;
    p.face_x = approach(p.face_x, goal.face_x, dt, turn);
    p.face_y = approach(p.face_y, goal.face_y, dt, turn);
    p.face_z = approach(p.face_z, goal.face_z, dt, turn);
    p.eye_x = approach(p.eye_x, goal.eye_x, dt, turn);
    p.eye_y = approach(p.eye_y, goal.eye_y, dt, turn);

    const k = Math.max(this.#gaze.idle_amount, 0);
    this.#speech = approach(this.#speech, input.speaking ? 1 : 0, dt, 400);
    const lively = 1 + (c.speech_motion - 1) * this.#speech;

    // Saccades.
    this.#nextSaccade -= dt;
    if (this.#nextSaccade <= 0) {
      this.#saccade(this.#random.chance(c.glance_chance));
      this.#nextSaccade = this.#saccadeGap();
    }
    this.#eye.x = approach(this.#eye.x, this.#eye.tx, dt, c.saccade_ms);
    this.#eye.y = approach(this.#eye.y, this.#eye.ty, dt, c.saccade_ms);
    this.#follow.x = approach(this.#follow.x, this.#follow.tx, dt, 350);
    this.#follow.y = approach(this.#follow.y, this.#follow.ty, dt, 350);

    // Onset nods: the mouth opens after having been (nearly) closed.
    const open = Number.isFinite(input.open) ? input.open : 0;
    this.#sinceNod += dt;
    if (
      input.speaking &&
      this.#prevOpen < c.nod_threshold &&
      open >= c.nod_threshold &&
      this.#sinceNod >= c.nod_gap_ms
    ) {
      this.#sinceNod = 0;
      this.#pulses.push({
        axis: "y",
        amount: -c.nod_deg * this.#random.range(0.6, 1.2),
        tau: 110,
        t: 0,
      });
      if (this.#random.chance(0.25)) {
        this.#pulses.push({
          axis: "z",
          amount: this.#random.sign() * c.nod_deg * 0.6,
          tau: 160,
          t: 0,
        });
      }
    }
    this.#prevOpen = open;
    const pulse = { x: 0, y: 0, z: 0 };
    for (const q of this.#pulses) {
      q.t += dt;
      const u = q.t / q.tau;
      pulse[q.axis] += q.amount * u * Math.exp(1 - u);
    }
    this.#pulses = this.#pulses.filter((q) => q.t < q.tau * 8);

    // Sentence lean relaxes back to 0.
    this.#lean.tz = approach(this.#lean.tz, 0, dt, 2_500);
    this.#lean.ty = approach(this.#lean.ty, 0, dt, 1_200);
    this.#lean.z = approach(this.#lean.z, this.#lean.tz, dt, 220);
    this.#lean.y = approach(this.#lean.y, this.#lean.ty, dt, 180);

    const [dx, dy, dz] = this.#drift;
    const nx = c.drift_x * dx.update(dt) * lively;
    const ny = c.drift_y * dy.update(dt) * lively;
    const nz = c.drift_z * dz.update(dt) * lively;
    const hx = k * (nx + this.#follow.x + pulse.x);
    const hy = k * (ny + this.#follow.y + pulse.y + this.#lean.y);
    const hz = k * (nz + pulse.z + this.#lean.z);
    const faceX = clamp(p.face_x + hx, -30, 30);
    const faceY = clamp(p.face_y + hy, -30, 30);
    const faceZ = clamp(p.face_z + hz, -30, 30);
    const eyeX = clamp(p.eye_x + k * this.#eye.x, -1, 1);
    const eyeY = clamp(p.eye_y + k * this.#eye.y, -1, 1);

    // Body: lagged and smaller, plus its own slow drift.
    const lag = Math.max(c.body_lag_ms, 1);
    const [bx, by, bz] = this.#bodyDrift;
    this.#body.x = approach(this.#body.x, faceX * c.body_follow, dt, lag);
    this.#body.y = approach(this.#body.y, faceY * c.body_follow, dt, lag);
    this.#body.z = approach(this.#body.z, faceZ * c.body_follow, dt, lag);
    const bd = k * c.body_drift;
    return {
      FaceAngleX: faceX,
      FaceAngleY: faceY,
      FaceAngleZ: faceZ,
      EyeLeftX: eyeX,
      EyeLeftY: eyeY,
      EyeRightX: eyeX,
      EyeRightY: eyeY,
      MiyoriaBodyX: clamp(this.#body.x + bd * bx.update(dt), -30, 30),
      MiyoriaBodyY: clamp(this.#body.y + bd * 0.6 * by.update(dt), -30, 30),
      MiyoriaBodyZ: clamp(this.#body.z + bd * bz.update(dt), -30, 30),
    };
  }
}
