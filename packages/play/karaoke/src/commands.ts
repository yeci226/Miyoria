// Karaoke on Discord: `/me play karaoke` (the path is `me karaoke`, which Discord shows under
// `/me play`, see `SLASH_REGROUP`) and the room notices in the comment channel. No new top-level
// command: one entry beside the coin commands that tells the caller, only them, where karaoke is
// (a link to the member site when `site_url` is set), whether it is open to them, their coins, what
// a room costs and pays, the rooms open now with a link to each (theirs first, with its queue),
// and lets them open a room and pick songs. Singing is on the member page; Discord only points
// there.
//
// - 開房 (on the notice, only when the caller may open one now and has the coins): an ephemeral
//   confirmation with the price and their coins; nothing is charged before 確定. 確定 opens the
//   room through `RoomDesk.open`, the web's own path (same charge, same refusals, one opening per
//   person at a time), and the confirmation turns into the room's code and a link to it.
// - `song:` (a link or words, or a ready song picked from the suggestions, `id:<song>`): in a room,
//   it is queued there; otherwise it is only asked for (prepared into the shared list). No coins.
//
// Every answer is a neutral system card; names and titles are people's and are escaped.

import {
  type AnyComponentRoute,
  ArgKind,
  argSpec,
  type CardBlock,
  type CardButton,
  type Choice,
  type CommandRegistry,
  type CommandReply,
  ComponentResult,
  cancelled,
  cardReply,
  commandSpec,
  componentId,
  type Invocation,
  notice,
  typedCommand,
} from "@miyoria/commands";
import type { KaraokeRooms, KaraokeSongView } from "@miyoria/contracts/api";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { type KaraokeConfig, siteLink } from "./config.js";
import type { RoomBrief, RoomDesk, RoomNotice } from "./rooms.js";
import { KaraokeError, type KaraokeService } from "./service.js";

const log = getLogger("karaoke.commands");

export const PATHS = ["me karaoke"] as const;

/** The coin commands' node: a role without it, like `blocked`, cannot take part. */
const NODE = "me.wallet";
/** A panel admin (the panel's own node): karaoke is open to them while it is closed to members. */
const PANEL_ACCESS = "admin.panel.access";
const OFF = "唱 K 現在沒有開";
const FAILED = "唱 K 現在打不開,等一下再試";
const TITLE = "唱 K";

/** The routes of the notice's 開房 and its confirmation. */
export const ROUTES = {
  open: "karaoke:room:open",
  yes: "karaoke:room:yes",
  no: "karaoke:room:no",
} as const;
/** A confirmation's buttons stay usable this long. */
const CONFIRM_TTL_MS = 2 * 60_000;
/** A suggestion's value: a song picked from the list, not words typed. */
export const SONG_ID = "id:";
/** Entries of the caller's room's queue the notice shows. */
const QUEUE_SHOWN = 5;
/** Discord shows at most 25 suggestions. */
const MAX_CHOICES = 25;

/** The song worker's stages while it prepares a song, as short words (as on the member page). */
const STAGE_WORDS: Readonly<Record<string, string>> = {
  queued: "排隊中",
  resolve: "下載中",
  download: "下載中",
  separate: "分離人聲",
  lead: "分出主唱",
  reference: "抓旋律",
  encode: "做伴唱帶",
  lyrics: "找歌詞",
};

/** Display names come from people: no Markdown in them. */
export function md(text: string): string {
  return text.replace(/[\\*_`~|>#[\]()<@]/g, (c) => `\\${c}`);
}

const roomPath = (code: string) => `/karaoke/room/${encodeURIComponent(code)}`;
const songTitle = (title: string) => `「${md(title.slice(0, 80))}」`;

/** One room's line: its code, the song (or none yet), how many sing. */
function briefLine(room: RoomBrief): string {
  const song = room.song === null ? "還沒選歌" : `「${md(room.song.slice(0, 60))}」`;
  const state =
    room.state === "countdown" || room.state === "singing"
      ? "　正在唱"
      : room.state === "results"
        ? "　剛唱完一首"
        : "";
  return `**${room.code}**　${song}　${room.singers} / ${room.max_singers} 人唱${state}`;
}

/** The next few songs of a room's queue: title, who added it, preparing / failed marks. */
function queueBlocks(room: RoomBrief, command: string): CardBlock[] {
  if (room.queue.length === 0) {
    return [{ type: "muted", text: `還沒有人點歌:用 \`${command} song:\` 點一首。` }];
  }
  const lines = room.queue.slice(0, QUEUE_SHOWN).map((e, i) => {
    const mark = e.state === "preparing" ? "　準備中" : e.state === "failed" ? "　準備失敗" : "";
    return `${i + 1}. ${songTitle(e.title)}　${md(e.by.slice(0, 40))}${mark}`;
  });
  const more = room.queue.length - QUEUE_SHOWN;
  if (more > 0) lines.push(`還有 ${more} 首`);
  return [{ type: "text", text: `**點歌**\n${lines.join("\n")}` }];
}

