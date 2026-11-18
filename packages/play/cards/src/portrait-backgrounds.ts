// The backgrounds of a daily card (docs/design/cards.md §5): drawn by program, not game art. Her
// colours, light spots, stars, water and the night sky, each an SVG made from the card's seed, so
// the same card always gets the same sky and two cards with the same background still differ a
// little. The renderer draws the SVG behind her (`tools/card-studio`); the owner's own pictures can
// join later as new parts with a picture instead of a drawing.

import { type Random, seededRandom } from "./draw.js";
import type { BackgroundId } from "./portrait-looks.js";

/** Her two colours (the panel's) and the blue of her hair. */
const PINK = "#f29dc4";
const VIOLET = "#7355e8";
const BLUE = "#4f8dff";
const CYAN = "#7fe3ff";
const GOLD = "#ffd58a";

/** A number with at most two decimals, so the SVG stays short and stable. */
const n = (x: number) => String(Math.round(x * 100) / 100);

function between(random: Random, lo: number, hi: number): number {
  return lo + random() * (hi - lo);
}

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))] as T;
}

interface Canvas {
  w: number;
  h: number;
  random: Random;
  defs: string[];
  body: string[];
}

function linear(c: Canvas, id: string, stops: readonly [number, string][], angle = 90): string {
  const rad = (angle * Math.PI) / 180;
  const x = Math.cos(rad) / 2;
  const y = Math.sin(rad) / 2;
  c.defs.push(
    `<linearGradient id="${id}" x1="${n(0.5 - x)}" y1="${n(0.5 - y)}" x2="${n(0.5 + x)}" y2="${n(0.5 + y)}">${stops
      .map(([o, col]) => `<stop offset="${n(o)}" stop-color="${col}"/>`)
      .join("")}</linearGradient>`,
  );
  return `url(#${id})`;
}

function blur(c: Canvas, id: string, sd: number): string {
  c.defs.push(
    `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n(sd)}"/></filter>`,
  );
  return `url(#${id})`;
}

function sky(c: Canvas, stops: readonly [number, string][]): void {
  c.body.push(`<rect width="${c.w}" height="${c.h}" fill="${linear(c, "sky", stops)}"/>`);
}

