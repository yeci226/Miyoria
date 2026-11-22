import { describe, expect, it } from "vitest";
import { DEFAULT_WORLD, readWorld, WORLD } from "./world";

const page = (head: string) => new DOMParser().parseFromString(`<html><head>${head}</head></html>`, "text/html");
const tag = (json: string) => `<meta name="miyoria:world" content="${json.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" />`;

describe("readWorld", () => {
  it("is the first character's words without a tag", () => {
    expect(readWorld(page(""))).toEqual(DEFAULT_WORLD);
    expect(readWorld(undefined)).toEqual(DEFAULT_WORLD);
    expect(DEFAULT_WORLD).toEqual({ currency: "魚幣", exchange_name: "深海交易所", pronoun: "她", persona: "DeepSeek-chan", landing: "builtin" });
    // This test page has none either.
    expect(WORLD).toEqual(DEFAULT_WORLD);
  });

  it("reads every field the Core tagged the page with", () => {
    const world = { currency: "貝殼", exchange_name: "珊瑚交易所", pronoun: "他", persona: "Kuro", landing: "own" };
    expect(readWorld(page(tag(JSON.stringify(world))))).toEqual(world);
  });

  it("keeps the default of each missing or bad field, and of a broken tag", () => {
    expect(readWorld(page(tag('{"currency":"貝殼"}')))).toEqual({ ...DEFAULT_WORLD, currency: "貝殼" });
    expect(readWorld(page(tag('{"currency":"  ","pronoun":3,"landing":"other","persona":"Kuro"}')))).toEqual({ ...DEFAULT_WORLD, persona: "Kuro" });
    expect(readWorld(page(tag('{"currency":"一二三四五六七八九十一二三四五六七"}'))).currency).toBe("魚幣");
    expect(readWorld(page(tag("{not json")))).toEqual(DEFAULT_WORLD);
    expect(readWorld(page(tag("[1,2]")))).toEqual(DEFAULT_WORLD);
    expect(readWorld(page(tag("null")))).toEqual(DEFAULT_WORLD);
    expect(readWorld(page('<meta name="miyoria:world" />'))).toEqual(DEFAULT_WORLD);
  });
});
