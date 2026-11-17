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

import type { ControlResult, SongsState, SongView } from "@miyoria/contracts/api";
import { SingerKey, type SongEntry } from "@miyoria/sing";
import { type ContextKey, contextKeyString, type JsonObject } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { actAs } from "./ops.js";
import { type ApiContext, type ApiState, toJson } from "./state.js";

const BODY_REJECTED = "Failed to deserialize the JSON body into the target type";

/**
 * A text of the body, trimmed. The contract checks the text as it came; one that is empty or too
 * long once trimmed is refused with the answer a body that does not match its shape gets (422).
 */
function trimmed(field: string, value: string, max: number): string {
  const text = value.trim();
  if (text.length < 1) {
    throw new ApiError(
      422,
      `${BODY_REJECTED}: ${field}: Too small: expected string to have >=1 characters`,
    );
  }
  if (text.length > max) {
    throw new ApiError(
      422,
      `${BODY_REJECTED}: ${field}: Too big: expected string to have <=${max} characters`,
    );
  }
  return text;
}

const trimmedId = (field: string, value: string) => trimmed(field, value, 64);
const optionalId = (field: string, value: string | null | undefined) =>
  value == null ? null : trimmedId(field, value);

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

async function join(
  state: ApiState,
  c: ApiContext,
  body: { guild: string; channel?: string | null | undefined },
): Promise<ControlResult> {
  const guild = trimmedId("guild", body.guild);
  const channel = optionalId("channel", body.channel);
  return run(state, c, "voice.join", { guild, channel }, { action: "voice.join", target: guild });
}

async function leave(
  state: ApiState,
  c: ApiContext,
  body: { guild?: string | null | undefined },
): Promise<ControlResult> {
  const guild = guildOf(state, optionalId("guild", body.guild));
  return run(state, c, "voice.leave", { guild }, { action: "voice.leave", target: guild });
}

async function golive(
  state: ApiState,
  c: ApiContext,
  body: { action: "start" | "stop"; guild?: string | null | undefined },
): Promise<ControlResult> {
  const guild = guildOf(state, optionalId("guild", body.guild));
  const capability = body.action === "start" ? "stream.start" : "stream.stop";
  return run(
    state,
    c,
    capability,
    { guild },
    { action: `voice.golive.${body.action}`, target: guild },
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

async function requestSong(
  state: ApiState,
  c: ApiContext,
  body: { query: string; key?: number | null | undefined },
): Promise<ControlResult & SongsState> {
  const query = trimmed("query", body.query, 300);
  const args: JsonObject = { query, key: body.key ?? null };
  const result = await run(state, c, "sing.request", args, {
    action: "sing.request",
    target: query,
  });
  return { ...result, ...songsState(state) };
}

async function playSong(
  state: ApiState,
  c: ApiContext,
  body: { song?: number | null | undefined },
): Promise<ControlResult & SongsState> {
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
  return { ...result, ...songsState(state) };
}

async function stopSong(
  state: ApiState,
  c: ApiContext,
  body: { all?: boolean | null | undefined },
): Promise<ControlResult & SongsState> {
  const all = body.all === true;
  const result = await run(
    state,
    c,
    "sing.stop",
    { all },
    { action: "sing.stop", target: all ? "all" : "current" },
  );
  return { ...result, ...songsState(state) };
}

// ---- game -------------------------------------------------------------------------------

/** The game director plays where she is; it needs a place to report to. */
function playContext(state: ApiState, asked: ContextKey | null | undefined): ContextKey {
  const context = asked ?? state.monitor.voiceContext();
  if (!context)
    throw ApiError.conflict("she needs to be in a voice channel to play from the panel");
  return context;
}

async function gameStart(
  state: ApiState,
  c: ApiContext,
  body: {
    game?: string | null | undefined;
    goal?: string | null | undefined;
    stream?: boolean | null | undefined;
    context?: ContextKey | null | undefined;
  },
): Promise<ControlResult> {
  const game = optionalId("game", body.game);
  const goal = body.goal == null ? null : trimmed("goal", body.goal, 200);
  const context = playContext(state, body.context);
  const args: JsonObject = { game, goal, stream: body.stream ?? null };
  return run(
    state,
    c,
    "game.start",
    args,
    { action: "game.start", target: game ?? contextKeyString(context) },
    context,
  );
}

async function gameStop(state: ApiState, c: ApiContext): Promise<ControlResult> {
  return run(
    state,
    c,
    "game.stop",
    {},
    { action: "game.stop", target: "game" },
    state.monitor.voiceContext(),
  );
}

async function gameGoal(state: ApiState, c: ApiContext, text: string): Promise<ControlResult> {
  return run(
    state,
    c,
    "game.goal",
    { text: trimmed("text", text, 200) },
    { action: "game.goal", target: "game" },
    state.monitor.voiceContext(),
  );
}

/** The control routes on the route table (`@miyoria/contracts/api`); `voice` joins the monitor's. */
export const controlRpc = {
  voice: {
    join: os.voice.join.handler(({ input, context }) => join(context.state, context.c, input.body)),
    leave: os.voice.leave.handler(({ input, context }) =>
      leave(context.state, context.c, input.body),
    ),
    goLive: os.voice.goLive.handler(({ input, context }) =>
      golive(context.state, context.c, input.body),
    ),
  },
  songs: {
    list: os.songs.list.handler(({ context }) => songsState(context.state)),
    request: os.songs.request.handler(({ input, context }) =>
      requestSong(context.state, context.c, input.body),
    ),
    play: os.songs.play.handler(({ input, context }) =>
      playSong(context.state, context.c, input.body),
    ),
    stop: os.songs.stop.handler(({ input, context }) =>
      stopSong(context.state, context.c, input.body),
    ),
  },
  game: {
    start: os.game.start.handler(({ input, context }) =>
      gameStart(context.state, context.c, input.body),
    ),
    stop: os.game.stop.handler(({ context }) => gameStop(context.state, context.c)),
    goal: os.game.goal.handler(({ input, context }) =>
      gameGoal(context.state, context.c, input.body.text),
    ),
  },
};
