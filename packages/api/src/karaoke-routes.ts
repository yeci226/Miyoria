// Karaoke's routes (docs/design/karaoke.md 「做了什麼(第一步)」), over `KaraokeKey`:
//
// * Member (`karaoke` group, a session, limited per account): `GET /api/member/karaoke`,
//   `POST /api/member/karaoke/songs` `{ text }`, `GET /api/member/karaoke/songs/{id}`,
//   `POST /api/member/karaoke/songs/{id}/sessions`, `POST /api/member/karaoke/sessions/{id}/result`,
//   `GET /api/member/karaoke/sessions/{id}`. The person is the session's; a refusal is its status
//   and sentence.
// * The files of a session (`GET /api/member/karaoke/files/:session/:name?exp=&sig=`): a plain
//   member route, since it is not JSON. It needs the member's session cookie as well as the
//   link's signature, which is bound to the session, the file, the account and a time ten minutes
//   on. Anything wrong is the same 404. The answer is `no-store` (every member answer is) and has
//   no `content-disposition`: the page plays it, it does not offer it as a download. One byte range
//   (`Range: bytes=a-b`) is answered with 206, so the background video can be read as it plays.
// * The recording of a session (`POST /api/member/karaoke/sessions/:id/voice?offset_ms=`, step 3):
//   the raw recording as the body (`audio/webm`, `audio/ogg`, `audio/mp4`), at most
//   `KARAOKE_VOICE_MAX_BYTES`, read with that cap and kept only in memory; one per session, after
//   its result. `202 {state}`: a song worker reads it and Core scores it in the background.
// * The reference editor (step 6, a panel admin's session only, else `403`):
//   `GET /api/member/karaoke/songs/{id}/edit`, `PUT` the same path (an edit, also needs
//   `admin.panel.write`), `POST .../edit/restore`; and its backing track as a plain member route
//   (`GET /api/member/karaoke/edit/:song/backing`, served like the session files, a 404 to anyone
//   else). A session's signed `reference.json` of a song with an edit is the edit.
// * Admin (`karaokeAdmin`): `GET /api/karaoke/results?space=`, the latest results with their flags
//   (with `space`: that server's rooms and the results sung alone).
// * Rooms (step 4, `karaokeRooms` over `KaraokeRoomsKey`): the table routes (open, join, ready,
//   queue, start, close, ...) and four plain member routes: the room's event stream (SSE, what each
//   connection gets is decided per person by the rooms: a singer of the running round never gets
//   the board), the clock sync, a singer's microphone (µ-law, read with a cap, relayed, never
//   stored) and a singer's own detected pitch. These are not counted against the member rate limit
//   (a song is several requests a second); the rooms cap them per singer instead. Rooms are per
//   server (phase 6): the list and opening take `?space=` through `memberSpace` (404 a server she
//   is not in, 403 one the person is not a member of; default: their own, the primary first).
//
// A panel admin (session tier `admin`) may use everything while karaoke is not open, to try it;
// members see it closed. Without the `karaoke` module every route is a `503` that names it.
//
// A refused submit, recording, room microphone chunk or room pitch (any 4xx or 5xx, the input
// check and the member rate limit included) is logged at warn with the route, the status, the
// sentence and the session or room: a singer's lost result can be traced. Never the body (the
// pitch, the audio, the recording). The same refusal of one account is logged once per
// `REFUSAL_LOG_MS`, with how many were left out.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  KARAOKE_ROOM_CODE,
  KaraokeClockSchema,
  KaraokePitchSchema,
  type KaraokeRooms,
} from "@miyoria/contracts/api";
import { KARAOKE_VOICE_MAX_BYTES } from "@miyoria/contracts/workers";
import {
  KaraokeError,
  KaraokeKey,
  KaraokeRoomsKey,
  type KaraokeService,
  MAX_AUDIO_BYTES,
  type RoomDesk,
} from "@miyoria/play/karaoke";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { type AccountRef, accountRefString, PlacesKey } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { json, noContent, param, type Route } from "./route.js";
import type { SessionRecord } from "./session.js";
import { adminSpace, memberPerson, memberSpace } from "./space-param.js";
import type { ApiContext, ApiState } from "./state.js";
import type { Watch } from "./watch.js";

const log = getLogger("api.karaoke");

/** The same refusal (route, status, account) is logged at most once in this long. */
export const REFUSAL_LOG_MS = 10_000;
const refusalsSeen = new Map<string, { at: number; left: number }>();

/**
 * A karaoke request answered with an error: logged at warn (route, status, sentence, where), never
 * its body. `where`: the session or room it was about.
 */
