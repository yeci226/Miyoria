// Emotion parameter poses, blended over time.
//
// Every emotion in `avatar.toml` can carry `[emotion.<name>.params]`: VTS input parameter →
// value. `neutral`'s params are the rest values. An emotion eases in (`ease_in_ms`), decays
// towards `sustain` of its strength over `decay_ms` while held, and eases out when it ends; a
// new emotion cross-fades with the old one. Strength is the marker's intensity.
//
// Head, eye and body inputs (`OFFSET_PARAMS`) are offsets added to the procedural motion; all
// other parameters are absolute values blended from the rest value.

import { z } from "zod";
import type { AvatarProfile, EmotionPose } from "./avatar.js";
import { approach, clamp } from "./random.js";

/** `[emotion]` section of the Stage config. */
export const EmotionConfigSchema = z.object({
  /** Time to reach a new emotion's pose (ms). */
  ease_in_ms: z.number().nonnegative().default(250),
  /** Time to let go of an ended emotion's pose (ms). */
  ease_out_ms: z.number().nonnegative().default(700),
  /** Share of the pose left after the decay. */
  sustain: z.number().min(0).max(1).default(0.65),
  /** Decay time constant while held (ms). */
  decay_ms: z.number().nonnegative().default(3_000),
  /** How far her resting face goes toward what she shows: her feeling's strength times this. */
  resting_strength: z.number().min(0).max(1).default(0.6),
});
export type EmotionConfig = z.output<typeof EmotionConfigSchema>;

/** Body inputs created by the Stage (map them to `PositionX/Y/Z` in VTS; see the docs). */
export const BODY_PARAMS = ["MiyoriaBodyX", "MiyoriaBodyY", "MiyoriaBodyZ"] as const;

/** Inputs that are added to the procedural motion instead of blended from a rest value. */
export const OFFSET_PARAMS: ReadonlySet<string> = new Set([
  "FaceAngleX",
  "FaceAngleY",
  "FaceAngleZ",
  "EyeLeftX",
  "EyeLeftY",
  "EyeRightX",
  "EyeRightY",
  ...BODY_PARAMS,
]);

/** Rest values of common inputs when `neutral` does not set them. */
export const DEFAULT_REST: Readonly<Record<string, number>> = {
  EyeOpenLeft: 1,
  EyeOpenRight: 1,
  Brows: 0.5,
  MouthSmile: 0.5,
};

/** Value range of an input, for clamping. */
export function paramRange(name: string): [number, number] {
  if (name.startsWith("FaceAngle") || name.startsWith("MiyoriaBody")) return [-30, 30];
  if (/^Eye(Left|Right)[XY]$/.test(name)) return [-1, 1];
  if (name === "MouthX" || name === "MouthPucker") return [-1, 1];
  return [0, 1];
}

export function clampParam(name: string, value: number): number {
  const [lo, hi] = paramRange(name);
  return clamp(value, lo, hi);
}

interface Layer {
  name: string;
  pose: EmotionPose;
  intensity: number;
  /** When the decay (re)started. */
  since: number;
  released: boolean;
  weight: number;
}

/** Blended pose values for one frame. */
export interface PoseFrame {
  /** Absolute values (every parameter any pose or the rest pose sets). */
  values: Map<string, number>;
  /** Offsets for `OFFSET_PARAMS`. */
  offsets: Map<string, number>;
  /** Blend of the active emotions' blink rate multipliers. */
  blink: number;
}

export class PoseBlender {
  readonly #c: EmotionConfig;
  readonly #profile: AvatarProfile;
  readonly #rest = new Map<string, number>();
  readonly #absolute: string[];
  readonly #offsetNames: string[];
  #layers: Layer[] = [];

  constructor(profile: AvatarProfile, config: EmotionConfig) {
    this.#c = config;
    this.#profile = profile;
    const absolute = new Set<string>();
    const offsets = new Set<string>();
    for (const pose of profile.poses.values()) {
      for (const name of pose.params.keys())
        (OFFSET_PARAMS.has(name) ? offsets : absolute).add(name);
    }
    const neutral = profile.poses.get("neutral");
    for (const name of absolute) {
      this.#rest.set(name, neutral?.params.get(name) ?? DEFAULT_REST[name] ?? 0);
    }
    this.#absolute = [...absolute].sort();
    this.#offsetNames = [...offsets].sort();
  }

  /** Every absolute parameter the poses drive. */
  params(): string[] {
    return [...this.#absolute];
  }

  /** Rest value of a parameter (`neutral`, `DEFAULT_REST`, else 0). */
  rest(name: string): number {
    return (
      this.#rest.get(name) ??
      this.#profile.poses.get("neutral")?.params.get(name) ??
      DEFAULT_REST[name] ??
      0
    );
  }

  /** The emotion being eased towards (`null` = rest). */
  current(): string | null {
    const top = this.#layers.at(-1);
    return top && !top.released ? top.name : null;
  }

  /** Shows `emotion` (`null` / `neutral`: back to rest) at `intensity` (0..1). */
  set(emotion: string | null, intensity: number, now: number): void {
    const name = emotion?.trim().toLowerCase() ?? null;
    const strength = clamp(Number.isFinite(intensity) ? intensity : 1, 0, 1);
    const top = this.#layers.at(-1);
    if (name !== null && name !== "neutral" && top && !top.released && top.name === name) {
      top.intensity = strength;
      top.since = now;
      return;
    }
    for (const layer of this.#layers) layer.released = true;
    if (name === null || name === "neutral") return;
    const pose = this.#profile.poses.get(name);
    if (!pose) return;
    this.#layers.push({ name, pose, intensity: strength, since: now, released: false, weight: 0 });
    // Older fading layers beyond a few are dropped.
    if (this.#layers.length > 4) this.#layers.splice(0, this.#layers.length - 4);
  }

  /** Advances the blend weights by `dtMs` and returns the frame at `now`. */
  update(dtMs: number, now: number): PoseFrame {
    const { ease_in_ms, ease_out_ms, sustain, decay_ms } = this.#c;
    for (const layer of this.#layers) {
      let target = 0;
      if (!layer.released) {
        const held = Math.max(now - layer.since, 0);
        const decay = decay_ms > 0 ? sustain + (1 - sustain) * Math.exp(-held / decay_ms) : 1;
        target = layer.intensity * decay;
      }
      const tau = target > layer.weight ? ease_in_ms / 3 : ease_out_ms / 3;
      layer.weight = approach(layer.weight, target, dtMs, Math.max(tau, 1));
    }
    this.#layers = this.#layers.filter((l) => !l.released || l.weight > 0.002);
    const total = this.#layers.reduce((s, l) => s + l.weight, 0);
    const norm = Math.max(total, 1);

    const values = new Map<string, number>();
    for (const name of this.#absolute) {
      const rest = this.#rest.get(name) ?? 0;
      let v = rest;
      for (const l of this.#layers) {
        const p = l.pose.params.get(name);
        if (p !== undefined) v += (l.weight / norm) * (p - rest);
      }
      values.set(name, clampParam(name, v));
    }
    const offsets = new Map<string, number>();
    for (const name of this.#offsetNames) {
      let v = 0;
      for (const l of this.#layers) v += (l.weight / norm) * (l.pose.params.get(name) ?? 0);
      offsets.set(name, v);
    }
    let blink = 1;
    for (const l of this.#layers) blink += (l.weight / norm) * (l.pose.blink - 1);
    return { values, offsets, blink };
  }

  /** Total weight of the emotion layers (0 = at rest). */
  weight(): number {
    return this.#layers.reduce((s, l) => s + l.weight, 0);
  }
}
