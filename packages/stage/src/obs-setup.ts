// `miyoria stage obs-setup`: builds Miyoria's OBS layout on any streaming PC, so nobody has to
// redo the scenes by hand. It reads OBS (`ObsAdmin.snapshot`), plans the missing pieces
// (`planObsSetup`, pure) and applies them (`applyObsSetup`); `--dry-run` only prints the plan.
//
// What it builds (sizes at 1920x1080, scaled to OBS's base resolution):
//
// * browser sources for the overlay's backdrop (`?layer=backdrop`, `&layout=sing`) and the overlay
//   itself (plain and `?layout=sing`), the overlay's sound in OBS's mix (`reroute_audio`: its
//   karaoke scene plays the round's backing and the relayed singer's voice);
// * `VTube Studio 透明`: a game capture of VTube Studio with transparency (VTube Studio itself
//   must use a transparent background, which no API can set);
// * the song video media source inside the frame scene `◇ 影片框`, rounded by an image mask
//   (`mask-video-rounded.png`, written into `[stage] data_dir`);
// * the sing scene: backdrop, the frame at `SING.video`, her model at `SING.model`, the sing
//   overlay on top. `SING` must match `--pad` / `--video-*` in apps/overlay/src/style.css;
// * the chat scene: backdrop, her model filling the frame, the overlay;
// * the game scene (when a `game` role is set): her model in the bottom-right corner, the overlay.
//
// It only ever creates and changes Miyoria's own sources. Items it places are positioned once,
// when it adds them (`relayout` places them again). In the scenes it manages, another capture of
// VTube Studio is hidden, never removed (the transparent one replaces it).
//
// Where it builds (`runObsSetup`): in OBS's scene collection `Miyoria` and with the profile
// `Miyoria` (`ObsPlace`), created or switched to first, so the owner's own collections and
// profiles are never touched. `--here` / `--no-profile` keep the current ones. Switching while an
// output runs would cut it, so it is refused then. A profile is only changed when it was created in
// this run, or when `--profile-settings` asks for it: canvas and output 1920x1080, the replay
// buffer on. Nothing else (stream key, encoders, recording paths) is ever set or copied.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { errorMessage, withTimeout } from "@miyoria/runtime/kernel";
import OBSWebSocket from "obs-websocket-js/json";
import { ObsError } from "./obs.js";

/** The layout this command builds, in pixels of a 1920x1080 frame. */
export const SING = {
  /** The song video (`--pad`, `--video-w`, `--video-h` in the overlay's style.css). */
  video: { x: 48, y: 48, width: 1504, height: 846 },
  /** Corner radius of the video (`--video-r`). */
  radius: 14,
  /** Her model, a box it is fitted into (bottom right, over the video's corner). */
  model: { x: 1030, y: 432, width: 1152, height: 648 },
} as const;

/** Her model in the corner of the game scene. */
export const GAME_MODEL = { x: 1320, y: 732, width: 576, height: 324 } as const;

/** The Threads scene: her browser window on the left, her model standing at the right. */
export const THREADS = {
  window: { x: 120, y: 40, width: 760, height: 1000 },
  model: { x: 600, y: 200, width: 1600, height: 900 },
} as const;

/** The Threads extension's browser window (an app window titled `Miyoria Threads`). */
export const THREADS_WINDOW = "Miyoria Threads:Chrome_WidgetWin_1:chrome.exe";

/** The frame the layout is designed at. */
const DESIGN_WIDTH = 1920;

export const SOURCES = {
  backdrop: "Miyoria 背景",
  backdropSing: "Miyoria 背景 · 唱歌",
  overlay: "Miyoria Overlay",
  overlaySing: "Miyoria Overlay · 唱歌",
  model: "VTube Studio 透明",
  frame: "◇ 影片框",
  threads: "Miyoria Threads 視窗",
} as const;

/** The image mask filter that rounds the song video. */
export const MASK_FILTER = "圓角";

/** VTube Studio's window, as OBS's capture sources name it. */
export const VTS_WINDOW = "VTube Studio:UnityWndClass:VTube Studio.exe";

/** OBS's item alignment `top | left`: positions are the item's top-left corner. */
const TOP_LEFT = 5;

export interface ObsSetupOptions {
  /** The overlay page (`http://127.0.0.1:7884/overlay/`). */
  overlayUrl: string;
  /** `[stage.obs] song_video_source`. */
  videoSource: string;
  /** Where the mask image goes (absolute). */
  maskPath: string;
  /** Scene of each role (`[modules."stage.link".scenes] roles`); `game` and `threads` may be absent. */
  scenes: { sing: string; chat: string; game: string | null; threads?: string | null };
  /** Place the items again even when they exist. */
  relayout: boolean;
}

/** What `snapshot` reads from OBS. */
export interface ObsSnapshot {
  base: { width: number; height: number };
  scenes: string[];
  inputs: Array<{ name: string; kind: string; settings: Record<string, unknown> }>;
  /** Items of each scene, bottom first. */
  items: Record<string, Array<{ id: number; source: string; enabled: boolean }>>;
  /** Filter names per source (only the frame scene's are read). */
  filters: Record<string, string[]>;
}

export interface Transform {
  positionX: number;
  positionY: number;
  scaleX?: number;
  scaleY?: number;
  alignment: number;
  boundsType?: string;
  boundsWidth?: number;
  boundsHeight?: number;
  boundsAlignment?: number;
}

