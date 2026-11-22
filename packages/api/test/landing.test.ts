// The profile's front page and its words (docs/design/v5-profiles.md §8): with the first character
// nothing in the served page changes; another profile's words reach the panel, and its own front
// page and pictures are served under the static rules, nothing else.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLanding } from "@miyoria/runtime/profile";
import {
  CharacterKey,
  CurrencyKey,
  DEFAULT_CHARACTER,
  type ProfileLanding,
  ProfileLandingKey,
  RunningProfileKey,
  type ServiceKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { landingBody, landingRoutes, worldOf } from "../src/landing.js";
import { injectMeta, metaTags, pageMeta, WORLD_META } from "../src/meta.js";
import { Monitor } from "../src/monitor.js";
import { fitName } from "../src/og.js";
import { PublicConfigSchema, PublicSide } from "../src/public.js";
import type { Route } from "../src/route.js";
import { ApiState } from "../src/state.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "myr-landing-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A service key, of any type. */
type Keyed = Pick<ServiceKey<unknown>, "id">;

/** An API state with just these services. */
function stateWith(services: [Keyed, unknown][], publicEnabled = true): ApiState {
  const map = new Map<string, unknown>(services.map(([k, v]) => [k.id, v]));
  const ctx = {
    clock: { now: () => 0 },
    services: { get: (k: Keyed) => map.get(k.id) },
  };
  const side = new PublicSide(PublicConfigSchema.parse({ enabled: publicEnabled }), () => 0);
  return new ApiState(
    ctx as never,
    {} as never,
    new Monitor(),
    null,
    () => [],
    [],
    undefined,
    undefined,
    undefined,
    side,
  );
}

const KURO = { ...DEFAULT_CHARACTER, name: "Kuro", pronoun: "他", exchange_name: "珊瑚交易所" };

function call(routes: Route[], path: string): Promise<Response> {
  for (const r of routes) {
    const names: string[] = [];
    const pattern = new RegExp(
      `^${r.path.replace(/:([A-Za-z_]+)/g, (_, n: string) => {
        names.push(n);
        return "([^/]+)";
      })}$`,
    );
    const m = pattern.exec(path);
    if (!m) continue;
    const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? "")]));
    const c = { req: { param: (n: string) => params[n], url: `http://x${path}` } };
    return Promise.resolve(r.handler(c as never));
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}