export interface KaraokeNoticeInput {
  config: Pick<KaraokeConfig, "site_url" | "open">;
  overview: KaraokeRooms;
  rooms: readonly RoomBrief[];
  /** The caller is a panel admin (karaoke is theirs to try while closed). */
  admin: boolean;
  /** What the caller types for this command on their platform (`/me play karaoke` on Discord). */
  command: string;
}

/** The caller may open a room now: it is open to them, they are in none, they have the coins. */
export function mayOpen(overview: KaraokeRooms): boolean {
  if (!overview.available || overview.mine !== null) return false;
  const price = overview.terms.price;
  return price <= 0 || (overview.balance !== null && overview.balance >= price);
}

/** The answer of `/me play karaoke` (only the caller sees it). */
export function karaokeNotice(input: KaraokeNoticeInput): CommandReply {
  const { config, overview, rooms, admin, command } = input;
  const blocks: CardBlock[] = [];
  const mine =
    overview.mine === null ? null : (rooms.find((r) => r.code === overview.mine) ?? null);
  if (mine !== null) {
    const url = siteLink(config, roomPath(mine.code));
    const text = `你在房間裡:${briefLine(mine)}`;
    blocks.push(
      url === null
        ? { type: "text", text }
        : { type: "section", text, button: { id: "", label: "回到房間", url } },
    );
    blocks.push(...queueBlocks(mine, command));
  }
  if (!config.open && admin) {
    blocks.push({ type: "text", text: "唱 K 還沒開放,只有管理員能用。" });
  } else if (!config.open) {
    blocks.push({ type: "text", text: "唱 K 現在沒有開放。" });
  }
  if (overview.available) {
    if (mine === null)
      blocks.push({ type: "text", text: "現在可以開房間,或用房號加入別人的房間。" });
  } else if (overview.reason !== null && (config.open || admin)) {
    blocks.push({ type: "text", text: `現在不能開房間:${overview.reason}。` });
  }
  const t = overview.terms;
  blocks.push({
    type: "text",
    text:
      overview.balance === null
        ? `你的${t.currency}現在看不到(她還不認識你,或錢包暫時打不開)。`
        : `你有 **${overview.balance}** ${t.currency}。`,
  });
  blocks.push({
    type: "muted",
    text: `開房 ${t.price} ${t.currency},一間包 ${t.rounds} 首、最多 ${t.max_singers} 人一起唱;每一首第一名 +${t.prize}、唱完 +${t.finish};一首都沒唱完就全退。`,
  });
  const others = rooms.filter((r) => r.code !== mine?.code);
  if (config.open || admin) {
    blocks.push({ type: "separator" });
    if (others.length === 0) {
      blocks.push({ type: "muted", text: "現在沒有其他開著的房間。" });
    } else {
      blocks.push({ type: "text", text: "**開著的房間**" });
      for (const room of others.slice(0, 10)) {
        const url = siteLink(config, roomPath(room.code));
        const text = briefLine(room);
        blocks.push(
          url === null
            ? { type: "text", text }
            : { type: "section", text, button: { id: "", label: "加入", url } },
        );
      }
    }
  }
  const buttons: CardButton[] = [];
  if (mayOpen(overview)) {
    buttons.push({ id: componentId(ROUTES.open), label: "開房", style: "primary" });
  }
  const page = siteLink(config, "/karaoke");
  if (page === null) {
    blocks.push({
      type: "muted",
      text: "唱 K 在會員頁的「唱 K」(/karaoke),用 Discord 登入就能用。",
    });
  } else {
    buttons.push({ id: "", label: "打開唱 K", url: page });
  }
  if (buttons.length > 0) blocks.push({ type: "buttons", buttons });
  return cardReply(blocks, { accent: "neutral", title: TITLE, ephemeral: true });
}

