// WatchEngine on top of @dank074/discord-video-stream: receives someone else's Go Live.
//
//   STREAM_WATCH ─> STREAM_CREATE + STREAM_SERVER_UPDATE ─> StreamConnection (patched to receive)
//     ─> raw RTP on one track ─> H.264 keyframes / Opus packets ─> DAVE decrypt ─> hooks
//
// The voice connection is left alone: Discord answers a watch with a separate stream connection that only
// needs the voice session id. The library only sends, so this file patches a StreamConnection into a
// receive-only one. That means reaching into private fields; this is the only file that does, and
// {@link assertLibraryShape} names whatever a library upgrade renamed.
//
// Only keyframes and audio are decrypted: non-key video frames are dropped without a decrypt, and a single
// keyframe converts to a picture on its own (see snapshot.ts).
//
// Nothing here logs a gateway or voice payload: they carry stream tokens.
import type * as Dvs from "@dank074/discord-video-stream";
import type { Client } from "@lng2004/discord.js-selfbot-v13";
import type * as Dc from "@lng2004/node-datachannel";
import type { Logger } from "../log.js";
import { H264Assembler, isRtcp, parseRtp, pliPacket, type RtpPacket } from "./rtp.js";
import type { WatchEngine, WatchHooks, WatchPlan } from "./manager.js";

export interface WatchLibrary {
  dvs: typeof Dvs;
  dc: typeof Dc;
}

const PT_OPUS = 120;
const PT_H264 = 101;
const VIDEO_PAYLOADS: Record<string, [number, number]> = {
  H264: [101, 102],
  H265: [103, 104],
  VP8: [105, 106],
  VP9: [107, 108],
  AV1: [109, 110],
};
const MEDIA_AUDIO = 0;
const MEDIA_VIDEO = 1;
const PLI_EVERY_MS = 2_000;
const STREAM_INFO_MS = 10_000;
const VOICE_OP_SELECT_PROTOCOL = 1;
const VOICE_OP_READY = 12;
const VOICE_OP_VIDEO_BITRATES = 15;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The answer to our one-m-line offer, built from the transport fields of Discord's SDP. */
export function answerSdp(sdp: string): string {
  const pick = (prefix: string): string =>
    sdp.split("\n").find((l) => l.startsWith(prefix))?.trim() ?? "";
  const port = pick("a=rtcp").split(":")[1] ?? "";
  const payloads = Object.values(VIDEO_PAYLOADS).flat();
  const maps = Object.entries(VIDEO_PAYLOADS).flatMap(([name, [pt, rtx]]) => [
    `a=rtpmap:${pt} ${name}/90000`,
    `a=rtpmap:${rtx} rtx/90000`,
    `a=fmtp:${rtx} apt=${pt}`,
    `a=rtcp-fb:${pt} nack`,
    `a=rtcp-fb:${pt} nack pli`,
    `a=rtcp-fb:${pt} ccm fir`,
  ]);
  return [
    `m=video ${port} UDP/TLS/RTP/SAVPF ${payloads.join(" ")}`,
    pick("c="),
    "a=setup:passive",
    "a=mid:1",
    "a=sendrecv",
    pick("a=ice-ufrag"),
    pick("a=ice-pwd"),
    pick("a=fingerprint"),
    pick("a=candidate"),
    "a=rtcp-mux",
    "a=ice-lite",
    ...maps,
  ].join("\n");
}

/** The slice of a library StreamConnection this file touches. */
interface LibConn {
  _webRtcWrapper: {
    _videoDef: unknown;
    _webRtcConn: unknown;
    _videoTrack: unknown;
    initWebRtc: () => unknown;
    webRtcConn: { setRemoteDescription(sdp: string, type: string): void };
  };
  status: { started: boolean };
  _daveProtocolVersion: number;
  daveReady: unknown;
  daveSession: { decrypt(userId: string, mediaType: number, packet: Buffer): Uint8Array };
  webRtcParams: { audioSsrc?: number } | null;
  ws: { addEventListener(type: string, fn: (e: { data: unknown }) => void): void } | null;
  serverId: string;
  streamKey: string;
  handleProtocolAck: (d: Record<string, unknown>) => Promise<void>;
  setupEvents: () => void;
  sendOpcode: (op: number, d: unknown) => void;
  initDave: () => void;
  emit: (event: string) => boolean;
  setSession: (id: string) => void;
  setTokens: (endpoint: string, token: string) => void;
  stop: () => void;
}