export type Step =
  | { op: "write_mask"; path: string; width: number; height: number; radius: number }
  | { op: "create_scene"; scene: string }
  | {
      op: "create_input";
      scene: string;
      name: string;
      kind: string;
      settings: Record<string, unknown>;
    }
  | { op: "set_input"; name: string; settings: Record<string, unknown> }
  | { op: "add_item"; scene: string; source: string }
  | { op: "transform"; scene: string; source: string; transform: Transform }
  | { op: "place"; scene: string; source: string; at: "bottom" | "top" }
  | { op: "show"; scene: string; source: string }
  | { op: "hide"; scene: string; source: string }
  | {
      op: "filter";
      source: string;
      name: string;
      kind: string;
      settings: Record<string, unknown>;
      exists: boolean;
    }
  /** Shows `scene` in the program (only in a collection created by this run). */
  | { op: "program"; scene: string };

// ---------------------------------------------------------------- where it builds

/** Default name of Miyoria's own scene collection and profile. */
export const MIYORIA = "Miyoria";

/** Canvas and output size a profile gets from the setup. */
export const PROFILE_VIDEO = { width: 1920, height: 1080 } as const;

/**
 * The `basic.ini` keys that turn the replay buffer on: OBS creates its replay buffer output when
 * the one of the profile's output mode is `true` (`SimpleOutput` in Simple mode, `AdvOut` in
 * Advanced mode; frontend/utility/SimpleOutput.cpp and AdvancedOutput.cpp). Both are set, so it
 * works in either mode.
 */
export const REPLAY_BUFFER_PARAMETERS = [
  { category: "SimpleOutput", name: "RecRB" },
  { category: "AdvOut", name: "RecRB" },
] as const;

/** Which scene collection and profile the setup uses. */
export interface ObsPlace {
  /** The scene collection to build in (created when missing); `null` = the current one (`--here`). */
  collection: string | null;
  /** The profile to use (created when missing); `null` = keep the current one (`--no-profile`). */
  profile: string | null;
  /**
   * Set the video size and the replay buffer in `profile` even when it already exists
   * (`--profile-settings`). A profile created in this run always gets them.
   */
  profileSettings: boolean;
}

/** What OBS outputs run. */
export interface ObsOutputs {
  streaming: boolean;
  recording: boolean;
  virtualCam: boolean;
  replayBuffer: boolean;
}

export interface ObsVideo {
  baseWidth: number;
  baseHeight: number;
  outputWidth: number;
  outputHeight: number;
  fpsNumerator: number;
  fpsDenominator: number;
}

/** Where OBS is: its collections, profiles, outputs and video settings. */
export interface ObsWhere {
  collections: string[];
  currentCollection: string;
  profiles: string[];
  currentProfile: string;
  outputs: ObsOutputs;
  video: ObsVideo;
}

export type PlaceStep =
  | { op: "create_profile"; profile: string; from: string }
  | { op: "switch_profile"; profile: string; from: string }
  | {
      op: "profile_video";
      profile: string;
      width: number;
      height: number;
      /** The FPS OBS had before (kept in a new profile); `null` = leave the profile's. */
      fps: { numerator: number; denominator: number } | null;
    }
  | {
      op: "profile_replay_buffer";
      profile: string;
      /**
       * OBS creates the replay buffer only when it loads a profile, so when it is not there after
       * the keys are written the setup switches to this profile and back (`null` = none to use).
       */
      reloadVia: string | null;
    }
  | { op: "create_collection"; collection: string; from: string }
  | { op: "switch_collection"; collection: string; from: string };

const OUTPUT_NAMES: Record<keyof ObsOutputs, string> = {
  streaming: "推流",
  recording: "錄影",
  virtualCam: "虛擬攝影機",
  replayBuffer: "重播緩衝",
};

/**
 * The profile and collection steps (pure). `refused` says what to stop first when one of them
 * would run while an output is on (a switch interrupts it).
 */
export function planObsPlace(
  where: ObsWhere,
  place: ObsPlace,
): { steps: PlaceStep[]; refused: string | null } {
  const steps: PlaceStep[] = [];
  const profile = place.profile;
  if (profile !== null) {
    const exists = where.profiles.includes(profile);
    const from = where.currentProfile;
    if (!exists) steps.push({ op: "create_profile", profile, from });
    else if (from !== profile) steps.push({ op: "switch_profile", profile, from });
    if (!exists || place.profileSettings) {
      steps.push({
        op: "profile_video",
        profile,
        ...PROFILE_VIDEO,
        fps: exists
          ? null
          : { numerator: where.video.fpsNumerator, denominator: where.video.fpsDenominator },
      });
      const via = from !== profile ? from : (where.profiles.find((p) => p !== profile) ?? null);
      steps.push({ op: "profile_replay_buffer", profile, reloadVia: via });
    }
  }
  const collection = place.collection;
  if (collection !== null) {
    const from = where.currentCollection;
    if (!where.collections.includes(collection)) {
      steps.push({ op: "create_collection", collection, from });
    } else if (from !== collection) {
      steps.push({ op: "switch_collection", collection, from });
    }
  }
  const running = (Object.keys(OUTPUT_NAMES) as Array<keyof ObsOutputs>)
    .filter((k) => where.outputs[k])
    .map((k) => OUTPUT_NAMES[k]);
  const refused =
    steps.length > 0 && running.length > 0
      ? `OBS 正在${running.join("、")},換設定檔或場景集合會打斷它。先在 OBS 停掉${running.join("、")}再執行一次(只想在目前的場景集合和設定檔裡建:--here --no-profile)`
      : null;
  return { steps, refused };
}

