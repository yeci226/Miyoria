// `/queue osu request | list | skip | clear`: viewers' map requests for the osu! stream. The queue itself is osu_rl's
// live.requests (inside `python -m live.stream --requests`): it fetches the map, and the vision student plays the
// requests one after another in the game window on stream, from the picture alone. This only turns the commands into
// its HTTP calls.

import type { CommandReply, ExtensionContext, Invocation } from "@miyoria/sdk";

/** `[extensions."miyoria.osu"] queue_permissions`: who may do what (everyday users request and list). */
export interface QueuePermissions {
  request?: string;
  list?: string;
  skip?: string;
  clear?: string;
  /** `/queue osu join | leave` (the AI into a multiplayer room and out). */
  room?: string;
}

export interface QueueOptions {
  url: string;
  token: string;
  timeoutMs: number;
  permissions?: QueuePermissions;
}

/**
 * The beatmap (difficulty) id in a link or a bare number: `https://osu.ppy.sh/beatmapsets/1#osu/2`,
 * `…/beatmaps/2`, `…/b/2` or `2`. A link to a whole set, or to another mode's difficulty, says why it cannot be used.
 */
export function beatmapIdOf(text: string): { id: number } | { error: string } {
  const s = text.trim();
  if (/^\d{1,10}$/.test(s)) return { id: Number(s) };
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { error: "請貼譜面連結（osu.ppy.sh 上某個難度的網址）或譜面 id" };
  }
  const mode = /^#(osu|taiko|fruits|mania)\/(\d+)/.exec(url.hash);
  if (mode) {
    if (mode[1] !== "osu") return { error: "只能點 osu!（standard）的譜" };
    return { id: Number(mode[2]) };
  }
  const single = /^\/(?:beatmaps|b)\/(\d+)/.exec(url.pathname);
  if (single) return { id: Number(single[1]) };
  if (/^\/(?:beatmapsets|s)\/\d+/.test(url.pathname)) {
    return { error: "這是整組譜的連結，請選一個難度再貼（網址後面會有 #osu/數字）" };
  }
  return { error: "看不出這是哪張譜，請貼 osu.ppy.sh 的譜面連結" };
}

/** Titles come from the map: no Markdown in them. */
function md(text: string): string {
  return text.replace(/[\\*_`~|>#[\]()]/g, (c) => `\\${c}`);
}

function minutes(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface Item {
  no: number;
  title: string;
  stars: number;
  length: number;
  by: string;
  state: string;
  result: { accuracy: number | null; misses?: number; error?: string; skipped?: boolean } | null;
}

function label(i: Item): string {
  return `#${i.no} ${md(i.title)}（★${i.stars.toFixed(2)}，${minutes(i.length)}）· ${md(i.by)}`;
}

function outcome(i: Item): string {
  const r = i.result;
  if (!r) return "";
  if (r.skipped) return "：跳過了";
  if (r.accuracy === null) return "：沒打完";
  return `：${(r.accuracy * 100).toFixed(2)}%${r.misses ? `，miss ${r.misses}` : "，沒有 miss"}`;
}

export async function registerQueueCommands(
  ctx: ExtensionContext,
  options: QueueOptions,
): Promise<void> {
  const base = options.url.replace(/\/+$/, "");
  const perms = {
    request: options.permissions?.request ?? "queue.request",
    list: options.permissions?.list ?? "queue.list",
    skip: options.permissions?.skip ?? "queue.osu.skip",
    clear: options.permissions?.clear ?? "queue.osu.clear",
  };

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      ctx.log.warn("osu! request queue unreachable", { error: String(error) });
      return {
        ok: false,
        error: "連不到 osu! 點播服務（直播機的 live.stream 有開 --requests 嗎？）",
      };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401) return { ok: false, error: "osu! 點播服務的金鑰不對" };
    if (!res.ok) return { ok: false, error: String(data.error ?? `HTTP ${res.status}`) };
    return { ok: true, data };
  }

  const fail = (text: string): CommandReply => ({ text, ephemeral: true });

  await ctx.commands.register({
    path: "queue osu request",
    description: "點一張 osu! 譜給 AI 在直播上打（貼譜面連結）",
    args: [{ name: "map", description: "osu.ppy.sh 上某個難度的連結，或譜面 id" }],
    permission: perms.request,
    async run(inv: Invocation) {
      const parsed = beatmapIdOf(String(inv.args.map ?? ""));
      if ("error" in parsed) return fail(parsed.error);
      const r = await request("POST", "/request", {
        beatmap_id: parsed.id,
        by: inv.invoker_display_name,
        by_id: `${inv.invoker.platform}:${inv.invoker.id}`,
      });
      if (!r.ok) return fail(`沒辦法點播：${r.error}`);
      const item = r.data.item as Item;
      const position = Number(r.data.position);
      return position <= 1
        ? `已點播 ${label(item)}，下一首就打。`
        : `已點播 ${label(item)}，排第 ${position} 首。`;
    },
  });

  await ctx.commands.register({
    path: "queue osu list",
    description: "看 osu! 點播：正在打的、排隊中的和剛打完的",
    permission: perms.list,
    async run() {
      const r = await request("GET", "/queue");
      if (!r.ok) return fail(r.error);
      const { now, queue, recent, held } = r.data as {
        now: Item | null;
        queue: Item[];
        recent: Item[];
        held?: number | boolean | null;
      };
      const lines: string[] = [];
      if (held !== null && held !== undefined && held !== false) {
        const room = typeof held === "number" ? `(房間 ${held})` : "";
        lines.push(`AI 現在在多人房${room},點播先排著,離開房間後才會打。`);
      }
      if (now) lines.push(`正在打：${label(now)}`);
      for (const [k, i] of queue.entries()) lines.push(`${k + 1}. ${label(i)}`);
      if (lines.length === 0) lines.push("現在沒有點播。用 /queue osu request 貼譜面連結點一張。");
      const done = recent.slice(-3);
      if (done.length > 0) {
        lines.push("", "剛打完：", ...done.map((i) => `${label(i)}${outcome(i)}`));
      }
      return lines.join("\n");
    },
  });

  await ctx.commands.register({
    path: "queue osu skip",
    description: "跳過 AI 正在打的點播",
    permission: perms.skip,
    async run() {
      const r = await request("POST", "/skip");
      if (!r.ok) return fail(r.error);
      return r.data.skipped ? "已跳過正在打的點播。" : fail("現在沒有在打點播。");
    },
  });

  await ctx.commands.register({
    path: "queue osu clear",
    description: "清掉排隊中的 osu! 點播（選 all 連正在打的也停）",
    args: [{ name: "all", description: "正在打的也停", type: "boolean", required: false }],
    permission: perms.clear,
    async run(inv: Invocation) {
      const r = await request("POST", "/clear", { all: inv.args.all === true });
      if (!r.ok) return fail(r.error);
      const cleared = Number(r.data.cleared);
      return `清掉了 ${cleared} 首點播${r.data.skipped ? "，也停了正在打的" : ""}。`;
    },
  });
}

