import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LONG_SAMPLES, PICTURE_SAMPLES } from "@miyoria/card-face/pictures";
import type { PictureKind } from "@miyoria/types";
import { describe, expect, test } from "vitest";
import { weekLedger } from "../src/picture-data.js";
import {
  backgroundPath,
  PANEL_BACKGROUND,
  PictureRenderer,
  PictureService,
  pictureKey,
  stableJson,
} from "../src/pictures.js";

const KINDS = Object.keys(PICTURE_SAMPLES) as PictureKind[];

/** The PNG's size from its header. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("picture renderer", () => {
  test("draws_every_template_to_a_png_with_its_summary", async () => {
    const renderer = new PictureRenderer({ background: () => null });
    for (const kind of KINDS) {
      const file = await renderer.draw(kind, PICTURE_SAMPLES[kind] as never);
      expect(file.contentType).toBe("image/png");
      expect(file.name).toBe(`miyoria-${kind}.png`);
      expect([...file.data.slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
      expect(pngSize(file.data).width).toBe(1080);
      expect(file.alt.length).toBeGreaterThan(10);
      expect(file.alt).not.toContain("\n");
      expect(file.artifact_id).toBeNull();
    }
  }, 60_000);

  test("the_same_data_is_drawn_once_and_new_data_again", async () => {
    let ingested = 0;
    const renderer = new PictureRenderer({
      background: () => null,
      store: () => ({
        ingest: async () => {
          ingested += 1;
          return { id: `A${ingested}` } as never;
        },
      }),
    });
    const a = await renderer.draw("wallet", PICTURE_SAMPLES.wallet);
    const b = await renderer.draw("wallet", { ...PICTURE_SAMPLES.wallet });
    expect(b).toBe(a);
    expect(a.artifact_id).toBe("A1");
    const c = await renderer.draw("wallet", { ...PICTURE_SAMPLES.wallet, balance: 1281 });
    expect(c).not.toBe(a);
    expect(ingested).toBe(2);
  }, 30_000);

  test("the_key_follows_the_kind_the_data_and_the_background_not_key_order", () => {
    const w = PICTURE_SAMPLES.wallet;
    const reordered = Object.fromEntries(Object.entries(w).reverse());
    expect(pictureKey("wallet", reordered, "dusk")).toBe(pictureKey("wallet", w, "dusk"));
    expect(pictureKey("wallet", w, "a|1|2")).not.toBe(pictureKey("wallet", w, "dusk"));
    expect(pictureKey("week", w, "dusk")).not.toBe(pictureKey("wallet", w, "dusk"));
    expect(pictureKey("wallet", { ...w, balance: 1 }, "dusk")).not.toBe(
      pictureKey("wallet", w, "dusk"),
    );
    expect(stableJson({ b: 1, a: [1, { d: null, c: "x" }] })).toBe(
      '{"a":[1,{"c":"x","d":null}],"b":1}',
    );
  });

  test("a_store_that_fails_still_gives_the_picture", async () => {
    const renderer = new PictureRenderer({
      background: () => null,
      store: () => ({
        ingest: async () => {
          throw new Error("disk full");
        },
      }),
    });
    const file = await renderer.draw("odds", PICTURE_SAMPLES.odds);
    expect(file.artifact_id).toBeNull();
  }, 30_000);

  test("bad_data_is_null_from_render_never_a_throw", async () => {
    const renderer = new PictureRenderer({ background: () => null });
    expect(await renderer.render("wallet", null as never)).toBeNull();
    const service = new PictureService(renderer, async () => {
      throw new Error("no wallet");
    });
    const who = { account: { platform: "discord", id: "1" }, name: "x" };
    expect(await service.forMember(who, "wallet")).toBeNull();
    const none = new PictureService(renderer, async () => null);
    expect(await none.forMember(who, "profile")).toBeNull();
  });

  test("a_member_picture_keeps_its_summary_when_drawing_fails_or_is_not_asked", async () => {
    const who = { account: { platform: "discord", id: "1" }, name: "小魚乾" };
    const member = async () => ({
      kind: "wallet" as const,
      data: PICTURE_SAMPLES.wallet,
      person: null,
    });
    class Broken extends PictureRenderer {
      override async render() {
        return null;
      }
    }
    const broken = new PictureService(new Broken({ background: () => null }), member);
    const failed = await broken.forMember(who, "wallet");
    expect(failed?.file).toBeNull();
    expect(failed?.alt).toContain("餘額 1,280 魚幣");
    let drawn = 0;
    class Counting extends PictureRenderer {
      override async render() {
        drawn += 1;
        return null;
      }
    }
    const quiet = new PictureService(new Counting({ background: () => null }), member);
    const words = await quiet.forMember(who, "wallet", { draw: false });
    expect(words?.alt).toContain("餘額 1,280 魚幣");
    expect(drawn).toBe(0);
  });

  test("the_week_s_ledger_is_summed_by_day_and_by_reason", () => {
    const offset = 480;
    const day = (date: string, hour: number) =>
      new Date(Date.parse(`${date}T00:00:00Z`) + (hour - 8) * 3_600_000).toISOString();
    const first = Math.floor(Date.parse("2026-11-11T00:00:00Z") / 86_400_000);
    const week = weekLedger(
      [
        { ts: day("2026-11-11", 9), delta: 10, label: "簽到" },
        { ts: day("2026-11-11", 23), delta: 5, label: "聊天" },
        { ts: day("2026-11-12", 0), delta: -30, label: "每日卡" },
        { ts: day("2026-11-17", 12), delta: 10, label: "簽到" },
        // Before the week, and after it: left out.
        { ts: day("2026-11-10", 23), delta: 99, label: "簽到" },
        { ts: day("2026-11-18", 1), delta: 99, label: "簽到" },
        { ts: "not a time", delta: 1, label: "x" },
      ],
      first,
      first + 6,
      offset,
    );
    expect(week.days).toHaveLength(7);
    expect(week.days[0]).toEqual({ date: "2026-11-11", income: 15, spending: 0 });
    expect(week.days[1]).toEqual({ date: "2026-11-12", income: 0, spending: 30 });
    expect(week.days[6]).toEqual({ date: "2026-11-17", income: 10, spending: 0 });
    expect(week.income).toEqual([
      { label: "簽到", amount: 20 },
      { label: "聊天", amount: 5 },
    ]);
    expect(week.spending).toEqual([{ label: "每日卡", amount: 30 }]);
  });

  test("a_missing_background_file_draws_the_gradient", async () => {
    const renderer = new PictureRenderer({
      background: () => join(import.meta.dirname, "no-such.jpg"),
    });
    const file = await renderer.draw("dex", PICTURE_SAMPLES.dex);
    expect(pngSize(file.data).width).toBe(1080);
  }, 30_000);

  test("the_background_setting_and_the_panel_default", () => {
    expect(backgroundPath("", "/panel")).toBe(join("/panel", PANEL_BACKGROUND));
    expect(backgroundPath("", null)).toBeNull();
    expect(backgroundPath("  ", null)).toBeNull();
    expect(backgroundPath("/x/bg.png", "/panel")).toBe("/x/bg.png");
  });
});

// The sample pictures to look at: `MIYORIA_PICTURE_SAMPLES=<dir>` (and optionally
// `MIYORIA_PICTURE_BACKGROUND=<picture>`) writes every template, normal and with long data.
const samples = process.env.MIYORIA_PICTURE_SAMPLES;
describe.skipIf(!samples)("sample pictures", () => {
  test("writes_the_samples", async () => {
    const dir = samples as string;
    mkdirSync(dir, { recursive: true });
    const bg = process.env.MIYORIA_PICTURE_BACKGROUND ?? null;
    const renderer = new PictureRenderer({ background: () => bg });
    for (const kind of KINDS) {
      const file = await renderer.draw(kind, PICTURE_SAMPLES[kind] as never);
      writeFileSync(join(dir, `${kind}.png`), file.data);
      writeFileSync(join(dir, `${kind}.txt`), `${file.alt}\n`);
      const long = await renderer.draw(kind, LONG_SAMPLES[kind] as never);
      writeFileSync(join(dir, `${kind}-long.png`), long.data);
    }
    const plain = new PictureRenderer({ background: () => null });
    writeFileSync(
      join(dir, "wallet-gradient.png"),
      (await plain.draw("wallet", PICTURE_SAMPLES.wallet)).data,
    );
  }, 120_000);
});
