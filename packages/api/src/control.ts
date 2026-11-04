// Live controls the panel runs through the actuator gate (principal `panel`), like `/voice`,
// `/queue song` and `/game` do from Discord: her voice channel and Go Live, the song set list,
// and the game director. Every change is audited; the gate decides, nothing here bypasses it.
//
// * `POST /api/voice/join` `{ guild, channel? }` (`voice.join`; no channel = the busiest one)
// * `POST /api/voice/leave` `{ guild? }` (`voice.leave`)
// * `POST /api/voice/golive` `{ action: "start" | "stop", guild? }` (`stream.start|stop`)
// * `GET /api/songs`, `POST /api/songs` `{ query, key? }` (`sing.request`),
//   `POST /api/songs/play` `{ song? }` (`sing.play`), `POST /api/songs/stop` `{ all? }`
//   (`sing.stop`)
// * `POST /api/game/start` `{ game?, goal?, stream? }`, `POST /api/game/stop`,
//   `POST /api/game/goal` `{ text }` (`game.*`; played where she is in voice)
// * `POST /api/share/browse` (`share.browse`; one round on Threads, within the usual limits)

import { SingerKey, type SongEntry } from "@miyoria/sing";
import { type ContextKey, contextKeyString, type JsonObject } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { readJson } from "./extract.js";
import { actAs } from "./ops.js";
import { json, type Route } from "./route.js";
import { ContextKeySchema } from "./schemas.js";
import { type ApiContext, type ApiState, toJson } from "./state.js";
import type { ControlResult, SongsState, SongView } from "./types.js";

const Id = z.string().trim().min(1).max(64);

/** Runs `capability`, audits it as `audit` on `target`, and answers with its text. */
async function run(
  state: ApiState,
  c: ApiContext,
  capability: string,
  args: JsonObject,
  audit: { action: string; target: string },
  context: ContextKey | null = null,
): Promise<ControlResult> {
  const outcome = await actAs(state, c, capability, args, context);
  await state.audit(
    c,
    audit.action,
    audit.target,
    toJson(outcome.error ? { ...args, error: outcome.error.message } : args),
    outcome.error === null,
  );
  if (outcome.error) throw outcome.error;
  return { text: outcome.text };
}

/** The guild she is in voice in, or the one asked for. */
function guildOf(state: ApiState, asked: string | null | undefined): string {
  const guild = asked ?? state.monitor.voiceContext()?.scope ?? null;
  if (guild === null) throw ApiError.badRequest("`guild` is needed while she is not in voice");
  return guild;
}

// ---- voice ------------------------------------------------------------------------------

const JoinSchema = z.object({ guild: Id, channel: Id.nullish() });
const LeaveSchema = z.object({ guild: Id.nullish() });
const GoLiveSchema = z.object({ action: z.enum(["start", "stop"]), guild: Id.nullish() });

async function join(state: ApiState, c: ApiContext): Promise<Response> {
  const body = await readJson(c, JoinSchema);
  const args: JsonObject = { guild: body.guild, channel: body.channel ?? null };
  return json(
    await run(state, c, "voice.join", args, { action: "voice.join", target: body.guild }),
  );
}

async function leave(state: ApiState, c: ApiContext): Promise<Response> {
  const body = await readJson(c, LeaveSchema);
  const guild = guildOf(state, body.guild);
  return json(
    await run(state, c, "voice.leave", { guild }, { action: "voice.leave", target: guild }),
  );
}

async function golive(state: ApiState, c: ApiContext): Promise<Response> {
  const body = await readJson(c, GoLiveSchema);
  const guild = guildOf(state, body.guild);
  const capability = body.action === "start" ? "stream.start" : "stream.stop";
  return json(
    await run(
      state,
      c,
      capability,
      { guild },
      { action: `voice.golive.${body.action}`, target: guild },
    ),
  );
}

// ---- songs ------------------------------------------------------------------------------

function songView(e: SongEntry): SongView {
  return {
    no: e.no,
    query: e.query,
    title: e.song?.title || null,
    artist: e.song?.artist ?? null,
    duration_s: e.song?.duration_s ?? null,
    key: e.key,
    requester_name: e.requester_name,
    state: e.state,
    stage: e.stage,
    progress: e.progress,
    error: e.error,
    forced: e.forced,
    created_at: e.created_at,
    ready_at: e.ready_at,
  };
}

function songsState(state: ApiState): SongsState {
  const singer = state.service(SingerKey, "sing module");
  return {
    playing: singer.playing()?.no ?? null,
    paused: singer.paused(),
    songs: singer.list.all().map(songView),
  };
}

