// A contact sheet of daily cards, for a person to look at:
//
//   pnpm --filter @miyoria/card-studio sheet [out] [model.model3.json]
//
// Draws, through the same path the Core uses (`packages/play/cards/src/live2d.ts`, its disk cache
// in `<out>/cache`), one card per rarity, one per expression and one per part, each as her
// picture (`portrait-*.png`) and as the whole card (`card-*.png`, `packages/card-face` through resvg
// with the bundled fonts), and a sheet of each group (`sheet-*.png`). Default out:
// `.tmp-test/cards-sheet/` at the repository root. Needs `build` first (vendor.md).
//
// The workspace packages it borrows (the cards plugin, the card face, resvg and sharp from the
// api) are not dependencies of this tool: they are loaded from their folders, as a dev script may.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const out = resolve(process.argv[2] ?? join(repo, ".tmp-test/cards-sheet"));
const model = resolve(
  process.argv[3] ??
    "C:/Program Files (x86)/Steam/steamapps/common/VTube Studio/VTube Studio_Data/StreamingAssets/Live2DModels/DeepSeek-chan/大肥鱼.model3.json",
);

const load = (path: string) => import(pathToFileURL(join(repo, path)).href);
const cards = await load("packages/play/cards/src/catalogue.ts");
const expressionsMod = await load("packages/play/cards/src/expressions.ts");
const { Live2dPortrait } = await load("packages/play/cards/src/live2d.ts");
const { renderCardSvg } = await load("packages/card-face/src/render.tsx");
const { cardFontOptions } = await load("packages/card-face/src/fonts.ts");
const apiRequire = createRequire(join(repo, "packages/api/package.json"));
const { Resvg } = apiRequire("@resvg/resvg-js");
const sharp = apiRequire("sharp");

interface Part {
  id: string;
  slot: string;
  rarity: string;
  series: string | null;
  name: string;
  blank: boolean;
}
interface Expression {
  id: string;
  name: string;
}

const PARTS = new Map<string, Part>(
  (cards.SEED_PARTS as Part[]).map((p) => [
    p.id,
    { id: p.id, slot: p.slot, rarity: p.rarity, series: p.series, name: p.name, blank: p.blank },
  ]),
);
const EXPRESSIONS = expressionsMod.EXPRESSIONS as Record<string, Expression>;
const RANK = ["N", "R", "SR", "SSR"];

interface Sample {
  name: string;
  parts: string[];
  expression: string;
  seed: number;
}

/** A plain card to put one thing on: front, usual clothes, empty hands, her pink. */
const PLAIN = [
  "hand.none",
  "accessory.none",
  "outfit.usual",
  "pose.front",
  "background.gradient_pink",
];

function withPart(id: string): string[] {
  const slot = id.slice(0, id.indexOf("."));
  return PLAIN.map((p) => (p.startsWith(`${slot}.`) ? id : p));
}

const groups: Record<string, Sample[]> = {
  rarity: [
    {
      name: "N",
      parts: [
        "hand.none",
        "accessory.glasses",
        "outfit.usual",
        "pose.tilt_left",
        "background.bokeh",
      ],
      expression: "smile",
      seed: 11,
    },
    {
      name: "R",
      parts: [
        "hand.finger",
        "accessory.none",
        "outfit.long_skirt",
        "pose.turn_right",
        "background.stars",
      ],
      expression: "blush",
      seed: 22,
    },
    {
      name: "SR",
      parts: [
        "hand.foxtail",
        "accessory.basin",
        "outfit.top",
        "pose.lean_in",
        "background.night_sky",
      ],
      expression: "heart_eyes",
      seed: 33,
    },
    {
      name: "SSR",
      parts: [
        "hand.chest",
        "accessory.monocle_tail",
        "outfit.long_skirt",
        "pose.sway",
        "background.aurora",
      ],
      expression: "fangs",
      seed: 44,
    },
  ],
  expression: Object.keys(EXPRESSIONS).map((id, i) => ({
    name: id,
    parts: PLAIN,
    expression: id,
    seed: 100 + i,
  })),
  part: [...PARTS.values()]
    .filter((p) => !p.blank)
    .map((p, i) => ({
      name: p.id,
      parts: withPart(p.id),
      expression: "calm",
      seed: 200 + i,
    })),
};

const portrait = new Live2dPortrait({
  studioDir: resolve(here, ".."),
  model,
  cacheDir: join(out, "cache"),
  timeoutMs: 60_000,
  log: {
    warn: (f: object, m: string) => console.warn("warn", m, JSON.stringify(f)),
    info: (f: object, m: string) => console.log("info", m, JSON.stringify(f)),
    debug: () => undefined,
  },
});

