// Her live picture on a card: the look table covers every part and expression, the spec a draw
// becomes is the same for the same seed, and the renderer falls back (answers `null`, warns once)
// whenever it cannot draw. Real rendering runs only where Live2D's files, the studio's build and
// the model are on the machine; CI has none of them, so that test skips there.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { SEED_PARTS } from "../src/catalogue.js";
import { cardsConfig } from "../src/config.js";
import type { DrawnPart } from "../src/draw.js";
import { drawnPart } from "../src/draw.js";
import { EXPRESSIONS } from "../src/expressions.js";
import {
  Live2dPortrait,
  type Live2dPortraitOptions,
  livePortrait,
  type PortraitConfig,
  STUDIO_ENTRY,
  type Studio,
  type StudioModule,
} from "../src/live2d.js";
import type { PortraitInput } from "../src/portrait.js";
import { backgroundSvg } from "../src/portrait-backgrounds.js";
import {
  BACKGROUNDS,
  EXPRESSION_LOOKS,
  FRAMINGS,
  type ModelLook,
  PART_LOOKS,
} from "../src/portrait-looks.js";
import {
  PORTRAIT_HEIGHT,
  PORTRAIT_WIDTH,
  portraitSpec,
  SEED_OFFSETS,
} from "../src/portrait-spec.js";

const part = (id: string): DrawnPart => {
  const p = SEED_PARTS.find((x) => x.id === id);
  if (!p) throw new Error(`no part ${id}`);
  return drawnPart(p);
};

const PLAIN = ["hand.none", "accessory.none", "outfit.usual", "pose.front", "background.bokeh"];

const input = (ids = PLAIN, seed = 7, expression = "calm"): PortraitInput => ({
  parts: ids.map(part),
  expression: EXPRESSIONS[expression as keyof typeof EXPRESSIONS],
  seed,
});

describe("the look table", () => {
  it("has a row for every part of the catalogue, and none for a part that is gone", () => {
    const ids = SEED_PARTS.map((p) => p.id);
    expect(Object.keys(PART_LOOKS).sort()).toEqual([...ids].sort());
    // A disabled part keeps its row: the cards drawn before it was turned off still show it.
    const off = SEED_PARTS.filter((p) => !p.enabled).map((p) => p.id);
    expect(off).toEqual(["outfit.short_skirt"]);
    for (const id of off) expect(PART_LOOKS[id], id).toBeDefined();
  });

  it("has a row for every expression, and none for one that is gone", () => {
    expect(Object.keys(EXPRESSION_LOOKS).sort()).toEqual(Object.keys(EXPRESSIONS).sort());
  });

  it("shows a blank part as nothing, a background behind her, everything else on the model", () => {
    for (const p of SEED_PARTS) {
      const look = PART_LOOKS[p.id];
      if (p.blank) expect(look?.shown, p.id).toBe("nothing");
      else if (p.slot === "background") expect(look?.shown, p.id).toBe("background");
      else expect(look?.shown, p.id).toBe("model");
    }
  });

  it("names each background once, and every background draws", () => {
    const used = Object.values(PART_LOOKS).flatMap((l) =>
      l.shown === "background" ? [l.background] : [],
    );
    expect([...used].sort()).toEqual([...BACKGROUNDS].sort());
    for (const id of BACKGROUNDS) {
      const svg = backgroundSvg(id, 1, 90, 120);
      expect(svg.startsWith("<svg"), id).toBe(true);
      expect(svg.length, id).toBeGreaterThan(200);
    }
  });

  it("names only the model's files by their folders", () => {
    const looks: ModelLook[] = [
      ...Object.values(PART_LOOKS).flatMap((l) => (l.shown === "model" ? [l] : [])),
      ...Object.values(EXPRESSION_LOOKS),
    ];
    for (const look of looks) {
      for (const f of look.expressions ?? []) expect(f).toMatch(/^Exp3\/.+\.exp3\.json$/);
      for (const f of look.motions ?? []) expect(f).toMatch(/^Animation\/.+\.motion3\.json$/);
    }
  });
});

