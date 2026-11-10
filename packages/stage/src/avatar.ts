// The parts of a profile's `avatar.toml` the Stage uses.
//
//     [emotion]
//     sad = "流泪.exp3.json"                 # short form: just an accent expression / hotkey
//
//     [emotion.happy]
//     expression = "爱心眼.exp3.json"        # accent (decal) expression or hotkey
//     accent_min = 0.6                       # intensity needed for the accent
//     blink = 1.2                            # blink rate multiplier
//     gesture = ["chest"]                    # `[gesture.<name>]` variants
//     gesture_chance = 0.4
//     [emotion.happy.params]                 # VTS input parameter → value
//     MiyoriaEyeSmile = 0.8
//     FaceAngleZ = 3                         # head / eye / body inputs are offsets
//
//     [gesture.chest]
//     open = "抚胸手打开"                    # hotkey, or an `.exp3.json` (shown, then hidden)
//     close = "抚胸手关闭"
//     group = "hands"                        # one gesture per group at a time
//     hold_ms = [2500, 5000]
//     cooldown_ms = 30000
//
//     [idle]
//     gesture = ["grass"]                    # while she is quiet
//
//     [gift_expression]                      # `stage.expression` (gifts) → expression file
//     heart = "爱心眼.exp3.json"             # defaults: heart, blush, squint, big_bowl
//
//     [lipsync]
//     mode = "inject"
//     [lipsync.shape.i]                      # offsets per vowel, × opening
//     MouthSmile = 0.1

import { readFileSync } from "node:fs";
import { errorMessage, getLogger } from "@miyoria/kernel";
import type { JsonObject } from "@miyoria/types";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { VOWELS, type Vowel } from "./lipsync.js";
import { GIFT_EXPRESSIONS, type GiftExpression } from "./protocol.js";

const log = getLogger("stage.avatar");

/** What an emotion maps to in VTube Studio. */
export type AvatarAction =
  /** An expression file (`*.exp3.json`), toggled with `ExpressionActivationRequest`. */
  | { type: "expression"; file: string }
  /** A hotkey name or id, fired with `HotkeyTriggerRequest`. */
  | { type: "hotkey"; name: string };

/** `""` and template placeholders (`<...>`) map to nothing. */
export function parseAvatarAction(value: string): AvatarAction | null {
  const v = value.trim();
  if (v === "" || v.startsWith("<")) return null;
  return v.toLowerCase().endsWith(".exp3.json")
    ? { type: "expression", file: v }
    : { type: "hotkey", name: v };
}

/** The expression files `stage.expression` shows (`[gift_expression]` overrides them). */
export const DEFAULT_GIFT_EXPRESSIONS: Readonly<Record<GiftExpression, string>> = {
  heart: "爱心眼.exp3.json",
  blush: "脸红.exp3.json",
  squint: "＞＜.exp3.json",
  big_bowl: "钢盆.exp3.json",
};

/**
 * How the mouth is driven: `inject` from playback levels (injected as parameters), or `mic`
 * (VTube Studio does it from a virtual microphone; nothing is injected).
 */
export type LipSyncMode = "inject" | "mic";

export class AvatarProfileError extends Error {
  override readonly name = "AvatarProfileError";
}

/** Parameter pose of an emotion and what goes with it. */
export interface EmotionPose {
  /** VTS input parameter → value (absolute, or an offset for head / eye / body inputs). */
  params: Map<string, number>;
  /** Blink rate multiplier. */
  blink: number;
  /** Gesture names to choose from. */
  gestures: string[];
  /** Chance (at intensity 1) that the emotion starts a gesture. */
  gestureChance: number;
  /** Intensity below which the accent expression is skipped. */
  accentMin: number;
}

/** A model gesture: an animation or decal that is shown, held, then taken back. */
export interface Gesture {
  name: string;
  open: AvatarAction;
  /** `null`: nothing to undo (or an expression, which is just deactivated). */
  close: AvatarAction | null;
  group: string | null;
  /** Hold time range (ms). */
  holdMs: [number, number];
  cooldownMs: number;
}

/** Gestures while she is quiet. */
export interface IdleGestures {
  gestures: string[];
  /** Gap between idle gestures (ms range). */
  everyMs: [number, number];
  /** Quiet time before the first one (ms). */
  afterMs: number;
}

const ParamsSchema = z.record(z.string(), z.number()).default({});
const RangeSchema = z
  .union([z.number().nonnegative(), z.tuple([z.number().nonnegative(), z.number().nonnegative()])])
  .transform((v): [number, number] =>
    typeof v === "number" ? [v, v] : [Math.min(v[0], v[1]), Math.max(v[0], v[1])],
  );
const NamesSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (typeof v === "string" ? [v] : v).map((s) => s.trim()).filter((s) => s !== ""))
  .default([]);

const EmotionSchema = z.union([
  z.string(),
  z.object({
    expression: z.string().default(""),
    accent_min: z.number().min(0).max(1).default(0),
    blink: z.number().positive().default(1),
    gesture: NamesSchema,
    gesture_chance: z.number().min(0).max(1).default(0.5),
    params: ParamsSchema,
  }),
]);

const GestureSchema = z.object({
  open: z.string(),
  close: z.string().default(""),
  group: z.string().default(""),
  hold_ms: RangeSchema.default([2_000, 4_000]),
  cooldown_ms: z.number().nonnegative().default(30_000),
});

const RawSchema = z.object({
  vts_model: z.string().nullish(),
  emotion: z.record(z.string(), EmotionSchema).default({}),
  gesture: z.record(z.string(), GestureSchema).default({}),
  gift_expression: z.record(z.string(), z.string()).default({}),
  idle: z
    .object({
      gesture: NamesSchema,
      every_ms: RangeSchema.default([60_000, 180_000]),
      after_ms: z.number().nonnegative().default(15_000),
    })
    .prefault({}),
  lipsync: z
    .object({
      mode: z.enum(["inject", "mic"]).default("inject"),
      mouth_open: z.string().nullish(),
      mouth_form: z.string().nullish(),
      jaw: z.string().nullish(),
      vowels: z.boolean().default(true),
      shape: z.record(z.string(), ParamsSchema).default({}),
    })
    .prefault({}),
});

function nonEmpty(v: string | null | undefined): string | null {
  const s = v?.trim() ?? "";
  return s === "" ? null : s;
}