/** One line per profile or collection step. */
export function describePlaceStep(step: PlaceStep): string {
  switch (step.op) {
    case "create_profile":
      return `建立 OBS 設定檔「${step.profile}」並切換過去(原本的「${step.from}」不會被改)`;
    case "switch_profile":
      return `切換到 OBS 設定檔「${step.profile}」(原本的「${step.from}」不會被改)`;
    case "profile_video":
      return `把設定檔「${step.profile}」的畫布和輸出大小設成 ${step.width}x${step.height}${
        step.fps ? `(FPS 沿用 ${fpsText(step.fps)})` : "(FPS 不變)"
      }`;
    case "profile_replay_buffer":
      return `打開設定檔「${step.profile}」的重播緩衝(簡易和進階輸出模式都開)${
        step.reloadVia ? `;OBS 還沒載入它的話,切到「${step.reloadVia}」再切回來讓 OBS 重新載入` : ""
      }`;
    case "create_collection":
      return `建立場景集合「${step.collection}」並切換過去(原本的「${step.from}」不會被改)`;
    case "switch_collection":
      return `切換到場景集合「${step.collection}」(原本的「${step.from}」不會被改)`;
  }
}

function fpsText(fps: { numerator: number; denominator: number }): string {
  const value = fps.numerator / Math.max(fps.denominator, 1);
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** One line per step, for the command's output. */
export function describeStep(step: Step | PlaceStep): string {
  switch (step.op) {
    case "create_profile":
    case "switch_profile":
    case "profile_video":
    case "profile_replay_buffer":
    case "create_collection":
    case "switch_collection":
      return describePlaceStep(step);
    case "program":
      return `把「${step.scene}」設成目前的場景`;
    case "write_mask":
      return `寫入圓角遮罩 ${step.path}(${step.width}x${step.height},圓角 ${step.radius}px)`;
    case "create_scene":
      return `建立場景「${step.scene}」`;
    case "create_input":
      return `建立來源「${step.name}」(${step.kind})並放進「${step.scene}」`;
    case "set_input":
      return `更新來源「${step.name}」的設定:${Object.keys(step.settings).join("、")}`;
    case "add_item":
      return `把「${step.source}」加進「${step.scene}」`;
    case "transform":
      return `擺放「${step.scene}」裡的「${step.source}」`;
    case "place":
      return `把「${step.scene}」裡的「${step.source}」移到${step.at === "bottom" ? "最下層" : "最上層"}`;
    case "show":
      return `顯示「${step.scene}」裡的「${step.source}」`;
    case "hide":
      return `隱藏「${step.scene}」裡的「${step.source}」(另一個擷取 VTube Studio 的來源,保留不刪)`;
    case "filter":
      return `${step.exists ? "更新" : "加上"}「${step.source}」的濾鏡「${step.name}」`;
  }
}

/** A capture source of VTube Studio's window. */
function capturesVts(input: ObsSnapshot["inputs"][number]): boolean {
  if (!["window_capture", "game_capture"].includes(input.kind)) return false;
  return String(input.settings.window ?? "").includes("VTube Studio.exe");
}

/** The overlay page with `query` (`?layer=backdrop`). */
function pageUrl(base: string, query: string): string {
  return query === "" ? base : `${base}${query}`;
}

/** The steps that make OBS match the layout. Pure: reads `snap`, changes nothing. */
export function planObsSetup(snap: ObsSnapshot, options: ObsSetupOptions): Step[] {
  const steps: Step[] = [];
  const { width: W, height: H } = snap.base;
  const k = W / DESIGN_WIDTH;
  const px = (v: number) => Math.round(v * k);
  const videoScale = SING.video.width / DESIGN_WIDTH;

  const scenes = new Set(snap.scenes);
  const inputs = new Map(snap.inputs.map((i) => [i.name, i]));
  const items = new Map(Object.entries(snap.items).map(([s, list]) => [s, [...list]]));
  /** Sources created by an earlier step (the first scene that wants one creates it). */
  const created = new Set<string>();

  const ensureScene = (scene: string) => {
    if (scenes.has(scene)) return;
    scenes.add(scene);
    items.set(scene, []);
    steps.push({ op: "create_scene", scene });
  };

  /**
   * A browser source of the overlay page. `audio`: the page's sound is an OBS audio source
   * ("Control audio via OBS"), in the mix the stream and Go Live carry; else it would play on the
   * PC's output device and reach the stream only through a desktop audio capture, if there is one.
   */
  const browser = (query: string, audio = false) => ({
    url: pageUrl(options.overlayUrl, query),
    width: W,
    height: H,
    shutdown: false,
    restart_when_active: false,
    reroute_audio: audio,
    css: "",
  });

  // The overlay pages show the karaoke scene, which plays the round's backing and the relayed
  // singer's voice (docs/design/karaoke.md 「做了什麼第五步」): their sound goes into OBS's mix. Only
  // the source in the scene on air is heard there. The backdrop layers make no sound.
  const want: Record<string, { kind: string; settings: Record<string, unknown> }> = {
    [SOURCES.backdrop]: { kind: "browser_source", settings: browser("?layer=backdrop") },
    [SOURCES.backdropSing]: {
      kind: "browser_source",
      settings: browser("?layer=backdrop&layout=sing"),
    },
    [SOURCES.overlay]: { kind: "browser_source", settings: browser("", true) },
    [SOURCES.overlaySing]: { kind: "browser_source", settings: browser("?layout=sing", true) },
    [SOURCES.model]: {
      kind: "game_capture",
      settings: {
        capture_mode: "window",
        window: VTS_WINDOW,
        priority: 2,
        allow_transparency: true,
        capture_cursor: false,
      },
    },
    [SOURCES.threads]: {
      kind: "window_capture",
      // Matched by its title first; only the page, not the window frame.
      settings: {
        window: THREADS_WINDOW,
        priority: 1,
        method: 2,
        client_area: true,
        cursor: false,
      },
    },
    [options.videoSource]: {
      kind: "ffmpeg_source",
      settings: {
        is_local_file: true,
        local_file: "",
        looping: false,
        restart_on_activate: false,
        close_when_inactive: false,
        clear_on_media_end: true,
        hw_decode: true,
      },
    },
  };
  /** Settings that must hold on an existing source (the rest is the owner's to change). */
  const keep: Record<string, string[]> = {
    [SOURCES.backdrop]: ["url"],
    [SOURCES.backdropSing]: ["url"],
    [SOURCES.overlay]: ["url", "reroute_audio"],
    [SOURCES.overlaySing]: ["url", "reroute_audio"],
    [SOURCES.model]: ["allow_transparency"],
  };
  for (const [name, fields] of Object.entries(keep)) {
    const have = inputs.get(name);
    const target = want[name];
    if (!have || !target) continue;
    const changed = Object.fromEntries(
      fields
        .filter((f) => have.settings[f] !== target.settings[f])
        .map((f) => [f, target.settings[f]]),
    );
    if (Object.keys(changed).length > 0) steps.push({ op: "set_input", name, settings: changed });
  }

  /**
   * Puts `source` into `scene` (creating the input or the item when missing) and, when it was
   * added now or on `relayout`, positions it. Returns whether it was added.
   */
  const put = (scene: string, source: string, transform: Transform): boolean => {
    const list = items.get(scene) ?? [];
    const item = list.find((i) => i.source === source);
    let added = false;
    if (!item) {
      const spec = want[source];
      if (spec && !inputs.has(source) && !created.has(source)) {
        steps.push({
          op: "create_input",
          scene,
          name: source,
          kind: spec.kind,
          settings: spec.settings,
        });
        created.add(source);
      } else {
        steps.push({ op: "add_item", scene, source });
      }
      list.push({ id: -1, source, enabled: true });
      items.set(scene, list);
      added = true;
    } else if (!item.enabled) {
      steps.push({ op: "show", scene, source });
    }
    if (added || options.relayout) steps.push({ op: "transform", scene, source, transform });
    return added;
  };

  /**
   * Puts Miyoria's sources into `scene`, `bottom` ones under everything and `top` ones over
   * everything, each list in order. Once something was added (or on `relayout`) all of them are
   * stacked again, so a new item never ends up over one that must stay on top.
   */
  type Entry = { source: string; transform: Transform };
  const layout = (scene: string, bottom: Entry[], top: Entry[]) => {
    let added = false;
    for (const e of [...bottom, ...top]) added = put(scene, e.source, e.transform) || added;
    if (!added && !options.relayout) return;
    for (const e of [...bottom].reverse())
      steps.push({ op: "place", scene, source: e.source, at: "bottom" });
    for (const e of top) steps.push({ op: "place", scene, source: e.source, at: "top" });
  };

  const full: Transform = { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, alignment: TOP_LEFT };
  const fitInto = (box: { x: number; y: number; width: number; height: number }): Transform => ({
    positionX: px(box.x),
    positionY: px(box.y),
    alignment: TOP_LEFT,
    boundsType: "OBS_BOUNDS_SCALE_INNER",
    boundsWidth: px(box.width),
    boundsHeight: px(box.height),
    boundsAlignment: 0,
  });
  const hideOtherVts = (scene: string) => {
    for (const item of items.get(scene) ?? []) {
      if (!item.enabled || item.source === SOURCES.model) continue;
      const input = inputs.get(item.source);
      if (input && capturesVts(input)) steps.push({ op: "hide", scene, source: item.source });
    }
  };

  // ---- the frame scene: the song video, fitted to the frame and rounded by the mask
  const radius = Math.round(px(SING.radius) / videoScale);
  steps.push({ op: "write_mask", path: options.maskPath, width: W, height: H, radius });
  ensureScene(SOURCES.frame);
  const wholeFrame = fitInto({ x: 0, y: 0, width: DESIGN_WIDTH, height: (DESIGN_WIDTH * H) / W });
  layout(SOURCES.frame, [{ source: options.videoSource, transform: wholeFrame }], []);
  steps.push({
    op: "filter",
    source: SOURCES.frame,
    name: MASK_FILTER,
    kind: "mask_filter_v2",
    settings: { image_path: options.maskPath, type: "mask_alpha_filter.effect", opacity: 1 },
    exists: (snap.filters[SOURCES.frame] ?? []).includes(MASK_FILTER),
  });

  // ---- sing: backdrop, the video, her model, the overlay
  const sing = options.scenes.sing;
  ensureScene(sing);
  layout(
    sing,
    [{ source: SOURCES.backdropSing, transform: full }],
    [
      {
        source: SOURCES.frame,
        transform: {
          positionX: px(SING.video.x),
          positionY: px(SING.video.y),
          scaleX: videoScale,
          scaleY: videoScale,
          alignment: TOP_LEFT,
        },
      },
      { source: SOURCES.model, transform: fitInto(SING.model) },
      { source: SOURCES.overlaySing, transform: full },
    ],
  );
  // The plain overlay here would draw everything twice.
  if ((items.get(sing) ?? []).some((i) => i.source === SOURCES.overlay && i.enabled)) {
    steps.push({ op: "hide", scene: sing, source: SOURCES.overlay });
  }
  hideOtherVts(sing);

  // ---- chat: backdrop, her model filling the frame, the overlay
  const chat = options.scenes.chat;
  ensureScene(chat);
  layout(
    chat,
    [{ source: SOURCES.backdrop, transform: full }],
    [
      { source: SOURCES.model, transform: wholeFrame },
      { source: SOURCES.overlay, transform: full },
    ],
  );
  hideOtherVts(chat);

  // ---- game: her model in the corner over the game, the overlay
  const game = options.scenes.game;
  if (game !== null) {
    ensureScene(game);
    layout(
      game,
      [],
      [
        { source: SOURCES.model, transform: fitInto(GAME_MODEL) },
        { source: SOURCES.overlay, transform: full },
      ],
    );
    hideOtherVts(game);
  }

  // ---- threads: backdrop, her browser window, her model, the overlay
  const threads = options.scenes.threads ?? null;
  if (threads !== null) {
    ensureScene(threads);
    layout(
      threads,
      [{ source: SOURCES.backdrop, transform: full }],
      [
        { source: SOURCES.threads, transform: fitInto(THREADS.window) },
        { source: SOURCES.model, transform: fitInto(THREADS.model) },
        { source: SOURCES.overlay, transform: full },
      ],
    );
    hideOtherVts(threads);
  }
  return steps;
}

// ---------------------------------------------------------------- the mask image

/** A white rounded rectangle on transparent, `width` x `height`, anti-aliased edges (PNG). */
export function roundedMaskPng(width: number, height: number, radius: number): Buffer {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const row = 1 + width * 4;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      // Distance outside the rounded corner, sampled at the pixel's centre.
      const cx = Math.min(Math.max(x + 0.5, r), width - r);
      const cy = Math.min(Math.max(y + 0.5, r), height - r);
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;
      const alpha = Math.round(Math.min(Math.max(0.5 - d, 0), 1) * 255);
      const o = y * row + 1 + x * 4;
      raw[o] = 255;
      raw[o + 1] = 255;
      raw[o + 2] = 255;
      raw[o + 3] = alpha;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- talking to OBS

/** The obs-websocket requests the setup needs, behind an interface so tests can fake OBS. */
export interface ObsAdmin {
  snapshot(frameScene: string): Promise<ObsSnapshot>;
  createScene(scene: string): Promise<void>;
  createInput(
    scene: string,
    name: string,
    kind: string,
    settings: Record<string, unknown>,
  ): Promise<void>;
  setInputSettings(name: string, settings: Record<string, unknown>): Promise<void>;
  addItem(scene: string, source: string): Promise<void>;
  /** The item showing `source` in `scene` (the first one). */
  itemId(scene: string, source: string): Promise<number | null>;
  setTransform(scene: string, id: number, transform: Transform): Promise<void>;
  setEnabled(scene: string, id: number, enabled: boolean): Promise<void>;
  /** Moves an item to the bottom (`0`) or the top. */
  setIndex(scene: string, id: number, at: "bottom" | "top"): Promise<void>;
  setFilter(
    source: string,
    name: string,
    kind: string,
    settings: Record<string, unknown>,
    exists: boolean,
  ): Promise<void>;
  /** Shows `scene` in the program. */
  setProgramScene(scene: string): Promise<void>;
  /** Collections, profiles, running outputs and video settings. */
  where(): Promise<ObsWhere>;
  /**
   * Creates (`create`) or switches to scene collection `name` and waits until OBS reports it
   * changed (`awaitChange`); fails when it does not in time.
   */
  useCollection(name: string, create: boolean): Promise<void>;
  /** The same for a profile. */
  useProfile(name: string, create: boolean): Promise<void>;
  /** Sets the canvas and output size of the current profile (and its FPS when given). */
  setVideo(
    width: number,
    height: number,
    fps: { numerator: number; denominator: number } | null,
  ): Promise<void>;
  /** Sets one `basic.ini` value of the current profile. */
  setProfileParameter(category: string, name: string, value: string): Promise<void>;
  /** Whether the current profile has a replay buffer (OBS made one when it loaded the profile). */
  replayBufferAvailable(): Promise<boolean>;
  close(): Promise<void>;
}

/** The part of an event emitter `awaitChange` listens on. */
export interface ChangeEvents {
  on(event: string, listener: (data: Record<string, unknown>) => void): unknown;
  off(event: string, listener: (data: Record<string, unknown>) => void): unknown;
}

/** How long a collection or profile switch may take (OBS loads every source of the collection). */
export const SWITCH_TIMEOUT_MS = 30_000;

/**
 * Sends a switch (`send`) and waits for OBS's `event` (`CurrentSceneCollectionChanged`,
 * `CurrentProfileChanged`) naming `name`. The listener is in place before the request goes out,
 * so an event that comes before the answer counts. Requests sent while OBS changes collection fail
 * (or worse), so nothing else is sent until the event came; without it in `timeoutMs` this fails.
 */
export async function awaitChange(
  events: ChangeEvents,
  change: { event: string; field: string; name: string; what: string },
  send: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let listener: (data: Record<string, unknown>) => void = () => {};
  const changed = new Promise<void>((resolve) => {
    listener = (data) => {
      if (data?.[change.field] === change.name) resolve();
    };
    events.on(change.event, listener);
  });
  const TIMED_OUT = Symbol("timed out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const done = send().then(() => changed);
  // A request that fails after the timeout must not become an unhandled rejection.
  done.catch(() => undefined);
  try {
    if ((await Promise.race([done, timeout])) === TIMED_OUT) {
      throw new ObsError(
        `OBS 在 ${Math.round(timeoutMs / 1000)} 秒內沒有換到${change.what}「${change.name}」;等 OBS 換好(有對話框就先關掉)再執行一次`,
      );
    }
  } finally {
    clearTimeout(timer);
    events.off(change.event, listener);
  }
}

/** Writes files (the mask); replaced in tests. */
export type FileWriter = (path: string, data: Buffer) => Promise<void>;

const writeFileMkdir: FileWriter = async (path, data) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
};

/** Applies `steps` in order; `onStep` hears each one before it runs. */
export async function applyObsSetup(
  admin: ObsAdmin,
  steps: readonly Step[],
  onStep: (step: Step) => void = () => {},
  write: FileWriter = writeFileMkdir,
): Promise<void> {
  const id = async (scene: string, source: string) => {
    const found = await admin.itemId(scene, source);
    if (found === null) throw new ObsError(`「${scene}」裡找不到「${source}」`);
    return found;
  };
  for (const step of steps) {
    onStep(step);
    switch (step.op) {
      case "write_mask":
        await write(step.path, roundedMaskPng(step.width, step.height, step.radius));
        break;
      case "create_scene":
        await admin.createScene(step.scene);
        break;
      case "create_input":
        await admin.createInput(step.scene, step.name, step.kind, step.settings);
        break;
      case "set_input":
        await admin.setInputSettings(step.name, step.settings);
        break;
      case "add_item":
        await admin.addItem(step.scene, step.source);
        break;
      case "transform":
        await admin.setTransform(step.scene, await id(step.scene, step.source), step.transform);
        break;
      case "place":
        await admin.setIndex(step.scene, await id(step.scene, step.source), step.at);
        break;
      case "show":
      case "hide":
        await admin.setEnabled(step.scene, await id(step.scene, step.source), step.op === "show");
        break;
      case "filter":
        await admin.setFilter(step.source, step.name, step.kind, step.settings, step.exists);
        break;
      case "program":
        await admin.setProgramScene(step.scene);
        break;
    }
  }
}

/**
 * Applies the profile and collection steps in order. Returns notes for the owner (a replay buffer
 * OBS has not made yet).
 */
export async function applyObsPlace(
  admin: ObsAdmin,
  steps: readonly PlaceStep[],
  onStep: (step: PlaceStep) => void = () => {},
): Promise<string[]> {
  const notes: string[] = [];
  for (const step of steps) {
    onStep(step);
    switch (step.op) {
      case "create_profile":
      case "switch_profile":
        await admin.useProfile(step.profile, step.op === "create_profile");
        break;
      case "profile_video":
        await admin.setVideo(step.width, step.height, step.fps);
        break;
      case "profile_replay_buffer": {
        for (const p of REPLAY_BUFFER_PARAMETERS) {
          await admin.setProfileParameter(p.category, p.name, "true");
        }
        if (await admin.replayBufferAvailable()) break;
        // OBS makes its outputs when it loads a profile: load this one again.
        if (step.reloadVia !== null) {
          await admin.useProfile(step.reloadVia, false);
          await admin.useProfile(step.profile, false);
        }
        if (!(await admin.replayBufferAvailable())) {
          notes.push(
            `設定檔「${step.profile}」的重播緩衝已經打開,但 OBS 還沒載入:重開 OBS 一次就會有(精華要用它)`,
          );
        }
        break;
      }
      case "create_collection":
      case "switch_collection":
        await admin.useCollection(step.collection, step.op === "create_collection");
        break;
    }
  }
  return notes;
}

/** What `runObsSetup` needs besides OBS. */
export interface ObsSetupRun {
  layout: ObsSetupOptions;
  place: ObsPlace;
  dryRun: boolean;
}

/** What `runObsSetup` did (or, on a dry run, would do). */
export interface ObsSetupReport {
  place: PlaceStep[];
  steps: Step[];
  /**
   * Dry run onto a collection that exists but is not the current one: what is in it can only be
   * read after switching, so `steps` is empty (a real run adds only what is missing).
   */
  layoutUnknown: boolean;
  /** The collection and profile the layout is (or would be) in. */
  collection: string;
  profile: string;
  createdCollection: boolean;
  createdProfile: boolean;
  /** Things the owner still has to do. */
  notes: string[];
}

/**
 * The whole command: reads where OBS is, refuses a switch while an output runs, creates or switches
 * to the collection and profile, then plans and applies the layout there. A dry run changes
 * nothing: it reports the steps (onto an empty snapshot for a collection it would create).
 */
export async function runObsSetup(
  admin: ObsAdmin,
  run: ObsSetupRun,
  hooks: { onStep?: (step: Step | PlaceStep) => void; write?: FileWriter } = {},
): Promise<ObsSetupReport> {
  const onStep = hooks.onStep ?? (() => {});
  const where = await admin.where();
  const { steps: place, refused } = planObsPlace(where, run.place);
  if (refused !== null) throw new ObsError(refused);
  const createdCollection = place.some((s) => s.op === "create_collection");
  const createdProfile = place.some((s) => s.op === "create_profile");
  const collection = run.place.collection ?? where.currentCollection;
  const profile = run.place.profile ?? where.currentProfile;
  const chat = run.layout.scenes.chat;
  const report: ObsSetupReport = {
    place,
    steps: [],
    layoutUnknown: false,
    collection,
    profile,
    createdCollection,
    createdProfile,
    notes: [],
  };

  if (run.dryRun) {
    for (const step of place) onStep(step);
    const video = place.find((s) => s.op === "profile_video");
    const base = video
      ? { width: video.width, height: video.height }
      : { width: where.video.baseWidth, height: where.video.baseHeight };
    let snap: ObsSnapshot | null;
    if (collection === where.currentCollection) {
      snap = { ...(await admin.snapshot(SOURCES.frame)), base };
    } else if (createdCollection) {
      snap = { base, scenes: [], inputs: [], items: {}, filters: {} };
    } else {
      snap = null;
    }
    if (snap === null) {
      report.layoutUnknown = true;
    } else {
      report.steps = planObsSetup(snap, run.layout);
      if (createdCollection) report.steps.push({ op: "program", scene: chat });
      for (const step of report.steps) onStep(step);
    }
    return report;
  }

  report.notes.push(...(await applyObsPlace(admin, place, onStep)));
  report.steps = planObsSetup(await admin.snapshot(SOURCES.frame), run.layout);
  // A new collection starts on OBS's empty default scene: show hers.
  if (createdCollection) report.steps.push({ op: "program", scene: chat });
  await applyObsSetup(admin, report.steps, onStep, hooks.write);
  return report;
}

const CALL_TIMEOUT_MS = 10_000;

/** `ObsAdmin` over obs-websocket. */
export class ObsWebSocketAdmin implements ObsAdmin {
  readonly #client: OBSWebSocket;

  private constructor(client: OBSWebSocket) {
    this.#client = client;
  }

  static async connect(options: {
    host: string;
    port: number;
    password?: string | null;
  }): Promise<ObsWebSocketAdmin> {
    const client = new OBSWebSocket();
    client.on("ConnectionError", () => {});
    try {
      await client.connect(`ws://${options.host}:${options.port}`, options.password || undefined);
    } catch (error) {
      throw new ObsError(
        `cannot connect to OBS at ${options.host}:${options.port}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    return new ObsWebSocketAdmin(client);
  }

  // The request types are generic here: the setup sends a handful of plain requests.
  async #call(
    type: string,
    data?: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const call = this.#client.call.bind(this.#client) as (
      t: string,
      d?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    // Requests without response data answer `undefined`, so the timeout is told apart by a mark.
    const TIMED_OUT = Symbol("timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      const answer = await Promise.race([call(type, data), timeout]);
      if (answer === TIMED_OUT) {
        throw new ObsError(`OBS did not answer ${type} within ${timeoutMs} ms`);
      }
      return answer ?? {};
    } finally {
      clearTimeout(timer);
    }
  }

  async snapshot(frameScene: string): Promise<ObsSnapshot> {
    const video = await this.#call("GetVideoSettings");
    const sceneList = (await this.#call("GetSceneList")).scenes as Array<Record<string, unknown>>;
    const scenes = sceneList.map((s) => String(s.sceneName ?? "")).filter((s) => s !== "");
    const inputList = (await this.#call("GetInputList")).inputs as Array<Record<string, unknown>>;
    const inputs: ObsSnapshot["inputs"] = [];
    for (const i of inputList) {
      const name = String(i.inputName ?? "");
      const kind = String(i.unversionedInputKind ?? i.inputKind ?? "");
      const r = await this.#call("GetInputSettings", { inputName: name });
      inputs.push({ name, kind, settings: (r.inputSettings ?? {}) as Record<string, unknown> });
    }
    const items: ObsSnapshot["items"] = {};
    for (const scene of scenes) {
      const r = await this.#call("GetSceneItemList", { sceneName: scene });
      items[scene] = (r.sceneItems as Array<Record<string, unknown>>)
        .map((it) => ({
          id: Number(it.sceneItemId),
          source: String(it.sourceName ?? ""),
          enabled: Boolean(it.sceneItemEnabled),
          index: Number(it.sceneItemIndex ?? 0),
        }))
        .sort((a, b) => a.index - b.index)
        .map(({ id, source, enabled }) => ({ id, source, enabled }));
    }
    const filters: ObsSnapshot["filters"] = {};
    if (scenes.includes(frameScene)) {
      const r = await this.#call("GetSourceFilterList", { sourceName: frameScene });
      filters[frameScene] = (r.filters as Array<Record<string, unknown>>).map((f) =>
        String(f.filterName ?? ""),
      );
    }
    return {
      base: { width: Number(video.baseWidth), height: Number(video.baseHeight) },
      scenes,
      inputs,
      items,
      filters,
    };
  }

  async createScene(scene: string): Promise<void> {
    await this.#call("CreateScene", { sceneName: scene });
  }

  async createInput(
    scene: string,
    name: string,
    kind: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    await this.#call("CreateInput", {
      sceneName: scene,
      inputName: name,
      inputKind: kind,
      inputSettings: settings,
      sceneItemEnabled: true,
    });
  }

  async setInputSettings(name: string, settings: Record<string, unknown>): Promise<void> {
    await this.#call("SetInputSettings", {
      inputName: name,
      inputSettings: settings,
      overlay: true,
    });
  }

  async addItem(scene: string, source: string): Promise<void> {
    await this.#call("CreateSceneItem", { sceneName: scene, sourceName: source });
  }

  async itemId(scene: string, source: string): Promise<number | null> {
    try {
      const r = await this.#call("GetSceneItemId", { sceneName: scene, sourceName: source });
      return Number(r.sceneItemId);
    } catch {
      return null;
    }
  }

  async setTransform(scene: string, id: number, transform: Transform): Promise<void> {
    await this.#call("SetSceneItemTransform", {
      sceneName: scene,
      sceneItemId: id,
      sceneItemTransform: { ...transform },
    });
  }

  async setEnabled(scene: string, id: number, enabled: boolean): Promise<void> {
    await this.#call("SetSceneItemEnabled", {
      sceneName: scene,
      sceneItemId: id,
      sceneItemEnabled: enabled,
    });
  }

  async setIndex(scene: string, id: number, at: "bottom" | "top"): Promise<void> {
    let index = 0;
    if (at === "top") {
      const r = await this.#call("GetSceneItemList", { sceneName: scene });
      index = (r.sceneItems as unknown[]).length - 1;
    }
    await this.#call("SetSceneItemIndex", {
      sceneName: scene,
      sceneItemId: id,
      sceneItemIndex: index,
    });
  }

  async setFilter(
    source: string,
    name: string,
    kind: string,
    settings: Record<string, unknown>,
    exists: boolean,
  ): Promise<void> {
    if (exists) {
      await this.#call("SetSourceFilterSettings", {
        sourceName: source,
        filterName: name,
        filterSettings: settings,
      });
    } else {
      await this.#call("CreateSourceFilter", {
        sourceName: source,
        filterName: name,
        filterKind: kind,
        filterSettings: settings,
      });
    }
  }

  async setProgramScene(scene: string): Promise<void> {
    await this.#call("SetCurrentProgramScene", { sceneName: scene });
  }

  /** `outputActive` of a status request; `false` when OBS has no such output (no replay buffer). */
  async #active(type: string): Promise<boolean> {
    try {
      return Boolean((await this.#call(type)).outputActive);
    } catch {
      return false;
    }
  }

  async where(): Promise<ObsWhere> {
    const c = await this.#call("GetSceneCollectionList");
    const p = await this.#call("GetProfileList");
    const v = await this.#call("GetVideoSettings");
    return {
      collections: (c.sceneCollections as unknown[]).map(String),
      currentCollection: String(c.currentSceneCollectionName ?? ""),
      profiles: (p.profiles as unknown[]).map(String),
      currentProfile: String(p.currentProfileName ?? ""),
      outputs: {
        streaming: Boolean((await this.#call("GetStreamStatus")).outputActive),
        recording: Boolean((await this.#call("GetRecordStatus")).outputActive),
        // These two answer an error when the output does not exist: then it is not running.
        virtualCam: await this.#active("GetVirtualCamStatus"),
        replayBuffer: await this.#active("GetReplayBufferStatus"),
      },
      video: {
        baseWidth: Number(v.baseWidth),
        baseHeight: Number(v.baseHeight),
        outputWidth: Number(v.outputWidth),
        outputHeight: Number(v.outputHeight),
        fpsNumerator: Number(v.fpsNumerator),
        fpsDenominator: Number(v.fpsDenominator),
      },
    };
  }

  #events(): ChangeEvents {
    const client = this.#client as unknown as ChangeEvents;
    return {
      on: (event, listener) => client.on(event, listener),
      off: (event, listener) => client.off(event, listener),
    };
  }

  async useCollection(name: string, create: boolean): Promise<void> {
    await awaitChange(
      this.#events(),
      {
        event: "CurrentSceneCollectionChanged",
        field: "sceneCollectionName",
        name,
        what: "場景集合",
      },
      // Both requests switch and answer once OBS has loaded the collection.
      () =>
        this.#call(
          create ? "CreateSceneCollection" : "SetCurrentSceneCollection",
          { sceneCollectionName: name },
          SWITCH_TIMEOUT_MS,
        ),
      SWITCH_TIMEOUT_MS,
    );
  }

  async useProfile(name: string, create: boolean): Promise<void> {
    await awaitChange(
      this.#events(),
      { event: "CurrentProfileChanged", field: "profileName", name, what: "設定檔" },
      // `CreateProfile` makes a blank profile and switches to it.
      () =>
        this.#call(
          create ? "CreateProfile" : "SetCurrentProfile",
          { profileName: name },
          SWITCH_TIMEOUT_MS,
        ),
      SWITCH_TIMEOUT_MS,
    );
  }

  async setVideo(
    width: number,
    height: number,
    fps: { numerator: number; denominator: number } | null,
  ): Promise<void> {
    // Fields go in pairs; OBS refuses while an output runs (`OutputRunning`).
    await this.#call("SetVideoSettings", {
      baseWidth: width,
      baseHeight: height,
      outputWidth: width,
      outputHeight: height,
      ...(fps === null ? {} : { fpsNumerator: fps.numerator, fpsDenominator: fps.denominator }),
    });
  }

  async setProfileParameter(category: string, name: string, value: string): Promise<void> {
    await this.#call("SetProfileParameter", {
      parameterCategory: category,
      parameterName: name,
      parameterValue: value,
    });
  }

  async replayBufferAvailable(): Promise<boolean> {
    try {
      await this.#call("GetReplayBufferStatus");
      return true;
    } catch {
      // "Replay buffer is not available." (InvalidResourceState)
      return false;
    }
  }

  async close(): Promise<void> {
    await withTimeout(this.#client.disconnect(), CALL_TIMEOUT_MS);
  }
}
