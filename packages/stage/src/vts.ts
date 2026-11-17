// VTube Studio Public API client (`ws://localhost:8001`).
//
// Requests are JSON envelopes `{apiName, apiVersion, requestID, messageType, data}`; responses
// carry the same `requestID`, and failures come back as `messageType: "APIError"` with
// `{errorID, message}`. Parameter injection is fire and forget and coalesced: when frames are
// produced faster than the socket drains, only the newest value of each parameter is sent.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { isJsonObject, type JsonObject, type JsonValue } from "@miyoria/types";
import WebSocket from "ws";
import { z } from "zod";

const log = getLogger("stage.vts");

export const API_NAME = "VTubeStudioPublicAPI";
export const API_VERSION = "1.0";
/** `errorID` VTS uses when the user denies the plugin. */
export const ERROR_USER_DENIED = 50;

/** `[vts]` section of the Stage config. */
export const VtsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  url: z.string().default("ws://127.0.0.1:8001"),
  /** Plugin name shown in VTS. */
  plugin_name: z.string().default("Miyoria"),
  plugin_developer: z.string().default("Miyoria"),
  /** Optional base64 PNG (128×128) shown in the VTS approval dialog. */
  plugin_icon: z.string().nullable().default(null),
  /** How long an emotion is held. */
  emotion_hold_ms: z.number().int().nonnegative().default(4_000),
  /** Minimum time an emotion stays after she stops speaking. */
  after_speech_ms: z.number().int().nonnegative().default(1_500),
  /** Expression fade, in seconds. */
  expression_fade: z.number().default(0.3),
  /** Injection rate (frame times come from the clock, so any rate works). */
  inject_hz: z.number().int().nonnegative().default(60),
  /**
   * Drive the model only while OBS is streaming (Go Live included): nobody sees it otherwise.
   * Without an OBS connection configured the model is always driven.
   */
  only_while_streaming: z.boolean().default(true),
  /**
   * Tell VTS a face is tracked while injecting. Keeps the model's "tracking lost" idle
   * animation from playing (and taking over eyes, jaw and head) while Miyoria drives it.
   */
  face_found: z.boolean().default(true),
  /**
   * Custom input parameters created on connect (`ParameterCreationRequest`), so the model's
   * mappings that expect them come alive. Default parameters of VTS are skipped.
   */
  custom_params: z
    .array(z.string())
    .default([
      "JawOpen",
      "BrowInnerUp",
      "MouthFunnel",
      "MouthPucker",
      "REyeSquint",
      "LEyeSquint",
      "mouthSmileL",
      "mouthSmileR",
      "MiyoriaEyeSmile",
      "MiyoriaBodyX",
      "MiyoriaBodyY",
      "MiyoriaBodyZ",
    ]),
  /** Inject idle head / eye motion. */
  idle_motion: z.boolean().default(true),
  /** Timeout of ordinary requests. */
  request_timeout_ms: z.number().int().nonnegative().default(5_000),
  /** How long to wait for the user to approve the plugin. */
  approval_timeout_ms: z.number().int().nonnegative().default(120_000),
});
export type VtsConfig = z.output<typeof VtsConfigSchema>;

/** Plugin identity used for authentication. */
export interface PluginInfo {
  name: string;
  developer: string;
  icon: string | null;
}

export function pluginInfo(config: VtsConfig): PluginInfo {
  return { name: config.plugin_name, developer: config.plugin_developer, icon: config.plugin_icon };
}

/** An `APIError` response. */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly id: number,
    readonly apiMessage: string,
  ) {
    super(`VTube Studio error ${id}: ${apiMessage}`);
  }
}

export class VtsError extends Error {
  override readonly name = "VtsError";
}

/** Loaded model, from `CurrentModelRequest`. */
export interface ModelInfo {
  loaded: boolean;
  name: string;
  id: string;
}

/** One hotkey of the current model. */
export interface Hotkey {
  name: string;
  kind: string;
  id: string;
}