const toDataUrl = (type: string, bytes: Uint8Array) =>
  `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

/** The whole card, as the Core's link preview draws it (`packages/api/src/og.ts`). */
async function card(sample: Sample, png: Uint8Array | null, n: number): Promise<Buffer> {
  const parts = sample.parts.map((id) => PARTS.get(id)).filter((p): p is Part => !!p);
  const rarity = parts.reduce(
    (r, p) => (RANK.indexOf(p.rarity) > RANK.indexOf(r) ? p.rarity : r),
    "N",
  );
  const art =
    png === null
      ? null
      : toDataUrl(
          "image/jpeg",
          await sharp(png)
            .resize({ width: 1000 })
            .flatten({ background: "#000000" })
            .jpeg({ quality: 88 })
            .toBuffer(),
        );
  const svg = renderCardSvg({
    card: {
      serial: `SHEET${String(n).padStart(4, "0")}`,
      issued_at: "2026-11-17T12:00:00.000Z",
      name: "看卡的人",
      number: n,
      call_name: "小魚乾",
      relationship: "好朋友",
      affinity: "很喜歡",
      trust: "信任",
      familiarity: "熟",
      public_feeling: null,
      line: "今天也一起玩吧，這張是給你的。",
      stamp: "收好",
      fields: [],
      frame: null,
      foil: rarity === "SSR",
      rarity,
      parts: parts.filter((p) => !p.blank).map((p) => ({ name: p.name })),
      expression: EXPRESSIONS[sample.expression]?.name ?? null,
    },
    art,
    avatar: null,
    colors: { primary: "#f29dc4", secondary: "#7355e8" },
    verifyUrl: "https://miyoria.invalid/card/SHEET",
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 630 }, font: cardFontOptions() });
  return resvg.render().asPng();
}

/** A sheet of `files`, five a row, each with its name above it. */
async function sheet(name: string, files: { label: string; png: Buffer }[], w: number) {
  if (files.length === 0) return;
  const h = Math.round((w * 880) / 630);
  const cols = Math.min(5, files.length);
  const rows = Math.ceil(files.length / cols);
  const label = 26;
  const layers = [];
  for (const [i, f] of files.entries()) {
    const x = (i % cols) * (w + 10);
    const y = Math.floor(i / cols) * (h + label + 10);
    const text = f.label.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    layers.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${label}"><text x="2" y="18" font-size="15" fill="#ddd" font-family="Noto Sans TC">${text}</text></svg>`,
      ),
      left: x,
      top: y,
    });
    layers.push({
      input: await sharp(f.png)
        .resize(w, h, { fit: "contain", background: "#00000000" })
        .png()
        .toBuffer(),
      left: x,
      top: y + label,
    });
  }
  await sharp({
    create: {
      width: cols * (w + 10),
      height: rows * (h + label + 10),
      channels: 4,
      background: "#202228",
    },
  })
    .composite(layers)
    .png()
    .toFile(join(out, `sheet-${name}.png`));
}

mkdirSync(out, { recursive: true });
let n = 1;
const times: number[] = [];
try {
  for (const [group, samples] of Object.entries(groups)) {
    const cardsOf: { label: string; png: Buffer }[] = [];
    for (const s of samples) {
      const parts = s.parts.map((id) => PARTS.get(id)).filter((p): p is Part => !!p);
      const t = performance.now();
      const png = await portrait.render({
        parts,
        expression: EXPRESSIONS[s.expression] ?? { id: s.expression, name: s.expression },
        seed: s.seed,
      });
      const ms = Math.round(performance.now() - t);
      times.push(ms);
      const file = `${group}-${s.name.replace(/[^a-z0-9_.-]/gi, "_")}`;
      if (png !== null) writeFileSync(join(out, `portrait-${file}.png`), png);
      const face = await card(s, png, n++);
      writeFileSync(join(out, `card-${file}.png`), face);
      cardsOf.push({ label: `${s.name}${png === null ? " (fixed)" : ""}`, png: face });
      console.log(`${file}\t${png === null ? "fallback" : `${png.length} bytes`}\t${ms} ms`);
    }
    await sheet(group, cardsOf, 300);
  }
} finally {
  await portrait.close();
}
console.log(
  `first ${times[0]} ms; then median ${times.slice(1).sort((a, b) => a - b)[Math.floor((times.length - 1) / 2)]} ms`,
);
console.log(out);