export function logRefusal(
  route: string,
  c: ApiContext,
  error: unknown,
  where: Record<string, string | null>,
): void {
  const status = error instanceof ApiError ? error.status : 500;
  if (status < 400) return;
  const member = c.get("member") as SessionRecord | undefined;
  const who = member === undefined ? null : accountRefString(member.account);
  const key = `${route}|${status}|${who ?? ""}`;
  const now = Date.now();
  const seen = refusalsSeen.get(key);
  if (seen !== undefined && now - seen.at < REFUSAL_LOG_MS) {
    seen.left++;
    return;
  }
  refusalsSeen.set(key, { at: now, left: 0 });
  if (refusalsSeen.size > 1_000) {
    for (const [k, v] of refusalsSeen) if (now - v.at >= REFUSAL_LOG_MS) refusalsSeen.delete(k);
  }
  log.warn(
    {
      route,
      status,
      message: errorMessage(error).slice(0, 200),
      ...where,
      account: who,
      ...(seen !== undefined && seen.left > 0 ? { left_out: seen.left } : {}),
    },
    "karaoke: a request was refused",
  );
}

/**
 * The table's karaoke routes whose refusals are logged (`rpc.ts` asks for each route): the
 * browser's result of a session. `null` for any other route.
 */
export function karaokeRefusals(
  path: readonly string[],
): ((c: ApiContext, error: unknown) => void) | null {
  if (path[0] !== "karaoke" || path[1] !== "submit") return null;
  return (c, error) =>
    logRefusal("karaoke.submit", c, error, { session: c.req.param("id") ?? null });
}

/** `handler` with its refusals logged as `route`, about the session or room of the path. */
function logged(route: string, handler: (c: ApiContext) => Promise<Response>) {
  return async (c: ApiContext): Promise<Response> => {
    try {
      return await handler(c);
    } catch (error) {
      logRefusal(route, c, error, {
        session: c.req.param("id") ?? null,
        room: c.req.param("code") ?? null,
      });
      throw error;
    }
  };
}

function service(state: ApiState): KaraokeService {
  return state.service(KaraokeKey, "karaoke module");
}

function memberOf(c: ApiContext): SessionRecord {
  return c.get("member") as SessionRecord;
}

function accountOf(c: ApiContext): AccountRef {
  return memberOf(c).account;
}

/** Runs `fn`, a refusal of the service as its status and sentence. */
async function refusals<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof KaraokeError) throw new ApiError(error.status, error.message);
    throw error;
  }
}

/** A panel admin (their session's tier): they may use karaoke while it is not open. */
function adminOf(c: ApiContext): boolean {
  return memberOf(c).tier === "admin";
}

export const karaokeRpc = {
  overview: os.karaoke.overview.handler(({ context: { state, c } }) =>
    refusals(() => service(state).overview(accountOf(c), adminOf(c))),
  ),
  request: os.karaoke.request.handler(({ input, context: { state, c } }) =>
    refusals(() => service(state).request(accountOf(c), input.body.text, adminOf(c))),
  ),
  song: os.karaoke.song.handler(({ input, context: { state, c } }) =>
    refusals(() => service(state).song(accountOf(c), input.params.id)),
  ),
  start: os.karaoke.start.handler(({ input, context: { state, c } }) =>
    refusals(() =>
      service(state).start(
        accountOf(c),
        memberOf(c).name,
        input.params.id,
        input.body?.shift ?? 0,
        adminOf(c),
      ),
    ),
  ),
  submit: os.karaoke.submit.handler(({ input, context: { state, c } }) =>
    refusals(() => service(state).submit(accountOf(c), input.params.id, input.body)),
  ),
  result: os.karaoke.result.handler(({ input, context: { state, c } }) =>
    refusals(() => service(state).result(accountOf(c), input.params.id)),
  ),
  editor: os.karaoke.editor.handler(({ input, context: { state, c } }) =>
    refusals(() => service(state).editor(accountOf(c), input.params.id, adminOf(c))),
  ),
  saveEdit: os.karaoke.saveEdit.handler(({ input, context: { state, c } }) =>
    refusals(() =>
      service(state).saveEdit(
        accountOf(c),
        memberOf(c).name,
        input.params.id,
        input.body,
        adminOf(c),
      ),
    ),
  ),
  restoreEdit: os.karaoke.restoreEdit.handler(({ input, context: { state, c } }) =>
    refusals(() =>
      service(state).restoreEdit(
        accountOf(c),
        memberOf(c).name,
        input.params.id,
        input.body.revision,
        adminOf(c),
      ),
    ),
  ),
};