export interface SeatStatus {
  problem: string | null;
  room: boolean;
  room_id?: number | null;
  map: string | null;
  ready: boolean;
  playing: { map: string } | null;
  last: { map: string; accuracy: number | null; misses?: number } | null;
}

export type Http = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }>;

/** An HTTP client for one osu_rl service (the token, a timeout, the error in words when it is down). */
export function httpClient(
  ctx: ExtensionContext,
  url: string,
  token: string,
  timeoutMs: number,
  down: string,
): Http {
  const base = url.replace(/\/+$/, "");
  return async (method, path, body) => {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      ctx.log.warn("osu_rl service unreachable", { url: base, error: String(error) });
      return { ok: false, error: down };
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401) return { ok: false, error: "osu_rl 的金鑰不對" };
    if (!res.ok) return { ok: false, error: String(data.error ?? `HTTP ${res.status}`) };
    return { ok: true, data };
  };
}

export const SEAT_DOWN = "連不到直播機的 osu! AI(live.room_play 有開嗎?)";

/** What the seated AI is doing, in words. */
export function describeSeat(s: SeatStatus): string {
  const lines: string[] = [];
  if (s.problem) lines.push("AI 現在不能上場(帳號或伺服器不對,看直播機的終端機)。");
  else if (s.playing) lines.push(`AI 正在打:${md(s.playing.map)}`);
  else if (s.map) lines.push(`AI ${s.ready ? "準備好了" : "還不能打"}:${md(s.map)}`);
  else lines.push("AI 在等選譜");
  lines.push(s.room ? `在多人房裡${s.room_id ? `(房間 ${s.room_id})` : ""}。` : "不在多人房。");
  if (s.last && s.last.accuracy !== null && s.last.accuracy !== undefined) {
    const miss = s.last.misses ? `,miss ${s.last.misses}` : "";
    lines.push(`上一首:${md(s.last.map)} ${Number(s.last.accuracy).toFixed(2)}%${miss}`);
  }
  return lines.join("\n");
}

/**
 * `/queue osu status | join | leave`: the AI seated at the stream's lazer (osu_rl live.room_play). It plays rooms, and
 * maps started there by hand, from the screen with the vision student; join takes it into a room, where it readies
 * up by itself every round, and leave takes it out.
 */
export async function registerSeatCommands(
  ctx: ExtensionContext,
  seat: Http,
  permissions: { status: string; room: string },
): Promise<void> {
  await ctx.commands.register({
    path: "queue osu status",
    description: "看直播上的 osu! AI 在做什麼:正在打哪張、在不在多人房、上一首打多少",
    permission: permissions.status,
    async run() {
      const r = await seat("GET", "/status");
      return r.ok
        ? describeSeat(r.data as unknown as SeatStatus)
        : { text: r.error, ephemeral: true };
    },
  });

  await ctx.commands.register({
    path: "queue osu join",
    description: "讓 osu! AI 進多人房跟大家一起打(它會自己按準備,每一輪都打)",
    args: [
      { name: "room", description: "房間 id(房間連結最後的數字)", type: "integer" },
      { name: "password", description: "房間密碼(有的話)", required: false },
    ],
    permission: permissions.room,
    async run(inv: Invocation) {
      const body: Record<string, unknown> = { room_id: Number(inv.args.room) };
      if (typeof inv.args.password === "string" && inv.args.password)
        body.password = inv.args.password;
      const r = await seat("POST", "/join", body);
      if (!r.ok) return { text: `沒辦法進房:${r.error}`, ephemeral: true };
      return `AI 進了房間 ${r.data.room_id ?? body.room_id},譜下載好就會自己按準備。`;
    },
  });

  await ctx.commands.register({
    path: "queue osu leave",
    description: "讓 osu! AI 離開多人房",
    permission: permissions.room,
    async run() {
      const r = await seat("POST", "/leave");
      if (!r.ok) return { text: `沒辦法離開:${r.error}`, ephemeral: true };
      return "AI 離開房間了。";
    },
  });
}