const CONN_FIELDS = [
  "status",
  "_webRtcWrapper",
  "_daveProtocolVersion",
  "daveReady",
  "daveSession",
  "webRtcParams",
  "ws",
  "serverId",
  "streamKey",
  "handleProtocolAck",
  "setupEvents",
  "sendOpcode",
  "initDave",
  "emit",
  "setSession",
  "setTokens",
  "stop",
];
const WRAPPER_FIELDS = ["_videoDef", "_webRtcConn", "_videoTrack", "initWebRtc", "webRtcConn"];

/** Throws, naming every field this file needs that the library's connection no longer has. */
export function assertLibraryShape(conn: unknown): void {
  const has = (o: unknown, k: string): boolean => typeof o === "object" && o !== null && k in o;
  const missing = CONN_FIELDS.filter((k) => !has(conn, k));
  const wrapper = has(conn, "_webRtcWrapper") ? (conn as Record<string, unknown>)._webRtcWrapper : undefined;
  if (wrapper !== undefined) missing.push(...WRAPPER_FIELDS.filter((k) => !has(wrapper, k)).map((k) => `_webRtcWrapper.${k}`));
  if (missing.length > 0) {
    throw new Error(`the Discord video library changed shape, missing: ${missing.join(", ")}`);
  }
}

export class DiscordWatchEngine implements WatchEngine {
  private lib: WatchLibrary | undefined;
  private streamer: Dvs.Streamer | undefined;
  private current: { requestKeyframe(): void } | undefined;

  constructor(
    private readonly client: Client<true>,
    private readonly log: Logger,
    /** Test hook / alternative loader. The libraries are native, so they load only when someone is watched. */
    private readonly load: () => Promise<WatchLibrary> = async () => ({
      dvs: await import("@dank074/discord-video-stream"),
      dc: await import("@lng2004/node-datachannel"),
    }),
  ) {}

  requestKeyframe(): void {
    try {
      this.current?.requestKeyframe();
    } catch (e) {
      this.log.debug(`watch: keyframe request failed: ${errMsg(e)}`);
    }
  }