export const karaokeAdminRpc = {
  results: os.karaokeAdmin.results.handler(({ input, context: { state } }) => {
    const asked = input?.query.space;
    const space = asked === undefined ? undefined : (adminSpace(state, asked)?.id ?? undefined);
    return service(state).adminResults(50, space);
  }),
};

// ---- rooms (step 4) ---------------------------------------------------------------------------

function rooms(state: ApiState): RoomDesk {
  return state.service(KaraokeRoomsKey, "karaoke module");
}

/**
 * The server a rooms route is about: `?space=` checked against the person (`memberSpace`: 404,
 * 403), else their own. Left out (the rooms' own default, the primary) when Core has no places.
 */
async function roomSpace(
  state: ApiState,
  c: ApiContext,
  requested: string | undefined,
): Promise<string | undefined> {
  if (state.optional(PlacesKey) === undefined) return undefined;
  return memberSpace(state, await memberPerson(state, c), requested).id;
}

/**
 * `GET /api/member/karaoke/rooms?space=` as a view (also the `rooms` push topic): the server is
 * checked against the person here (`404`, `403`), for both.
 */
export async function roomsWatch(
  state: ApiState,
  c: ApiContext,
  requested: string | undefined,
): Promise<Watch<KaraokeRooms>> {
  const space = await roomSpace(state, c, requested);
  const account = accountOf(c);
  const admin = adminOf(c);
  return {
    key: `rooms:${accountRefString(account)}:${admin ? "admin" : "member"}:${space ?? ""}`,
    build: () => refusals(() => rooms(state).overview(account, admin, space)),
  };
}

export const karaokeRoomsRpc = {
  overview: os.karaokeRooms.overview.handler(async ({ input, context: { state, c } }) =>
    (await roomsWatch(state, c, input?.query.space)).build(),
  ),
  open: os.karaokeRooms.open.handler(async ({ input, context: { state, c } }) => {
    const space = await roomSpace(state, c, input.query?.space);
    return refusals(() =>
      rooms(state).open(
        accountOf(c),
        memberOf(c).name,
        input.body.song ?? null,
        input.body.shift,
        adminOf(c),
        space,
      ),
    );
  }),
  room: os.karaokeRooms.room.handler(({ input, context: { state, c } }) =>
    refusals(() => rooms(state).view(input.params.code, accountOf(c))),
  ),
  join: os.karaokeRooms.join.handler(({ input, context: { state, c } }) =>
    refusals(() =>
      rooms(state).join(
        input.params.code,
        accountOf(c),
        memberOf(c).name,
        input.body.as,
        adminOf(c),
      ),
    ),
  ),
  leave: os.karaokeRooms.leave.handler(({ input, context: { state, c } }) =>
    refusals(() => rooms(state).leave(input.params.code, accountOf(c))),
  ),
  ready: os.karaokeRooms.ready.handler(({ input, context: { state, c } }) =>
    refusals(() => rooms(state).ready(input.params.code, accountOf(c), input.body)),
  ),
  queueAdd: os.karaokeRooms.queueAdd.handler(({ input, context: { state, c } }) =>
    refusals(() =>
      rooms(state).queueAdd(
        input.params.code,
        accountOf(c),
        memberOf(c).name,
        input.body,
        adminOf(c),
      ),
    ),
  ),
  queueRemove: os.karaokeRooms.queueRemove.handler(({ input, context: { state, c } }) =>
    refusals(() =>
      rooms(state).queueRemove(input.params.code, accountOf(c), input.params.entry, adminOf(c)),
    ),
  ),
  queueMove: os.karaokeRooms.queueMove.handler(({ input, context: { state, c } }) =>
    refusals(() =>
      rooms(state).queueMove(
        input.params.code,
        accountOf(c),
        input.params.entry,
        input.body.to,
        adminOf(c),
      ),
    ),
  ),
  relay: os.karaokeRooms.relay.handler(({ input, context: { state, c } }) =>
    refusals(() => rooms(state).relay(input.params.code, accountOf(c), input.body, adminOf(c))),
  ),
  cheer: os.karaokeRooms.cheer.handler(({ input, context: { state, c } }) =>
    refusals(() => rooms(state).cheer(input.params.code, accountOf(c), input.body)),
  ),
  start: os.karaokeRooms.start.handler(({ input, context: { state, c } }) =>
    refusals(() => rooms(state).start(input.params.code, accountOf(c))),
  ),
  close: os.karaokeRooms.close.handler(({ input, context: { state, c } }) =>
    refusals(() => rooms(state).close(input.params.code, accountOf(c))),
  ),
};

