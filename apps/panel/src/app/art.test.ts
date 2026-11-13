import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loginArt } from "@/pages/login/TokenGate";
import { BACKGROUNDS, pictureCss } from "./appearance";

// The owner's pictures are kept out of git: a build without them must not ask for them (a 404 on
// every load), a build with them shows them.
describe("the owner's pictures", () => {
  it("are asked for only when they were there at build time", () => {
    expect(pictureCss(true)).toMatch(/^url\("\/background\.local\.jpg"\) .*gradient/);
    expect(pictureCss(false)).not.toContain("url(");
    expect(pictureCss(false)).toContain("gradient");
    expect(loginArt(true)).toEqual({ "--login-art": 'url("/login.local.jpg")' });
    expect(loginArt(false)).toBeUndefined();
  });

  it("are not referred to in this checkout, which has none", () => {
    expect(__PANEL_ART__).toEqual({ background: false, login: false });
    expect(BACKGROUNDS.find((b) => b.id === "picture")?.css).not.toContain("local.jpg");
    const css = readFileSync(join(__dirname, "../index.css"), "utf8");
    expect(css).not.toMatch(/url\(["']?\/[^)]*\.local\./);
  });
});
