import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The panel is opened at nested addresses (/card/MYR-…, /people/…): a relative URL in the page
// would be looked up under them and miss.
describe("index.html", () => {
  it("refers to its files from the root", () => {
    const html = readFileSync(join(__dirname, "../../index.html"), "utf8");
    const urls = [...html.matchAll(/\s(?:href|src|content)="(\.{1,2}\/[^"]*)"/g)].map((m) => m[1]);
    expect(urls).toEqual([]);
    expect(html).toContain('href="/favicon.svg"');
  });
});