/** Keep-alive comment interval of a room's event stream. */
const ROOM_KEEP_ALIVE_MS = 15_000;
/** Messages a room stream may fall behind by before it is closed (a reader that stopped). */
const ROOM_MAX_BEHIND = 64;
/** Room streams one account may hold open at once (a few tabs). */
export const ROOM_STREAMS_PER_ACCOUNT = 3;
const roomStreams = new WeakMap<ApiState, Map<string, number>>();

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-accel-buffering": "no",
};

/** A room's code from the path, or a 404. */
function codeOf(c: ApiContext): string {
  const code = param(c, "code").toUpperCase();
  if (!KARAOKE_ROOM_CODE.test(code)) throw ApiError.notFound("no such room");
  return code;
}

/**
 * `GET /api/member/karaoke/rooms/:code/events`: the room as this person sees it, the board or
 * their own trend. What a connection gets is decided by the rooms (`RoomDesk.follow`), per
 * person: a singer of the running round is never sent the board.
 */
async function roomEvents(state: ApiState, c: ApiContext): Promise<Response> {
  const desk = rooms(state);
  const code = codeOf(c);
  const account = accountOf(c);
  const who = accountRefString(account);
  let open = roomStreams.get(state);
  if (open === undefined) {
    open = new Map();
    roomStreams.set(state, open);
  }
  if ((open.get(who) ?? 0) >= ROOM_STREAMS_PER_ACCOUNT) throw ApiError.tooMany(5_000);
  const counts = open;
  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;
  let stop: (() => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    stop?.();
    clearInterval(keepAlive);
    signal.removeEventListener("abort", finish);
    const left = (counts.get(who) ?? 1) - 1;
    if (left <= 0) counts.delete(who);
    else counts.set(who, left);
  };
  let refusal: unknown = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (text: string) => {
        if (done) return;
        if ((controller.desiredSize ?? 0) < -ROOM_MAX_BEHIND) {
          finish();
          controller.close();
          return;
        }
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          finish();
        }
      };
      counts.set(who, (counts.get(who) ?? 0) + 1);
      push("retry: 3000\n\n");
      try {
        stop = desk.follow(code, account, (event) =>
          push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        );
      } catch (error) {
        refusal = error;
        finish();
        return;
      }
      keepAlive = setInterval(() => push(":\n\n"), ROOM_KEEP_ALIVE_MS);
      signal.addEventListener("abort", finish, { once: true });
    },
    cancel() {
      finish();
    },
  });
  if (refusal !== null) {
    void stream.cancel().catch(() => undefined);
    if (refusal instanceof KaraokeError) throw new ApiError(refusal.status, refusal.message);
    throw refusal;
  }
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/** `POST /api/member/karaoke/rooms/:code/clock` `{t0}`: one round trip of the clock sync. */
async function roomClock(state: ApiState, c: ApiContext): Promise<Response> {
  const desk = rooms(state);
  const body = KaraokeClockSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new ApiError(400, "the body must be {t0}");
  return json(desk.clock(body.data.t0));
}

/**
 * `POST /api/member/karaoke/rooms/:code/audio?at=&song_ms=&end=`: a singer's microphone, µ-law
 * 16 kHz mono, at most two seconds. Read with that cap, relayed to the song worker, never stored
 * or logged.
 */
async function roomAudio(state: ApiState, c: ApiContext): Promise<Response> {
  const desk = rooms(state);
  const code = codeOf(c);
  const at = Number(c.req.query("at") ?? "");
  const songMs = Number(c.req.query("song_ms") ?? "");
  const end = c.req.query("end") === "1";
  const bytes = await bodyUpTo(c, MAX_AUDIO_BYTES);
  if (bytes === null) throw new ApiError(413, "一次送太多了");
  const reply = await refusals(() => desk.audio(code, accountOf(c), at, songMs, end, bytes));
  return json(reply);
}

/** `POST /api/member/karaoke/rooms/:code/pitch` `{from, track}`: the browser's own pitch. */
async function roomPitch(state: ApiState, c: ApiContext): Promise<Response> {
  const desk = rooms(state);
  const code = codeOf(c);
  const body = KaraokePitchSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new ApiError(400, "the body must be {from, track}");
  await refusals(() => desk.pitch(code, accountOf(c), body.data.from, body.data.track));
  return noContent();
}