const RequestSchema = z.object({
  query: z.string().trim().min(1).max(300),
  key: z.number().int().min(-6).max(6).nullish(),
});
const PlaySchema = z.object({ song: z.number().int().positive().nullish() });
const StopSchema = z.object({ all: z.boolean().nullish() });

async function requestSong(state: ApiState, c: ApiContext): Promise<Response> {
  const body = await readJson(c, RequestSchema);
  const args: JsonObject = { query: body.query, key: body.key ?? null };
  const result = await run(state, c, "sing.request", args, {
    action: "sing.request",
    target: body.query,
  });
  return json({ ...result, ...songsState(state) });
}

async function playSong(state: ApiState, c: ApiContext): Promise<Response> {
  const body = await readJson(c, PlaySchema);
  const target = body.song == null ? "next" : `#${body.song}`;
  // Sung in the voice channel she is in.
  const result = await run(
    state,
    c,
    "sing.play",
    { song: body.song ?? null },
    { action: "sing.play", target },
    state.monitor.voiceContext(),
  );
  return json({ ...result, ...songsState(state) });
}

async function stopSong(state: ApiState, c: ApiContext): Promise<Response> {
  const body = await readJson(c, StopSchema);
  const all = body.all === true;
  const result = await run(
    state,
    c,
    "sing.stop",
    { all },
    { action: "sing.stop", target: all ? "all" : "current" },
  );
  return json({ ...result, ...songsState(state) });
}

// ---- share ------------------------------------------------------------------------------

async function shareBrowse(state: ApiState, c: ApiContext): Promise<Response> {
  return json(
    await run(state, c, "share.browse", {}, { action: "share.browse", target: "threads" }),
  );
}

// ---- game -------------------------------------------------------------------------------

const GameStartSchema = z.object({
  game: Id.nullish(),
  goal: z.string().trim().min(1).max(200).nullish(),
  stream: z.boolean().nullish(),
  /** Where to play; default the voice channel she is in. */
  context: ContextKeySchema.nullish(),
});
const GoalSchema = z.object({ text: z.string().trim().min(1).max(200) });

/** The game director plays where she is; it needs a place to report to. */
function playContext(state: ApiState, asked: ContextKey | null | undefined): ContextKey {
  const context = asked ?? state.monitor.voiceContext();
  if (!context)
    throw ApiError.conflict("she needs to be in a voice channel to play from the panel");
  return context;
}

async function gameStart(state: ApiState, c: ApiContext): Promise<Response> {
  const body = await readJson(c, GameStartSchema);
  const context = playContext(state, body.context as ContextKey | null | undefined);
  const args: JsonObject = {
    game: body.game ?? null,
    goal: body.goal ?? null,
    stream: body.stream ?? null,
  };
  return json(
    await run(
      state,
      c,
      "game.start",
      args,
      { action: "game.start", target: body.game ?? contextKeyString(context) },
      context,
    ),
  );
}

async function gameStop(state: ApiState, c: ApiContext): Promise<Response> {
  return json(
    await run(
      state,
      c,
      "game.stop",
      {},
      { action: "game.stop", target: "game" },
      state.monitor.voiceContext(),
    ),
  );
}

async function gameGoal(state: ApiState, c: ApiContext): Promise<Response> {
  const body = await readJson(c, GoalSchema);
  return json(
    await run(
      state,
      c,
      "game.goal",
      { text: body.text },
      { action: "game.goal", target: "game" },
      state.monitor.voiceContext(),
    ),
  );
}

export function controlRoutes(state: ApiState): Route[] {
  return [
    { method: "POST", path: "/api/voice/join", handler: (c) => join(state, c) },
    { method: "POST", path: "/api/voice/leave", handler: (c) => leave(state, c) },
    { method: "POST", path: "/api/voice/golive", handler: (c) => golive(state, c) },
    { method: "GET", path: "/api/songs", handler: () => json(songsState(state)) },
    { method: "POST", path: "/api/songs", handler: (c) => requestSong(state, c) },
    { method: "POST", path: "/api/songs/play", handler: (c) => playSong(state, c) },
    { method: "POST", path: "/api/songs/stop", handler: (c) => stopSong(state, c) },
    { method: "POST", path: "/api/game/start", handler: (c) => gameStart(state, c) },
    { method: "POST", path: "/api/game/stop", handler: (c) => gameStop(state, c) },
    { method: "POST", path: "/api/game/goal", handler: (c) => gameGoal(state, c) },
    { method: "POST", path: "/api/share/browse", handler: (c) => shareBrowse(state, c) },
  ];
}
