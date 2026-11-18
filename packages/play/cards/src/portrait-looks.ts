// What each part and expression of a card looks like on her Live2D model (docs/design/cards.md
// §3–§6): the table the live portrait is drawn from (`portrait-spec.ts`). A test keeps it whole:
// every part of the catalogue and every expression has a row, and no row names something that is
// gone.
//
// The model is DeepSeek-chan (VTube Studio's 大肥鱼). Its toggles are parameters (`key1`..`key13`,
// `Movement1`..`3`, `Clothes1`..`5`) with an expression file each in `Exp3/`, and the hand gestures
// are motions in `Animation/` whose last frame is the hand in place. Rows name those files rather
// than their parameters where a file exists, so the table follows the model's own toggles.
//
// How a part is shown:
// - `model`: by the model (its files and parameters), with the framing it needs to be seen;
// - `background`: drawn behind her (`portrait-backgrounds.ts`), the model has none;
// - `nothing`: a blank part (an empty hand, no accessory): her default.

/** Parameters and the model's own files that make one look. */
export interface ModelLook {
  /** Motions (relative to the model's folder) held at their last frame, in order. */
  motions?: readonly string[];
  /** Parameters set outright. */
  set?: Readonly<Record<string, number>>;
  /** Expression files (relative to the model's folder), each with its own blend. */
  expressions?: readonly string[];
  /** Parameters added after everything else. */
  add?: Readonly<Record<string, number>>;
}

/** How much of her a picture must show: the part that decides it is the lowest one. */
export type Framing = "bust" | "crown" | "knee" | "full";

/**
 * The band of the model (in its units: the canvas is -1..1 high, her head's top about 0.82, her
 * feet about -0.92) that a framing keeps in the clear top half of the card, above the words.
 */
export const FRAMINGS: Readonly<Record<Framing, { top: number; bottom: number }>> = {
  /** Head to chest: the face, the hands and what she holds. */
  bust: { top: 0.9, bottom: 0.2 },
  /** The same with room above her head, for what sits on it. */
  crown: { top: 1.04, bottom: 0.24 },
  /** Down to the hips, the rest of her under the words: the skirts and the tail. */
  knee: { top: 0.9, bottom: -0.3 },
  /** Head to toe: the shoes. */
  full: { top: 0.9, bottom: -0.95 },
};

/** The names of the procedural backgrounds (`portrait-backgrounds.ts`). */
export const BACKGROUNDS = [
  "gradient_pink",
  "gradient_blue",
  "bokeh",
  "bokeh_night",
  "stars",
  "water",
  "night_sky",
  "moon_water",
  "meteor",
  "aurora",
  "fireworks",
] as const;
export type BackgroundId = (typeof BACKGROUNDS)[number];

export type PartLook =
  | ({ shown: "model"; framing?: Framing } & ModelLook)
  | { shown: "background"; background: BackgroundId }
  | { shown: "nothing" };

/**
 * Every card starts from this: the model's defaults (the short skirt, her shoes, the open collar)
 * without the tail, which is a part of its own here (the model shows it by default).
 */
export const BASE_LOOK: ModelLook = { set: { Clothes5: 0 } };

const EXP = (name: string) => `Exp3/${name}.exp3.json`;
const MOTION = (name: string) => `Animation/${name}.motion3.json`;

/** The tail on: `Clothes5` back at the model's own 1 (`尾巴开关` takes it off). */
const TAIL = { Clothes5: 1 };

