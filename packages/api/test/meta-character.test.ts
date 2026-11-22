// The site's tags name her by the running profile's character, and are today's words without one.

import { DEFAULT_CHARACTER } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { metaTags, pageMeta } from "../src/meta.js";

const ORIGIN = "https://example.test";
const KURO = { ...DEFAULT_CHARACTER, name: "Kuro", short_name: "Ku", other_names: [] };

describe("page meta and the character", () => {
  it("is word for word today's without a profile", () => {
    expect(pageMeta("/", ORIGIN)).toMatchObject({
      title: "Miyoria",
      description:
        "Miyoria 是住在 Discord 和直播裡的 AI VTuber。看看她現在在做什麼,領一張她發的會員卡。",
    });
    expect(pageMeta("/card/x", ORIGIN).description).toBe(
      "Miyoria 發的會員卡,掃卡上的條碼就能確認它是不是真的。",
    );
    expect(pageMeta("/watch", ORIGIN).description).toBe(
      "Miyoria 現在的直播畫面和她說的話,登入後可以在畫面上摸摸她。",
    );
    expect(pageMeta("/system", ORIGIN)).toMatchObject({
      title: "管理面板 · Miyoria",
      description: "Miyoria 的管理面板。",
    });
    expect(metaTags(pageMeta("/", ORIGIN))).toContain(
      '<meta property="og:site_name" content="Miyoria" />',
    );
  });

  it("names another character everywhere", () => {
    const pages = ["/", "/me", "/card/x", "/watch", "/login", "/system"].map((p) =>
      pageMeta(p, ORIGIN, KURO),
    );
    for (const m of pages) {
      expect(`${m.title} ${m.description} ${m.imageAlt}`).not.toContain("Miyoria");
      expect(m.title).toContain("Kuro");
      expect(metaTags(m)).toContain('<meta property="og:site_name" content="Kuro" />');
    }
  });
});
