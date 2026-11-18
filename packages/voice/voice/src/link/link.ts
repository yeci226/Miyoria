// The `VoiceLink` service: the connection(s) to the self voice node and the per-connection
// protocol loop.

import { timingSafeEqual } from "node:crypto";
import { readFrameHeader, VOICE_LINK_FRAME_HEADER_BYTES } from "@miyoria/contracts/voice-link";
import { errorMessage, type Logger } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type ContextKey,
  Events,
  newId,
  type PlatformId,
  type PlaybackState,
  type Publish,
  sameAccount,
  serviceKey,
  type VoiceParticipant,
} from "@miyoria/types";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import type { AudioStream } from "../../../speech/src/index.js";
import {
  CAPABILITY_WATCH,
  CLOSE,
  decodeAudio,
  type GoLiveEncoder,
  GoLiveEncoderSchema,
  type NodeMessage,
  NodeMessageSchema,
  TAG_CAPTURE,
  TAG_SNAPSHOT,
  TAG_WATCH_AUDIO,
  VERSION,
  type WireParticipant,
} from "../protocol.js";
import { BoundedQueue, deferred, Watch } from "../util.js";
import {
  Conn,
  closeSocket,
  type GoLiveStatus,
  newConnState,
  VoiceLinkError,
  type WatchStatus,
} from "./conn.js";
import { type LeveledChunk, type Playback, startPlayback } from "./playback.js";

/** Topic of Go Live state changes. */
export const GOLIVE_TOPIC = Events.VoiceGoLive.type;
/** Topic of the state of her watching a stream. */
export const WATCH_TOPIC = Events.VoiceWatch.type;

export const DEFAULT_BIND = "127.0.0.1:7879";

/** `[modules."voice.link"]` config section. */
export const VoiceLinkConfigSchema = z.object({
  /** Listen address. Default `127.0.0.1:7879`. */
  bind: z.string().default(DEFAULT_BIND),
  /** Shared secret the node sends in `hello`. Required. */
  token: z.string().default(""),
  /** How long `join` waits for `joined` / `error`. Default 10 000. */
  join_timeout_ms: z.number().int().nonnegative().default(10_000),
  /** Core → node ping interval. Default 15 000. */
  ping_interval_ms: z.number().int().nonnegative().default(15_000),
  /** A node that sends nothing for this long is disconnected. Default 45 000. */
  peer_timeout_ms: z.number().int().nonnegative().default(45_000),
  /** Time allowed between connecting and `hello`. Default 5 000. */
  hello_timeout_ms: z.number().int().nonnegative().default(5_000),
  /** Capacity of each audio subscriber queue, in events. Default 1024 (about 20 s of one stream). */
  audio_buffer: z.number().int().nonnegative().default(1024),
});
export type VoiceLinkConfig = z.output<typeof VoiceLinkConfigSchema>;

/** Information about one incoming audio stream (one speaker). */
export interface StreamInfo {
  /** Unique per link (node stream ids are scoped to their connection). */
  stream: number;
  /** Kind `voice`; scope = guild, channel = voice channel. */
  context: ContextKey;
  speaker: AccountRef;
  displayName: string;
  sampleRate: number;
}

/** Captured audio, as delivered by `VoiceLink.subscribeAudio`. */
export type AudioEvent =
  | { type: "stream_open"; info: StreamInfo }
  /** PCM s16le mono at the stream's sample rate (16 kHz). */
  | { type: "frame"; stream: number; samples: Int16Array }
  | { type: "stream_close"; stream: number };

/**
 * A request to start a Go Live stream. Only `guild` and `source` are required; the node applies
 * its own defaults to the rest.
 */
