// A room's four routes that are not on the route table (`packages/api/src/karaoke-routes.ts`):
// its event stream (Server-Sent Events), the clock, a singer's microphone and their pitch. They go
// with the headers every member request carries (the CSRF guard, same-origin credentials), like
// the recording's upload (`recorder.ts`). The JSON routes are `api.rpc.karaokeRooms.*`.

import type { KaraokeAudioReply, KaraokeClockReply, KaraokeRoomEvent } from "@miyoria/contracts/api";
import { ApiError, type ApiClient, seg } from "@/api/http";
import { type AudioChunk, answerOf, type StreamAnswer } from "./room-stream";

export const roomPath = (code: string) => `/api/member/karaoke/rooms/${seg(code)}`;

// ---- the event stream --------------------------------------------------------------------------

/** How a room's stream is going: `open` (messages arrive), `retrying` (lost; it tries again). */
export type RoomLink = "connecting" | "open" | "retrying";

export interface RoomEventsHandlers {
  onEvent: (e: KaraokeRoomEvent) => void;
  onLink?: (state: RoomLink) => void;
}

/** Opens a room's event stream; the function it gives closes it. */
export type RoomEventsFactory = (url: string, handlers: RoomEventsHandlers) => () => void;

/** Waits before trying again after a lost stream, in ms: longer each time, at most five seconds. */
export const RETRY_MS = [1_000, 2_000, 5_000] as const;

const TYPES = ["room", "board", "trend"] as const;

/** `EventSource` with credentials; tries again when the browser gives up (a refused or closed stream). */
const eventSourceFactory: RoomEventsFactory = (url, h) => {
  let es: EventSource | null = null;
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const open = () => {
    if (closed) return;
    h.onLink?.("connecting");
    const src = new EventSource(url, { withCredentials: true });
    es = src;
    src.onopen = () => {
      tries = 0;
      h.onLink?.("open");
    };
    for (const type of TYPES) {
      src.addEventListener(type, (m) => {
        try {
          const e = JSON.parse((m as MessageEvent<string>).data) as KaraokeRoomEvent;
          if (e && e.type === type) h.onEvent(e);
        } catch {
          // Not a message of ours.
        }
      });
    }
    src.onerror = () => {
      h.onLink?.("retrying");
      // The browser tries again by itself while the stream is only interrupted; once it closes
      // (a refusal, a proxy), this does.
      if (src.readyState !== 2) return;
      src.close();
      const wait = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)] as number;
      tries++;
      timer = setTimeout(open, wait);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    es?.close();
  };
};

let factory: RoomEventsFactory = eventSourceFactory;

/** Replaces the event stream (the dev demo's, or a test's). */
export function setRoomEventsFactory(make: RoomEventsFactory): void {
  factory = make;
}

/** Listens to a room: the first message is the room itself. */
export function openRoomEvents(client: ApiClient, code: string, handlers: RoomEventsHandlers): () => void {
  return factory(client.url(`${roomPath(code)}/events`), handlers);
}

// ---- the clock, the microphone, the pitch ------------------------------------------------------

/** One round trip of the clock sync. */
export function postClock(client: ApiClient, code: string, t0: number): Promise<KaraokeClockReply> {
  return client.request<KaraokeClockReply>("POST", `${roomPath(code)}/clock`, { body: { t0 } });
}

/** The browser's own pitch since frame `from` (50 Hz, `encodeTrack`, base64). */
export async function postPitch(client: ApiClient, code: string, body: { from: number; track: string }): Promise<void> {
  await client.request<unknown>("POST", `${roomPath(code)}/pitch`, { body });
}

/** One chunk of the microphone: Core's answer says whether to go on. */
export async function postAudio(client: ApiClient, code: string, chunk: AudioChunk): Promise<StreamAnswer> {
  const path = `${roomPath(code)}/audio`;
  let res: Response;
  try {
    res = await fetch(client.url(path, { at: chunk.at, song_ms: chunk.song_ms, end: chunk.end ? 1 : undefined }), {
      method: "POST",
      headers: client.headers({ "Content-Type": "application/octet-stream" }),
      body: chunk.bytes,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("network", 0, path, "聲音沒有送出");
  }
  if (!res.ok) throw new ApiError("http", res.status, path, "聲音沒有送出");
  try {
    const reply = (await res.json()) as KaraokeAudioReply;
    return answerOf(reply);
  } catch {
    return "estimate";
  }
}