describe("the words the served page carries", () => {
  it("carries nothing for the first character, so the page is byte for byte today's", () => {
    const state = stateWith([]);
    expect(worldOf(state)).toBeNull();
    const defaults = stateWith([
      [CharacterKey, DEFAULT_CHARACTER],
      [CurrencyKey, "魚幣"],
      [ProfileLandingKey, { kind: "builtin" }],
      [
        RunningProfileKey,
        { id: "deepseek-chan", own: false, character: "Miyoria", persona: "DeepSeek-chan" },
      ],
    ]);
    expect(worldOf(defaults)).toBeNull();
    const html = "<html><head><title>x</title></head><body></body></html>";
    expect(injectMeta(html, pageMeta("/", "https://a.test"))).not.toContain(WORLD_META);
  });

  it("carries every word once any differs, escaped", () => {
    const state = stateWith([
      [CharacterKey, KURO],
      [CurrencyKey, '貝"殼<'],
      [ProfileLandingKey, { kind: "plain" }],
      [RunningProfileKey, { id: "kuro", own: true, character: "Kuro", persona: "Kuro" }],
    ]);
    const world = worldOf(state);
    expect(world).toEqual({
      currency: '貝"殼<',
      exchange_name: "珊瑚交易所",
      pronoun: "他",
      persona: "Kuro",
      landing: "plain",
    });
    const tags = metaTags({ ...pageMeta("/", "https://a.test", KURO), world: world ?? {} });
    const content = new RegExp(`<meta name="${WORLD_META}" content="([^"]*)" />`).exec(tags)?.[1];
    expect(content).toBeDefined();
    const unescaped = (content ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    expect(JSON.parse(unescaped)).toEqual(world);
    expect(content).not.toContain("<");
  });

  it("names only the landing when that alone differs", () => {
    expect(
      worldOf(
        stateWith([
          [
            ProfileLandingKey,
            { kind: "own", dir: "/x", content: { line: null, cover: null, sections: [] } },
          ],
        ]),
      )?.landing,
    ).toBe("own");
  });
});

describe("the front page", () => {
  it("is the first character's own page by default", () => {
    expect(landingBody(stateWith([]))).toEqual({ kind: "builtin" });
  });

  it("is the plain page from [character] without a landing file", () => {
    const state = stateWith([
      [CharacterKey, KURO],
      [ProfileLandingKey, { kind: "plain" }],
    ]);
    expect(landingBody(state)).toEqual({
      kind: "plain",
      name: "Kuro",
      line: "Kuro 是住在 Discord 和直播裡的 AI VTuber。",
    });
  });

  it("is only served while the public side is on", () => {
    expect(landingRoutes(stateWith([], false))).toEqual([]);
    expect(landingRoutes(stateWith([])).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/public/landing",
      "GET /api/public/landing/files/:file",
    ]);
  });

  it("serves a profile's own page and only the pictures it uses", async () => {
    const profile = await tempDir();
    const dir = join(profile, "landing");
    await mkdir(dir);
    const webp = Buffer.from("RIFF0000WEBPVP8 ");
    await writeFile(join(dir, "cover.webp"), webp);
    await writeFile(join(dir, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(dir, "unused.png"), Buffer.from([1]));
    await writeFile(join(dir, "secret.txt"), "no");
    await writeFile(join(profile, "outside.png"), Buffer.from([2]));
    await writeFile(
      join(dir, "landing.json"),
      JSON.stringify({
        line: "<b>一隻黑貓</b>",
        cover: "cover.webp",
        sections: [
          { title: "聊天", text: "標他就好", image: "a.png" },
          { title: "唱歌", text: "點一首", image: null },
        ],
      }),
    );
    const loaded = await loadLanding(profile);
    expect(loaded.problems).toEqual([]);
    const state = stateWith([
      [CharacterKey, KURO],
      [ProfileLandingKey, loaded.landing],
    ]);
    expect(landingBody(state)).toEqual({
      kind: "own",
      name: "Kuro",
      line: "<b>一隻黑貓</b>",
      cover: "/api/public/landing/files/cover.webp",
      sections: [
        { title: "聊天", text: "標他就好", image: "/api/public/landing/files/a.png" },
        { title: "唱歌", text: "點一首", image: null },
      ],
    });
    const routes = landingRoutes(state);
    const page = await call(routes, "/api/public/landing");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("application/json");
    const cover = await call(routes, "/api/public/landing/files/cover.webp");
    expect(cover.status).toBe(200);
    expect(cover.headers.get("content-type")).toBe("image/webp");
    expect(cover.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await cover.arrayBuffer())).toEqual(webp);
    expect(
      (await call(routes, "/api/public/landing/files/a.png")).headers.get("content-type"),
    ).toBe("image/png");
    for (const bad of [
      "unused.png",
      "secret.txt",
      "landing.json",
      "..%2Foutside.png",
      "%2E%2E%2Foutside.png",
      ".hidden.png",
      "missing.png",
    ])
      expect((await call(routes, `/api/public/landing/files/${bad}`)).status, bad).toBe(404);
  });

  it("serves nothing of a page that is not its own", async () => {
    for (const landing of [{ kind: "builtin" }, { kind: "plain" }] as ProfileLanding[]) {
      const routes = landingRoutes(stateWith([[ProfileLandingKey, landing]]));
      expect((await call(routes, "/api/public/landing/files/cover.webp")).status).toBe(404);
    }
  });

  it.skipIf(process.platform === "win32")("never follows a link out of the folder", async () => {
    const profile = await tempDir();
    const dir = join(profile, "landing");
    await mkdir(dir);
    await writeFile(join(profile, "outside.png"), Buffer.from([2]));
    await symlink(join(profile, "outside.png"), join(dir, "a.png"));
    await writeFile(join(dir, "landing.json"), JSON.stringify({ cover: "a.png" }));
    const loaded = await loadLanding(profile);
    expect(loaded.problems.length).toBe(1);
    const routes = landingRoutes(stateWith([[ProfileLandingKey, loaded.landing]]));
    expect((await call(routes, "/api/public/landing/files/a.png")).status).toBe(404);
  });
});

describe("her name on the site's picture", () => {
  it("keeps Miyoria at full size, as the picture always was", () => {
    expect(fitName("Miyoria")).toEqual({ text: "Miyoria", size: 128 });
  });

  it("shrinks a long name, and cuts one that still does not fit", () => {
    const longer = fitName("Kurokawa Akane");
    expect(longer.size).toBeLessThan(128);
    expect(longer.size).toBeGreaterThanOrEqual(56);
    expect(longer.text).toBe("Kurokawa Akane");
    const longest = fitName("無限に長い名前を持つとても長い名前のキャラクターです本当に");
    expect(longest.size).toBe(56);
    expect(longest.text.endsWith("…")).toBe(true);
    expect(longest.text.length).toBeLessThan(30);
  });
});