export interface GoLiveRequest {
  guild: string;
  /** Voice channel to stream in. Default: the one she is in, else the node joins it first. */
  channel?: string;
  /** `rtmp://`, `srt://`, `udp://`, `http(s)://` URL or a local file. */
  source: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
  /** `auto` (default), `nvenc` or `software`. */
  encoder?: string;
  /** Send the source's audio track (default true). */
  audio?: boolean;
  /**
   * Make the node's ffmpeg wait for the source to connect (default: true for `rtmp://`; SRT URLs
   * without `mode=` become `mode=listener`).
   */
  listen?: boolean;
}

/** Builds the context of a voice channel. */
export function voiceContext(platform: PlatformId, guild: string, channel: string): ContextKey {
  return { platform, scope: guild, channel, kind: "voice" };
}

/** Constant-time comparison of the token. */
function tokenMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

type HelloOutcome =
  | { ok: true; account: AccountRef; node: string; capabilities: string[] }
  | { ok: false; code: number; reason: string };

function readHello(text: string, token: string): HelloOutcome {
  const reject = (code: number, reason: string): HelloOutcome => ({ ok: false, code, reason });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return reject(CLOSE.BAD_HELLO, "invalid JSON");
  }
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "hello") {
    return reject(CLOSE.BAD_HELLO, "expected hello");
  }
  // Token first, so an unauthenticated peer learns nothing else.
  const got = "token" in value && typeof value.token === "string" ? value.token : "";
  if (!tokenMatches(token, got)) return reject(CLOSE.UNAUTHORIZED, "invalid token");
  const parsed = NodeMessageSchema.safeParse(value);
  if (!parsed.success || parsed.data.type !== "hello") {
    return reject(CLOSE.BAD_HELLO, "malformed hello");
  }
  const hello = parsed.data;
  if (hello.version !== VERSION) return reject(CLOSE.BAD_HELLO, "unsupported version");
  if (hello.self_account.platform === "" || hello.self_account.id === "") {
    return reject(CLOSE.BAD_HELLO, "missing self_account");
  }
  return {
    ok: true,
    account: { platform: hello.self_account.platform, id: hello.self_account.id },
    node: hello.node,
    capabilities: hello.capabilities,
  };
}

function rawText(data: RawData): string {
  return rawBytes(data).toString("utf8");
}

function rawBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}

function isEncoder(value: string): value is GoLiveEncoder {
  return GoLiveEncoderSchema.safeParse(value).success;
}

export interface VoiceLinkOptions {
  config: VoiceLinkConfig;
  /** Publishes an event as the owning module. */
  publish: Publish;
  /** The module's stop signal. */
  signal: AbortSignal;
  log: Logger;
}

/**
 * Service provided by `voice.link` (`VoiceLinkKey`): the connection to the self voice node(s),
 * one per self account.
 *
 * Commands go to the connection that is in the given guild, else to the most recently connected
 * one.
 */
export class VoiceLink {
  readonly #publishEvent: Publish;
  readonly #signal: AbortSignal;
  readonly #log: Logger;
  readonly #token: string;
  readonly #audioBuffer: number;
  readonly #joinTimeoutMs: number;
  readonly #pingIntervalMs: number;
  readonly #peerTimeoutMs: number;
  readonly #helloTimeoutMs: number;
  #conns: Conn[] = [];
  #audioSubs: BoundedQueue<AudioEvent>[] = [];
  #watchAudioSubs: BoundedQueue<Int16Array>[] = [];
  #watchAudioDropped = 0;
  #nextSnapshot = 1;
  #audioDropped = 0;
  readonly #knownSelf = new Map<string, AccountRef>();
  #nextConn = 1;
  #nextPlay = 1;

  constructor(options: VoiceLinkOptions) {
    const c = options.config;
    this.#publishEvent = options.publish;
    this.#signal = options.signal;
    this.#log = options.log;
    this.#token = c.token.trim();
    this.#audioBuffer = Math.max(1, c.audio_buffer);
    this.#joinTimeoutMs = Math.max(1, c.join_timeout_ms);
    this.#pingIntervalMs = Math.max(1, c.ping_interval_ms);
    this.#peerTimeoutMs = Math.max(1, c.peer_timeout_ms);
    this.#helloTimeoutMs = Math.max(1, c.hello_timeout_ms);
  }

