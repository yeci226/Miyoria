// osu! on stream, everything played by osu_rl's vision student from the game's picture (2026-11-17):
// - viewers' map requests (`/queue osu request | list | skip | clear`, osu_rl's live.requests);
// - the AI seated at the stream's lazer (`/queue osu status | join | leave`, osu_rl's live.room_play): it joins a
//   multiplayer room, readies up by itself and plays every round from the screen through a virtual tablet;
// - her tools for the same (osu_ai.*): status, rooms, join, leave, and a single map (into the request queue).
// The state model (which read the map) and live.service (rooms over the lazer protocol, without a picture) are gone,
// and with them the level and feel settings. Which account the AI plays on is osu_rl's to check (only the AI's own,
// on the private server), before every map and every join.

import { defineExtension } from "@miyoria/sdk";
import {
  httpClient,
  type QueuePermissions,
  registerQueueCommands,
  registerSeatCommands,
  SEAT_DOWN,
} from "./queue.js";

export { beatmapIdOf, describeSeat } from "./queue.js";

/** `[extensions."miyoria.osu"]` config (everything optional). */
interface OsuConfig {
  /** osu_rl's OSU_RL_CONTROL_TOKEN (both services take it). */
  token?: string;
  request_timeout_ms?: number;
  /** osu_rl's request queue (`live.stream --requests`): request commands and the play_map tool. */
  queue_url?: string;
  queue_permissions?: QueuePermissions;
  /** osu_rl's live.room_play (the AI at the stream's lazer): status, join and leave, as commands and tools. */
  seat_url?: string;
}

const PLAY = "tools.osu.play";
const QUEUE_DOWN = "連不到 osu! 點播服務(直播機的 live.stream 有開 --requests 嗎?)";

export default defineExtension({
  async activate(ctx) {
    const config = ctx.config as OsuConfig;
    const token = config.token ?? process.env.MIYORIA_OSU_TOKEN ?? "";
    const timeoutMs = config.request_timeout_ms ?? 120_000;
    if (!token)
      ctx.log.warn(
        "no osu_rl token (config token / MIYORIA_OSU_TOKEN); every call will be refused",
      );
    const asTool = (r: Awaited<ReturnType<ReturnType<typeof httpClient>>>) =>
      r.ok ? JSON.stringify(r.data) : `失敗:${r.error}`;

    const seatUrl = config.seat_url ?? process.env.MIYORIA_OSU_SEAT_URL ?? "";
    if (seatUrl.trim()) {
      // joining waits until the fork is in the room (up to 20 s on osu_rl's side)
      const seat = httpClient(ctx, seatUrl, token, 30_000, SEAT_DOWN);
      await registerSeatCommands(ctx, seat, {
        status: config.queue_permissions?.list ?? "queue.list",
        room: config.queue_permissions?.room ?? "queue.osu.room",
      });

      await ctx.tools.register({
        name: "osu_ai.status",
        description:
          "看直播上的 osu! AI 在做什麼:在不在多人房(哪一間)、正在打哪張、上一首打多少。AI 看著遊戲畫面打,沒有強度或手感可調。",
        run: async () => asTool(await seat("GET", "/status")),
      });

      await ctx.tools.register({
        name: "osu_ai.list_rooms",
        description:
          "列出 osu! 伺服器上開著的 lazer 多人房(id、名稱、房主、有沒有密碼、人數),用來挑一間讓 AI 進去。",
        run: async () => asTool(await seat("GET", "/rooms")),
      });

      await ctx.tools.register({
        name: "osu_ai.join_room",
        description:
          "把直播上的 osu! AI 送進一間 lazer 多人房。進去後譜下載好它就自己按準備,房主每開一輪都會一起打(看著畫面打)。",
        params: {
          room_id: { type: "integer", description: "房間 id,從 osu_ai_list_rooms 或房間連結拿" },
          password: { type: "string", description: "房間密碼(有的話)" },
        },
        optional: ["password"],
        permission: PLAY,
        run: async ({ room_id, password }) =>
          asTool(await seat("POST", "/join", { room_id, password })),
      });

      await ctx.tools.register({
        name: "osu_ai.leave_room",
        description: "讓直播上的 osu! AI 離開目前的多人房。",
        permission: PLAY,
        run: async () => asTool(await seat("POST", "/leave")),
      });
    }

    const queueUrl = config.queue_url ?? process.env.MIYORIA_OSU_QUEUE_URL ?? "";
    if (queueUrl.trim()) {
      await registerQueueCommands(ctx, {
        url: queueUrl,
        token,
        timeoutMs,
        permissions: config.queue_permissions,
      });

      const queue = httpClient(ctx, queueUrl, token, timeoutMs, QUEUE_DOWN);
      await ctx.tools.register({
        name: "osu_ai.play_map",
        description:
          "讓直播上的 osu! AI 打一張譜:排進點播佇列(跟觀眾點的一起排),輪到時 AI 在直播的遊戲視窗裡看著畫面打。回傳排第幾首;成績之後用 /queue osu list 看。",
        params: {
          beatmap_id: { type: "integer", description: "osu.ppy.sh 上某個難度(譜面)的 id" },
        },
        permission: PLAY,
        run: async ({ beatmap_id }) =>
          asTool(await queue("POST", "/request", { beatmap_id, by: "Miyoria", by_id: "miyoria" })),
      });
    }

    ctx.log.info("osu extension activated", { queue: queueUrl || null, seat: seatUrl || null });
  },
});
