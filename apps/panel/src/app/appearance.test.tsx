import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { mockFetch, renderRoute } from "@/test/render";
import { DEFAULT_LOOK, glassVariables, normalizeLook, resetLook, setLook } from "./appearance";
import { groupFor, NAV, NAV_GROUPS, titleFor } from "./nav";

const KEY = "miyoria.panel.look.v2";
const root = document.documentElement;

afterEach(() => resetLook());

describe("look", () => {
  it("turns whatever was stored into a valid look", () => {
    expect(normalizeLook(null)).toEqual(DEFAULT_LOOK);
    expect(normalizeLook("nonsense")).toEqual(DEFAULT_LOOK);
    expect(normalizeLook({ brightness: 999, elementBlur: -3, elementMask: "dark", theme: "neon", density: "huge", background: "bg.jpg", glass: 1 })).toEqual({
      ...DEFAULT_LOOK,
      brightness: 100,
      elementBlur: 0,
    });
  });

  it("gives the approved glass at the default mask", () => {
    expect(glassVariables(DEFAULT_LOOK.elementMask)).toEqual({ "--sheet-a": "0.105", "--sheet-b": "0.680", "--dock-a": "0.310", "--well-a": "0.290" });
  });

  it("applies and keeps a change, and resets", () => {
    setLook({ theme: "mint", density: "compact", glass: false, backgroundBlur: 12 });
    expect(root.style.getPropertyValue("--primary")).toBe("#8fe0c8");
    expect(root.style.getPropertyValue("--bg-blur")).toBe("12px");
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.glass).toBe("off");
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "{}")).toMatchObject({ theme: "mint", density: "compact", glass: false });
    resetLook();
    expect(root.style.getPropertyValue("--primary")).toBe("#f29dc4");
    expect(root.dataset.glass).toBe("on");
  });

  it("starts from a gradient, never from a picture", () => {
    expect(DEFAULT_LOOK.background).toBe("picture");
  });
});

describe("appearance popover", () => {
  it("changes the look from the header", async () => {
    mockFetch(() => undefined);
    const user = userEvent.setup();
    renderRoute("/settings");
    await user.click(await screen.findByRole("button", { name: "外觀設定" }));
    const dialog = await screen.findByRole("dialog", { name: "外觀設定" });

    await user.click(within(dialog).getByRole("button", { name: "夕陽" }));
    expect(root.style.getPropertyValue("--primary")).toBe("#f5a68c");

    await user.click(within(dialog).getByRole("switch", { name: "玻璃模式" }));
    expect(root.dataset.glass).toBe("off");
    expect(within(dialog).getByRole("slider", { name: "元件模糊" })).toHaveAttribute("data-disabled");

    await user.click(within(dialog).getByRole("button", { name: "海霧" }));
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "{}")).toMatchObject({ theme: "dusk", glass: false, background: "gradient-tide" });

    await user.click(within(dialog).getByRole("button", { name: "重設" }));
    expect(root.dataset.glass).toBe("on");
    expect(within(dialog).getByRole("button", { name: "櫻花" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("navigation", () => {
  it("groups the pages for the sidebar and the header", () => {
    expect(NAV_GROUPS.map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      ["現場", ["總覽", "直播", "動態"]],
      ["她", ["內心", "角色", "生活", "規則"]],
      ["運作", ["LLM", "系統", "經濟", "評測"]],
      ["管理", ["權限", "資料", "設定"]],
    ]);
    expect(NAV).toHaveLength(14);
    expect(groupFor("/inner")).toBe("她");
    expect(titleFor("/inner")).toBe("內心");
    expect(groupFor("/nowhere")).toBeNull();
  });

  it("shows where you are in the header and every group in the sidebar", async () => {
    mockFetch(() => undefined);
    renderRoute("/llm");
    const banner = await screen.findByRole("banner");
    expect(banner).toHaveTextContent("運作 / LLM");
    const sidebar = screen.getByRole("complementary", { name: "主選單" });
    for (const g of ["現場", "她", "運作", "管理"]) expect(within(sidebar).getByRole("heading", { name: g })).toBeInTheDocument();
    expect(within(sidebar).getByRole("link", { name: "LLM" })).toHaveAttribute("aria-current", "page");
    expect(within(sidebar).getByRole("button", { name: "搜尋與跳轉" })).toBeInTheDocument();
  });
});
