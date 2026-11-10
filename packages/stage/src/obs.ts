// OBS control (obs-websocket v5 via `obs-websocket-js`), behind `Obs` so it can be faked in
// tests.

import { writeFile } from "node:fs/promises";
import { errorMessage, getLogger, SerialQueue, sleep, withTimeout } from "@miyoria/kernel";
import OBSWebSocket, { type OBSRequestTypes, type OBSResponseTypes } from "obs-websocket-js/json";
import { z } from "zod";
import type { SceneTransition, StreamAction } from "./protocol.js";
import { Watch } from "./watch.js";

const log = getLogger("stage.obs");

/**
 * Longest wait for one OBS request. A crashed OBS keeps its socket open behind its crash
 * dialog and never answers; the failed poll then drops the connection and reconnects.
 */
const CALL_TIMEOUT_MS = 5_000;

/** `[obs]` section of the Stage config. */
export const ObsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65_535).default(4455),
  /** obs-websocket password (empty when authentication is off). */
  password: z.string().default(""),
  /**
   * Text source that shows her latest line (none by default). Created in the current scene,
   * at the bottom, when OBS does not have it yet.
   */
  subtitle_source: z.string().nullable().default(null),
  /** Clear the subtitle source this long after the final text; 0 keeps it. */
  subtitle_clear_ms: z.number().int().nonnegative().default(6_000),
  /** Status poll interval. */
  poll_ms: z.number().int().nonnegative().default(2_000),
  /** How long `stream start / stop` waits for OBS to change state. */
  stream_wait_ms: z.number().int().nonnegative().default(15_000),
  /**
   * Media source (`ffmpeg_source`) that shows the song's original video, muted, while she
   * sings (`null` = off). The owner creates it; the Stage sets its file and plays it only when
   * it is an item of the scene it plays in (the `sing` scene, else the current one).
   */
  song_video_source: z.string().trim().min(1).nullable().default("Miyoria 歌曲影片"),
  /** The song worker's cache (`SING_DATA_DIR`): video paths outside it are refused. */
  song_video_dir: z.string().default("data/songs"),
  /**
   * Start the video this much early (OBS takes a moment from restart to the first frame). It
   * already waits `[stage.lipsync] latency_ms` like her mouth, so it shows what viewers hear.
   */
  song_video_lead_ms: z.number().int().min(0).max(5_000).default(0),
  /** Re-seek the video when it drifts this far from the song (checked now and then); 0 = never. */
  song_video_resync_ms: z.number().int().nonnegative().default(300),
  /**
   * Keep OBS's replay buffer running while streaming, so a highlight (`clip`) can be saved; the
   * buffer's length and folder are set in OBS (Settings → Output → Replay Buffer).
   */
  replay_buffer: z.boolean().default(true),
});
export type ObsConfig = z.output<typeof ObsConfigSchema>;

/** The OBS operations the Stage needs. */
export interface Obs {
  currentScene(): Promise<string>;
  /** Scene names, top of OBS's scene list first (optional). */
  sceneList?(): Promise<string[]>;
  setScene(name: string): Promise<void>;
  /**
   * Sets the transition used when switching *to* `scene` (OBS's per-scene transition override),
   * with its duration when given (optional; without it scene switches use whatever transition is
   * current). Unlike the old `setTransition`, OBS's global current transition is never changed,
   * so one switch's transition cannot leak into another.
   */
  setSceneTransition?(scene: string, name: string, durationMs: number | null): Promise<void>;
  /**
   * @deprecated Changed OBS's *global* current transition (and so every later switch); not
   * called any more. Implement `setSceneTransition`.
   */
  setTransition?(name: string, durationMs: number | null): Promise<void>;
  streaming(): Promise<boolean>;
  startStream(): Promise<void>;
  stopStream(): Promise<void>;
  /** Sets the `text` setting of a text source. */
  setText(source: string, text: string): Promise<void>;
  /**
   * Creates text source `source` in the current scene unless an input with that name exists.
   * Returns whether it created one (optional).
   */
  ensureTextSource?(source: string): Promise<boolean>;
  /** Items of `scene` (top level), for the song video (optional, like the media calls below). */
  sceneItems?(scene: string): Promise<SceneItem[]>;
  setSceneItemEnabled?(scene: string, id: number, enabled: boolean): Promise<void>;
  /**
   * Points media source `source` at `file` (`""` clears it): local, no loop, no restart on
   * activate (the Stage starts it on time itself), muted.
   */
  setMediaFile?(source: string, file: string): Promise<void>;
  mediaAction?(source: string, action: MediaAction): Promise<void>;
  /** Playback position in ms, `null` when nothing plays. */
  mediaCursor?(source: string): Promise<number | null>;
  seekMedia?(source: string, ms: number): Promise<void>;
  /** Whether the replay buffer runs (optional, like the two below). */
  replayBufferActive?(): Promise<boolean>;
  startReplayBuffer?(): Promise<void>;
  /** Saves the replay buffer and returns the file OBS wrote, `null` when it wrote none in time. */
  saveReplay?(): Promise<string | null>;
  /** Drops the connection (optional). */
  close?(): Promise<void>;
}

