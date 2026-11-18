// `miyoria stage obs-setup` against a fake OBS: what it builds, that a second run changes
// nothing, that the owner's own sources are left alone, and that it builds in its own scene
// collection and profile without touching the owner's.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  applyObsSetup,
  awaitChange,
  MIYORIA,
  type ObsAdmin,
  type ObsOutputs,
  type ObsPlace,
  type ObsSetupOptions,
  type ObsSnapshot,
  type ObsVideo,
  type ObsWhere,
  type PlaceStep,
  planObsSetup,
  roundedMaskPng,
  runObsSetup,
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

/** One scene collection: its scenes (items bottom first), inputs, filters and program scene. */
interface Collection {
  scenes: Map<string, Item[]>;
  inputs: Map<string, { kind: string; settings: Record<string, unknown> }>;
  filters: Map<string, Map<string, Record<string, unknown>>>;
  program: string | null;
}

const blankCollection = (): Collection => ({
  scenes: new Map(),
  inputs: new Map(),
  filters: new Map(),
  program: null,
});

/** One profile: video settings, `basic.ini` values, and whether OBS made a replay buffer. */
interface Profile {
  video: ObsVideo;
  params: Map<string, string>;
  replayBuffer: boolean;
}

/** What OBS gives a new profile (the monitor's size, 30 FPS): never what the setup wants. */
const blankProfile = (): Profile => ({
  video: {
    baseWidth: 2560,
    baseHeight: 1440,
    outputWidth: 1280,
    outputHeight: 720,
    fpsNumerator: 30,
    fpsDenominator: 1,
  },
  params: new Map(),
  replayBuffer: false,
});

/**
 * OBS as a few maps, with scene collections and profiles like OBS has them: a switch is announced
 * by its changed event (after `changeDelayMs`), and any other request before that fails.
 */
class FakeObs implements ObsAdmin {
  collections = new Map<string, Collection>([["未命名", blankCollection()]]);
  collection = "未命名";
  profiles = new Map<string, Profile>([["未命名", blankProfile()]]);
  profile = "未命名";
  outputs: ObsOutputs = {
    streaming: false,
    recording: false,
    virtualCam: false,
    replayBuffer: false,
  };
  /** Requests that change OBS, in order. */
  calls: string[] = [];
  /** How late OBS announces a collection or profile switch. */
  changeDelayMs = 0;
  /** How long the setup waits for it. */
  switchTimeoutMs = 1_000;
  readonly events = new EventEmitter();
  #changing = false;
  #next = 1;

  constructor() {
    const user = this.profiles.get("未命名") as Profile;
    user.video = { ...user.video, baseWidth: 1920, baseHeight: 1080, fpsNumerator: 60 };
  }

