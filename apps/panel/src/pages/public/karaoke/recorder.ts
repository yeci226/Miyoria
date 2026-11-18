// Recording the singer for the official score (docs/design/karaoke.md 「做了什麼第三步」). When the
// session allows it, the microphone (one channel) is recorded during the song with the browser's
// `MediaRecorder`, compressed (Opus where the browser has it), and sent once after the result: the
// song worker scores it and deletes it. A restart throws the recording away and starts anew; a
// recording past the session's limits is dropped (the result stays 預估). Nothing here retries.
//
// The recorder notes the song time at which it really began (its `start` event), from the same
// clock the pitch track is placed by, so Core can line the recording up with the song.

import type { KaraokeVoiceAccepted } from "@miyoria/contracts/api";
import { ApiError, type ApiClient, seg } from "@/api/http";

/** The containers asked for, best first: Opus in WebM (Chrome, Firefox), Opus in Ogg, then MP4 (Safari). */
export const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"] as const;
/** About 32 kbps: plenty for a voice's pitch, about 1 MB for a four-minute song. */
export const RECORDER_BITS = 32_000;
/** A piece of the recording arrives this often, in ms, so its size is known while it grows. */
export const RECORDER_SLICE_MS = 1_000;
/** How long the end of a recording is waited for, in ms. */
const STOP_WAIT_MS = 3_000;

/** The session's limits (`KaraokeSession.recording`). */
export interface RecordingLimits {
  max_bytes: number;
  max_seconds: number;
}

/** A finished recording, ready to send. */
export interface VoiceTake {
  blob: Blob;
  /** The container without its parameters: `audio/webm`, `audio/ogg`, `audio/mp4`. */
  type: string;
  /** The song time, in ms, of the recording's first moment. */
  offset_ms: number;
}

/** Where a recorder is. `over`: it went past a limit and will give nothing. */
export type RecorderState = "idle" | "recording" | "over" | "failed";

/** What the singing screen holds while the song plays. */
export interface VoiceRecorder {
  readonly state: RecorderState;
  /** Begins recording, or begins again (what was recorded so far is thrown away). */
  start(): void;
  /** Ends it: the recording, or `null` when there is nothing usable. */
  stop(): Promise<VoiceTake | null>;
  /** Ends it and throws it away. */
  cancel(): void;
}

/** The first container this browser records, or `null`. */
export function pickRecorderType(isSupported: (type: string) => boolean): string | null {
  for (const type of RECORDER_TYPES) {
    try {
      if (isSupported(type)) return type;
    } catch {
      // An odd browser: try the next.
    }
  }
  return null;
}