  /** A voice node is connected and authenticated. */
  isConnected(): boolean {
    return this.#conns.length > 0;
  }

  /** The self account of the most recently connected node. */
  selfAccount(): AccountRef | null {
    return this.#conns.at(-1)?.account ?? null;
  }

  /**
   * Whether `account` is one of her accounts (a connected node's self account, or any account
   * announced with `platform.ready`).
   */
  isSelf(account: AccountRef): boolean {
    return (
      this.#knownSelf.has(accountKey(account)) ||
      this.#conns.some((c) => sameAccount(c.account, account))
    );
  }

  /** @internal */
  addSelfAccount(account: AccountRef): void {
    this.#knownSelf.set(accountKey(account), account);
  }

  #connFor(guild: string): Conn {
    const conn =
      this.#conns.findLast((c) => c.state.guilds.has(guild)) ?? this.#conns.at(-1) ?? null;
    if (conn === null) throw new VoiceLinkError("no voice node connected");
    return conn;
  }

  /**
   * Joins voice in `guild`: `channel` if given, else the channel `userId` is currently in.
   * Returns the joined channel id.
   */
  async join(guild: string, channel: string | null, userId: string | null): Promise<string> {
    if (channel === null && userId === null) {
      throw new VoiceLinkError("join needs a channel or a user id");
    }
    const conn = this.#connFor(guild);
    const answer = deferred<string>();
    const pending = {
      guild,
      resolve: answer.resolve,
      reject: (message: string) => answer.reject(new VoiceLinkError(message)),
    };
    const forget = () => {
      const i = conn.state.pendingJoins.indexOf(pending);
      if (i >= 0) conn.state.pendingJoins.splice(i, 1);
    };
    conn.state.pendingJoins.push(pending);
    try {
      await conn.sendJson({
        type: "join",
        guild,
        ...(channel !== null ? { channel } : {}),
        ...(userId !== null ? { user_id: userId } : {}),
      });
    } catch (error) {
      forget();
      throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        forget();
        reject(new VoiceLinkError("voice node did not answer the join in time"));
      }, this.#joinTimeoutMs);
    });
    try {
      return await Promise.race([answer.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Leaves voice in `guild`. `voice.left` follows when the node confirms. */
  async leave(guild: string): Promise<void> {
    await this.#connFor(guild).sendJson({ type: "leave", guild });
  }

  /** The voice channel she is in, in `guild`. */
  channel(guild: string): string | null {
    for (const c of this.#conns.toReversed()) {
      const g = c.state.guilds.get(guild);
      if (g) return g.channel;
    }
    return null;
  }

  /** Who is in her voice channel in `guild` (empty when she is not in one). */
  participants(guild: string): VoiceParticipant[] {
    for (const c of this.#conns.toReversed()) {
      const g = c.state.guilds.get(guild);
      if (g) return [...g.participants];
    }
    return [];
  }

  /**
   * Starts playing `audio` (PCM s16le mono at `sampleRate`) in `guild`. The node queues plays,
   * so this returns before the audio is heard. With `levels`, chunks may carry a levels track
   * (`LeveledChunk`) that her lip sync follows instead of the audio.
   */
  async play(
    guild: string,
    sampleRate: number,
    audio: AudioStream | AsyncIterable<LeveledChunk>,
    options: { levels?: boolean } = {},
  ): Promise<Playback> {
    if (sampleRate === 0) throw new VoiceLinkError("sample rate must not be 0");
    const conn = this.#connFor(guild);
    const id = this.#nextPlay;
    this.#nextPlay = (this.#nextPlay + 1) >>> 0;
    const node = new Watch<PlaybackState | null>(null);
    conn.state.plays.set(id, node);
    try {
      await conn.sendJson({
        type: "play_start",
        play: id,
        guild,
        sample_rate: sampleRate,
        ...(options.levels ? { levels: true } : {}),
      });
    } catch (error) {
      conn.state.plays.delete(id);
      throw error;
    }
    return startPlayback(conn, id, sampleRate, audio, node, {
      send: (msg) => conn.trySend(msg),
      supports: (capability) => conn.capabilities.has(capability),
    });
  }

  /**
   * Asks the node to start a Go Live stream. Returns once the request is sent; progress arrives
   * as `voice.golive` events (`starting`, `live`, `stopped`, `failed`) and in `golive()`.
   */
  async goliveStart(req: GoLiveRequest): Promise<void> {
    if (req.guild.trim() === "") throw new VoiceLinkError("go live needs a guild");
    if (req.source.trim() === "") throw new VoiceLinkError("go live needs a source");
    const encoder = req.encoder;
    if (encoder !== undefined && !isEncoder(encoder)) {
      throw new VoiceLinkError(`unknown encoder \`${encoder}\` (expected auto, nvenc or software)`);
    }
    for (const [name, v] of [
      ["width", req.width],
      ["height", req.height],
      ["fps", req.fps],
      ["bitrate_kbps", req.bitrateKbps],
    ] as const) {
      if (v === 0) throw new VoiceLinkError(`\`${name}\` must not be 0`);
    }
    const conn = this.#connFor(req.guild);
    await conn.sendJson({
      type: "golive_start",
      guild: req.guild,
      channel: req.channel,
      source: req.source.trim(),
      width: req.width,
      height: req.height,
      fps: req.fps,
      bitrate_kbps: req.bitrateKbps,
      encoder,
      audio: req.audio,
      listen: req.listen,
    });
  }

  /** Asks the node to stop the Go Live stream in `guild`. */
  async goliveStop(guild: string): Promise<void> {
    await this.#connFor(guild).sendJson({ type: "golive_stop", guild });
  }

  /** The last Go Live state the node reported for `guild`. */
  golive(guild: string): GoLiveStatus | null {
    for (const c of this.#conns.toReversed()) {
      const s = c.state.golive.get(guild);
      if (s) return { ...s };
    }
    return null;
  }

  /** Whether a Go Live stream is starting or live in `guild`. */
  isStreaming(guild: string): boolean {
    const s = this.golive(guild)?.state;
    return s === "starting" || s === "live";
  }

  /** The connection of `guild`, when its node can watch a stream. */
  #watcherFor(guild: string): Conn {
    const conn = this.#connFor(guild);
    if (!conn.capabilities.has(CAPABILITY_WATCH)) {
      throw new VoiceLinkError("this voice node cannot watch streams");
    }
    return conn;
  }

  /**
   * Asks the node to watch `userId`'s Go Live stream in `guild`, while she stays in the voice
   * channel. One stream at a time: it replaces the watch going on. Progress arrives as
   * `voice.watch` events and in `watchStatus()`.
   */
  async watchStart(guild: string, userId: string): Promise<void> {
    await this.#watcherFor(guild).sendJson({ type: "watch_start", guild, user_id: userId });
  }

  /** Asks the node to stop watching in `guild`. */
  async watchStop(guild: string): Promise<void> {
    await this.#watcherFor(guild).sendJson({ type: "watch_stop", guild });
  }

  /** The last watch state the node reported for `guild`. */
  watchStatus(guild: string): WatchStatus | null {
    for (const c of this.#conns.toReversed()) {
      const s = c.state.watch.get(guild);
      if (s) return { ...s };
    }
    return null;
  }

  /**
   * Asks the node for a JPEG of the stream watched in `guild`. Rejects after `timeoutMs`, when
   * `signal` aborts, when the node has no picture and when it disconnects; a picture that
   * arrives after that is dropped.
   */
  async snapshot(guild: string, timeoutMs: number, signal: AbortSignal): Promise<Buffer> {
    const conn = this.#watcherFor(guild);
    signal.throwIfAborted();
    const id = this.#nextSnapshot;
    this.#nextSnapshot = (this.#nextSnapshot + 1) >>> 0;
    const answer = deferred<Buffer>();
    // The state is replaced when the node disconnects: keep the map the entry went into.
    const snapshots = conn.state.snapshots;
    snapshots.set(id, { resolve: answer.resolve, reject: answer.reject });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new VoiceLinkError("the voice node did not send a snapshot in time")),
        Math.max(1, timeoutMs),
      );
      onAbort = () => reject(new VoiceLinkError("snapshot aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // Either can settle while the send is pending, before anything listens to it.
    answer.promise.catch(() => undefined);
    interrupted.catch(() => undefined);
    try {
      await conn.sendJson({ type: "watch_snapshot", id });
      return await Promise.race([answer.promise, interrupted]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      snapshots.delete(id);
    }
  }

  /**
   * Receives the sound (PCM s16le mono 16 kHz) of the watched stream from now on. The queue is
   * bounded; frames are dropped (with a warning) while it is full.
   */
  subscribeWatchAudio(signal?: AbortSignal): BoundedQueue<Int16Array> {
    const queue = new BoundedQueue<Int16Array>(this.#audioBuffer, signal);
    this.#watchAudioSubs.push(queue);
    return queue;
  }

  #emitWatchAudio(samples: Int16Array): void {
    this.#watchAudioSubs = this.#watchAudioSubs.filter((q) => {
      if (q.closed) return false;
      if (!q.push(samples)) {
        const n = this.#watchAudioDropped++;
        if (n % 100 === 0) {
          this.#log.warn({ dropped: n + 1 }, "watch audio subscriber is full, dropping frames");
        }
      }
      return true;
    });
  }

  #publishWatch(platform: PlatformId, guild: string, status: WatchStatus): void {
    this.#publishEvent(Events.VoiceWatch, {
      platform,
      guild,
      user_id: status.user_id,
      state: status.state,
      error: status.error,
      reason: status.reason,
    });
  }

  #publishGolive(platform: PlatformId, guild: string, status: GoLiveStatus): void {
    this.#publishEvent(Events.VoiceGoLive, {
      platform,
      guild,
      state: status.state,
      error: status.error,
      reason: status.reason,
    });
  }

  /**
   * Receives every captured audio event from now on. The queue is bounded; events are dropped
   * (with a warning) while it is full. Close it (or abort `signal`) to unsubscribe.
   */
  subscribeAudio(signal?: AbortSignal): BoundedQueue<AudioEvent> {
    const queue = new BoundedQueue<AudioEvent>(this.#audioBuffer, signal);
    this.#audioSubs.push(queue);
    return queue;
  }

  #emitAudio(event: AudioEvent): void {
    this.#audioSubs = this.#audioSubs.filter((q) => {
      if (q.closed) return false;
      if (!q.push(event)) {
        const n = this.#audioDropped++;
        if (n % 100 === 0) {
          this.#log.warn({ dropped: n + 1 }, "audio subscriber is full, dropping events");
        }
      }
      return true;
    });
  }

  /** @internal Closes every connection (module stop). */
  closeAll(): void {
    for (const conn of this.#conns) conn.shutdown(CLOSE.GOING_AWAY, "core shutting down");
  }

  // ── connection handling ────────────────────────────────────────────────────

  /** @internal Runs the protocol on a freshly upgraded socket. */
  serve(ws: WebSocket): void {
    let phase: "hello" | "open" | "done" = "hello";
    let conn: Conn | null = null;
    let stopOpen: (() => void) | null = null;

    const helloTimer = setTimeout(
      () => reject(CLOSE.BAD_HELLO, "no hello in time"),
      this.#helloTimeoutMs,
    );
    const onAbort = () => {
      if (phase === "hello") reject(CLOSE.GOING_AWAY, "core shutting down");
    };
    const endHello = () => {
      clearTimeout(helloTimer);
      this.#signal.removeEventListener("abort", onAbort);
    };
    const reject = (code: number, reason: string) => {
      if (phase !== "hello") return;
      phase = "done";
      endHello();
      this.#log.warn({ code, reason }, "rejected voice node");
      closeSocket(ws, code, reason);
    };
    if (this.#signal.aborted) {
      reject(CLOSE.GOING_AWAY, "core shutting down");
      return;
    }
    this.#signal.addEventListener("abort", onAbort, { once: true });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (phase === "hello") {
        if (isBinary) {
          reject(CLOSE.BAD_HELLO, "expected hello");
          return;
        }
        const hello = readHello(rawText(data), this.#token);
        if (!hello.ok) {
          reject(hello.code, hello.reason);
          return;
        }
        phase = "open";
        endHello();
        conn = this.#open(ws, hello.account, hello.node, hello.capabilities);
        stopOpen = this.#attach(conn, ws);
        return;
      }
      if (phase === "open" && conn && !conn.isClosed) {
        if (isBinary) this.#handleAudio(conn, rawBytes(data));
        else this.#handleText(conn, rawText(data));
      }
    });
    ws.on("error", (error: Error) => {
      this.#log.debug({ err: errorMessage(error) }, "voice link socket error");
    });
    ws.on("close", () => {
      if (phase === "hello") {
        phase = "done";
        endHello();
        return;
      }
      if (phase === "open" && conn) {
        phase = "done";
        stopOpen?.();
        conn.shutdown(1000, "");
        this.#cleanup(conn);
      }
    });
  }

  #open(ws: WebSocket, account: AccountRef, node: string, capabilities: string[]): Conn {
    const conn = new Conn(this.#nextConn++, account, ws, capabilities);
    const session = newId();
    // Welcome goes out before anything else on this connection.
    conn.trySend({ type: "welcome", session });
    const i = this.#conns.findIndex((c) => sameAccount(c.account, account));
    const old = i >= 0 ? this.#conns.splice(i, 1)[0] : undefined;
    this.#conns.push(conn);
    if (old) {
      this.#log.info({ account: account.id }, "voice node replaced by a new connection");
      old.shutdown(CLOSE.REPLACED, "replaced by a newer connection");
    }
    this.addSelfAccount(account);
    this.#log.info({ account: account.id, node, session }, "voice node connected");
    this.#publishEvent(Events.PlatformReady, { platform: account.platform, self_account: account });
    return conn;
  }

  /** Heartbeat: pings, the peer timeout and module shutdown. Returns the teardown. */
  #attach(conn: Conn, ws: WebSocket): () => void {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        this.#log.warn({ account: conn.account.id }, "voice node timed out");
        conn.shutdown(CLOSE.TIMEOUT, "heartbeat timeout");
      }, this.#peerTimeoutMs);
    };
    bump();
    const ping = setInterval(() => conn.trySend({ type: "ping" }), this.#pingIntervalMs);
    const onAbort = () => conn.shutdown(CLOSE.GOING_AWAY, "core shutting down");
    this.#signal.addEventListener("abort", onAbort, { once: true });
    // Any traffic (also control frames) proves the peer is alive.
    ws.on("message", bump);
    ws.on("ping", bump);
    ws.on("pong", bump);
    return () => {
      clearTimeout(deadline);
      clearInterval(ping);
      this.#signal.removeEventListener("abort", onAbort);
    };
  }

  #participant(platform: PlatformId, p: WireParticipant): VoiceParticipant {
    const account = { platform, id: p.user_id };
    return {
      account,
      display_name: p.display_name,
      is_self: p.is_self || this.isSelf(account),
      muted: p.muted,
      deafened: p.deafened,
    };
  }

  #handleText(conn: Conn, text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      this.#log.warn({ err: errorMessage(error) }, "invalid message from voice node");
      return;
    }
    const parsed = NodeMessageSchema.safeParse(value);
    if (!parsed.success) {
      this.#log.warn({ err: z.prettifyError(parsed.error) }, "invalid message from voice node");
      return;
    }
    this.#handle(conn, parsed.data);
  }

  #takeJoins(conn: Conn, guild: string) {
    const waiting = conn.state.pendingJoins.filter((p) => p.guild === guild);
    conn.state.pendingJoins = conn.state.pendingJoins.filter((p) => p.guild !== guild);
    return waiting;
  }

  #handle(conn: Conn, msg: NodeMessage): void {
    const platform = conn.account.platform;
    const st = conn.state;
    switch (msg.type) {
      case "hello":
        this.#log.warn("duplicate hello from voice node");
        return;
      case "ping":
        conn.trySend({ type: "pong" });
        return;
      case "pong":
        return;
      case "joined": {
        const { guild, channel } = msg;
        let g = st.guilds.get(guild);
        if (!g) {
          g = { channel: "", participants: [] };
          st.guilds.set(guild, g);
        }
        if (g.channel !== channel) {
          g.participants = [];
          g.channel = channel;
        }
        const participants = [...g.participants];
        for (const p of this.#takeJoins(conn, guild)) p.resolve(channel);
        this.#log.info({ guild, channel }, "joined voice");
        this.#publishEvent(Events.VoiceJoined, {
          context: voiceContext(platform, guild, channel),
          participants,
        });
        return;
      }
      case "left": {
        const { guild, reason } = msg;
        const left = st.guilds.get(guild);
        st.guilds.delete(guild);
        for (const p of this.#takeJoins(conn, guild)) {
          p.reject(`left voice: ${reason ?? "no reason given"}`);
        }
        if (left) {
          this.#log.info({ guild, reason }, "left voice");
          this.#publishEvent(Events.VoiceLeft, {
            context: voiceContext(platform, guild, left.channel),
            reason,
          });
        }
        return;
      }
      case "voice_state": {
        const { guild, channel } = msg;
        const participants = msg.participants.map((p) => this.#participant(platform, p));
        st.guilds.set(guild, { channel, participants: [...participants] });
        this.#publishEvent(Events.VoiceParticipants, {
          context: voiceContext(platform, guild, channel),
          participants,
        });
        return;
      }
      case "speaking": {
        const channel = st.guilds.get(msg.guild)?.channel;
        if (channel === undefined) {
          this.#log.debug({ guild: msg.guild }, "speaking signal for a guild she is not in");
          return;
        }
        this.#publishEvent(Events.VoiceSpeaking, {
          context: voiceContext(platform, msg.guild, channel),
          account: { platform, id: msg.user_id },
          speaking: msg.speaking,
        });
        return;
      }
      case "stream_open": {
        // Unique per link: the connection id in the high bits.
        const id = conn.id * 2 ** 32 + msg.stream;
        const previous = st.streams.get(msg.stream);
        st.streams.set(msg.stream, { id, guild: msg.guild });
        if (previous) this.#emitAudio({ type: "stream_close", stream: id });
        this.#emitAudio({
          type: "stream_open",
          info: {
            stream: id,
            context: voiceContext(platform, msg.guild, msg.channel),
            speaker: { platform, id: msg.user_id },
            displayName: msg.display_name,
            sampleRate: msg.sample_rate,
          },
        });
        return;
      }
      case "stream_close": {
        const removed = st.streams.get(msg.stream);
        st.streams.delete(msg.stream);
        if (removed) this.#emitAudio({ type: "stream_close", stream: removed.id });
        return;
      }
      case "playback": {
        if (msg.error !== null) {
          this.#log.warn(
            { play: msg.play, error: msg.error },
            "voice node reported a playback error",
          );
        }
        st.plays.get(msg.play)?.set(msg.state);
        return;
      }
      case "watch": {
        const status: WatchStatus = {
          user_id: msg.user_id,
          state: msg.state,
          error: msg.error,
          reason: msg.reason,
        };
        const current = st.watch.get(msg.guild);
        // A stop of somebody she no longer watches must not end the watch going on.
        const stale =
          current !== undefined &&
          current.user_id !== msg.user_id &&
          (msg.state === "stopped" || msg.state === "failed");
        if (!stale) st.watch.set(msg.guild, status);
        this.#log.info(
          { guild: msg.guild, state: status.state, error: status.error, stale },
          "watch state",
        );
        this.#publishWatch(platform, msg.guild, status);
        return;
      }
      case "watch_snapshot_failed": {
        st.snapshots.get(msg.id)?.reject(new VoiceLinkError(`snapshot failed: ${msg.error}`));
        st.snapshots.delete(msg.id);
        return;
      }
      case "golive": {
        const status: GoLiveStatus = { state: msg.state, error: msg.error, reason: msg.reason };
        st.golive.set(msg.guild, status);
        this.#log.info(
          { guild: msg.guild, state: status.state, error: status.error },
          "go live state",
        );
        this.#publishGolive(platform, msg.guild, status);
        return;
      }
      case "error": {
        this.#log.warn({ message: msg.message }, "voice node error");
        st.pendingJoins.shift()?.reject(msg.message);
        return;
      }
    }
  }

  #handleAudio(conn: Conn, data: Uint8Array): void {
    if (data[0] === TAG_SNAPSHOT) {
      const header = readFrameHeader(data);
      const pending = header === null ? undefined : conn.state.snapshots.get(header.id);
      if (header !== null && pending !== undefined) {
        conn.state.snapshots.delete(header.id);
        const all = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        pending.resolve(all.subarray(VOICE_LINK_FRAME_HEADER_BYTES));
      }
      return;
    }
    const frame = decodeAudio(data);
    if (!frame) return;
    if (frame.tag === TAG_WATCH_AUDIO) {
      this.#emitWatchAudio(frame.samples);
      return;
    }
    if (frame.tag !== TAG_CAPTURE) {
      this.#log.debug({ tag: frame.tag }, "unexpected binary frame from voice node");
      return;
    }
    const stream = conn.state.streams.get(frame.id);
    if (stream) this.#emitAudio({ type: "frame", stream: stream.id, samples: frame.samples });
  }

  /**
   * Forgets a closed connection: fails its pending work and closes its streams. Guilds are
   * reported as left unless a newer connection of the same account took over.
   */
  #cleanup(conn: Conn): void {
    this.#conns = this.#conns.filter((c) => c.id !== conn.id);
    const state = conn.state;
    conn.state = newConnState();
    for (const { id } of state.streams.values())
      this.#emitAudio({ type: "stream_close", stream: id });
    const platform = conn.account.platform;
    if (conn.closeCode() !== CLOSE.REPLACED) {
      // The node stops its watch when its link drops.
      for (const [guild, status] of state.watch) {
        if (status.state === "starting" || status.state === "live") {
          this.#publishWatch(platform, guild, {
            ...status,
            state: "stopped",
            error: null,
            reason: "voice node disconnected",
          });
        }
      }
      // A Go Live stream belongs to the node; Core can no longer see it.
      for (const [guild, status] of state.golive) {
        if (status.state === "starting" || status.state === "live") {
          this.#publishGolive(platform, guild, {
            state: "stopped",
            error: null,
            reason: "voice node disconnected",
          });
        }
      }
      for (const [guild, g] of state.guilds) {
        this.#publishEvent(Events.VoiceLeft, {
          context: voiceContext(platform, guild, g.channel),
          reason: "voice node disconnected",
        });
      }
    }
    this.#log.info({ account: conn.account.id, code: conn.closeCode() }, "voice node disconnected");
    for (const p of state.pendingJoins) p.reject("voice node disconnected");
    for (const p of state.snapshots.values()) {
      p.reject(new VoiceLinkError("voice node disconnected"));
    }
  }
}

function accountKey(a: AccountRef): string {
  return `${a.platform}:${a.id}`;
}

export const VoiceLinkKey = serviceKey<VoiceLink>("VoiceLink");