/** The confirmation before a room is opened: its price and the caller's coins, nothing charged. */
export function openConfirm(overview: KaraokeRooms): CommandReply {
  const t = overview.terms;
  const cost =
    t.price <= 0
      ? `開房不用${t.currency}`
      : `開房要 ${t.price} ${t.currency}${overview.balance === null ? "" : `,你有 ${overview.balance}`}`;
  return cardReply(
    [
      { type: "text", text: `${cost},確定?` },
      {
        type: "muted",
        text: `一間包 ${t.rounds} 首、最多 ${t.max_singers} 人一起唱;一首都沒唱完就全退。`,
      },
      {
        type: "buttons",
        buttons: [
          { id: componentId(ROUTES.yes), label: "確定", style: "primary" },
          { id: componentId(ROUTES.no), label: "取消", style: "secondary" },
        ],
      },
    ],
    {
      accent: "neutral",
      title: TITLE,
      ephemeral: true,
      // Only the one who pressed 開房 may confirm, and not after a while.
      session: { ttlMs: CONFIRM_TTL_MS, initiatorOnly: true },
    },
  );
}

/** What a confirmation turns into once the room is open: its code and where it is. */
export function openedCard(
  config: Pick<KaraokeConfig, "site_url">,
  code: string,
  command: string,
): CommandReply {
  const url = siteLink(config, roomPath(code));
  const blocks: CardBlock[] = [
    { type: "text", text: `房間開好了,房號 **${code}**。` },
    {
      type: "muted",
      text:
        url === null
          ? `到會員頁的「唱 K」(/karaoke)就會看到你的房間;點歌也可以用 \`${command} song:\`。`
          : `進房間後點歌,大家一起唱;點歌也可以用 \`${command} song:\`。`,
    },
  ];
  if (url !== null) {
    blocks.push({ type: "buttons", buttons: [{ id: "", label: "進房間", url }] });
  }
  return cardReply(blocks, { accent: "neutral", title: TITLE, ephemeral: true });
}

/** A room's notice in the comment channel: its code and a 「加入」 link; 「已結束」 once closed. */
export function roomNotice(
  config: Pick<KaraokeConfig, "site_url">,
  room: RoomNotice,
): CommandReply {
  if (room.state === "ended") {
    return cardReply(
      [
        {
          type: "text",
          text: `唱 K 房間 **${room.code}** 已結束。`,
        },
        ...(room.reason === null ? [] : [{ type: "muted" as const, text: room.reason }]),
      ],
      { accent: "neutral", title: TITLE },
    );
  }
  const text = `${md(room.opener)} 開了一間唱 K 房間,房號 **${room.code}**。進房間再點歌,大家一起唱。`;
  const url = siteLink(config, roomPath(room.code));
  const blocks: CardBlock[] =
    url === null
      ? [
          { type: "text", text },
          { type: "muted", text: "在會員頁的「唱 K」輸入房號加入。" },
        ]
      : [
          { type: "text", text },
          { type: "buttons", buttons: [{ id: "", label: "加入", url }] },
        ];
  return cardReply(blocks, { accent: "neutral", title: TITLE });
}

/** A refusal in the service's own words; anything else is logged and said plainly. */
function refusal(error: unknown, what: string): CommandReply {
  if (error instanceof KaraokeError) {
    return notice(error.status >= 500 ? "warn" : "info", error.message);
  }
  log.warn({ error: errorMessage(error) }, `${what} failed`);
  return notice("warn", FAILED);
}

/** How far a song being prepared is: its stage, and how many wait before it. */
function stageText(song: KaraokeSongView): string {
  const word = (song.stage ? STAGE_WORDS[song.stage] : undefined) ?? "準備中";
  return song.position !== null && song.position > 0
    ? `${word}(前面還有 ${song.position} 首)`
    : word;
}

/** A song picked from the suggestions (`id:<song>`), else `null` (words or a link). */
function pickedSong(raw: string): string | null {
  if (!raw.startsWith(SONG_ID)) return null;
  const id = raw.slice(SONG_ID.length).trim();
  return id === "" ? null : id;
}