const byName = <T>(entries: [string, T][]): Map<string, T> =>
  new Map(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function defaultPose(): EmotionPose {
  return { params: new Map(), blink: 1, gestures: [], gestureChance: 0.5, accentMin: 0 };
}

/** `avatar.toml`. */
export class AvatarProfile {
  /** Expected VTS model name or id (warned about when another is loaded). */
  vtsModel: string | null = null;
  /**
   * Emotion (lowercase) → accent expression / hotkey, ordered by name. `neutral` is the resting
   * state.
   */
  emotions = new Map<string, AvatarAction>();
  /** Emotion (lowercase) → parameter pose, ordered by name. `neutral` holds the rest values. */
  poses = new Map<string, EmotionPose>();
  /** Gesture name → gesture. */
  gestures = new Map<string, Gesture>();
  /** Gift expression → expression file (see `[gift_expression]`). */
  giftExpressions = new Map<GiftExpression, string>(
    Object.entries(DEFAULT_GIFT_EXPRESSIONS) as [GiftExpression, string][],
  );
  idle: IdleGestures = { gestures: [], everyMs: [60_000, 180_000], afterMs: 15_000 };
  lipsync: LipSyncMode = "inject";
  /** Parameter for mouth opening. Default `MouthOpen`. */
  mouthOpen = "MouthOpen";
  /**
   * VTS tracking parameter for mouth shape (0..1). Default `MouthSmile`, which VTS maps to
   * `ParamMouthForm`; `MouthForm` itself is a Live2D parameter VTS won't take injections for.
   */
  mouthForm: string | null = "MouthSmile";
  /** Parameter for the jaw (`null`: not driven). Default `JawOpen` (a custom parameter). */
  jaw: string | null = "JawOpen";
  /** Drive `VoiceA..VoiceO` / `VoiceSilence` from the vowel estimate. */
  vowels = true;
  /** Per-vowel parameter offsets (× opening). */
  shapes = new Map<Vowel, Map<string, number>>();

  /** Parses `avatar.toml` (`null` when the profile has none). */
  static parse(table: JsonObject | Record<string, unknown> | null): AvatarProfile {
    const p = new AvatarProfile();
    if (table === null) return p;
    const result = RawSchema.safeParse(table);
    if (!result.success) {
      throw new AvatarProfileError(`invalid avatar.toml: ${z.prettifyError(result.error)}`);
    }
    const raw = result.data;
    const emotions: [string, AvatarAction][] = [];
    const poses: [string, EmotionPose][] = [];
    for (const [rawName, value] of Object.entries(raw.emotion)) {
      const name = rawName.trim().toLowerCase();
      const expression = typeof value === "string" ? value : value.expression;
      const action = parseAvatarAction(expression);
      if (action) emotions.push([name, action]);
      else if (expression.trim().startsWith("<")) {
        log.warn({ emotion: name }, "avatar.toml emotion is still a placeholder");
      }
      if (typeof value !== "string") {
        poses.push([
          name,
          {
            params: new Map(Object.entries(value.params)),
            blink: value.blink,
            gestures: value.gesture,
            gestureChance: value.gesture_chance,
            accentMin: value.accent_min,
          },
        ]);
      }
    }
    p.emotions = byName(emotions);
    p.poses = byName(poses);
    const gestures: [string, Gesture][] = [];
    for (const [rawName, g] of Object.entries(raw.gesture)) {
      const name = rawName.trim();
      const open = parseAvatarAction(g.open);
      if (!open) continue;
      gestures.push([
        name,
        {
          name,
          open,
          close: parseAvatarAction(g.close),
          group: nonEmpty(g.group),
          holdMs: g.hold_ms,
          cooldownMs: g.cooldown_ms,
        },
      ]);
    }
    p.gestures = byName(gestures);
    for (const [emotion, pose] of p.poses) {
      for (const g of pose.gestures) {
        if (!p.gestures.has(g)) log.warn({ emotion, gesture: g }, "avatar.toml: unknown gesture");
      }
    }
    p.idle = {
      gestures: raw.idle.gesture.filter((g) => p.gestures.has(g)),
      everyMs: raw.idle.every_ms,
      afterMs: raw.idle.after_ms,
    };
    for (const [rawName, file] of Object.entries(raw.gift_expression)) {
      const name = rawName.trim().toLowerCase();
      const action = parseAvatarAction(file);
      if (!(GIFT_EXPRESSIONS as readonly string[]).includes(name)) {
        log.warn({ gift_expression: name }, "avatar.toml: unknown gift expression");
      } else if (action?.type !== "expression") {
        log.warn({ gift_expression: name }, "avatar.toml: a gift expression must be an .exp3.json");
      } else {
        p.giftExpressions.set(name as GiftExpression, action.file);
      }
    }
    const model = nonEmpty(raw.vts_model);
    p.vtsModel = model?.startsWith("<") ? null : model;
    p.lipsync = raw.lipsync.mode;
    p.mouthOpen = nonEmpty(raw.lipsync.mouth_open) ?? p.mouthOpen;
    if (raw.lipsync.mouth_form !== undefined && raw.lipsync.mouth_form !== null) {
      p.mouthForm = nonEmpty(raw.lipsync.mouth_form);
    }
    if (raw.lipsync.jaw !== undefined && raw.lipsync.jaw !== null) {
      p.jaw = nonEmpty(raw.lipsync.jaw);
    }
    p.vowels = raw.lipsync.vowels;
    for (const [v, params] of Object.entries(raw.lipsync.shape)) {
      const vowel = v.trim().toLowerCase();
      if ((VOWELS as readonly string[]).includes(vowel)) {
        p.shapes.set(vowel as Vowel, new Map(Object.entries(params)));
      }
    }
    return p;
  }

  /** Reads and parses an `avatar.toml` file. */
  static load(path: string): AvatarProfile {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      throw new AvatarProfileError(`cannot read ${path}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    let table: Record<string, unknown>;
    try {
      table = parseToml(text) as Record<string, unknown>;
    } catch (error) {
      throw new AvatarProfileError(`invalid ${path}: ${errorMessage(error)}`, { cause: error });
    }
    return AvatarProfile.parse(table);
  }

  actionFor(emotion: string): AvatarAction | null {
    return this.emotions.get(emotion.trim().toLowerCase()) ?? null;
  }

  /** The pose of an emotion (a default one when it has none). */
  poseFor(emotion: string): EmotionPose {
    return this.poses.get(emotion.trim().toLowerCase()) ?? defaultPose();
  }

  /** Emotions with an accent or a pose, `neutral` excluded. */
  knownEmotions(): Set<string> {
    const names = new Set([...this.emotions.keys(), ...this.poses.keys()]);
    names.delete("neutral");
    return names;
  }

  clone(): AvatarProfile {
    const p = new AvatarProfile();
    p.vtsModel = this.vtsModel;
    p.emotions = new Map(this.emotions);
    p.poses = new Map(this.poses);
    p.gestures = new Map(this.gestures);
    p.giftExpressions = new Map(this.giftExpressions);
    p.idle = { ...this.idle };
    p.lipsync = this.lipsync;
    p.mouthOpen = this.mouthOpen;
    p.mouthForm = this.mouthForm;
    p.jaw = this.jaw;
    p.vowels = this.vowels;
    p.shapes = new Map(this.shapes);
    return p;
  }
}
