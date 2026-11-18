import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { familiarityBand, trustBand } from "@miyoria/types";
import { describe, expect, test } from "vitest";
import {
  FAMILIARITY_WORDS,
  fitText,
  LONG_SAMPLES,
  layoutPicture,
  PANEL_TOKENS,
  PICTURE_SAMPLES,
  SECONDARY_LINE,
  TRUST_WORDS,
  textWidth,
  WIDTH,
  wrap,
} from "../src/pictures/index.js";
import { drawable, estimateAdvance, MISSING } from "../src/pictures/measure.js";

const KINDS = Object.keys(PICTURE_SAMPLES) as (keyof typeof PICTURE_SAMPLES)[];
const PANEL_CSS = fileURLToPath(new URL("../../../apps/panel/src/index.css", import.meta.url));

/** Every `<text>` of an SVG with its position, size, anchor and content. */
function texts(svg: string): { x: number; size: number; anchor: string; weight: number; text: string }[] {
  const out = [];
  for (const m of svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1] ?? "";
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
    out.push({
      x: Number(attr("x")),
      size: Number(attr("font-size")),
      anchor: attr("text-anchor") ?? "start",
      weight: Number(attr("font-weight") ?? 400),
      text: (m[2] ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'),
    });
  }
  return out;
}

/** Where a text starts and ends, by its anchor. */
function extent(t: ReturnType<typeof texts>[number]): [number, number] {
  const w = textWidth(t.text, t.size, t.weight === 700 ? 700 : 400);
  if (t.anchor === "end") return [t.x - w, t.x];
  if (t.anchor === "middle") return [t.x - w / 2, t.x + w / 2];
  return [t.x, t.x + w];
}

