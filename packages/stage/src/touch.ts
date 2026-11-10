// Touches: a viewer touches the stream on the website (`live.touch` on the Core bus). The overlay
// draws the touch where it landed, and her avatar reacts a little, by the part that was touched
// (`[stage.touch]`): a short head tilt and a smile of the eyes on parameters, and, when the
// owner wants one, a gift expression for a moment. Pure: times are passed in.

import { isJsonObject, type JsonValue } from "@miyoria/types";
import { z } from "zod";
import { approach, clamp } from "./random.js";

/** Topic of a viewer's touch on the stream (`{x, y, part}`, `x`/`y` 0..1, origin top-left). */
export const TOUCH_TOPIC = "live.touch";

/** What a touch landed on. */
export const TOUCH_PARTS = ["head", "face", "body", "screen"] as const;
export type TouchPart = (typeof TOUCH_PARTS)[number];

/** The parts of her that react (`screen` does not). */
export type ReactingPart = Exclude<TouchPart, "screen">;

export interface Touch {
  x: number;
  y: number;
  part: TouchPart;
}

/** A `live.touch` payload as a touch, or `null` when it is anything else. */
export function parseTouch(payload: JsonValue): Touch | null {
  const p = isJsonObject(payload) ? payload : null;
  if (p === null) return null;
  const { x, y, part } = p;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  if (typeof part !== "string" || !(TOUCH_PARTS as readonly string[]).includes(part)) return null;
  return { x, y, part: part as TouchPart };
}

/** Touches per second the overlay is sent at most. */
export const TOUCH_OVERLAY_PER_S = 8;

/** Lets at most `perSecond` through in any one second (a sliding window). */
export class TouchThrottle {
  readonly #perSecond: number;
  #times: number[] = [];

  constructor(perSecond = TOUCH_OVERLAY_PER_S) {
    this.#perSecond = perSecond;
  }

  allow(now: number): boolean {
    this.#times = this.#times.filter((t) => now - t < 1_000);
    if (this.#times.length >= this.#perSecond) return false;
    this.#times.push(now);
    return true;
  }
}

/** How one part reacts. Angles are degrees added to VTS's face / body angles at the peak. */
export const TouchPartSchema = z.object({
  face_x: z.number().default(0),
  face_y: z.number().default(0),
  face_z: z.number().default(0),
  body_z: z.number().default(0),
  /** Peak of `MiyoriaEyeSmile` (0..1). */
  eye_smile: z.number().min(0).max(1).default(0),
  /** A gift expression shown on top (`heart`, `blush`, `squint`, `big_bowl`; needs its file in `[gift_expression]`). Default off. */
  expression: z.enum(["heart", "blush", "squint", "big_bowl"]).nullable().default(null),
  expression_s: z.number().min(1).max(15).default(3),
});
export type TouchPartConfig = z.output<typeof TouchPartSchema>;

/** `[stage.touch]` section of the Stage config. */
export const TouchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Least time between two reactions (ms); touches during a reaction extend it instead. */
  cooldown_ms: z.number().nonnegative().default(1_500),
  /** How long a reaction stays at its peak after the latest touch (ms). */
  hold_ms: z.number().positive().default(900),
  /** A burst never keeps one reaction longer than this (ms). */
  max_ms: z.number().positive().default(5_000),
  head: TouchPartSchema.prefault({ face_z: 8, face_y: -3, eye_smile: 0.8 }),
  face: TouchPartSchema.prefault({ face_x: 3, face_y: 6, face_z: -5, eye_smile: 0.5 }),
  body: TouchPartSchema.prefault({ face_z: 3, body_z: 6, eye_smile: 0.3 }),
});
export type TouchConfig = z.output<typeof TouchConfigSchema>;

/** Parameter name → offset a reaction adds. */
export type TouchOffsets = ReadonlyMap<string, number>;

/** The VTS inputs a reaction may touch. */
export function touchParams(config: TouchConfig): string[] {
  if (!config.enabled) return [];
  const names = new Set<string>();
  for (const spec of [config.head, config.face, config.body]) {
    if (spec.face_x !== 0) names.add("FaceAngleX");
    if (spec.face_y !== 0) names.add("FaceAngleY");
    if (spec.face_z !== 0) names.add("FaceAngleZ");
    if (spec.body_z !== 0) names.add("MiyoriaBodyZ");
    if (spec.eye_smile !== 0) names.add("MiyoriaEyeSmile");
  }
  return [...names];
}

/**
 * One reaction at a time. A touch while one runs extends it (up to `max_ms` in all) without
 * restarting; one right after it ended waits out `cooldown_ms` from its start. The level rises
 * quickly and falls back slowly, so offsets never jump.
 */
export class TouchReaction {
  readonly #c: TouchConfig;
  #part: ReactingPart | null = null;
  #started = Number.NEGATIVE_INFINITY;
  #until = 0;
  #level = 0;

  constructor(config: TouchConfig) {
    this.#c = config;
  }

  /** `true` when a new reaction starts now; `false` when it only extended one or was ignored. */
  touch(part: TouchPart, now: number): boolean {
    if (!this.#c.enabled || part === "screen") return false;
    if (this.#part !== null && now < this.#until) {
      this.#until = Math.min(now + this.#c.hold_ms, this.#started + this.#c.max_ms);
      return false;
    }
    if (now - this.#started < this.#c.cooldown_ms) return false;
    this.#part = part;
    this.#started = now;
    this.#until = now + this.#c.hold_ms;
    return true;
  }

  /** The gift expression the running reaction asks for, if any. */
  expression(): { name: NonNullable<TouchPartConfig["expression"]>; seconds: number } | null {
    const spec = this.#part === null ? null : this.#c[this.#part];
    return spec?.expression ? { name: spec.expression, seconds: spec.expression_s } : null;
  }

  /** Offsets for this frame (empty while nothing reacts). */
  update(dtMs: number, now: number): TouchOffsets {
    const out = new Map<string, number>();
    const part = this.#part;
    if (part === null) return out;
    const on = now < this.#until;
    this.#level = approach(this.#level, on ? 1 : 0, Math.max(dtMs, 0), on ? 160 : 450);
    if (!on && this.#level < 0.005) {
      this.#level = 0;
      this.#part = null;
      return out;
    }
    const spec = this.#c[part];
    const l = this.#level;
    if (spec.face_x !== 0) out.set("FaceAngleX", spec.face_x * l);
    if (spec.face_y !== 0) out.set("FaceAngleY", spec.face_y * l);
    if (spec.face_z !== 0) out.set("FaceAngleZ", spec.face_z * l);
    if (spec.body_z !== 0) out.set("MiyoriaBodyZ", spec.body_z * l);
    if (spec.eye_smile !== 0) out.set("MiyoriaEyeSmile", clamp(spec.eye_smile * l, 0, 1));
    return out;
  }
}