/** One item of a scene. */
export interface SceneItem {
  id: number;
  source: string;
  enabled: boolean;
}

export type MediaAction = "restart" | "stop";

const MEDIA_ACTIONS: Record<MediaAction, string> = {
  restart: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
  stop: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP",
};

/** Opens `Obs` connections. */
export interface ObsConnector {
  connect(): Promise<Obs>;
}

export class ObsError extends Error {
  override readonly name = "ObsError";
}

/** Connects with `obs-websocket-js`. */
export class ObsWebSocketConnector implements ObsConnector {
  readonly host: string;
  readonly port: number;
  readonly #password: string | null;

  constructor(options: { host: string; port: number; password?: string | null }) {
    this.host = options.host;
    this.port = options.port;
    this.#password = options.password ? options.password : null;
  }

  static fromConfig(config: ObsConfig): ObsWebSocketConnector {
    return new ObsWebSocketConnector(config);
  }

  async connect(): Promise<Obs> {
    const client = new OBSWebSocket();
    // Without a listener EventEmitter3 drops errors anyway; keep them out of the log noise.
    client.on("ConnectionError", () => {});
    try {
      await client.connect(`ws://${this.host}:${this.port}`, this.#password ?? undefined);
    } catch (error) {
      throw new ObsError(
        `cannot connect to OBS at ${this.host}:${this.port}: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    return new ObsWebSocketObs(client);
  }

  toJSON(): { host: string; port: number } {
    // Never the password.
    return { host: this.host, port: this.port };
  }
}

class ObsWebSocketObs implements Obs {
  readonly #client: OBSWebSocket;

  constructor(client: OBSWebSocket) {
    this.#client = client;
  }

  async #call<T extends keyof OBSRequestTypes>(
    type: T,
    data?: OBSRequestTypes[T],
  ): Promise<OBSResponseTypes[T]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ObsError(`OBS did not answer ${type} within ${CALL_TIMEOUT_MS} ms`)),
        CALL_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([this.#client.call(type, data), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async currentScene(): Promise<string> {
    const r = await this.#call("GetCurrentProgramScene");
    return r.sceneName ?? r.currentProgramSceneName;
  }

  async sceneList(): Promise<string[]> {
    const { scenes } = await this.#call("GetSceneList");
    // `sceneIndex` 0 is the bottom of OBS's list.
    return scenes
      .map((s) => ({ name: String(s.sceneName ?? ""), index: Number(s.sceneIndex ?? 0) }))
      .filter((s) => s.name !== "")
      .sort((a, b) => b.index - a.index)
      .map((s) => s.name);
  }

  async setScene(name: string): Promise<void> {
    await this.#call("SetCurrentProgramScene", { sceneName: name });
  }

  async setSceneTransition(scene: string, name: string, durationMs: number | null): Promise<void> {
    // The scene's own override: used for switches to this scene only, OBS's current
    // (global) transition stays what the owner set.
    await this.#call("SetSceneSceneTransitionOverride", {
      sceneName: scene,
      transitionName: name,
      ...(durationMs === null
        ? {}
        : { transitionDuration: Math.min(Math.max(Math.round(durationMs), 50), 20_000) }),
    });
  }

  async streaming(): Promise<boolean> {
    return (await this.#call("GetStreamStatus")).outputActive;
  }

  async startStream(): Promise<void> {
    await this.#call("StartStream");
  }

  async stopStream(): Promise<void> {
    await this.#call("StopStream");
  }

  async setText(source: string, text: string): Promise<void> {
    await this.#call("SetInputSettings", {
      inputName: source,
      inputSettings: { text },
      overlay: true,
    });
  }

  async ensureTextSource(source: string): Promise<boolean> {
    const { inputs } = await this.#call("GetInputList");
    if (inputs.some((i) => i.inputName === source)) return false;
    const { inputKinds } = await this.#call("GetInputKindList", { unversioned: false });
    // GDI+ on Windows, FreeType elsewhere.
    const kind = ["text_gdiplus_v3", "text_gdiplus_v2", "text_ft2_source_v2"].find((k) =>
      inputKinds.includes(k),
    );
    if (!kind) throw new ObsError("OBS has no text source type");
    const video = await this.#call("GetVideoSettings");
    const width = Math.round(video.baseWidth * 0.9);
    const fontSize = Math.max(Math.round(video.baseHeight / 16), 24);
    const scene = await this.currentScene();
    const { sceneItemId } = await this.#call("CreateInput", {
      sceneName: scene,
      inputName: source,
      inputKind: kind,
      inputSettings: {
        text: "",
        font: { face: "Microsoft JhengHei", size: fontSize, style: "Bold", flags: 1 },
        color: 0xffffffff,
        outline: true,
        outline_size: Math.max(Math.round(fontSize / 10), 3),
        outline_color: 0xff000000,
        align: "center",
        valign: "bottom",
        extents: true,
        extents_cx: width,
        extents_cy: fontSize * 3,
        extents_wrap: true,
      },
      sceneItemEnabled: true,
    });
    await this.#call("SetSceneItemTransform", {
      sceneName: scene,
      sceneItemId,
      sceneItemTransform: {
        positionX: Math.round((video.baseWidth - width) / 2),
        positionY: Math.round(video.baseHeight - fontSize * 3 - video.baseHeight * 0.04),
      },
    });
    return true;
  }

  async sceneItems(scene: string): Promise<SceneItem[]> {
    const { sceneItems } = await this.#call("GetSceneItemList", { sceneName: scene });
    return sceneItems.map((i) => ({
      id: Number(i.sceneItemId),
      source: String(i.sourceName ?? ""),
      enabled: Boolean(i.sceneItemEnabled),
    }));
  }

  async setSceneItemEnabled(scene: string, id: number, enabled: boolean): Promise<void> {
    await this.#call("SetSceneItemEnabled", {
      sceneName: scene,
      sceneItemId: id,
      sceneItemEnabled: enabled,
    });
  }

  async setMediaFile(source: string, file: string): Promise<void> {
    await this.#call("SetInputSettings", {
      inputName: source,
      inputSettings: {
        is_local_file: true,
        local_file: file,
        looping: false,
        restart_on_activate: false,
        close_when_inactive: false,
        clear_on_media_end: true,
      },
      overlay: true,
    });
    await this.#call("SetInputMute", { inputName: source, inputMuted: true });
  }

  async mediaAction(source: string, action: MediaAction): Promise<void> {
    await this.#call("TriggerMediaInputAction", {
      inputName: source,
      mediaAction: MEDIA_ACTIONS[action],
    });
  }

  async mediaCursor(source: string): Promise<number | null> {
    const r = await this.#call("GetMediaInputStatus", { inputName: source });
    return r.mediaState === "OBS_MEDIA_STATE_PLAYING" && typeof r.mediaCursor === "number"
      ? r.mediaCursor
      : null;
  }

  async seekMedia(source: string, ms: number): Promise<void> {
    await this.#call("SetMediaInputCursor", {
      inputName: source,
      mediaCursor: Math.max(0, Math.round(ms)),
    });
  }

  async replayBufferActive(): Promise<boolean> {
    return (await this.#call("GetReplayBufferStatus")).outputActive;
  }

  async startReplayBuffer(): Promise<void> {
    await this.#call("StartReplayBuffer");
  }

  async saveReplay(): Promise<string | null> {
    const before = await this.#lastReplay();
    await this.#call("SaveReplayBuffer");
    // OBS writes the file in the background and reports it as the last replay when done.
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const path = await this.#lastReplay();
      if (path !== null && path !== before) return path;
    }
    return null;
  }

  async #lastReplay(): Promise<string | null> {
    try {
      const path = (await this.#call("GetLastReplayBufferReplay")).savedReplayPath;
      return path === "" ? null : path;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    // A hung OBS never answers the close handshake either.
    await withTimeout(this.#client.disconnect(), CALL_TIMEOUT_MS);
  }
}

/** What the Stage knows about OBS. */
export interface ObsState {
  connected: boolean;
  scene: string | null;
  streaming: boolean;
  /** Scene names, top of OBS's scene list first. */
  scenes: string[];
}

export function defaultObsState(): ObsState {
  return { connected: false, scene: null, streaming: false, scenes: [] };
}

function sameObsState(a: ObsState, b: ObsState): boolean {
  return (
    a.connected === b.connected &&
    a.scene === b.scene &&
    a.streaming === b.streaming &&
    a.scenes.length === b.scenes.length &&
    a.scenes.every((s, i) => s === b.scenes[i])
  );
}

/** Keeps one OBS connection (reconnecting with backoff), polls its state and runs commands. */
export class ObsController {
  readonly #connector: ObsConnector;
  readonly #config: ObsConfig;
  #current: Obs | null = null;
  readonly #state = new Watch<ObsState>(defaultObsState(), sameObsState);
  #subtitleGeneration = 0;
  readonly #clearTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Scene switches, one at a time. */
  readonly #switches = new SerialQueue();
  #replayWarned = false;

  constructor(connector: ObsConnector, config: ObsConfig) {
    this.#connector = connector;
    this.#config = config;
  }

  state(): ObsState {
    return this.#state.get();
  }

  /** The OBS connection, `null` while disconnected. */
  connection(): Obs | null {
    return this.#current;
  }

  /** Calls `listener` whenever the state changes; returns the unsubscribe function. */
  subscribe(listener: (state: ObsState) => void): () => void {
    return this.#state.subscribe(listener);
  }

  #obs(): Obs {
    if (!this.#current) throw new ObsError("OBS is not connected");
    return this.#current;
  }

  /** Connection loop; returns when `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    let backoffMs = 1_000;
    const pollMs = Math.max(this.#config.poll_ms, 100);
    try {
      while (!signal.aborted) {
        let obs: Obs | null = null;
        try {
          obs = await this.#connector.connect();
        } catch (error) {
          log.debug({ err: errorMessage(error) }, "OBS not reachable");
        }
        if (obs) {
          log.info("connected to OBS");
          backoffMs = 1_000;
          this.#current = obs;
          await this.#ensureSubtitleSource(obs);
          while (!signal.aborted) {
            try {
              await this.refresh();
            } catch (error) {
              log.warn({ err: errorMessage(error) }, "lost the OBS connection");
              break;
            }
            if (!(await pause(pollMs, signal))) break;
          }
          this.#current = null;
          this.#state.set(defaultObsState());
          await obs.close?.().catch(() => undefined);
        }
        if (!(await pause(backoffMs, signal))) return;
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    } finally {
      for (const timer of this.#clearTimers) clearTimeout(timer);
      this.#clearTimers.clear();
    }
  }

  async #ensureSubtitleSource(obs: Obs): Promise<void> {
    const source = this.#config.subtitle_source;
    if (source === null || !obs.ensureTextSource) return;
    try {
      if (await obs.ensureTextSource(source)) {
        log.info({ source }, "created the subtitle text source in the current scene");
      }
    } catch (error) {
      log.warn({ err: errorMessage(error), source }, "cannot create the subtitle source");
    }
  }

  /** Reads scene and streaming state. */
  async refresh(): Promise<ObsState> {
    const obs = this.#obs();
    const scene = await obs.currentScene();
    const streaming = await obs.streaming();
    let scenes = this.#state.get().scenes;
    if (obs.sceneList) {
      try {
        scenes = await obs.sceneList();
      } catch (error) {
        log.debug({ err: errorMessage(error) }, "cannot list OBS scenes");
      }
    }
    const state: ObsState = { connected: true, scene, streaming, scenes };
    this.#state.set(state);
    if (streaming) await this.#keepReplayBuffer(obs);
    return state;
  }

  /** Starts OBS's replay buffer while streaming (`replay_buffer`); failures are logged once. */
  async #keepReplayBuffer(obs: Obs): Promise<void> {
    if (!this.#config.replay_buffer || !obs.replayBufferActive || !obs.startReplayBuffer) return;
    try {
      if (!(await obs.replayBufferActive())) {
        await obs.startReplayBuffer();
        log.info("started the OBS replay buffer for highlights");
      }
      this.#replayWarned = false;
    } catch (error) {
      if (!this.#replayWarned) {
        log.warn(
          { err: errorMessage(error) },
          "cannot start the OBS replay buffer (enable it in OBS)",
        );
      }
      this.#replayWarned = true;
    }
  }

  /**
   * Saves the replay buffer as a highlight and writes `<file>.json` next to it (`reason`, when).
   * Returns the video file, or `null` when the buffer is off or OBS wrote nothing.
   */
  async clip(reason: string, now: () => number = Date.now): Promise<string | null> {
    const obs = this.#obs();
    if (!obs.saveReplay) return null;
    if (obs.replayBufferActive && !(await obs.replayBufferActive())) return null;
    const path = await obs.saveReplay();
    if (path === null) return null;
    try {
      await writeFile(
        `${path}.json`,
        `${JSON.stringify({ reason, at: new Date(now()).toISOString() }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      log.warn({ err: errorMessage(error), path }, "cannot write the highlight's note");
    }
    return path;
  }

  /**
   * Switches the program scene, with `transition` set for this switch only (the target scene's
   * transition override; OBS's global transition is never changed). A transition OBS does not
   * have is logged and the switch happens with the current one. Switches are serialized: a
   * second one waits for the first to finish, so their transitions never interleave.
   */
  setScene(name: string, transition: SceneTransition | null = null): Promise<ObsState> {
    return this.#switches.run(async () => {
      const obs = this.#obs();
      if (transition !== null && obs.setSceneTransition) {
        try {
          await obs.setSceneTransition(name, transition.name, transition.duration_ms);
        } catch (error) {
          log.warn(
            { err: errorMessage(error), transition: transition.name, scene: name },
            "cannot set the scene transition; switching with the current one",
          );
        }
      }
      await obs.setScene(name);
      return this.refresh();
    });
  }

  /** Starts / stops streaming and waits (up to `stream_wait_ms`) for OBS to report it. */
  async stream(action: StreamAction): Promise<ObsState> {
    const obs = this.#obs();
    const want = action === "start";
    if ((await obs.streaming()) !== want) {
      if (want) await obs.startStream();
      else await obs.stopStream();
    }
    const deadline = Date.now() + Math.max(this.#config.stream_wait_ms, 1);
    for (;;) {
      const state = await this.refresh();
      if (state.streaming === want || Date.now() >= deadline) return state;
      await sleep(250);
    }
  }

  /**
   * Shows `text` in the subtitle source (when configured); a final text is cleared after
   * `subtitle_clear_ms`.
   */
  async subtitle(text: string, isFinal: boolean): Promise<void> {
    const source = this.#config.subtitle_source;
    if (source === null) return;
    const generation = ++this.#subtitleGeneration;
    const obs = this.#current;
    if (!obs) return;
    try {
      await obs.setText(source, text);
    } catch (error) {
      log.warn({ err: errorMessage(error), source }, "cannot update the subtitle source");
      return;
    }
    if (isFinal && this.#config.subtitle_clear_ms > 0) {
      const timer = setTimeout(() => {
        this.#clearTimers.delete(timer);
        if (this.#subtitleGeneration !== generation) return;
        const current = this.#current;
        if (current) void current.setText(source, "").catch(() => undefined);
      }, this.#config.subtitle_clear_ms);
      this.#clearTimers.add(timer);
    }
  }
}

/** Sleeps `ms`; false when `signal` aborted. */
async function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await sleep(ms, signal);
    return true;
  } catch {
    return false;
  }
}