  async run(plan: WatchPlan, hooks: WatchHooks, signal: AbortSignal): Promise<string> {
    const lib = await this.loadLibrary();
    if (signal.aborted) return "stopped";
    const streamer = (this.streamer ??= new lib.dvs.Streamer(this.client));
    const streamKey = `guild:${plan.guild}:${plan.channel}:${plan.userId}`;
    const selfId = this.client.user.id;
    const { log } = this;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let conn: LibConn | undefined;
      let track: Dc.Track | undefined;
      let videoSsrc: number | undefined;
      let pliTimer: NodeJS.Timeout | undefined;
      let live = false;
      let gotKeyframe = false;
      let loggedError = false;
      let deleteOnExit = true;
      let serverId: string | undefined;
      const assembler = new H264Assembler();

      const once = (where: string, error: unknown): void => {
        if (loggedError) return;
        loggedError = true;
        log.warn(`watch: first ${where} failure: ${errMsg(error)}`);
      };

      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        this.client.off("raw", onRaw);
        clearTimeout(infoTimer);
        if (pliTimer) clearInterval(pliTimer);
        if (this.current === handle) this.current = undefined;
        if (deleteOnExit) {
          try {
            streamer.sendOpcode(lib.dvs.GatewayOpCodes.STREAM_DELETE, { stream_key: streamKey });
          } catch (e) {
            log.debug(`watch: stream delete failed: ${errMsg(e)}`);
          }
        }
        try {
          // stop() leaves status.started set, so the library would reopen the socket and RESUME with the
          // stream token. Clearing it makes the library's close listener take its terminal branch.
          if (conn) conn.status.started = false;
          conn?.stop();
        } catch (e) {
          log.debug(`watch: connection stop failed: ${errMsg(e)}`);
        }
      };
      const finish = (outcome: { reason: string } | { error: Error }): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.reason);
      };

      const requestKeyframe = (): void => {
        if (!track || videoSsrc === undefined || !conn) return;
        try {
          const self = conn.webRtcParams?.audioSsrc ?? 1;
          track.sendMessageBinary(pliPacket(self, videoSsrc));
        } catch (e) {
          once("pli", e);
        }
      };
      const handle = { requestKeyframe };
      this.current = handle;

      const markLive = (): void => {
        if (live) return;
        live = true;
        hooks.onLive();
      };

      /** The media in `payload`, decrypted when it carries DAVE's trailer; null when it cannot be opened. */
      const open = (payload: Buffer, kind: "audio" | "video"): Buffer | null => {
        const encrypted = payload.at(-1) === 0xfa && payload.at(-2) === 0xfa;
        if (!encrypted) return payload;
        if (!conn?.daveReady) return null;
        try {
          const out = conn.daveSession.decrypt(plan.userId, kind === "video" ? MEDIA_VIDEO : MEDIA_AUDIO, payload);
          return Buffer.from(out);
        } catch (e) {
          once("decrypt", e);
          return null;
        }
      };

      const onVideo = (packet: RtpPacket): void => {
        videoSsrc = packet.ssrc;
        const frame = assembler.push(packet);
        if (!frame || !frame.keyframe) return; // Other frames are dropped without a decrypt.
        const data = open(frame.data, "video");
        if (!data) return;
        if (!gotKeyframe) {
          gotKeyframe = true;
          if (pliTimer) clearInterval(pliTimer);
          pliTimer = undefined;
        }
        markLive();
        hooks.onKeyframe(data);
      };

      const onAudio = (packet: RtpPacket): void => {
        if (packet.payload.length < 3) return;
        const data = open(packet.payload, "audio");
        if (!data) return;
        markLive();
        hooks.onOpus(data);
      };

      const onPcState = (state: string): void => {
        if (state === "failed") finish({ error: new Error("the stream connection failed") });
        else if (state === "closed") finish({ reason: "connection closed" });
      };

      const onPacket = (b: Buffer): void => {
        if (settled) return;
        try {
          if (isRtcp(b)) return;
          const packet = parseRtp(b);
          if (!packet) return;
          if (packet.payloadType === PT_H264) onVideo(packet);
          else if (packet.payloadType === PT_OPUS) onAudio(packet);
        } catch (e) {
          once("packet", e);
        }
      };

      const startConnection = (endpoint: string, token: string): void => {
        const c = new lib.dvs.StreamConnection(streamer, plan.guild, selfId, plan.channel, () => {
          log.debug("watch: protocol selected");
        }) as unknown as LibConn;
        assertLibraryShape(c);
        conn = c;
        const wrapper = c._webRtcWrapper;

        // Receive-only, one m-line: everything arrives on one track.
        wrapper.initWebRtc = () => {
          try {
            const pc = new lib.dc.PeerConnection("", { iceServers: ["stun:stun.l.google.com:19302"] });
            const t = pc.addTrack(wrapper._videoDef as Dc.Video);
            t.onMessage(onPacket);
            wrapper._webRtcConn = pc;
            wrapper._videoTrack = t;
            track = t;
            // The peer connection holds a single state callback and the library registers its own right
            // after this returns, so hand it a facade (it uses only these three methods) that tells us first.
            return {
              onStateChange: (cb: (state: string) => void) =>
                pc.onStateChange((state) => {
                  onPcState(state);
                  cb(state);
                }),
              onLocalDescription: (cb: (sdp: string, type: string) => void) => pc.onLocalDescription(cb),
              setLocalDescription: () => pc.setLocalDescription(),
            };
          } catch (e) {
            finish({ error: e instanceof Error ? e : new Error(String(e)) });
            // Throwing would be an unhandled rejection inside the library; hand it an inert connection.
            return { onStateChange: () => {}, onLocalDescription: () => {}, setLocalDescription: () => {} };
          }
        };

        // The library calls this without awaiting it, so an error must end the run here.
        c.handleProtocolAck = async (d) => {
          try {
            if (typeof d.sdp !== "string") throw new Error("Only WebRTC connections are allowed");
            const codec = typeof d.video_codec === "string" ? d.video_codec : undefined;
            if (codec !== undefined && codec.toUpperCase() !== "H264") {
              finish({ error: new Error(`the stream uses ${codec}; only H264 can be watched`) });
              return;
            }
            c._daveProtocolVersion = d.dave_protocol_version as number;
            c.initDave();
            wrapper.webRtcConn.setRemoteDescription(answerSdp(d.sdp), "answer");
            c.emit("select_protocol_ack");
            // Without this the server may forward no video at all.
            c.sendOpcode(VOICE_OP_VIDEO_BITRATES, { any: 100 });
            if (!pliTimer && !gotKeyframe) pliTimer = setInterval(requestKeyframe, PLI_EVERY_MS);
          } catch (e) {
            finish({ error: e instanceof Error ? e : new Error(String(e)) });
          }
        };

        // We only decode H.264.
        const send = c.sendOpcode.bind(c);
        c.sendOpcode = (op, d) => {
          const body = d as { codecs?: { name: string }[] };
          send(
            op,
            op === VOICE_OP_SELECT_PROTOCOL && body.codecs
              ? { ...body, codecs: body.codecs.filter((x) => x.name === "opus" || x.name === "H264") }
              : d,
          );
        };

        const setup = c.setupEvents.bind(c);
        c.setupEvents = () => {
          setup();
          c.ws?.addEventListener("message", (e) => {
            if (typeof e.data !== "string") return;
            try {
              const { op, d } = JSON.parse(e.data) as { op: number; d?: { video_ssrc?: number } };
              if (op === VOICE_OP_READY && typeof d?.video_ssrc === "number" && d.video_ssrc !== 0) {
                c.sendOpcode(VOICE_OP_VIDEO_BITRATES, { any: 100, [String(d.video_ssrc)]: 100 });
              }
            } catch {
              // Not JSON: nothing to do with it.
            }
          });
        };

        c.serverId = serverId as string;
        c.streamKey = streamKey;
        c.setSession(plan.sessionId);
        c.setTokens(endpoint, token);
      };

      let created = false;
      const onRaw = (packet: { t?: string; d?: Record<string, unknown> }): void => {
        if (settled || !packet.t?.startsWith("STREAM_") || packet.d?.stream_key !== streamKey) return;
        try {
          if (packet.t === "STREAM_CREATE") {
            created = true;
            serverId = String(packet.d.rtc_server_id);
          } else if (packet.t === "STREAM_SERVER_UPDATE" && created && !conn) {
            clearTimeout(infoTimer);
            startConnection(String(packet.d.endpoint), String(packet.d.token));
          } else if (packet.t === "STREAM_DELETE") {
            deleteOnExit = false;
            finish({ reason: "stream ended" });
          }
        } catch (e) {
          finish({ error: e instanceof Error ? e : new Error(String(e)) });
        }
      };

      const onAbort = (): void => finish({ reason: "stopped" });

      const infoTimer = setTimeout(
        () => finish({ error: new Error("Discord did not answer the watch request in time") }),
        STREAM_INFO_MS,
      );

      signal.addEventListener("abort", onAbort, { once: true });
      this.client.on("raw", onRaw);
      try {
        streamer.sendOpcode(lib.dvs.GatewayOpCodes.STREAM_WATCH, { stream_key: streamKey });
      } catch (e) {
        finish({ error: e instanceof Error ? e : new Error(String(e)) });
      }
    });
  }

  private async loadLibrary(): Promise<WatchLibrary> {
    if (this.lib) return this.lib;
    try {
      this.lib = await this.load();
    } catch (e) {
      throw new Error(
        `could not load the Discord video library (${errMsg(e)}); run \`pnpm install --ignore-workspace\` in apps/voice-node`,
      );
    }
    return this.lib;
  }
}
