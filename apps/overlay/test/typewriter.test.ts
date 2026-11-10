import { describe, expect, it } from "vitest";
import { defaultWsUrl, parseConfig } from "../src/config.js";
import { emotionColor, hashHue } from "../src/emotion.js";
import {
  advance,
  commonPrefixLength,
  cpLength,
  DEFAULT_CPS,
  lingerMs,
  reconcile,
  splitAt,
} from "../src/typewriter.js";

describe("code point helpers", () => {
  it("counts and splits by code point, never inside a surrogate pair", () => {
    expect(cpLength("你好😀a")).toBe(4);
    expect(splitAt("你好😀a", 3)).toEqual(["你好😀", "a"]);
    expect(splitAt("abc", 0)).toEqual(["", "abc"]);
    expect(splitAt("abc", 9)).toEqual(["abc", ""]);
    expect(commonPrefixLength("你好嗎", "你好啊")).toBe(2);
    expect(commonPrefixLength("😀a", "😀b")).toBe(1);
    expect(commonPrefixLength("", "x")).toBe(0);
  });

  it("reconcile keeps the revealed part that is still the same", () => {
    expect(reconcile(5, "你好嗎今天", "你好嗎今天好")).toBe(5);
    expect(reconcile(5, "你好嗎今天", "你好啊今天")).toBe(2);
    expect(reconcile(2, "你好嗎", "你好嗎啊")).toBe(2);
  });
});

describe("advance", () => {
  it("runs at the base speed when little text is waiting", () => {
    const next = advance({ shown: 0, total: 6, dtMs: 200, final: false });
    expect(next).toBeCloseTo((DEFAULT_CPS * 200) / 1000, 6);
  });

  it("speeds up as the backlog grows so it never lags far behind the stream", () => {
    const small = advance({ shown: 0, total: 10, dtMs: 100, final: false });
    const big = advance({ shown: 0, total: 60, dtMs: 100, final: false });
    expect(big).toBeGreaterThan(small * 2);
  });

  it("finishes a final subtitle of 40 characters in under half a second", () => {
    let shown = 0;
    let t = 0;
    while (shown < 40 && t < 5000) {
      shown = advance({ shown, total: 40, dtMs: 16, final: true });
      t += 16;
    }
    expect(shown).toBe(40);
    expect(t).toBeLessThanOrEqual(450);
  });

  it("never passes the end, and a custom cps changes the pace", () => {
    expect(advance({ shown: 4.9, total: 5, dtMs: 10_000, final: false })).toBe(5);
    expect(advance({ shown: 5, total: 5, dtMs: 100, final: false })).toBe(5);
    const slow = advance({ shown: 0, total: 5, dtMs: 1000, final: false, cps: 2 });
    expect(slow).toBeCloseTo(2, 6);
  });

  it("plays out a 30 character line at roughly speaking pace when it arrives all at once", () => {
    let shown = 0;
    let t = 0;
    while (shown < 30) {
      shown = advance({ shown, total: 30, dtMs: 16, final: false });
      t += 16;
    }
    expect(t).toBeGreaterThan(900);
    expect(t).toBeLessThan(2500);
  });
});

describe("lingerMs", () => {
  it("grows with the text and is capped", () => {
    expect(lingerMs("好")).toBeGreaterThan(2000);
    expect(lingerMs("好".repeat(40))).toBeGreaterThan(lingerMs("好"));
    expect(lingerMs("好".repeat(5000))).toBe(9000);
  });
});