  get #c(): Collection {
    this.#ready();
    return this.collections.get(this.collection) as Collection;
  }
  get scenes() {
    return this.#c.scenes;
  }
  get inputs() {
    return this.#c.inputs;
  }
  get filters() {
    return this.#c.filters;
  }
  get base() {
    const v = (this.profiles.get(this.profile) as Profile).video;
    return { width: v.baseWidth, height: v.baseHeight };
  }
  set base(size: { width: number; height: number }) {
    const p = this.profiles.get(this.profile) as Profile;
    p.video = { ...p.video, baseWidth: size.width, baseHeight: size.height };
  }

  /** Requests during a collection or profile change fail, as in OBS (`NotReady`). */
  #ready(): void {
    if (this.#changing) throw new Error("NotReady: OBS is changing its scene collection");
  }

  #announce(event: string, data: Record<string, unknown>): void {
    if (this.changeDelayMs <= 0) {
      this.events.emit(event, data);
      return;
    }
    this.#changing = true;
    setTimeout(() => {
      this.#changing = false;
      this.events.emit(event, data);
    }, this.changeDelayMs);
  }

  async where(): Promise<ObsWhere> {
    this.#ready();
    return {
      collections: [...this.collections.keys()],
      currentCollection: this.collection,
      profiles: [...this.profiles.keys()],
      currentProfile: this.profile,
      outputs: { ...this.outputs },
      video: { ...(this.profiles.get(this.profile) as Profile).video },
    };
  }
  async useCollection(name: string, create: boolean) {
    this.#ready();
    await awaitChange(
      this.events,
      {
        event: "CurrentSceneCollectionChanged",
        field: "sceneCollectionName",
        name,
        what: "場景集合",
      },
      async () => {
        this.calls.push(`${create ? "create" : "switch"} collection ${name}`);
        if (create === this.collections.has(name)) throw new Error(`collection ${name}?`);
        if (create) this.collections.set(name, blankCollection());
        this.collection = name;
        this.#announce("CurrentSceneCollectionChanged", { sceneCollectionName: name });
      },
      this.switchTimeoutMs,
    );
  }
  async useProfile(name: string, create: boolean) {
    this.#ready();
    await awaitChange(
      this.events,
      { event: "CurrentProfileChanged", field: "profileName", name, what: "設定檔" },
      async () => {
        this.calls.push(`${create ? "create" : "switch"} profile ${name}`);
        if (create === this.profiles.has(name)) throw new Error(`profile ${name}?`);
        if (create) this.profiles.set(name, blankProfile());
        this.profile = name;
        // OBS makes the replay buffer when it loads a profile whose output mode has it on.
        const p = this.profiles.get(name) as Profile;
        p.replayBuffer = p.params.get("SimpleOutput/RecRB") === "true";
        this.#announce("CurrentProfileChanged", { profileName: name });
      },
      this.switchTimeoutMs,
    );
  }
  async setVideo(
    width: number,
    height: number,
    fps: { numerator: number; denominator: number } | null,
  ) {
    this.#ready();
    if (Object.values(this.outputs).some(Boolean)) throw new Error("OutputRunning");
    this.calls.push(`video ${width}x${height}${fps ? ` ${fps.numerator}/${fps.denominator}` : ""}`);
    const p = this.profiles.get(this.profile) as Profile;
    p.video = {
      baseWidth: width,
      baseHeight: height,
      outputWidth: width,
      outputHeight: height,
      fpsNumerator: fps?.numerator ?? p.video.fpsNumerator,
      fpsDenominator: fps?.denominator ?? p.video.fpsDenominator,
    };
  }
  async setProfileParameter(category: string, name: string, value: string) {
    this.#ready();
    this.calls.push(`param ${category}/${name}=${value}`);
    (this.profiles.get(this.profile) as Profile).params.set(`${category}/${name}`, value);
  }
  async replayBufferAvailable() {
    this.#ready();
    return (this.profiles.get(this.profile) as Profile).replayBuffer;
  }
  async setProgramScene(scene: string) {
    this.#c.program = scene;
  }

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
    // The overlay pages' sound (the karaoke scene's backing and relayed voice) is in OBS's mix;
    // the backdrops make none.
    expect(obs.inputs.get(SOURCES.overlay)?.settings.reroute_audio).toBe(true);
    expect(obs.inputs.get(SOURCES.overlaySing)?.settings.reroute_audio).toBe(true);
    expect(obs.inputs.get(SOURCES.backdrop)?.settings.reroute_audio).toBe(false);
    expect(obs.inputs.get(SOURCES.backdropSing)?.settings.reroute_audio).toBe(false);
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
    // The existing overlay kept its place but points at this Stage now, its sound in OBS's mix.
    expect(obs.inputs.get(SOURCES.overlay)?.settings.url).toBe(OPTIONS.overlayUrl);
    expect(obs.inputs.get(SOURCES.overlay)?.settings.reroute_audio).toBe(true);
    expect(steps).toContainEqual({
      op: "set_input",
      name: SOURCES.overlay,
      settings: { url: OPTIONS.overlayUrl, reroute_audio: true },
    });
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

const MIYORIA_PLACE: ObsPlace = { collection: MIYORIA, profile: MIYORIA, profileSettings: false };