describe("a draw as a picture", () => {
  it("is the same for the same card", () => {
    expect(portraitSpec(input())).toEqual(portraitSpec(input()));
  });

  it("differs a little with the seed, within the offsets", () => {
    const a = portraitSpec(input(PLAIN, 1));
    const b = portraitSpec(input(PLAIN, 2));
    expect(a).not.toEqual(b);
    for (const seed of [0, 1, 2, 99, 2 ** 31 - 1]) {
      const s = portraitSpec(input(PLAIN, seed));
      for (const [id, max] of Object.entries(SEED_OFFSETS)) {
        expect(Math.abs(s.set[id] ?? 0), `${id} @ ${seed}`).toBeLessThanOrEqual(max + 1e-9);
      }
    }
  });

  it("holds the parts' and the expression's files, and starts without the tail", () => {
    const s = portraitSpec(
      input(
        ["hand.foxtail", "accessory.glasses", "outfit.top", "pose.lean_in", "background.stars"],
        3,
        "blush",
      ),
    );
    expect(s.motions).toEqual(["Animation/狗尾草切换出来.motion3.json"]);
    expect(s.expressions).toEqual([
      "Exp3/黑框眼镜.exp3.json",
      "Exp3/胸口衣服.exp3.json",
      "Exp3/脸红.exp3.json",
    ]);
    expect(s.set.Clothes5).toBe(0);
    expect(s.set.LeanInput).toBe(-30);
    expect(s.background).toContain("<svg");
    expect([s.width, s.height]).toEqual([PORTRAIT_WIDTH, PORTRAIT_HEIGHT]);
  });

  it("frames her lower for parts that are lower on her", () => {
    const bust = portraitSpec(input(PLAIN, 5));
    const tail = portraitSpec(
      input(["hand.none", "accessory.tail", "outfit.usual", "pose.front", "background.bokeh"], 5),
    );
    const shoes = portraitSpec(
      input(["hand.none", "accessory.none", "outfit.shoes", "pose.front", "background.bokeh"], 5),
    );
    expect(tail.set.Clothes5).toBe(1);
    expect(tail.zoom).toBeLessThan(bust.zoom);
    expect(shoes.zoom).toBeLessThan(tail.zoom);
    // The framed band's top stays near the top of the picture whatever the zoom.
    for (const s of [bust, tail, shoes]) {
      const top = s.centerY + 1 / s.zoom;
      expect(top).toBeGreaterThan(FRAMINGS.bust.top);
    }
  });

  it("ignores a part it has no row for and an unknown expression", () => {
    const s = portraitSpec({
      parts: [{ id: "hand.someday" }, ...PLAIN.map(part)],
      expression: { id: "someday" },
      seed: 4,
    });
    expect(s).toEqual(
      portraitSpec({ parts: PLAIN.map(part), expression: { id: "calm" }, seed: 4 }),
    );
  });
});

// ---- the renderer ---------------------------------------------------------------------------

function scratch(): string {
  const root = join(process.env.TMP ?? tmpdir(), "portrait-test");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "p-"));
}

