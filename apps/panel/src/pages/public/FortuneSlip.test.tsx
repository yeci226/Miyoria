import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssuedFortune } from "@/api/types";
import { FortuneFace, FortuneSlip, fortuneFileName, rankInk, slipDate } from "./FortuneSlip";

const SLIP: IssuedFortune = {
  id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
  date: "2026-11-08",
  issued_at: "2026-11-08T04:00:00.000Z",
  rank: "大吉",
  title: "春風得意",
  poem: ["月落烏啼", "江楓漁火", "姑蘇城外", "夜半鐘聲"],
  fields: [
    { label: "戀愛", text: "有人在等你" },
    { label: "學業", text: "專心就好" },
  ],
  line: "今天也辛苦了",
};

afterEach(() => vi.restoreAllMocks());

describe("the fortune slip", () => {
  it("draws the rank, title and poem down the slip and says it all to a screen reader", () => {
    render(<FortuneFace fortune={SLIP} />);
    const svg = screen.getByRole("img");
    const label = svg.getAttribute("aria-label") ?? "";
    expect(label).toContain("2026.11.08 今日籤");
    expect(label).toContain("大吉「春風得意」");
    expect(label).toContain("月落烏啼,江楓漁火,姑蘇城外,夜半鐘聲");
    expect(label).toContain("戀愛:有人在等你");
    expect(label).toContain("她說「今天也辛苦了」");
    // One text element per character of the rank, title and every poem line, and none run together.
    const texts = [...svg.querySelectorAll("text")].map((t) => t.textContent);
    for (const ch of [..."大吉春風得意月落烏啼夜半鐘聲"]) expect(texts).toContain(ch);
    expect(texts).not.toContain("春風得意");
    // The poem reads right to left: the first line is the rightmost column.
    const x = (ch: string) =>
      Number([...svg.querySelectorAll("text")].find((t) => t.textContent === ch)?.getAttribute("x"));
    expect(x("月")).toBeGreaterThan(x("江"));
    expect(x("江")).toBeGreaterThan(x("姑"));
    expect(x("姑")).toBeGreaterThan(x("夜"));
  });

  it("holds to its limits however much it is given", () => {
    const long: IssuedFortune = {
      ...SLIP,
      title: "題".repeat(20),
      poem: ["字".repeat(15), "二", "三", "四"],
      fields: [1, 2, 3, 4, 5].map((n) => ({ label: `欄位名稱很長${n}`, text: "很長".repeat(30) })),
      line: "話".repeat(80),
    };
    const { container } = render(<FortuneFace fortune={long} />);
    const texts = [...container.querySelectorAll("text")].map((t) => t.textContent ?? "");
    expect(texts.filter((t) => t === "題")).toHaveLength(8);
    expect(texts.filter((t) => t === "字")).toHaveLength(7);
    const fields = texts.filter((t) => t.startsWith("欄位名稱"));
    expect(fields).toHaveLength(3);
    // The label is cut to four characters and the text to one line.
    for (const f of fields) expect([...f].length).toBeLessThanOrEqual(4 + 17 + 1);
    expect(texts.filter((t) => t.startsWith("「") || t.startsWith("話")).length).toBeLessThanOrEqual(3);
  });

  it("stamps the rank in a block whose colour depends on the rank, and the six are told apart", () => {
    const inks = (["大吉", "吉", "中吉", "小吉", "末吉", "凶"] as const).map((r) => rankInk(r));
    expect(inks[1]).toBe(inks[2]);
    expect(inks[3]).toBe(inks[4]);
    expect(new Set(inks).size).toBe(4);
    const draw = (rank: IssuedFortune["rank"]) => {
      const { container, unmount } = render(<FortuneFace fortune={{ ...SLIP, rank }} />);
      const markup = container.innerHTML;
      unmount();
      return markup;
    };
    expect(draw("凶")).not.toBe(draw("大吉"));
  });

  it("prints its day the way a slip does", () => {
    expect(slipDate("2026-11-08")).toBe("二〇二六年十一月八日");
    expect(slipDate("2027-01-20")).toBe("二〇二七年一月二十日");
    expect(slipDate("2026-12-31")).toBe("二〇二六年十二月三十一日");
    expect(slipDate("2026-10-10")).toBe("二〇二六年十月十日");
  });

  it("downloads the slip as a PNG named for its day", async () => {
    const saved: string[] = [];
    vi.stubGlobal(
      "Image",
      class {
        decoding = "";
        src = "";
        decode = async () => undefined;
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb: BlobCallback) =>
      cb(new Blob(["png"], { type: "image/png" })),
    );
    URL.createObjectURL = vi.fn(() => "blob:fortune");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    render(<FortuneSlip fortune={SLIP} />);
    await userEvent.click(screen.getByRole("button", { name: "下載" }));
    await waitFor(() => expect(saved).toEqual(["miyoria-fortune-2026-11-08.png"]));
    expect(fortuneFileName(SLIP)).toBe("miyoria-fortune-2026-11-08.png");
    vi.unstubAllGlobals();
  });
});