/** The whole command (`runObsSetup`), with the mask written nowhere. */
async function setup(obs: FakeObs, place: Partial<ObsPlace> = {}, dryRun = false) {
  const seen: Array<Step | PlaceStep> = [];
  const written: string[] = [];
  const report = await runObsSetup(
    obs,
    { layout: OPTIONS, place: { ...MIYORIA_PLACE, ...place }, dryRun },
    {
      onStep: (s) => seen.push(s),
      write: async (path) => {
        written.push(path);
      },
    },
  );
  return { report, seen, written };
}

/** The owner's own OBS: a scene with a capture, in their collection and profile. */
function ownersObs(): FakeObs {
  const obs = new FakeObs();
  obs.inputs.set("我的攝影機", { kind: "dshow_input", settings: { device: "cam" } });
  obs.scene("我的場景", ["我的攝影機"]);
  const user = obs.profiles.get("未命名");
  user?.params.set("SimpleOutput/RecRB", "false");
  return obs;
}

/** A deep copy of a collection, to see that it did not change. */
function copy(c: Collection | undefined) {
  return JSON.parse(
    JSON.stringify({
      scenes: [...(c?.scenes ?? [])],
      inputs: [...(c?.inputs ?? [])],
      filters: [...(c?.filters ?? [])].map(([k, v]) => [k, [...v]]),
      program: c?.program,
    }),
  );
}

function copyProfile(p: Profile | undefined) {
  return JSON.parse(JSON.stringify({ video: p?.video, params: [...(p?.params ?? [])] }));
}