describe("parseConfig", () => {
  const loc = { protocol: "http:", host: "192.168.1.5:7884", pathname: "/overlay/index.html" };

  it("shows everything by default and derives the websocket from where the page was served", () => {
    const c = parseConfig("", loc);
    expect([...c.show].sort()).toEqual(["activity", "emotion", "gifts", "queue", "screen", "status", "subtitles", "wave"]);
    expect(c.ws).toBe("ws://192.168.1.5:7884/overlay/ws");
    expect(c).toMatchObject({ cps: DEFAULT_CPS, scale: 1, debug: false, demo: false });
  });

  it("show= selects sections, ignoring unknown names and falling back when none are valid", () => {
    expect([...parseConfig("?show=subtitles,queue", loc).show]).toEqual(["subtitles", "queue"]);
    expect([...parseConfig("?show=Subtitles,%20EMOTION,bogus", loc).show]).toEqual(["subtitles", "emotion"]);
    expect(parseConfig("?show=bogus", loc).show.size).toBe(8);
    expect(parseConfig("?show=", loc).show.size).toBe(8);
  });

  it("ws= overrides, but only ws:// or wss://", () => {
    expect(parseConfig("?ws=ws://10.0.0.2:9000/x", loc).ws).toBe("ws://10.0.0.2:9000/x");
    expect(parseConfig("?ws=wss://example.test/o", loc).ws).toBe("wss://example.test/o");
    expect(parseConfig("?ws=javascript:alert(1)", loc).ws).toBe("ws://192.168.1.5:7884/overlay/ws");
  });

  it("numbers fall back to the default when missing, malformed or out of range", () => {
    expect(parseConfig("?cps=20&scale=1.5", loc)).toMatchObject({ cps: 20, scale: 1.5 });
    expect(parseConfig("?cps=abc&scale=0", loc)).toMatchObject({ cps: DEFAULT_CPS, scale: 1 });
    expect(parseConfig("?cps=99999&scale=9", loc)).toMatchObject({ cps: DEFAULT_CPS, scale: 1 });
  });

  it("flags: present means on unless explicitly off", () => {
    expect(parseConfig("?demo&debug=1", loc)).toMatchObject({ demo: true, debug: true });
    expect(parseConfig("?demo=0&debug=false", loc)).toMatchObject({ demo: false, debug: false });
  });

  it("layer= and layout= pick a known value, else the overlay in the default layout", () => {
    expect(parseConfig("", loc)).toMatchObject({ layer: "overlay", layout: "default" });
    expect(parseConfig("?layer=Backdrop&layout=sing", loc)).toMatchObject({ layer: "backdrop", layout: "sing" });
    expect(parseConfig("?layer=top&layout=karaoke", loc)).toMatchObject({ layer: "overlay", layout: "default" });
  });
});

describe("defaultWsUrl", () => {
  it("handles https, mount paths, file:// and a missing location", () => {
    expect(defaultWsUrl({ protocol: "https:", host: "stage.test", pathname: "/overlay/" })).toBe("wss://stage.test/overlay/ws");
    expect(defaultWsUrl({ protocol: "http:", host: "localhost:5173", pathname: "/" })).toBe("ws://localhost:5173/ws");
    expect(defaultWsUrl({ protocol: "file:", host: "", pathname: "/C:/o/index.html" })).toBe("ws://127.0.0.1:7884/overlay/ws");
    expect(defaultWsUrl(undefined)).toBe("ws://127.0.0.1:7884/overlay/ws");
  });
});

describe("emotionColor", () => {
  it("uses one lightness and chroma for every named emotion, only the hue changes", () => {
    const lc = (s: string) => /oklch\(([\d.]+) ([\d.]+)/.exec(s)?.slice(1, 3).join(" ");
    expect(lc(emotionColor("happy"))).toBe(lc(emotionColor("sad")));
    expect(emotionColor("happy")).not.toBe(emotionColor("sad"));
  });

  it("neutral is a near-grey, unknown names get a stable hue", () => {
    expect(emotionColor("neutral")).toContain("0.012");
    expect(emotionColor("zzz")).toBe(emotionColor("ZZZ "));
    expect(hashHue("zzz")).toBeGreaterThanOrEqual(0);
    expect(hashHue("zzz")).toBeLessThan(360);
  });
});