/** One expression of the current model. */
export interface Expression {
  name: string;
  file: string;
  active: boolean;
}

/** Where the authentication token is kept. */
export function tokenPath(dataDir: string): string {
  return join(dataDir, "vts-token.txt");
}

const str = (v: JsonValue | undefined): string => (typeof v === "string" ? v : "");
const bool = (v: JsonValue | undefined): boolean => v === true;
const obj = (v: JsonValue | undefined): JsonObject => (isJsonObject(v) ? v : {});
const list = (v: JsonValue | undefined): JsonValue[] => (Array.isArray(v) ? v : []);

interface Waiter {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
}

/** A connection to VTube Studio. */
export class VtsClient {
  readonly #ws: WebSocket;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, Waiter>();
  readonly #inject = new Map<string, number>();
  #injectFaceFound = false;
  #injectScheduled = false;
  #injectCount = 0;
  #nextId = 1;
  #errors = 0;
  #closed = false;
  readonly #closedPromise: Promise<void>;
  #resolveClosed!: () => void;

  private constructor(ws: WebSocket, timeoutMs: number) {
    this.#ws = ws;
    this.#timeoutMs = timeoutMs;
    this.#closedPromise = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) this.#onMessage(data.toString());
    });
    ws.on("close", () => this.#markClosed());
    ws.on("error", (error) => {
      log.debug({ err: error.message }, "VTube Studio socket error");
      this.#markClosed();
    });
  }

  /** Opens the WebSocket. Call `authenticate` next. */
  static connect(url: string, timeoutMs: number): Promise<VtsClient> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
      } catch (error) {
        reject(new VtsError(`cannot connect to VTube Studio at ${url}: ${errorMessage(error)}`));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        ws.terminate();
        reject(new VtsError(`timed out connecting to VTube Studio at ${url}`));
      }, timeoutMs);
      const onOpen = () => {
        cleanup();
        resolve(new VtsClient(ws, timeoutMs));
      };
      const onError = (error: Error) => {
        cleanup();
        ws.terminate();
        reject(new VtsError(`cannot connect to VTube Studio at ${url}: ${error.message}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("open", onOpen);
        ws.off("error", onError);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  /** The connection is gone. */
  isClosed(): boolean {
    return this.#closed;
  }

  /** Resolves when the connection is gone. */
  closed(): Promise<void> {
    return this.#closedPromise;
  }

  /** Closes the connection. */
  close(): void {
    if (this.#closed) return;
    this.#markClosed();
    this.#ws.close();
    setTimeout(() => this.#ws.terminate(), 1_000).unref();
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#pending.values()) {
      waiter.reject(new VtsError("VTube Studio disconnected"));
    }
    this.#pending.clear();
    this.#inject.clear();
    this.#resolveClosed();
  }

  #onMessage(text: string): void {
    let value: JsonValue;
    try {
      value = JSON.parse(text) as JsonValue;
    } catch {
      log.debug("invalid JSON from VTube Studio");
      return;
    }
    if (!isJsonObject(value)) return;
    const id = str(value.requestID);
    const waiter = this.#pending.get(id);
    if (waiter) {
      this.#pending.delete(id);
      waiter.resolve(value);
    } else if (value.messageType === "APIError") {
      this.#errors += 1;
      if (this.#errors % 300 === 1) {
        log.warn(
          { request: id, error: obj(value.data).message ?? null, count: this.#errors },
          "VTube Studio rejected a request",
        );
      }
    }
    // Otherwise: injection acks and events.
  }

  #sendText(text: string): boolean {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(text, (error) => {
      if (error) this.#markClosed();
    });
    return true;
  }

  /** Sends a request and returns the response `data`. */
  request(
    messageType: string,
    data: JsonValue = {},
    timeoutMs = this.#timeoutMs,
  ): Promise<JsonObject> {
    const id = `miyoria-${this.#nextId++}`;
    const text = JSON.stringify({
      apiName: API_NAME,
      apiVersion: API_VERSION,
      requestID: id,
      messageType,
      data,
    });
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new VtsError(`VTube Studio did not answer \`${messageType}\` in time`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          const responseData = obj(value.data);
          if (value.messageType === "APIError") {
            const errorId = responseData.errorID;
            reject(
              new ApiError(
                typeof errorId === "number" && Number.isInteger(errorId) ? errorId : -1,
                str(responseData.message),
              ),
            );
          } else {
            resolve(responseData);
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (!this.#sendText(text)) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new VtsError("VTube Studio disconnected"));
      }
    });
  }

  /**
   * Authenticates as a plugin. Uses the token stored at `tokenFile` when it is still valid;
   * otherwise asks VTS for a new one (the user must click "Allow" in VTube Studio) and stores it.
   */
  async authenticate(
    plugin: PluginInfo,
    tokenFile: string,
    approvalTimeoutMs: number,
  ): Promise<void> {
    const stored = await readToken(tokenFile);
    if (stored !== null) {
      const [ok, reason] = await this.#authWith(plugin, stored);
      if (ok) {
        log.debug("authenticated with VTube Studio using the stored token");
        return;
      }
      log.warn({ reason }, "stored VTube Studio token was rejected, requesting a new one");
      await rm(tokenFile, { force: true }).catch(() => undefined);
    }
    log.info('requesting a VTube Studio plugin token: click "Allow" in VTube Studio');
    const data: JsonObject = { pluginName: plugin.name, pluginDeveloper: plugin.developer };
    if (plugin.icon !== null) data.pluginIcon = plugin.icon;
    let response: JsonObject;
    try {
      response = await this.request("AuthenticationTokenRequest", data, approvalTimeoutMs);
    } catch (error) {
      if (error instanceof ApiError && error.id === ERROR_USER_DENIED) {
        throw new VtsError(`the plugin was denied in VTube Studio (${error.apiMessage})`, {
          cause: error,
        });
      }
      throw error;
    }
    const token = str(response.authenticationToken);
    if (token === "") throw new VtsError("VTube Studio sent no authentication token");
    await writeToken(tokenFile, token);
    const [ok, reason] = await this.#authWith(plugin, token);
    if (!ok) throw new VtsError(`VTube Studio rejected the new token: ${reason}`);
    log.info("authenticated with VTube Studio");
  }

  async #authWith(plugin: PluginInfo, token: string): Promise<[boolean, string]> {
    const data = await this.request("AuthenticationRequest", {
      pluginName: plugin.name,
      pluginDeveloper: plugin.developer,
      authenticationToken: token,
    });
    return [bool(data.authenticated), str(data.reason)];
  }

  async currentModel(): Promise<ModelInfo> {
    const d = await this.request("CurrentModelRequest", {});
    return { loaded: bool(d.modelLoaded), name: str(d.modelName), id: str(d.modelID) };
  }

  async hotkeys(): Promise<Hotkey[]> {
    const d = await this.request("HotkeysInCurrentModelRequest", {});
    return list(d.availableHotkeys).map((h) => {
      const o = obj(h);
      return { name: str(o.name), kind: str(o.type), id: str(o.hotkeyID) };
    });
  }

  /** Fires a hotkey given by name (case-insensitive) or id. Returns the id. */
  async triggerHotkey(nameOrId: string): Promise<string> {
    const wanted = nameOrId.trim();
    let id: string;
    let hotkeys: Hotkey[] | null = null;
    try {
      hotkeys = await this.hotkeys();
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot list hotkeys, triggering by name");
    }
    if (hotkeys) {
      const lower = wanted.toLowerCase();
      const found =
        hotkeys.find((h) => h.id === wanted) ?? hotkeys.find((h) => h.name.toLowerCase() === lower);
      if (!found) throw new VtsError(`the model has no hotkey \`${wanted}\``);
      id = found.id;
    } else {
      id = wanted;
    }
    await this.request("HotkeyTriggerRequest", { hotkeyID: id });
    return id;
  }

  async expressions(): Promise<Expression[]> {
    const d = await this.request("ExpressionStateRequest", { details: false });
    return list(d.expressions).map((e) => {
      const o = obj(e);
      return { name: str(o.name), file: str(o.file), active: bool(o.active) };
    });
  }

  async setExpression(file: string, active: boolean, fade: number): Promise<void> {
    await this.request("ExpressionActivationRequest", {
      expressionFile: file,
      active,
      fadeTime: Math.min(Math.max(fade, 0), 2),
    });
  }

  /** Names of the input parameters (default and custom) VTS knows. */
  async inputParameters(): Promise<Set<string>> {
    const { defaults, custom } = await this.inputParameterLists();
    return new Set([...defaults, ...custom]);
  }

  /** VTS's own input parameters and the custom ones plugins created. */
  async inputParameterLists(): Promise<{ defaults: Set<string>; custom: Set<string> }> {
    const d = await this.request("InputParameterListRequest", {});
    const read = (key: string) => {
      const names = new Set<string>();
      for (const p of list(d[key])) {
        const name = obj(p).name;
        if (typeof name === "string") names.add(name);
      }
      return names;
    };
    return { defaults: read("defaultParameters"), custom: read("customParameters") };
  }

  /**
   * Creates (or updates, when this plugin made it) a custom input parameter. Names are 4–32
   * letters / digits.
   */
  async createParameter(
    name: string,
    min: number,
    max: number,
    defaultValue: number,
    explanation = "",
  ): Promise<void> {
    await this.request("ParameterCreationRequest", {
      parameterName: name,
      explanation: explanation.slice(0, 255),
      min,
      max,
      defaultValue,
    });
  }

  /**
   * Queues parameter values for the next `InjectParameterDataRequest` (mode `set`). Values not
   * sent yet are merged; newer ones win.
   */
  inject(values: readonly (readonly [string, number])[], faceFound: boolean): void {
    if (this.#closed || values.length === 0) return;
    for (const [id, value] of values) {
      if (Number.isFinite(value)) this.#inject.set(id, value);
    }
    this.#injectFaceFound = faceFound;
    this.#scheduleInject();
  }

  #scheduleInject(delayMs = 0): void {
    if (this.#injectScheduled) return;
    this.#injectScheduled = true;
    const flush = () => {
      this.#injectScheduled = false;
      this.#flushInject();
    };
    if (delayMs > 0) setTimeout(flush, delayMs);
    else setImmediate(flush);
  }

  #flushInject(): void {
    if (this.#closed || this.#inject.size === 0) return;
    // Still draining the previous frame: keep merging.
    if (this.#ws.bufferedAmount > 0) {
      this.#scheduleInject(2);
      return;
    }
    const ids = [...this.#inject.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parameterValues = ids.map((id) => ({ id, value: this.#inject.get(id) as number }));
    this.#inject.clear();
    this.#injectCount += 1;
    this.#sendText(
      JSON.stringify({
        apiName: API_NAME,
        apiVersion: API_VERSION,
        requestID: `inject-${this.#injectCount}`,
        messageType: "InjectParameterDataRequest",
        data: { faceFound: this.#injectFaceFound, mode: "set", parameterValues },
      }),
    );
  }
}

async function readToken(path: string): Promise<string | null> {
  try {
    const t = (await readFile(path, "utf8")).trim();
    return t === "" ? null : t;
  } catch {
    return null;
  }
}

async function writeToken(path: string, token: string): Promise<void> {
  const dir = dirname(path);
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new VtsError(`cannot create ${dir}: ${errorMessage(error)}`, { cause: error });
  }
  try {
    await writeFile(path, token);
  } catch (error) {
    throw new VtsError(`cannot store the VTS token in ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}