/** `audio/webm;codecs=opus` → `audio/webm`. */
export function bareType(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether a recording of `bytes` and `seconds` may be sent. */
export function withinLimits(bytes: number, seconds: number, limits: RecordingLimits): boolean {
  return bytes > 0 && bytes <= limits.max_bytes && seconds <= limits.max_seconds;
}

/**
 * The offset sent with a recording: the song time (seconds) at its first moment, in whole ms. The
 * recorder is started when the backing starts, so this is a few ms either side of 0; a recording
 * that began a moment early is counted from the song's start (less than one 20 ms frame).
 */
export function recordingOffsetMs(songTime: number): number {
  return Math.max(0, Math.round(songTime * 1000));
}

/** What of `MediaRecorder` is used (a test passes its own). */
export interface RecorderLike {
  readonly mimeType: string;
  state: "inactive" | "recording" | "paused";
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstart: (() => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export type MakeRecorder = (stream: MediaStream, options: MediaRecorderOptions) => RecorderLike;

/** One `MediaRecorder` per take; a restart makes a new one, so each take has its own start. */
export class MediaVoiceRecorder implements VoiceRecorder {
  readonly #stream: MediaStream;
  readonly #type: string;
  readonly #limits: RecordingLimits;
  readonly #songTime: () => number;
  readonly #make: MakeRecorder;
  readonly #now: () => number;
  #rec: RecorderLike | null = null;
  #chunks: Blob[] = [];
  #bytes = 0;
  #offset: number | null = null;
  #began = 0;
  #state: RecorderState = "idle";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped: Promise<void> = Promise.resolve();

  constructor(
    stream: MediaStream,
    type: string,
    limits: RecordingLimits,
    songTime: () => number,
    make: MakeRecorder,
    now: () => number = () => performance.now() / 1000,
  ) {
    this.#stream = stream;
    this.#type = type;
    this.#limits = limits;
    this.#songTime = songTime;
    this.#make = make;
    this.#now = now;
  }

  get state(): RecorderState {
    return this.#state;
  }

  start(): void {
    this.#drop();
    let rec: RecorderLike;
    try {
      rec = this.#make(this.#stream, { mimeType: this.#type, audioBitsPerSecond: RECORDER_BITS });
    } catch {
      this.#state = "failed";
      return;
    }
    this.#rec = rec;
    this.#state = "recording";
    let done: () => void = () => {};
    this.#stopped = new Promise<void>((resolve) => {
      done = resolve;
    });
    const mine = () => this.#rec === rec;
    rec.onstart = () => {
      if (!mine()) return;
      this.#offset = recordingOffsetMs(this.#songTime());
      this.#began = this.#now();
    };
    rec.ondataavailable = (e) => {
      if (!mine() || this.#state === "over") return;
      this.#chunks.push(e.data);
      this.#bytes += e.data.size;
      if (this.#bytes > this.#limits.max_bytes) this.#overLimit();
    };
    rec.onerror = () => {
      if (mine()) this.#state = "failed";
    };
    rec.onstop = () => done();
    try {
      rec.start(RECORDER_SLICE_MS);
    } catch {
      this.#state = "failed";
      this.#rec = null;
      done();
      return;
    }
    this.#timer = setTimeout(() => {
      if (mine()) this.#overLimit();
    }, this.#limits.max_seconds * 1000);
  }

  async stop(): Promise<VoiceTake | null> {
    clearTimeout(this.#timer);
    const rec = this.#rec;
    if (!rec) return null;
    try {
      if (rec.state !== "inactive") rec.stop();
    } catch {
      this.#state = "failed";
    }
    // The last piece arrives before `stop`; a recorder that never says so is not waited on forever.
    let wait: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.#stopped, new Promise((r) => (wait = setTimeout(r, STOP_WAIT_MS)))]);
    clearTimeout(wait);
    const seconds = this.#now() - this.#began;
    const offset = this.#offset;
    const ok = this.#state === "recording" && offset !== null;
    this.#rec = null;
    if (!ok) {
      this.#chunks = [];
      return null;
    }
    this.#state = "idle";
    const type = bareType(rec.mimeType || this.#type);
    const blob = new Blob(this.#chunks, { type });
    this.#chunks = [];
    if (!withinLimits(blob.size, seconds, this.#limits)) {
      this.#state = "over";
      return null;
    }
    return { blob, type, offset_ms: offset };
  }

  cancel(): void {
    this.#drop();
    this.#state = "idle";
  }

  #overLimit(): void {
    this.#state = "over";
    this.#chunks = [];
    const rec = this.#rec;
    if (rec && rec.state !== "inactive") rec.stop();
  }

  /** Forgets the take being recorded, if any. */
  #drop(): void {
    clearTimeout(this.#timer);
    const rec = this.#rec;
    this.#rec = null;
    this.#chunks = [];
    this.#bytes = 0;
    this.#offset = null;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // Already ended.
      }
    }
  }
}

/** What of the window a recorder needs. */
export interface RecorderScope {
  MediaRecorder?: {
    new (stream: MediaStream, options?: MediaRecorderOptions): RecorderLike;
    isTypeSupported?: (type: string) => boolean;
  };
}

/** A recorder of `stream`, or `null` when this browser cannot record any of the containers. */
export function createVoiceRecorder(
  stream: MediaStream,
  limits: RecordingLimits,
  songTime: () => number,
  scope: RecorderScope = globalThis as RecorderScope,
): VoiceRecorder | null {
  const Rec = scope.MediaRecorder;
  if (typeof Rec !== "function") return null;
  const type = pickRecorderType((t) => Rec.isTypeSupported?.(t) ?? false);
  if (type === null) return null;
  return new MediaVoiceRecorder(stream, type, limits, songTime, (s, o) => new Rec(s, o));
}

/** `POST /api/member/karaoke/sessions/{id}/voice?offset_ms=…`: the recording as it is, once. */
export function voicePath(session: string): string {
  return `/api/member/karaoke/sessions/${seg(session)}/voice`;
}

/**
 * Sends the recording with the headers every member request carries (the CSRF guard, same-origin
 * credentials). Not through the route table: the body is the recording's bytes, not JSON.
 */
export async function uploadVoice(
  client: ApiClient,
  session: string,
  take: VoiceTake,
  signal?: AbortSignal,
): Promise<KaraokeVoiceAccepted> {
  const path = voicePath(session);
  let res: Response;
  try {
    res = await fetch(client.url(path, { offset_ms: take.offset_ms }), {
      method: "POST",
      headers: client.headers({ "Content-Type": take.type }),
      body: take.blob,
      credentials: "same-origin",
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("network", 0, path, "錄音沒有送出");
  }
  if (!res.ok) throw new ApiError("http", res.status, path, "錄音沒有送出");
  try {
    return (await res.json()) as KaraokeVoiceAccepted;
  } catch {
    return { state: "scoring" };
  }
}