describe("obs-setup's own scene collection and profile", () => {
  it("on a fresh OBS creates both, sets only the new profile, and leaves the owner's alone", async () => {
    const obs = ownersObs();
    const theirs = copy(obs.collections.get("未命名"));
    const theirProfile = copyProfile(obs.profiles.get("未命名"));
    const { report } = await setup(obs);

    expect(report.createdProfile).toBe(true);
    expect(report.createdCollection).toBe(true);
    // The profile first, the collection after; the replay buffer appears after a reload.
    expect(obs.calls).toEqual([
      "create profile Miyoria",
      "video 1920x1080 60/1",
      "param SimpleOutput/RecRB=true",
      "param AdvOut/RecRB=true",
      "switch profile 未命名",
      "switch profile Miyoria",
      "create collection Miyoria",
    ]);
    expect(obs.collection).toBe(MIYORIA);
    expect(obs.profile).toBe(MIYORIA);
    const mine = obs.profiles.get(MIYORIA);
    expect(mine?.video).toEqual({
      baseWidth: 1920,
      baseHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
      fpsNumerator: 60,
      fpsDenominator: 1,
    });
    expect(mine?.replayBuffer).toBe(true);
    expect(report.notes).toEqual([]);
    // Built in Miyoria's collection, showing her chat scene.
    expect(obs.order("唱歌")).toEqual([
      SOURCES.backdropSing,
      SOURCES.frame,
      SOURCES.model,
      SOURCES.overlaySing,
    ]);
    expect(obs.collections.get(MIYORIA)?.program).toBe("聊天");
    // The owner's collection and profile are as they were.
    expect(copy(obs.collections.get("未命名"))).toEqual(theirs);
    expect(copyProfile(obs.profiles.get("未命名"))).toEqual(theirProfile);
  });

  it("switches to the existing ones the next time and only adds what is missing", async () => {
    const obs = ownersObs();
    await setup(obs);
    // The owner went back to their own, and changed Miyoria's profile by hand.
    obs.collection = "未命名";
    obs.profile = "未命名";
    const mine = obs.profiles.get(MIYORIA) as Profile;
    mine.video = { ...mine.video, fpsNumerator: 30 };
    mine.params.set("SimpleOutput/RecRB", "false");
    obs.collections.get(MIYORIA)?.scenes.delete("聊天");
    obs.calls = [];

    const { report } = await setup(obs);
    expect(report.place.map((s) => s.op)).toEqual(["switch_profile", "switch_collection"]);
    expect(obs.calls).toEqual(["switch profile Miyoria", "switch collection Miyoria"]);
    // An existing profile keeps what the owner set.
    expect(mine.video.fpsNumerator).toBe(30);
    expect(mine.params.get("SimpleOutput/RecRB")).toBe("false");
    // Only the missing scene came back; no program switch in an existing collection.
    expect(changes(report.steps).map((s) => s.op)).toContain("create_scene");
    expect(report.steps.some((s) => s.op === "program")).toBe(false);
    expect(obs.order("聊天")).toEqual([SOURCES.backdrop, SOURCES.model, SOURCES.overlay]);

    // Already there: nothing to switch, nothing to add.
    obs.calls = [];
    const again = await setup(obs);
    expect(again.report.place).toEqual([]);
    expect(changes(again.report.steps)).toEqual([]);
    expect(obs.calls).toEqual([]);
  });

  it("sets an existing profile again only with --profile-settings, keeping its FPS", async () => {
    const obs = ownersObs();
    await setup(obs);
    const mine = obs.profiles.get(MIYORIA) as Profile;
    mine.video = { ...mine.video, baseWidth: 1280, baseHeight: 720, fpsNumerator: 30 };
    obs.calls = [];
    await setup(obs, { profileSettings: true });
    expect(obs.calls.slice(0, 1)).toEqual(["video 1920x1080"]);
    expect(mine.video).toMatchObject({ baseWidth: 1920, outputHeight: 1080, fpsNumerator: 30 });
  });

  it("works with the user on another collection when Miyoria's exists", async () => {
    const obs = ownersObs();
    await setup(obs);
    obs.collections.set("直播 B", blankCollection());
    obs.collection = "直播 B";
    obs.calls = [];
    const { report } = await setup(obs);
    expect(report.place).toEqual([
      { op: "switch_collection", collection: MIYORIA, from: "直播 B" },
    ]);
    expect(obs.collection).toBe(MIYORIA);
    expect(obs.collections.get("直播 B")?.scenes.size).toBe(0);
  });

  it("refuses to switch while an output runs, and says what to stop", async () => {
    const obs = ownersObs();
    obs.outputs.streaming = true;
    obs.outputs.replayBuffer = true;
    const theirs = copy(obs.collections.get("未命名"));
    await expect(setup(obs)).rejects.toThrow(/OBS 正在推流、重播緩衝.*先在 OBS 停掉推流、重播緩衝/);
    expect(obs.calls).toEqual([]);
    expect(copy(obs.collections.get("未命名"))).toEqual(theirs);
    expect(obs.profiles.size).toBe(1);
    // Already on Miyoria's collection and profile: nothing to switch, so it builds as before.
    obs.outputs.streaming = false;
    obs.outputs.replayBuffer = false;
    await setup(obs);
    obs.outputs.recording = true;
    obs.outputs.virtualCam = true;
    obs.collections.get(MIYORIA)?.scenes.delete("聊天");
    const { report } = await setup(obs);
    expect(report.place).toEqual([]);
    expect(obs.order("聊天")).toEqual([SOURCES.backdrop, SOURCES.model, SOURCES.overlay]);
    // ... but a switch is refused with the recording and the virtual camera named.
    obs.collection = "未命名";
    await expect(setup(obs)).rejects.toThrow(/錄影、虛擬攝影機/);
  });

  it("--here builds in the current collection and profile, as before", async () => {
    const obs = ownersObs();
    const { report } = await setup(obs, { collection: null, profile: null });
    expect(report.place).toEqual([]);
    expect(report.collection).toBe("未命名");
    expect(obs.collections.size).toBe(1);
    expect(obs.profiles.size).toBe(1);
    expect(obs.order("聊天")).toEqual([SOURCES.backdrop, SOURCES.model, SOURCES.overlay]);
    expect(obs.order("我的場景")).toEqual(["我的攝影機"]);
    expect(report.steps.some((s) => s.op === "program")).toBe(false);
  });

  it("--no-profile keeps the current profile and still uses Miyoria's collection", async () => {
    const obs = ownersObs();
    const theirProfile = copyProfile(obs.profiles.get("未命名"));
    const { report } = await setup(obs, { profile: null });
    expect(report.place.map((s) => s.op)).toEqual(["create_collection"]);
    expect(obs.profiles.size).toBe(1);
    expect(obs.profile).toBe("未命名");
    expect(copyProfile(obs.profiles.get("未命名"))).toEqual(theirProfile);
    expect(obs.collection).toBe(MIYORIA);
  });

  it("--dry-run prints the whole plan and changes nothing", async () => {
    const obs = ownersObs();
    const theirs = copy(obs.collections.get("未命名"));
    const { report, seen, written } = await setup(obs, {}, true);
    expect(report.place.map((s) => s.op)).toEqual([
      "create_profile",
      "profile_video",
      "profile_replay_buffer",
      "create_collection",
    ]);
    // The layout as it would be in the new, empty collection at 1920x1080.
    expect(report.layoutUnknown).toBe(false);
    expect(report.steps.flatMap((s) => (s.op === "create_scene" ? [s.scene] : []))).toEqual([
      SOURCES.frame,
      "唱歌",
      "聊天",
    ]);
    expect(report.steps.at(-1)).toEqual({ op: "program", scene: "聊天" });
    expect(seen).toEqual([...report.place, ...report.steps]);
    expect(obs.calls).toEqual([]);
    expect(written).toEqual([]);
    expect(obs.collections.size).toBe(1);
    expect(obs.profiles.size).toBe(1);
    expect(copy(obs.collections.get("未命名"))).toEqual(theirs);

    // An existing collection that is not current can only be read after switching.
    await setup(obs);
    obs.collection = "未命名";
    obs.calls = [];
    const later = await setup(obs, {}, true);
    expect(later.report.place.map((s) => s.op)).toEqual(["switch_collection"]);
    expect(later.report.layoutUnknown).toBe(true);
    expect(later.report.steps).toEqual([]);
    expect(obs.calls).toEqual([]);
    expect(obs.collection).toBe("未命名");
  });

  it("stops when OBS announces a switch too late, without sending anything during it", async () => {
    const obs = ownersObs();
    obs.changeDelayMs = 200;
    obs.switchTimeoutMs = 30;
    await expect(setup(obs)).rejects.toThrow(/OBS 在 0 秒內沒有換到設定檔「Miyoria」/);
    expect(obs.calls).toEqual(["create profile Miyoria"]);
    // Nothing went into the owner's collection, and no collection was made.
    await new Promise((r) => setTimeout(r, 250));
    expect(obs.collections.size).toBe(1);
    expect(obs.order("我的場景")).toEqual(["我的攝影機"]);

    // Slow but in time: it waits for the event and then carries on (no request fails).
    const slow = ownersObs();
    slow.changeDelayMs = 20;
    await setup(slow);
    expect(slow.collection).toBe(MIYORIA);
    expect(slow.order("唱歌")).toHaveLength(4);
  });

  it("notes a replay buffer OBS has not made yet", async () => {
    const obs = ownersObs();
    // An OBS that makes no replay buffer even after reloading (Advanced output mode, say).
    obs.replayBufferAvailable = async () => false;
    const { report } = await setup(obs);
    expect(report.notes).toEqual([
      "設定檔「Miyoria」的重播緩衝已經打開,但 OBS 還沒載入:重開 OBS 一次就會有(精華要用它)",
    ]);
  });
});

describe("awaitChange", () => {
  const change = { event: "Changed", field: "name", name: "Miyoria", what: "場景集合" };

  it("counts an event that comes before the answer, and ignores other names", async () => {
    const events = new EventEmitter();
    await awaitChange(
      events,
      change,
      async () => {
        events.emit("Changed", { name: "別的" });
        events.emit("Changed", { name: "Miyoria" });
      },
      50,
    );
    expect(events.listenerCount("Changed")).toBe(0);
  });

  it("fails when the event does not come in time, and when the request fails", async () => {
    const events = new EventEmitter();
    await expect(awaitChange(events, change, async () => {}, 20)).rejects.toThrow(
      "沒有換到場景集合「Miyoria」",
    );
    await expect(
      awaitChange(
        events,
        change,
        async () => {
          throw new Error("ResourceNotFound");
        },
        1_000,
      ),
    ).rejects.toThrow("ResourceNotFound");
    expect(events.listenerCount("Changed")).toBe(0);
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