/** `song:` in a room: queued there, with its place and a link back to the room. */
function queuedCard(
  config: Pick<KaraokeConfig, "site_url">,
  view: Awaited<ReturnType<RoomDesk["queueAdd"]>>,
): CommandReply {
  // The entry just added is the caller's last; its place counts the songs still to be sung.
  const waiting = view.queue.filter((e) => e.song.state !== "failed");
  const at = waiting.findLastIndex((e) => e.mine);
  const entry = at < 0 ? null : (waiting[at] ?? null);
  const blocks: CardBlock[] = [];
  if (entry === null) {
    blocks.push({ type: "text", text: `點好了,在房間 **${view.code}** 的點歌清單裡。` });
  } else {
    blocks.push({
      type: "text",
      text: `點好了:${songTitle(entry.song.title)},在房間 **${view.code}** 排第 ${at + 1} 首。`,
    });
    if (entry.song.state === "preparing") {
      blocks.push({
        type: "muted",
        text: `這首還在準備(${stageText(entry.song)}),準備好才會輪到。`,
      });
    }
  }
  const url = siteLink(config, roomPath(view.code));
  if (url !== null) {
    blocks.push({ type: "buttons", buttons: [{ id: "", label: "回到房間", url }] });
  }
  return cardReply(blocks, { accent: "neutral", title: TITLE, ephemeral: true });
}

/** `song:` outside a room: the song asked for (prepared into the shared list), and the page. */
function requestedCard(
  config: Pick<KaraokeConfig, "site_url">,
  song: KaraokeSongView,
  created: boolean,
): CommandReply {
  const title = songTitle(song.title);
  const text =
    song.state === "ready"
      ? `${title}已經準備好了,在唱 K 的歌單裡。`
      : song.state === "failed"
        ? `${title}準備失敗了${song.error ? `:${song.error}` : "。"}`
        : created
          ? `開始準備${title}了:${stageText(song)}。準備好就會在唱 K 的歌單裡。`
          : `${title}正在準備:${stageText(song)}。`;
  const blocks: CardBlock[] = [
    { type: "text", text },
    { type: "muted", text: "你現在不在房間裡:這首只放進歌單,進房間後再點。" },
  ];
  const page = siteLink(config, "/karaoke");
  if (page !== null) {
    blocks.push({ type: "buttons", buttons: [{ id: "", label: "打開唱 K", url: page }] });
  }
  return cardReply(blocks, { accent: "neutral", title: TITLE, ephemeral: true });
}

export interface KaraokeCommandDeps {
  rooms: () => RoomDesk | null;
  config: () => KaraokeConfig;
  /** The song list (asking for songs, the suggestions); without it only a room's queue works. */
  service: () => KaraokeService | null;
}

async function answer(inv: Invocation, d: KaraokeCommandDeps): Promise<CommandReply> {
  const desk = d.rooms();
  if (desk === null) return notice("info", OFF);
  const command = typedCommand("me karaoke", inv.invoker.platform);
  try {
    const admin = await inv.allowed(PANEL_ACCESS);
    const raw = inv.str("song")?.trim() ?? "";
    if (raw !== "") return await songAnswer(inv, d, desk, raw, admin);
    // The rooms of the server it was asked in (a DM: the primary's), and their own wherever it is.
    const space = desk.spaceAt(inv.context);
    const overview = await desk.overview(inv.invoker, admin, space);
    const rooms = desk.briefs(space);
    const own = desk.briefs().find((r) => r.code === overview.mine);
    if (own !== undefined && !rooms.some((r) => r.code === own.code)) rooms.unshift(own);
    return karaokeNotice({
      config: d.config(),
      overview,
      rooms,
      admin,
      command,
    });
  } catch (error) {
    return refusal(error, "/me play karaoke");
  }
}

async function songAnswer(
  inv: Invocation,
  d: KaraokeCommandDeps,
  desk: RoomDesk,
  raw: string,
  admin: boolean,
): Promise<CommandReply> {
  const config = d.config();
  const picked = pickedSong(raw);
  const { mine } = await desk.overview(inv.invoker, admin);
  if (mine !== null) {
    const body = picked === null ? { text: raw } : { song: picked };
    const view = await desk.queueAdd(mine, inv.invoker, inv.invoker_display_name, body, admin);
    return queuedCard(config, view);
  }
  const service = d.service();
  if (service === null) return notice("info", OFF);
  if (picked !== null) {
    service.openFor(admin);
    return requestedCard(config, service.song(inv.invoker, picked), false);
  }
  const asked = await service.request(inv.invoker, raw, admin);
  return requestedCard(config, asked.song, asked.created);
}

