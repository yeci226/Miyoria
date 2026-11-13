// Turns a `golive_start` request into a validated plan: the source URL (and the ffmpeg input
// options it needs), the geometry / bitrate, and the encoder preference. Pure, so it is unit tested.
import type { GoLiveConfig } from "../config.js";
import type { GoLiveStartMessage } from "../protocol.js";

export type ResolvedEncoder = "nvenc" | "software";

export interface GoLivePlan {
  guild: string;
  /** Voice channel to stream in; undefined = the one the node is already in. */
  channel: string | undefined;
  /** The (possibly rewritten) URL / path ffmpeg reads. */
  source: string;
  /** Extra ffmpeg input options (e.g. `-listen 1`). */
  inputOptions: string[];
  /** A live feed (RTMP / SRT / UDP / RTSP) rather than a file: lowers the input latency. */
  live: boolean;
  /**
   * ffmpeg pulls the feed from a server (a hub such as MediaMTX) instead of being the one OBS pushes
   * to: the feed starts mid-stream, so the probe has to wait for a keyframe.
   */
  pull: boolean;
  /** Output size; undefined = derive from the other side keeping the aspect ratio. */
  width: number | undefined;
  height: number | undefined;
  fps: number;
  bitrateKbps: number;
  bitrateMaxKbps: number;
  encoder: "auto" | ResolvedEncoder;
  nvencPreset: GoLiveConfig["nvencPreset"];
  codec: GoLiveConfig["codec"];
  audio: boolean;
  hwDecode: boolean;
  noTranscode: boolean;
}

export type PlanResult = { ok: true; plan: GoLivePlan } | { ok: false; error: string };

export type SourceResult =
  | { ok: true; source: string; inputOptions: string[]; live: boolean; pull: boolean }
  | { ok: false; error: string };

const ALLOWED_SCHEMES = new Set(["rtmp", "rtmps", "srt", "udp", "rtsp", "http", "https", "file"]);
const LIVE_SCHEMES = new Set(["rtmp", "rtmps", "srt", "udp", "rtsp"]);

/** Limits for the numeric fields; outside them the request fails instead of being clamped silently. */
export const LIMITS = {
  width: [16, 7680],
  height: [16, 4320],
  fps: [1, 120],
  bitrateKbps: [100, 100_000],
} as const;

/**
 * Validates `source` and works out how ffmpeg must open it.
 *
 *  - `rtmp://` : ffmpeg is the RTMP server (`-listen 1`) unless `listen === false` (then it pulls from a server).
 *  - `srt://`  : without `mode=`, ffmpeg listens (`mode=listener`) so OBS can push (`mode=caller`) to it;
 *                `listen === false` means `mode=caller`. An explicit `mode=` in the URL always wins.
 *  - `udp://`, `rtsp://`, `http(s)://`, `file://`, plain paths: used as given.
 *
 * Anything that is not one of those (`pipe:`, `concat:`, `lavfi`, a leading `-`, ...) is rejected: the
 * string goes into an ffmpeg command line.
 */
export function normalizeSource(raw: string, listen?: boolean): SourceResult {
  const source = raw.trim();
  if (source.length === 0) return { ok: false, error: "source is empty" };
  if (source.length > 2048) return { ok: false, error: "source is too long" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(source)) return { ok: false, error: "source contains control characters" };
  if (source.startsWith("-")) return { ok: false, error: "source must not start with `-`" };

  const url = /^([a-z][a-z0-9+.-]*):\/\//i.exec(source);
  if (url) {
    const scheme = (url[1] as string).toLowerCase();
    if (!ALLOWED_SCHEMES.has(scheme)) {
      return { ok: false, error: `unsupported source scheme \`${scheme}://\` (use rtmp, srt, udp, rtsp, http(s) or a file)` };
    }
    const live = LIVE_SCHEMES.has(scheme);
    const inputOptions: string[] = [];
    let out = source;
    if (scheme === "rtmp" || scheme === "rtmps") {
      if (listen !== false) inputOptions.push("-listen", "1");
    } else if (scheme === "srt") {
      out = withSrtMode(source, listen === false ? "caller" : "listener");
    }
    const pull = listen === false && (scheme === "rtmp" || scheme === "rtmps" || scheme === "srt");
    return { ok: true, source: out, inputOptions, live, pull };
  }
  // No `://`: a local path. `name:rest` forms (pipe:, concat:, subfile:, lavfi:...) are ffmpeg protocols, not files;
  // a single letter before the colon is a Windows drive.
  if (/^[a-z][a-z0-9+.,_=-]+:/i.test(source)) {
    return { ok: false, error: "unsupported source (looks like an ffmpeg protocol, not a URL or a file path)" };
  }
  return { ok: true, source, inputOptions: [], live: false, pull: false };
}

function withSrtMode(url: string, mode: "listener" | "caller"): string {
  const q = url.indexOf("?");
  if (q >= 0 && /(^|[?&])mode=/i.test(url.slice(q))) return url;
  if (q < 0) return `${url}?mode=${mode}`;
  const tail = url.endsWith("?") || url.endsWith("&") ? "" : "&";
  return `${url}${tail}mode=${mode}`;
}

function checkRange(name: keyof typeof LIMITS, v: number | undefined): string | undefined {
  if (v === undefined) return undefined;
  const [lo, hi] = LIMITS[name];
  return v < lo || v > hi ? `\`${name}\` must be in ${lo}..${hi} (got ${v})` : undefined;
}

export function planGoLive(req: GoLiveStartMessage, defaults: GoLiveConfig): PlanResult {
  const src = normalizeSource(req.source, req.listen);
  if (!src.ok) return src;
  for (const name of ["width", "height", "fps"] as const) {
    const err = checkRange(name, req[name]);
    if (err) return { ok: false, error: err };
  }
  const errBitrate = checkRange("bitrateKbps", req.bitrate_kbps);
  if (errBitrate) return { ok: false, error: errBitrate };

  // Default geometry: height from config, width follows the source's aspect ratio. A request that only
  // names a width leaves the height to the aspect ratio.
  let { width, height } = req;
  if (width === undefined && height === undefined) height = defaults.height;

  const bitrate = req.bitrate_kbps ?? defaults.bitrateKbps;
  return {
    ok: true,
    plan: {
      guild: req.guild,
      channel: req.channel,
      source: src.source,
      inputOptions: src.inputOptions,
      live: src.live,
      pull: src.pull,
      width,
      height,
      fps: req.fps ?? defaults.fps,
      bitrateKbps: bitrate,
      bitrateMaxKbps: Math.round(bitrate * defaults.bitrateMaxFactor),
      encoder: req.encoder ?? defaults.encoder,
      nvencPreset: defaults.nvencPreset,
      codec: defaults.codec,
      audio: req.audio ?? defaults.audio,
      hwDecode: defaults.hwDecode,
      noTranscode: defaults.noTranscode,
    },
  };
}