/** One row per part of the catalogue (`catalogue.ts`), by part id. */
export const PART_LOOKS: Readonly<Record<string, PartLook>> = {
  // ---- hand: a gesture's motion, held at its last frame (the arm is in place there) ----
  "hand.none": { shown: "nothing" },
  "hand.finger": { shown: "model", motions: [MOTION("竖手指切出来动画")] },
  "hand.chest": { shown: "model", motions: [MOTION("默认手切举手")] },
  "hand.foxtail": { shown: "model", motions: [MOTION("狗尾草切换出来")] },

  // ---- accessory ----
  "accessory.none": { shown: "nothing" },
  "accessory.glasses": { shown: "model", expressions: [EXP("黑框眼镜")] },
  "accessory.tail": { shown: "model", framing: "knee", set: TAIL },
  "accessory.monocle": { shown: "model", expressions: [EXP("单片眼镜")] },
  "accessory.basin": { shown: "model", framing: "crown", expressions: [EXP("钢盆")] },
  "accessory.monocle_tail": {
    shown: "model",
    framing: "knee",
    set: TAIL,
    expressions: [EXP("单片眼镜")],
  },

  // ---- outfit: the usual one is the model's default; the short skirt is that skirt, framed to
  // the knees so the card shows it (the model has two lengths, and the short one is its default).
  // The short skirt is no longer drawn (migration 9); its row stays for the cards that have it ----
  "outfit.usual": { shown: "model" },
  "outfit.long_skirt": { shown: "model", framing: "knee", expressions: [EXP("裙子切换")] },
  "outfit.short_skirt": { shown: "model", framing: "knee" },
  "outfit.shoes": { shown: "model", framing: "full", expressions: [EXP("脱鞋")] },
  "outfit.top": { shown: "model", expressions: [EXP("胸口衣服")] },

  // ---- pose: the parameters VTube Studio drives (cards.md §3); `ParamAngle*` are not wired ----
  "pose.front": { shown: "model", set: {} },
  "pose.tilt_left": { shown: "model", set: { AngleZ: 28, PositionZ: 20 } },
  "pose.tilt_right": { shown: "model", set: { AngleZ: -28, PositionZ: -20 } },
  "pose.look_up": { shown: "model", set: { AngleY: 26, ParamEyeBallY: 0.3 } },
  "pose.lean_in": { shown: "model", set: { LeanInput: -30, AngleY: -10 } },
  "pose.shy": {
    shown: "model",
    set: { AngleY: -24, AngleZ: 14, ParamEyeBallY: 0.6, ParamEyeBallX: -0.2 },
  },
  "pose.sway": { shown: "model", set: { PositionZ: 30, AngleZ: -20, AngleX: 22 } },
  "pose.turn_left": {
    shown: "model",
    set: { AngleX: 30, PositionX: 25, ParamEyeBallX: -0.7 },
  },
  "pose.turn_right": {
    shown: "model",
    set: { AngleX: -30, PositionX: -25, ParamEyeBallX: 0.7 },
  },

  // ---- background: drawn behind her, the model has none ----
  "background.gradient_pink": { shown: "background", background: "gradient_pink" },
  "background.gradient_blue": { shown: "background", background: "gradient_blue" },
  "background.bokeh": { shown: "background", background: "bokeh" },
  "background.bokeh_night": { shown: "background", background: "bokeh_night" },
  "background.stars": { shown: "background", background: "stars" },
  "background.water": { shown: "background", background: "water" },
  "background.night_sky": { shown: "background", background: "night_sky" },
  "background.moon_water": { shown: "background", background: "moon_water" },
  "background.meteor": { shown: "background", background: "meteor" },
  "background.aurora": { shown: "background", background: "aurora" },
  "background.fireworks": { shown: "background", background: "fireworks" },
};

/** A smile's mouth: open a little, corners up. */
const SMILE = { ParamMouthForm: 1, ParamMouthOpenY: 0.35, JawOpen: 0.3 };

/**
 * One row per expression (`expressions.ts`): the model's expression file (its toggle) and the
 * mouth, brows and eyes that go with it. Tears and sweat are animated in the model's idle motion;
 * here they are held at a frame where they show.
 */
export const EXPRESSION_LOOKS: Readonly<Record<string, ModelLook>> = {
  calm: {},
  smile: { set: { ...SMILE, ParamEyeLOpen: 0.9, ParamEyeROpen: 0.9 } },
  blush: { expressions: [EXP("脸红")], set: { ParamMouthForm: 0.6 } },
  heart_eyes: { expressions: [EXP("爱心眼")], set: SMILE },
  squint: { expressions: [EXP("＞＜")], set: { ParamMouthForm: 0.8, ParamMouthOpenY: 0.3 } },
  smug: { expressions: [EXP("屑屑眼")], set: { ParamMouthForm: 0.4 } },
  cold_sweat: {
    expressions: [EXP("流冷汗")],
    set: {
      ParamMouthForm: -0.6,
      BrowInnerUp: 1,
      SweatBurst1: 0.4,
      SweatBurst2: 1,
      SweatBurst3: 0.9,
      SweatBurst4: 1,
      SweatBurst5: 0.7,
      SweatBurst6: 1,
      Sweat1: 0.5,
      Sweat2: 0.5,
    },
  },
  tears: {
    expressions: [EXP("流泪")],
    set: {
      BrowInnerUp: 0.8,
      ParamMouthForm: -0.3,
      RCry: 1,
      LCry: 1,
      RCry2: 1,
      LCry3: 1,
      Param27: 1,
      Param28: 1,
      Param29: 1,
      Param30: 1,
    },
  },
  swirl_eyes: { expressions: [EXP("圈圈眼")], set: { ParamMouthForm: -0.2 } },
  black_face: { expressions: [EXP("黑脸")], set: { ParamMouthForm: -1 } },
  fangs: { expressions: [EXP("兔牙")], set: SMILE },
};