describe("design tokens", () => {
  test("the_mirrored_tokens_match_the_panel_css", () => {
    const css = readFileSync(PANEL_CSS, "utf8");
    const root = /:root\s*{([\s\S]*?)\n}/.exec(css)?.[1] ?? "";
    const block = (selector: string) =>
      new RegExp(`${selector.replace(".", "\\.")}\\s*{([\\s\\S]*?)}`).exec(css)?.[1] ?? "";
    const value = (scope: string, name: string) =>
      new RegExp(`${name}:\\s*([^;]+);`).exec(scope)?.[1]?.trim();
    for (const [key, token] of Object.entries(PANEL_TOKENS)) {
      const [selector, name] = token.css.startsWith(".")
        ? (token.css.split(" ") as [string, string])
        : [null, token.css];
      let found = value(selector === null ? root : block(selector), name);
      // `--sheet` and friends are written with their alpha as a variable.
      const alpha = /var\((--[a-z-]+)\)/.exec(found ?? "")?.[1];
      if (found !== undefined && alpha !== undefined) found = found.replace(`var(${alpha})`, value(root, alpha) ?? "");
      expect(found, `${key} (${token.css})`).toBe(token.value);
    }
    // The one mixed value: the mix is of the secondary the test just checked.
    expect(value(root, "--secondary-line")).toBe("color-mix(in oklab, var(--secondary) 62%, white)");
    expect(SECONDARY_LINE).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("the_step_meters_know_every_band_word", () => {
    for (let v = 0; v <= 100; v += 0.5) {
      expect(TRUST_WORDS).toContain(trustBand(v));
      expect(FAMILIARITY_WORDS).toContain(familiarityBand(v));
    }
  });
});

describe("measuring text", () => {
  test("cjk_is_one_em_and_latin_narrower", () => {
    expect(textWidth("小魚乾", 10)).toBeCloseTo(30, 0);
    const latin = textWidth("abc", 10);
    expect(latin).toBeGreaterThan(10);
    expect(latin).toBeLessThan(20);
    expect(textWidth("1,280", 14, 700)).toBeGreaterThan(textWidth("1,280", 14, 400) - 0.01);
    expect(estimateAdvance("魚".codePointAt(0) ?? 0, 400)).toBe(1);
    expect(estimateAdvance("a".codePointAt(0) ?? 0, 400)).toBeLessThan(1);
  });

  test("fit_keeps_what_fits_and_shortens_the_rest_with_an_ellipsis", () => {
    expect(fitText("小魚乾", 100, 14)).toBe("小魚乾");
    const short = fitText("超級無敵長的名字的小魚乾是我 The Longest Display Name", 120, 14);
    expect(short.endsWith("…")).toBe(true);
    expect(textWidth(short, 14)).toBeLessThanOrEqual(120);
    // A surrogate pair is never cut in half.
    expect(fitText("𠀀".repeat(20), 50, 14)).not.toMatch(/[\ud800-\udbff]…$/);
  });

  test("wrap_breaks_cjk_anywhere_and_latin_at_spaces_within_the_lines_given", () => {
    const lines = wrap("每次唱歌都會來聽到最後，還會記得我上次說想吃什麼。Thank you very much for everything", 200, 14, 2);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(textWidth(line, 14)).toBeLessThanOrEqual(200);
    expect(lines.at(-1)?.endsWith("…")).toBe(true);
    expect(wrap("short", 200, 14, 2)).toEqual(["short"]);
    expect(wrap("", 200, 14, 2)).toEqual([]);
  });

  test("a_character_the_font_lacks_becomes_the_geta_mark", () => {
    expect(drawable("夜に駆ける")).toBe(`夜に${MISSING}ける`);
    expect(drawable("小魚乾 abc")).toBe("小魚乾 abc");
  });
});

describe("templates", () => {
  test("every_template_lays_out_inside_the_width_with_a_summary", () => {
    for (const kind of KINDS) {
      for (const data of [PICTURE_SAMPLES[kind], LONG_SAMPLES[kind]]) {
        const layout = layoutPicture(kind, data as never);
        expect(layout.width).toBe(WIDTH);
        expect(layout.height).toBeGreaterThan(200);
        expect(layout.alt).not.toMatch(/\n/);
        const svg = layout.svg(null);
        expect(svg.startsWith("<svg")).toBe(true);
        expect(svg).toContain(`viewBox="0 0 ${WIDTH} ${layout.height}"`);
        // The frame along the top and the content glass under it, flush with the edges.
        expect(layout.surfaces.map((s) => s.kind)).toEqual(["dock", "sheet"]);
        expect(layout.surfaces[1]?.y).toBe(layout.surfaces[0]?.h);
        // No text runs past the edges.
        for (const t of texts(svg)) {
          const [left, right] = extent(t);
          expect(left, `${kind}: ${t.text}`).toBeGreaterThanOrEqual(0);
          expect(right, `${kind}: ${t.text}`).toBeLessThanOrEqual(WIDTH);
        }
      }
    }
  });

  test("the_long_names_are_shortened_and_the_big_numbers_kept_whole", () => {
    const svg = layoutPicture("wallet", LONG_SAMPLES.wallet).svg(null);
    const all = texts(svg).map((t) => t.text);
    expect(all.some((t) => t.startsWith("超級無敵長") && t.endsWith("…"))).toBe(true);
    expect(all).toContain("987,654,321");
    expect(layoutPicture("wallet", LONG_SAMPLES.wallet).alt).toContain("987,654,321");
  });

  test("the_wallet_says_its_numbers_in_the_picture_and_the_summary", () => {
    const layout = layoutPicture("wallet", PICTURE_SAMPLES.wallet);
    const all = texts(layout.svg(null)).map((t) => t.text);
    expect(all).toEqual(expect.arrayContaining(["錢包", "小魚乾", "1,280", "收入", "支出", "簽到", "120"]));
    expect(layout.alt).toBe(
      "小魚乾的錢包：餘額 1,280 魚幣；這一週收入 340、支出 220（收入最多的是簽到 120，支出最多的是每日卡 90）。",
    );
  });

  test("a_member_profile_has_no_number_and_the_owner_s_has_them", () => {
    const member = layoutPicture("profile", PICTURE_SAMPLES.profile);
    const shown = texts(member.svg(null)).map((t) => t.text).join(" ");
    expect(shown).toContain("知心 II");
    expect(shown).toContain("心意相通");
    expect(shown).not.toMatch(/\d/);
    expect(member.alt).not.toMatch(/\d/);
    const admin = layoutPicture("profile", LONG_SAMPLES.profile);
    const numbers = texts(admin.svg(null)).map((t) => t.text);
    expect(numbers).toEqual(expect.arrayContaining(["−87.5", "100.0", "−0.92", "0.71"]));
    // The ring has the bond on its heart only for the owner.
    expect(admin.svg(null)).toContain(">−87</text>");
  });

  test("empty_blocks_are_one_plain_line", () => {
    const quiet = layoutPicture("wallet", {
      ...PICTURE_SAMPLES.wallet,
      income: [],
      spending: [],
      days: PICTURE_SAMPLES.wallet.days.map((d) => ({ ...d, income: 0, spending: 0 })),
    });
    const all = texts(quiet.svg(null)).map((t) => t.text);
    expect(all).toContain("這一週沒有收入");
    expect(all).toContain("這一週沒有支出");
    const week = layoutPicture("week", { ...PICTURE_SAMPLES.week, songs: [], song_count: 0, cards: [] });
    expect(texts(week.svg(null)).map((t) => t.text)).toContain("這一週沒有點歌");
  });

  test("text_is_escaped", () => {
    const svg = layoutPicture("wallet", { ...PICTURE_SAMPLES.wallet, name: '<b>&"x"' }).svg(null);
    expect(svg).toContain("&lt;b&gt;&amp;&quot;x&quot;");
    expect(svg).not.toContain("<b>");
  });

  test("the_same_data_gives_the_same_svg", () => {
    for (const kind of KINDS) {
      const a = layoutPicture(kind, PICTURE_SAMPLES[kind] as never).svg("data:image/jpeg;base64,AA==");
      const b = layoutPicture(kind, structuredClone(PICTURE_SAMPLES[kind]) as never).svg("data:image/jpeg;base64,AA==");
      expect(a).toBe(b);
    }
  });

  test("the_lottery_and_the_auction_follow_their_state", () => {
    const cancelled = layoutPicture("lottery", { ...PICTURE_SAMPLES.lottery, state: "cancelled" });
    expect(cancelled.alt).toContain("全額退回");
    const drawn = layoutPicture("lottery", LONG_SAMPLES.lottery);
    expect(drawn.alt).toContain("樂透開獎");
    const auction = layoutPicture("auction", { ...PICTURE_SAMPLES.auction, top: null, history: [], mine: null });
    expect(auction.alt).toContain("還沒有人出價");
    expect(texts(auction.svg(null)).map((t) => t.text)).toContain("還沒有人出價");
    expect(layoutPicture("auction", PICTURE_SAMPLES.auction).alt).toContain("被超過了");
  });
});