/** The ready songs matching what was typed (title · artist), each by its id. */
async function suggestions(
  inv: Invocation,
  d: KaraokeCommandDeps,
  typed: string,
): Promise<Choice[]> {
  const service = d.service();
  if (service === null) return [];
  const admin = await inv.allowed(PANEL_ACCESS);
  if (!d.config().open && !admin) return [];
  let songs: KaraokeSongView[];
  try {
    songs = service.overview(inv.invoker, admin).songs;
  } catch {
    return [];
  }
  const words = typed
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((w) => w !== "");
  return songs
    .filter((s) => s.state === "ready")
    .map((s) => ({ s, name: s.artist ? `${s.title} · ${s.artist}` : s.title }))
    .filter(({ name }) => words.every((w) => name.toLowerCase().includes(w)))
    .slice(0, MAX_CHOICES)
    .map(({ s, name }) => ({ name: name.slice(0, 100), value: `${SONG_ID}${s.id}` }));
}

function routes(d: KaraokeCommandDeps): AnyComponentRoute[] {
  return [
    {
      // 開房 on the notice: checked again now, then only a confirmation (nothing is charged).
      route: ROUTES.open,
      ephemeral: true,
      handle: async (inv) => {
        const desk = d.rooms();
        if (desk === null) return ComponentResult.reply(notice("info", OFF));
        try {
          const admin = await inv.allowed(PANEL_ACCESS);
          const overview = await desk.overview(inv.invoker, admin, desk.spaceAt(inv.context));
          if (!overview.available) {
            return ComponentResult.reply(notice("info", overview.reason ?? OFF));
          }
          if (overview.mine !== null) {
            return ComponentResult.reply(
              notice("info", `你已經在房間 **${overview.mine}** 裡了。`),
            );
          }
          const t = overview.terms;
          if (t.price > 0 && overview.balance !== null && overview.balance < t.price) {
            return ComponentResult.reply(
              notice("info", `開房要 ${t.price} ${t.currency},你有 ${overview.balance}`),
            );
          }
          // A stranger (no coins to see) still gets the confirmation: the wallet refuses them.
          return ComponentResult.reply(openConfirm(overview));
        } catch (error) {
          return ComponentResult.reply(refusal(error, "karaoke: 開房"));
        }
      },
    },
    {
      // 確定: the web's own opening (one per person at a time); the confirmation becomes the room.
      // A refusal is a new notice: the message may already be the room (a second press).
      route: ROUTES.yes,
      ephemeral: true,
      requiresSession: true,
      handle: async (inv) => {
        const desk = d.rooms();
        if (desk === null) return ComponentResult.reply(notice("info", OFF));
        try {
          const admin = await inv.allowed(PANEL_ACCESS);
          const room = await desk.open(
            inv.invoker,
            inv.invoker_display_name,
            null,
            0,
            admin,
            desk.spaceAt(inv.context),
          );
          const command = typedCommand("me karaoke", inv.invoker.platform);
          return ComponentResult.update(openedCard(d.config(), room.code, command));
        } catch (error) {
          return ComponentResult.reply(refusal(error, "karaoke: opening a room"));
        }
      },
    },
    {
      route: ROUTES.no,
      ephemeral: true,
      handle: () => ComponentResult.update(cancelled()),
    },
  ];
}

/**
 * Registers `/me play karaoke`. `service` (the song list) is what `song:` asks songs of outside a
 * room and what its suggestions come from; left out, only a room's queue takes songs.
 */
export function registerCommands(
  registry: CommandRegistry,
  rooms: () => RoomDesk | null,
  config: () => KaraokeConfig,
  service: () => KaraokeService | null = () => null,
): void {
  const d: KaraokeCommandDeps = { rooms, config, service };
  registry.register(
    commandSpec("me karaoke", "唱 K:會員頁的連結、開著的房間、開房、點歌和你的魚幣", {
      args: [
        argSpec(
          "song",
          "點歌:貼連結、打歌名,或從清單選一首準備好的(在房間裡就點進房間)",
          ArgKind.string,
          { required: false },
        ),
      ],
      permission: NODE,
      ephemeral: true,
    }),
    (inv) => answer(inv, d),
    {
      components: routes(d),
      autocomplete: { song: (inv, typed) => suggestions(inv, d, typed) },
    },
  );
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
