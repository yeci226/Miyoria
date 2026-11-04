// `miyoria stage obs-setup` against a fake OBS: what it builds, that a second run changes
// nothing, and that the owner's own sources are left alone.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  applyObsSetup,
  type ObsAdmin,
  type ObsSetupOptions,
  type ObsSnapshot,
  planObsSetup,
  roundedMaskPng,
  SING,
  SOURCES,
  type Step,
  type Transform,
  VTS_WINDOW,
} from "../src/obs-setup.js";

interface Item {
  id: number;
  source: string;
  enabled: boolean;
  transform?: Transform;
}

/** OBS as a few maps; scenes list items bottom first. */
class FakeObs implements ObsAdmin {
  base = { width: 1920, height: 1080 };
  scenes = new Map<string, Item[]>();
  inputs = new Map<string, { kind: string; settings: Record<string, unknown> }>();
  filters = new Map<string, Map<string, Record<string, unknown>>>();
  #next = 1;

  scene(name: string, ...items: Array<[string, boolean?]>): void {
    this.scenes.set(
      name,
      items.map(([source, enabled]) => ({ id: this.#next++, source, enabled: enabled ?? true })),
    );
  }

  async snapshot(frame: string): Promise<ObsSnapshot> {
    return {
      base: this.base,
      scenes: [...this.scenes.keys()],
      inputs: [...this.inputs].map(([name, i]) => ({ name, kind: i.kind, settings: i.settings })),
      items: Object.fromEntries(
        [...this.scenes].map(([s, list]) => [
          s,
          list.map(({ id, source, enabled }) => ({ id, source, enabled })),
        ]),
      ),
      filters: { [frame]: [...(this.filters.get(frame)?.keys() ?? [])] },
    };
  }
  async createScene(scene: string) {
    this.scenes.set(scene, []);
  }
  async createInput(scene: string, name: string, kind: string, settings: Record<string, unknown>) {
    this.inputs.set(name, { kind, settings: { ...settings } });
    await this.addItem(scene, name);
  }
  async setInputSettings(name: string, settings: Record<string, unknown>) {
    const input = this.inputs.get(name);
    if (input) Object.assign(input.settings, settings);
  }
  async addItem(scene: string, source: string) {
    this.scenes.get(scene)?.push({ id: this.#next++, source, enabled: true });
  }
  async itemId(scene: string, source: string) {
    return this.scenes.get(scene)?.find((i) => i.source === source)?.id ?? null;
  }
  #item(scene: string, id: number): Item {
    const item = this.scenes.get(scene)?.find((i) => i.id === id);
    if (!item) throw new Error(`no item ${id} in ${scene}`);
    return item;
  }
  async setTransform(scene: string, id: number, transform: Transform) {
    this.#item(scene, id).transform = transform;
  }
  async setEnabled(scene: string, id: number, enabled: boolean) {
    this.#item(scene, id).enabled = enabled;
  }
  async setIndex(scene: string, id: number, at: "bottom" | "top") {
    const list = this.scenes.get(scene) ?? [];
    const item = this.#item(scene, id);
    list.splice(list.indexOf(item), 1);
    if (at === "bottom") list.unshift(item);
    else list.push(item);
  }
  async setFilter(source: string, name: string, _kind: string, settings: Record<string, unknown>) {
    const map = this.filters.get(source) ?? new Map();
    map.set(name, settings);
    this.filters.set(source, map);
  }
  async close() {}

  order(scene: string): string[] {
    return (this.scenes.get(scene) ?? []).map((i) => (i.enabled ? i.source : `(${i.source})`));
  }
  transform(scene: string, source: string): Transform | undefined {
    return this.scenes.get(scene)?.find((i) => i.source === source)?.transform;
  }
}

const OPTIONS: ObsSetupOptions = {
  overlayUrl: "http://127.0.0.1:7884/overlay/",
  videoSource: "Miyoria 歌曲影片",
  maskPath: "/data/stage/mask-video-rounded.png",
  scenes: { sing: "唱歌", chat: "聊天", game: null },
  relayout: false,
};

async function run(obs: FakeObs, options: Partial<ObsSetupOptions> = {}) {
  const steps = planObsSetup(await obs.snapshot(SOURCES.frame), { ...OPTIONS, ...options });
  const written: string[] = [];
  await applyObsSetup(
    obs,
    steps,
    () => {},
    async (path) => {
      written.push(path);
    },
  );
  return { steps, written };
}

/** Steps that change OBS (the mask image and its filter are written on every run). */
const changes = (steps: Step[]) => steps.filter((s) => s.op !== "write_mask" && s.op !== "filter");

describe("obs-setup", () => {
  it("builds the whole layout on an empty OBS", async () => {
    const obs = new FakeObs();
    const { written } = await run(obs);
    expect(written).toEqual([OPTIONS.maskPath]);
    expect(obs.order(SOURCES.frame)).toEqual(["Miyoria 歌曲影片"]);
    expect(obs.filters.get(SOURCES.frame)?.get("圓角")).toMatchObject({
      image_path: OPTIONS.maskPath,
    });
    expect(obs.order("唱歌")).toEqual([
      SOURCES.backdropSing,
      SOURCES.frame,
      SOURCES.model,
      SOURCES.overlaySing,
    ]);
    expect(obs.order("聊天")).toEqual([SOURCES.backdrop, SOURCES.model, SOURCES.overlay]);
    expect(obs.transform("唱歌", SOURCES.frame)).toMatchObject({
      positionX: 48,
      positionY: 48,
      scaleX: 1504 / 1920,
    });
    expect(obs.transform("唱歌", SOURCES.model)).toMatchObject({
      positionX: 1030,
      positionY: 432,
      boundsType: "OBS_BOUNDS_SCALE_INNER",
      boundsWidth: 1152,
    });
    expect(obs.inputs.get(SOURCES.backdropSing)?.settings.url).toBe(
      "http://127.0.0.1:7884/overlay/?layer=backdrop&layout=sing",
    );
    expect(obs.inputs.get(SOURCES.model)?.settings).toMatchObject({
      window: VTS_WINDOW,
      allow_transparency: true,
    });
  });

  it("changes nothing the second time, and keeps where the owner moved things", async () => {
    const obs = new FakeObs();
    await run(obs);
    const moved = obs.transform("唱歌", SOURCES.model);
    if (moved) moved.positionX = 1100;
    const again = await run(obs);
    expect(changes(again.steps)).toEqual([]);
    expect(obs.transform("唱歌", SOURCES.model)?.positionX).toBe(1100);
    // --relayout puts it back.
    await run(obs, { relayout: true });
    expect(obs.transform("唱歌", SOURCES.model)?.positionX).toBe(1030);
  });

  it("leaves the owner's sources alone and only hides another VTube Studio capture", async () => {
    const obs = new FakeObs();
    obs.inputs.set("視窗擷取 3", { kind: "window_capture", settings: { window: VTS_WINDOW } });
    obs.inputs.set("Minecraft 遊戲", { kind: "game_capture", settings: { window: "Minecraft" } });
    obs.inputs.set(SOURCES.overlay, {
      kind: "browser_source",
      settings: { url: "http://127.0.0.1:9999/overlay/" },
    });
    obs.scene("聊天", ["視窗擷取 3"], [SOURCES.overlay]);
    obs.scene("Minecraft", ["Minecraft 遊戲"], ["視窗擷取 3"]);
    const { steps } = await run(obs, { scenes: { ...OPTIONS.scenes, game: "Minecraft" } });
    expect(obs.order("聊天")).toEqual([
      SOURCES.backdrop,
      "(視窗擷取 3)",
      SOURCES.model,
      SOURCES.overlay,
    ]);
    expect(obs.order("Minecraft")).toEqual([
      "Minecraft 遊戲",
      "(視窗擷取 3)",
      SOURCES.model,
      SOURCES.overlay,
    ]);
    // The existing overlay kept its place but points at this Stage now.
    expect(obs.inputs.get(SOURCES.overlay)?.settings.url).toBe(OPTIONS.overlayUrl);
    expect(steps.filter((s) => s.op === "hide").map((s) => s.source)).toEqual([
      "視窗擷取 3",
      "視窗擷取 3",
    ]);
    expect(obs.inputs.has("Minecraft 遊戲")).toBe(true);
    expect(steps.some((s) => s.op === "create_input" && s.name === SOURCES.overlay)).toBe(false);
  });

  it("builds a Threads scene when the threads role has one", async () => {
    const obs = new FakeObs();
    await run(obs, { scenes: { ...OPTIONS.scenes, threads: "Threads" } });
    expect(obs.order("Threads")).toEqual([
      SOURCES.backdrop,
      SOURCES.threads,
      SOURCES.model,
      SOURCES.overlay,
    ]);
    expect(obs.inputs.get(SOURCES.threads)).toMatchObject({
      kind: "window_capture",
      settings: { window: "Miyoria Threads:Chrome_WidgetWin_1:chrome.exe" },
    });
    // Without the role there is no such scene.
    const none = new FakeObs();
    await run(none);
    expect(none.scenes.has("Threads")).toBe(false);
  });

  it("scales the layout to OBS's base resolution", async () => {
    const obs = new FakeObs();
    obs.base = { width: 1280, height: 720 };
    await run(obs);
    expect(obs.transform("唱歌", SOURCES.frame)).toMatchObject({ positionX: 32, positionY: 32 });
    expect(obs.transform("唱歌", SOURCES.model)).toMatchObject({
      positionX: 687,
      boundsWidth: 768,
    });
  });

  it("matches the overlay's sing layout in style.css", () => {
    const css = readFileSync(join(__dirname, "../../../apps/overlay/src/style.css"), "utf8");
    const rem = (name: string) => {
      const m = css.match(new RegExp(`--${name}:\\s*([\\d.]+)rem`));
      return m ? Number(m[1]) * 16 : Number.NaN;
    };
    expect(rem("pad")).toBe(SING.video.x);
    expect(rem("video-w")).toBe(SING.video.width);
    expect(rem("video-h")).toBe(SING.video.height);
    expect(rem("video-r")).toBe(SING.radius);
  });
});

describe("roundedMaskPng", () => {
  it("is a white rounded rectangle on transparent", () => {
    const png = roundedMaskPng(40, 20, 6);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(40);
    expect(png.readUInt32BE(20)).toBe(20);
    const idat = png.indexOf("IDAT");
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    const alpha = (x: number, y: number) => raw[y * (1 + 40 * 4) + 1 + x * 4 + 3];
    expect(alpha(0, 0)).toBe(0); // the corner is cut away
    expect(alpha(20, 10)).toBe(255);
    expect(alpha(20, 0)).toBe(255); // a straight edge is not
  });
});