/** `GET /api/member/karaoke/files/:session/:name`. */
async function file(state: ApiState, c: ApiContext): Promise<Response> {
  const found = await service(state).file(
    accountOf(c),
    param(c, "session"),
    param(c, "name"),
    c.req.query("exp"),
    c.req.query("sig"),
  );
  if (found === null) throw ApiError.notFound("no such file");
  if ("data" in found) {
    // An edited reference, from memory: small, whole, never in ranges.
    return new Response(found.data, {
      status: 200,
      headers: {
        "content-type": found.type,
        "cross-origin-resource-policy": "same-origin",
        "content-length": String(found.data.byteLength),
      },
    });
  }
  return sendFile(c, found.path, found.type);
}

/**
 * `GET /api/member/karaoke/edit/:song/backing`: the backing track the reference editor plays, for
 * a panel admin's session only. Anything else (a member, no such song, not ready, no file) is the
 * same 404 as the session files.
 */
async function editBacking(state: ApiState, c: ApiContext): Promise<Response> {
  if (!adminOf(c)) throw ApiError.notFound("no such file");
  let path: string | null;
  try {
    path = await service(state).editBacking(accountOf(c), param(c, "song"), true);
  } catch (error) {
    if (!(error instanceof KaraokeError)) throw error;
    path = null;
  }
  if (path === null) throw ApiError.notFound("no such file");
  return sendFile(c, path, "audio/mp4");
}

/** A file on Core as the answer, one byte range (`Range: bytes=a-b`) as a 206. */
async function sendFile(c: ApiContext, path: string, type: string): Promise<Response> {
  const size = (await stat(path)).size;
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cross-origin-resource-policy": "same-origin",
  };
  const range = byteRange(c.req.header("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
    });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body =
    size === 0 ? null : (Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream);
  return new Response(body, {
    status: range === null ? 200 : 206,
    headers: {
      ...headers,
      "content-length": String(size === 0 ? 0 : end - start + 1),
      ...(range === null ? {} : { "content-range": `bytes ${start}-${end}/${size}` }),
    },
  });
}

/**
 * One byte range of a `Range` header over `size` bytes: `null` for none (or one this does not
 * serve, like several ranges: the whole file then), `"unsatisfiable"` for one past the end.
 * (`range-parser` does this too, but is not a dependency of this package.)
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null;
  const [, from = "", to = ""] = m;
  if (from === "" && to === "") return null;
  let start: number;
  let end: number;
  if (from === "") {
    // The last `to` bytes.
    const n = Number(to);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** The request's body, up to `max` bytes; `null` when it is longer. */
async function bodyUpTo(c: ApiContext, max: number): Promise<Uint8Array | null> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  const stream = c.req.raw.body;
  if (stream === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  chunks.length = 0;
  return out;
}

/** `POST /api/member/karaoke/sessions/:id/voice?offset_ms=`. */
async function voice(state: ApiState, c: ApiContext): Promise<Response> {
  const karaoke = service(state);
  const offset = Number(c.req.query("offset_ms") ?? "0");
  const bytes = await bodyUpTo(c, KARAOKE_VOICE_MAX_BYTES);
  if (bytes === null) throw new ApiError(413, "錄音太大了");
  const accepted = await refusals(() =>
    karaoke.voice(
      accountOf(c),
      param(c, "id"),
      bytes,
      c.req.header("content-type") ?? "",
      Number.isFinite(offset) ? Math.round(offset) : Number.NaN,
    ),
  );
  return json(accepted, 202);
}

/** The member route of karaoke that is not on the route table. None when the public side is off. */
export function karaokeRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  return [
    {
      method: "GET",
      path: "/api/member/karaoke/files/:session/:name",
      member: true,
      handler: (c) => file(state, c),
    },
    {
      method: "GET",
      path: "/api/member/karaoke/edit/:song/backing",
      member: true,
      handler: (c) => editBacking(state, c),
    },
    {
      method: "POST",
      path: "/api/member/karaoke/sessions/:id/voice",
      member: true,
      handler: logged("karaoke.voice", (c) => voice(state, c)),
    },
    {
      method: "GET",
      path: "/api/member/karaoke/rooms/:code/events",
      member: true,
      handler: (c) => roomEvents(state, c),
    },
    {
      method: "POST",
      path: "/api/member/karaoke/rooms/:code/clock",
      member: true,
      handler: (c) => roomClock(state, c),
    },
    {
      method: "POST",
      path: "/api/member/karaoke/rooms/:code/audio",
      member: true,
      handler: logged("karaokeRooms.audio", (c) => roomAudio(state, c)),
    },
    {
      method: "POST",
      path: "/api/member/karaoke/rooms/:code/pitch",
      member: true,
      handler: logged("karaokeRooms.pitch", (c) => roomPitch(state, c)),
    },
  ];
}