/** A soft round light. */
function glow(c: Canvas, x: number, y: number, r: number, colour: string, opacity: number): void {
  const id = `glow${c.defs.length}`;
  c.defs.push(
    `<radialGradient id="${id}"><stop offset="0" stop-color="${colour}" stop-opacity="${n(opacity)}"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></radialGradient>`,
  );
  c.body.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="url(#${id})"/>`);
}

/** Out-of-focus lights: discs, some sharp, most blurred. */
function bokeh(c: Canvas, count: number, colours: readonly string[], top = 0, bottom = 1): void {
  const soft = blur(c, "bokeh-soft", c.w * 0.012);
  const softer = blur(c, "bokeh-softer", c.w * 0.03);
  for (let i = 0; i < count; i++) {
    const r = between(c.random, c.w * 0.02, c.w * 0.1);
    const filter = c.random() < 0.6 ? softer : soft;
    c.body.push(
      `<circle cx="${n(between(c.random, 0, c.w))}" cy="${n(between(c.random, top * c.h, bottom * c.h))}" r="${n(r)}" fill="${pick(c.random, colours)}" fill-opacity="${n(between(c.random, 0.18, 0.55))}" filter="${filter}"/>`,
    );
  }
}

/** Points of light, denser toward the top; a few are four-pointed sparkles. */
function stars(c: Canvas, count: number, bottom = 0.75, sparkles = 0): void {
  const dots: string[] = [];
  for (let i = 0; i < count; i++) {
    const y = c.random() ** 1.6 * bottom * c.h;
    dots.push(
      `<circle cx="${n(between(c.random, 0, c.w))}" cy="${n(y)}" r="${n(between(c.random, 0.6, 2.1) * (c.w / 900))}" fill-opacity="${n(between(c.random, 0.35, 1))}"/>`,
    );
  }
  c.body.push(`<g fill="#ffffff">${dots.join("")}</g>`);
  const glowing = blur(c, "star-glow", c.w * 0.004);
  for (let i = 0; i < sparkles; i++) {
    const x = between(c.random, 0.05, 0.95) * c.w;
    const y = between(c.random, 0.03, bottom * 0.8) * c.h;
    const s = between(c.random, 8, 18) * (c.w / 900);
    const t = s * 0.18;
    c.body.push(
      `<path d="M${n(x)} ${n(y - s)} L${n(x + t)} ${n(y - t)} L${n(x + s)} ${n(y)} L${n(x + t)} ${n(y + t)} L${n(x)} ${n(y + s)} L${n(x - t)} ${n(y + t)} L${n(x - s)} ${n(y)} L${n(x - t)} ${n(y - t)} Z" fill="#ffffff" fill-opacity="0.9" filter="${glowing}"/>`,
    );
  }
}

/** A band of water from `horizon` (a fraction of the height) down, with glints on it. */
function water(
  c: Canvas,
  horizon: number,
  stops: readonly [number, string][],
  glints: number,
  column: number | null = null,
): void {
  const top = horizon * c.h;
  const fill = linear(c, "water", stops);
  c.body.push(`<rect y="${n(top)}" width="${c.w}" height="${n(c.h - top)}" fill="${fill}"/>`);
  const lines: string[] = [];
  for (let i = 0; i < glints; i++) {
    const depth = c.random();
    const y = top + depth ** 1.4 * (c.h - top);
    const near = column !== null && c.random() < 0.6;
    const x = near ? column + between(c.random, -0.06, 0.06) * c.w : between(c.random, 0, c.w);
    const len = between(c.random, 0.02, 0.09) * c.w * (0.5 + depth);
    lines.push(
      `<rect x="${n(x - len / 2)}" y="${n(y)}" width="${n(len)}" height="${n(1.2 + depth * 2.5)}" rx="1" fill-opacity="${n(between(c.random, 0.15, near ? 0.8 : 0.5))}"/>`,
    );
  }
  c.body.push(`<g fill="#ffffff">${lines.join("")}</g>`);
  c.body.push(
    `<rect y="${n(top - 1)}" width="${c.w}" height="2" fill="#ffffff" fill-opacity="0.25"/>`,
  );
}

/**
 * Where water meets the sky, as a fraction of the height: high, because only the top half of the
 * picture shows above the card's words.
 */
const HORIZON = 0.36;

const NIGHT: readonly [number, string][] = [
  [0, "#070b22"],
  [0.55, "#151a45"],
  [1, "#271a4a"],
];

function draw(c: Canvas, id: BackgroundId): void {
  const { w, h, random } = c;
  switch (id) {
    case "gradient_pink":
      sky(c, [
        [0, "#ffd3e6"],
        [0.45, PINK],
        [1, "#5b3a8f"],
      ]);
      glow(
        c,
        between(random, 0.55, 0.9) * w,
        between(random, 0.08, 0.25) * h,
        w * 0.6,
        "#ffffff",
        0.55,
      );
      glow(c, between(random, 0, 0.3) * w, between(random, 0.4, 0.6) * h, w * 0.5, VIOLET, 0.35);
      break;
    case "gradient_blue":
      sky(c, [
        [0, "#cdeeff"],
        [0.45, BLUE],
        [1, "#1f2466"],
      ]);
      glow(
        c,
        between(random, 0.1, 0.45) * w,
        between(random, 0.08, 0.25) * h,
        w * 0.6,
        "#ffffff",
        0.5,
      );
      glow(c, between(random, 0.6, 1) * w, between(random, 0.4, 0.6) * h, w * 0.5, CYAN, 0.35);
      break;
    case "bokeh":
      sky(c, [
        [0, "#ffd9ec"],
        [0.5, "#c58ad9"],
        [1, "#3a2766"],
      ]);
      bokeh(c, 26, ["#ffffff", PINK, "#ffe9a8", CYAN]);
      break;
    case "bokeh_night":
      sky(c, [
        [0, "#0c1030"],
        [0.6, "#1d1747"],
        [1, "#2c1b44"],
      ]);
      bokeh(c, 32, [GOLD, PINK, CYAN, "#ff9e6b", VIOLET]);
      break;
    case "stars":
      sky(c, [
        [0, "#11183f"],
        [0.6, "#2a2560"],
        [1, "#3d2a5f"],
      ]);
      glow(c, between(random, 0.2, 0.8) * w, 0.35 * h, w * 0.7, VIOLET, 0.25);
      stars(c, 170, 0.8, 7);
      break;
    case "water":
      sky(c, [
        [0, "#bfe4ff"],
        [0.5, "#ffd6ea"],
        [1, "#ffd6ea"],
      ]);
      glow(c, between(random, 0.3, 0.7) * w, HORIZON * h, w * 0.45, "#ffffff", 0.8);
      water(
        c,
        HORIZON,
        [
          [0, "#8cc2f2"],
          [0.5, "#3f78c9"],
          [1, "#173068"],
        ],
        70,
      );
      break;
    case "night_sky": {
      sky(c, NIGHT);
      const band = blur(c, "band", w * 0.06);
      const angle = between(random, -35, -15);
      c.body.push(
        `<ellipse cx="${n(w / 2)}" cy="${n(h * 0.32)}" rx="${n(w * 0.9)}" ry="${n(h * 0.09)}" fill="${VIOLET}" fill-opacity="0.45" filter="${band}" transform="rotate(${n(angle)} ${n(w / 2)} ${n(h * 0.32)})"/>`,
        `<ellipse cx="${n(w / 2)}" cy="${n(h * 0.32)}" rx="${n(w * 0.7)}" ry="${n(h * 0.035)}" fill="${CYAN}" fill-opacity="0.3" filter="${band}" transform="rotate(${n(angle)} ${n(w / 2)} ${n(h * 0.32)})"/>`,
      );
      stars(c, 300, 0.85, 5);
      break;
    }
    case "moon_water": {
      sky(c, NIGHT);
      stars(c, 150, HORIZON, 3);
      const x = between(random, 0.2, 0.8) * w;
      const y = between(random, 0.07, 0.15) * h;
      const r = w * 0.075;
      glow(c, x, y, r * 4, "#c9d8ff", 0.45);
      c.body.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="#fdf6e3"/>`);
      water(
        c,
        HORIZON,
        [
          [0, "#1b2d66"],
          [1, "#070b22"],
        ],
        90,
        x,
      );
      break;
    }
    case "meteor": {
      sky(c, NIGHT);
      stars(c, 220, 0.85, 4);
      c.defs.push(
        `<linearGradient id="trail" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.95"/></linearGradient>`,
      );
      const soft = blur(c, "trail-glow", w * 0.003);
      const count = 3 + Math.floor(random() * 3);
      for (let i = 0; i < count; i++) {
        const x = between(random, 0.1, 1) * w;
        const y = between(random, 0.03, 0.45) * h;
        const len = between(random, 0.18, 0.4) * w;
        const angle = between(random, 140, 160);
        c.body.push(
          `<g transform="translate(${n(x)} ${n(y)}) rotate(${n(angle)})" filter="${soft}"><rect x="${n(-len)}" y="-1.6" width="${n(len)}" height="3.2" rx="1.6" fill="url(#trail)"/><circle r="3.4" fill="#ffffff"/></g>`,
        );
      }
      break;
    }
    case "aurora": {
      sky(c, [
        [0, "#04101f"],
        [0.6, "#0c1d36"],
        [1, "#1a1838"],
      ]);
      stars(c, 200, 0.8, 3);
      const soft = blur(c, "curtain", w * 0.025);
      const colours = ["#5ef2c0", CYAN, VIOLET];
      for (let i = 0; i < 3; i++) {
        const id = `curtain${i}`;
        const colour = colours[i] as string;
        c.defs.push(
          `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colour}" stop-opacity="0"/><stop offset="0.45" stop-color="${colour}" stop-opacity="0.75"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></linearGradient>`,
        );
        const base = between(random, 0.1, 0.3) * h;
        const amp = between(random, 0.04, 0.09) * h;
        const phase = random() * Math.PI * 2;
        const pts: string[] = [];
        for (let k = 0; k <= 12; k++) {
          const x = (k / 12) * w * 1.2 - w * 0.1;
          pts.push(`${n(x)} ${n(base + Math.sin(k * 0.7 + phase) * amp)}`);
        }
        const height = between(random, 0.22, 0.35) * h;
        const back = pts
          .slice()
          .reverse()
          .map((p) => {
            const [x, y] = p.split(" ").map(Number) as [number, number];
            return `${n(x)} ${n(y + height)}`;
          });
        c.body.push(
          `<path d="M${pts.join(" L")} L${back.join(" L")} Z" fill="url(#${id})" fill-opacity="0.7" filter="${soft}"/>`,
        );
      }
      break;
    }
    case "fireworks": {
      sky(c, [
        [0, "#0a0b26"],
        [0.6, "#1d1442"],
        [1, "#2e1840"],
      ]);
      stars(c, 90, 0.7, 0);
      const soft = blur(c, "spark", w * 0.0035);
      const count = 3 + Math.floor(random() * 2);
      for (let i = 0; i < count; i++) {
        const x = between(random, 0.1, 0.9) * w;
        const y = between(random, 0.08, 0.42) * h;
        const r = between(random, 0.1, 0.2) * w;
        const colour = pick(random, [PINK, GOLD, CYAN, "#b99bff", "#ff8f8f"]);
        const rays = 22 + Math.floor(random() * 14);
        glow(c, x, y, r * 1.3, colour, 0.25);
        const dots: string[] = [];
        for (let k = 0; k < rays; k++) {
          const a = (k / rays) * Math.PI * 2 + random() * 0.1;
          for (let s = 1; s <= 4; s++) {
            const d = (r * s) / 4;
            dots.push(
              `<circle cx="${n(x + Math.cos(a) * d)}" cy="${n(y + Math.sin(a) * d)}" r="${n((1 + s * 0.5) * (w / 900))}" fill-opacity="${n(0.25 + s * 0.18)}"/>`,
            );
          }
        }
        c.body.push(`<g fill="${colour}" filter="${soft}">${dots.join("")}</g>`);
      }
      break;
    }
  }
}

/** The background `id` as an SVG of `width` × `height`, the same for the same `seed`. */
export function backgroundSvg(
  id: BackgroundId,
  seed: number,
  width: number,
  height: number,
): string {
  // Its own stream of the seed: the pose's offsets do not move the stars.
  const c: Canvas = {
    w: width,
    h: height,
    random: seededRandom((seed ^ 0x5bd1e995) >>> 0),
    defs: [],
    body: [],
  };
  draw(c, id);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${c.defs.join("")}</defs>${c.body.join("")}</svg>`;
}
