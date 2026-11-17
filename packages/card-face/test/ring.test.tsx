import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BondRing, bondRingProps } from "../src/index.js";
import { renderBondRingSvg } from "../src/render.js";

const draw = (props: Parameters<typeof BondRing>[0]) =>
  renderToStaticMarkup(<BondRing {...props} />);
const lit = (svg: string) => (svg.match(/data-segment="lit"/g) ?? []).length;
const segments = (svg: string) => (svg.match(/data-segment=/g) ?? []).length;

describe("bond ring", () => {
  it("lights one segment per finished lap", () => {
    expect(lit(draw({ lap: 0, fraction: 0.35, title: "t" }))).toBe(0);
    expect(lit(draw({ lap: 3, fraction: 0.6, title: "t" }))).toBe(3);
    expect(lit(draw({ lap: 9, fraction: 0.5, title: "t" }))).toBe(9);
    const full = draw({ lap: 9, fraction: 1, full: true, title: "t" });
    expect(lit(full)).toBe(10);
    expect(segments(full)).toBe(10);
  });

  it("derives full from the last lap being full", () => {
    expect(lit(draw({ lap: 9, fraction: 1, title: "t" }))).toBe(10);
  });

  it("draws the lap arc as the fraction of the circle, less the round caps", () => {
    const c = 2 * Math.PI * 58;
    const svg = draw({ lap: 1, fraction: 0.5, title: "t" });
    const dash = Number(
      /r="58"[^>]*stroke-dasharray="([\d.]+) /.exec(svg)?.[1]);
    expect(dash).toBeCloseTo(c * 0.5 - 14, 1);
  });

  it("draws a full inner ring with no gap at 1000", () => {
    const svg = draw({ lap: 9, fraction: 1, full: true, title: "t" });
    expect(svg).toContain(`stroke-dasharray="${2 * Math.PI * 58} `);
  });

  it("runs a negative bond counter-clockwise, neutral, with an outline heart", () => {
    const svg = draw({ lap: 0, fraction: 0, below: 0.4, title: "t" });
    expect(svg).toContain("scale(1 -1)");
    expect(svg).toContain("stroke:rgba(241,240,244,.38)");
    expect(svg).toContain("fill:none;stroke:rgba(241,240,244,.45)");
    expect(lit(svg)).toBe(0);
  });

  it("draws bond 0 as an outline heart with nothing lit", () => {
    const svg = draw({ lap: 0, fraction: 0, title: "t" });
    expect(svg).toContain("fill:none;stroke:rgba(241,240,244,.45)");
    expect(lit(svg)).toBe(0);
    expect(svg).not.toContain("scale(1 -1)");
  });

  it("fills the heart once there is a bond", () => {
    expect(draw({ lap: 0, fraction: 0.1, title: "t" })).toContain("fill:var(--foreground");
  });

  it("has no segments and no number in the mark", () => {
    const svg = draw({ lap: 5, fraction: 0.3, size: "mark", value: 530, title: "t" });
    expect(segments(svg)).toBe(0);
    expect(svg).not.toContain("<text");
    expect(svg).toContain('data-bond-ring="mark"');
  });

  it("writes the number only when given one", () => {
    const admin = draw({ lap: 3, fraction: 0.42, value: 342, title: "t" });
    expect(admin).toContain(">342<");
    expect(admin).toContain('font-size="17.5"');
    expect(draw({ lap: 0, fraction: 0, below: 0.4, value: -40, title: "t" })).toContain(
      ">−40<",
    );
  });

  it("leaves every digit of the bond out of the public markup", () => {
    const svg = draw({ ...bondRingProps({ lap: 7, fraction: 0.42, below: 0 }, 742), title: "tier" });
    expect(svg.replace(/<[^>]*>/g, "")).toBe("");
    expect(svg).not.toMatch(/742/);
    expect(svg).toContain('aria-label="tier"');
    expect(svg).toContain('role="img"');
  });

  it("renders static markup with no var()", () => {
    const svg = renderBondRingSvg({ lap: 3, fraction: 0.4, value: 340, title: "t" });
    expect(svg).not.toContain("var(");
    expect(svg).toContain("xmlns=");
    expect(svg).toContain("#f29dc4");
    expect(
      renderBondRingSvg({ lap: 0, fraction: 0, below: 0.5, size: "mark", title: "t" }),
    ).not.toContain("var(");
  });

  it("builds the props from the bond itself, or from a position the page was given", () => {
    expect(bondRingProps(742)).toEqual({ lap: 7, fraction: expect.closeTo(0.42), below: 0, full: false });
    expect(bondRingProps(1000)).toMatchObject({ lap: 9, fraction: 1, full: true });
    expect(bondRingProps(-50)).toMatchObject({ lap: 0, fraction: 0, below: 0.5, full: false });
  });

  it("builds the props from a ring position", () => {
    expect(bondRingProps({ lap: 9, fraction: 1, below: 0 }, 1000)).toEqual({
      lap: 9,
      fraction: 1,
      below: 0,
      full: true,
    });
  });
});