/** A studio folder with a (fake) build, and a model file. */
function setup(): { studioDir: string; model: string; cacheDir: string } {
  const dir = scratch();
  const studioDir = join(dir, "studio");
  mkdirSync(join(studioDir, dirname(STUDIO_ENTRY)), { recursive: true });
  writeFileSync(join(studioDir, STUDIO_ENTRY), "");
  const model = join(dir, "model", "her.model3.json");
  mkdirSync(dirname(model), { recursive: true });
  writeFileSync(model, "{}");
  return { studioDir, model, cacheDir: join(dir, "cache") };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function fakeStudio(render: Studio["render"], missing: string | null = null) {
  const calls = { render: 0, stop: 0, created: 0 };
  const mod: StudioModule = {
    CardStudio: class {
      constructor() {
        calls.created++;
      }
      render(spec: Parameters<Studio["render"]>[0]) {
        calls.render++;
        return render(spec);
      }
      async stop() {
        calls.stop++;
      }
    },
    missingFiles: () => missing,
  };
  return { mod, calls };
}

function portraitWith(
  options: Partial<Live2dPortraitOptions> &
    Pick<Live2dPortraitOptions, "studioDir" | "model" | "cacheDir">,
) {
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const portrait = new Live2dPortrait({ timeoutMs: 1_000, log, ...options });
  return { portrait, log };
}

describe("the Live2D portrait", () => {
  it("answers null and says so once when no model is set", async () => {
    const { studioDir, cacheDir } = setup();
    const { portrait, log } = portraitWith({ studioDir, cacheDir, model: "" });
    expect(await portrait.render(input())).toBeNull();
    expect(await portrait.render(input())).toBeNull();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(portrait.unavailable).toMatch(/no model/);
  });

  it("is not provided for fixed portraits, nor where it cannot render", () => {
    const { studioDir, model, cacheDir } = setup();
    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const config: PortraitConfig = {
      portrait: "live2d",
      portrait_studio: studioDir,
      portrait_model: model,
      portrait_cache: cacheDir,
      portrait_cache_max_mb: 2048,
      portrait_browser: "msedge",
      portrait_timeout_secs: 30,
    };
    expect(livePortrait({ ...config, portrait: "fixed" }, log)).toBeNull();
    expect(livePortrait(config, log)).toBeInstanceOf(Live2dPortrait);
    expect(livePortrait({ ...config, portrait_model: "" }, log)).toBeNull();
    expect(livePortrait({ ...config, portrait_studio: join(studioDir, "gone") }, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("is on by default in the config, with no model until one is set", () => {
    const config = cardsConfig();
    expect(config.portrait).toBe("live2d");
    expect(config.portrait_model).toBe("");
    const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    expect(livePortrait(config, log)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("answers null when the studio is not built here", async () => {
    const { model, cacheDir } = setup();
    const { portrait, log } = portraitWith({ studioDir: join(scratch(), "none"), model, cacheDir });
    expect(await portrait.render(input())).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("answers null when the studio cannot load or misses Live2D's files", async () => {
    const paths = setup();
    const broken = portraitWith({
      ...paths,
      loadStudio: () => Promise.reject(new Error("Cannot find package 'playwright-core'")),
    });
    expect(await broken.portrait.render(input())).toBeNull();
    expect(await broken.portrait.render(input(PLAIN, 8))).toBeNull();
    expect(broken.log.warn).toHaveBeenCalledTimes(1);
    expect(broken.portrait.unavailable).toMatch(/playwright-core/);

    const { mod } = fakeStudio(
      async () => PNG,
      "card-studio is missing vendor/live2dcubismcore.min.js",
    );
    const bare = portraitWith({ ...setup(), loadStudio: async () => mod });
    expect(await bare.portrait.render(input())).toBeNull();
    expect(bare.portrait.unavailable).toMatch(/vendor/);
  });

  it("answers null for good when no browser starts", async () => {
    const paths = setup();
    const error = Object.assign(new Error("cannot start msedge"), { name: "BrowserUnavailable" });
    const { mod, calls } = fakeStudio(() => Promise.reject(error));
    const { portrait, log } = portraitWith({ ...paths, loadStudio: async () => mod });
    expect(await portrait.render(input())).toBeNull();
    expect(await portrait.render(input(PLAIN, 9))).toBeNull();
    expect(calls.render).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("draws once, keeps the picture on disk and reads it back", async () => {
    const paths = setup();
    const { mod, calls } = fakeStudio(async () => PNG);
    const first = portraitWith({ ...paths, loadStudio: async () => mod });
    expect(await first.portrait.render(input())).toEqual(PNG);
    expect(await first.portrait.render(input())).toEqual(PNG);
    expect(calls.render).toBe(1);
    expect(readdirSync(paths.cacheDir).filter((f) => f.endsWith(".png"))).toHaveLength(1);
    await first.portrait.close();
    expect(calls.stop).toBe(1);
    // After a restart the kept picture is still there.
    const again = portraitWith({ ...paths, loadStudio: async () => mod });
    expect(await again.portrait.render(input())).toEqual(PNG);
    expect(calls.render).toBe(1);
    expect(first.log.warn).not.toHaveBeenCalled();
  });

  it("draws a card asked for twice at once only once", async () => {
    const paths = setup();
    let release: (png: Uint8Array) => void = () => undefined;
    const { mod, calls } = fakeStudio(
      () =>
        new Promise<Uint8Array>((ok) => {
          release = ok;
        }),
    );
    const { portrait } = portraitWith({ ...paths, loadStudio: async () => mod });
    const a = portrait.render(input());
    const b = portrait.render(input());
    await vi.waitFor(() => expect(calls.render).toBe(1));
    release(PNG);
    expect(await a).toEqual(PNG);
    expect(await b).toEqual(PNG);
  });

  it("falls back on failures, warns once, and pauses after three in a row", async () => {
    const paths = setup();
    let now = 0;
    let fail = true;
    const { mod, calls } = fakeStudio(async () => {
      if (fail) throw new Error("page crashed");
      return PNG;
    });
    const { portrait, log } = portraitWith({
      ...paths,
      loadStudio: async () => mod,
      now: () => now,
    });
    for (const seed of [1, 2, 3]) expect(await portrait.render(input(PLAIN, seed))).toBeNull();
    expect(calls.render).toBe(3);
    // Paused: not even tried.
    expect(await portrait.render(input(PLAIN, 4))).toBeNull();
    expect(calls.render).toBe(3);
    expect(log.warn).toHaveBeenCalledTimes(2);
    now += 11 * 60_000;
    fail = false;
    expect(await portrait.render(input(PLAIN, 5))).toEqual(PNG);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("answers null when a picture takes too long", async () => {
    const paths = setup();
    const { mod } = fakeStudio(() => new Promise<Uint8Array>(() => undefined));
    const { portrait } = portraitWith({ ...paths, timeoutMs: 5, loadStudio: async () => mod });
    expect(await portrait.render(input())).toBeNull();
  });

  it("answers null after it is closed", async () => {
    const paths = setup();
    const { mod, calls } = fakeStudio(async () => PNG);
    const { portrait } = portraitWith({ ...paths, loadStudio: async () => mod });
    await portrait.close();
    expect(await portrait.render(input())).toBeNull();
    expect(calls.render).toBe(0);
  });
});

// ---- real rendering, only where it can run ------------------------------------------------

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const STUDIO = join(REPO, "tools/card-studio");
const MODEL =
  process.env.MIYORIA_CARD_MODEL ??
  "C:/Program Files (x86)/Steam/steamapps/common/VTube Studio/VTube Studio_Data/StreamingAssets/Live2DModels/DeepSeek-chan/大肥鱼.model3.json";
const CAN_RENDER =
  existsSync(join(STUDIO, "vendor/live2dcubismcore.min.js")) &&
  existsSync(join(STUDIO, STUDIO_ENTRY)) &&
  existsSync(MODEL);

describe.skipIf(!CAN_RENDER)("the Live2D portrait on this machine", () => {
  it("draws a PNG, the same one again from disk", { timeout: 120_000 }, async () => {
    const { portrait, log } = portraitWith({
      studioDir: STUDIO,
      model: MODEL,
      cacheDir: join(scratch(), "cache"),
      timeoutMs: 60_000,
    });
    try {
      const png = await portrait.render(input(PLAIN, 12, "smile"));
      expect(png).not.toBeNull();
      expect(
        Buffer.from(png ?? [])
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
      expect(await portrait.render(input(PLAIN, 12, "smile"))).toEqual(png);
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      await portrait.close();
    }
  });
});
