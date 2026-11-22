// `/me play karaoke` and the room notices: the caller alone sees where karaoke is, whether it is
// open to them (a panel admin may use it while it is closed), their coins, the terms and the rooms
// open now with links (theirs first, with its queue); without `site_url` there are no links, only
// where to go. 開房 asks first and charges nothing until 確定, which opens the room the web's way
// (once, however often it is pressed); `song:` queues in the caller's room or asks for the song.

import { rm } from "node:fs/promises";
import {
  type CardBlock,
  type CardButton,
  CommandRegistry,
  type CommandReply,
  type ComponentOutcome,
  componentId,
  Permissions,
  splitPath,
} from "@miyoria/commands";
import type { AccountRef, ContextKey } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROUTES,
  registerCommands,
  roomNotice,
  SONG_ID,
  unregisterCommands,
} from "../src/commands.js";
import { commentContext, type KaraokeConfig, KaraokeConfigSchema } from "../src/config.js";
import type { RoomDesk } from "../src/rooms.js";
import type { KaraokeService } from "../src/service.js";
import { ALICE, BOB, CAROL, makeRig, type Rig, STRANGER } from "./room-rig.js";

const SITE = "https://karaoke.example.com";
/** A panel admin (the owner here): not one of the people she knows. */
const ADMIN: AccountRef = { platform: "discord", id: "77" };
const ctx: ContextKey = { platform: "discord", scope: "111111", channel: "100", kind: "channel" };

const rigs: Rig[] = [];
async function rigWith(overrides: Partial<KaraokeConfig> = {}): Promise<Rig> {
  const r = await makeRig({ site_url: SITE, ...overrides });
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.raw.close();
    await rm(r.dir, { recursive: true, force: true });
  }
});

function registryWith(
  desk: RoomDesk | null,
  config: KaraokeConfig,
  service: KaraokeService | null = null,
  admins: readonly string[] = [ADMIN.id],
): CommandRegistry {
  const registry = new CommandRegistry(
    Permissions.fromStrings(admins.map((id) => `discord:${id}`)),
  );
  registerCommands(
    registry,
    () => desk,
    () => config,
    () => service,
  );
  return registry;
}

/** The registry with the rig's rooms and songs. */
const commandsOf = (r: Rig, admins?: readonly string[]) =>
  registryWith(r.desk, r.config, r.service, admins);

const NAMES: Record<string, string> = { "1": "Alice", "2": "Bob", "3": "Carol", "9": "Stranger" };

function run(
  registry: CommandRegistry,
  account: AccountRef,
  args: Record<string, string> = {},
): Promise<CommandReply> {
  return registry.dispatch({
    path: ["me", "karaoke"],
    args,
    invoker: account,
    invoker_display_name: NAMES[account.id] ?? "x",
    context: ctx,
    invoker_is_guild_admin: false,
  });
}

/** A press of one of the notice's or the confirmation's buttons; `session`: whose message it is. */
async function press(
  registry: CommandRegistry,
  account: AccountRef,
  route: string,
  session: AccountRef | null = account,
): Promise<ComponentOutcome> {
  const outcome = await registry.dispatchComponent({
    custom_id: componentId(route),
    invoker: account,
    invoker_display_name: NAMES[account.id] ?? "x",
    context: ctx,
    invoker_is_guild_admin: false,
    message_id: "m1",
    session: session === null ? null : { initiator: session, initiator_only: true, data: null },
  });
  if (outcome === null) throw new Error("not ours");
  return outcome;
}

const replyOf = (outcome: ComponentOutcome): CommandReply => {
  if (outcome.result.type === "modal") throw new Error("a modal");
  return outcome.result.reply;
};

function suggest(registry: CommandRegistry, account: AccountRef, typed: string) {
  return registry.autocomplete(
    {
      path: ["me", "karaoke"],
      args: {},
      invoker: account,
      invoker_display_name: "x",
      context: ctx,
      invoker_is_guild_admin: false,
    },
    "song",
    typed,
  );
}

const blocks = (reply: CommandReply): CardBlock[] => reply.card?.blocks ?? [];
const buttons = (reply: CommandReply): CardButton[] =>
  blocks(reply).flatMap((b) =>
    b.type === "section" ? [b.button] : b.type === "buttons" ? b.buttons : [],
  );
/** The link buttons. */
const links = (reply: CommandReply): CardButton[] =>
  buttons(reply).filter((b) => b.url !== undefined);
const openButton = (reply: CommandReply): CardButton | undefined =>
  buttons(reply).find((b) => b.id === componentId(ROUTES.open));
/** What the rig's wallet took for rooms from `person`. */
const charged = (r: Rig, person: string) => r.wallet.of(person, "karaoke_room");

describe("/me play karaoke", () => {
  it("is under /me play on Discord and answers only the caller", async () => {
    const r = await rigWith();
    const registry = registryWith(r.desk, r.config);
    expect(registry.slashPath(splitPath("me karaoke"))).toEqual(["me", "play", "karaoke"]);
    const reply = await run(registry, BOB);
    expect(reply.ephemeral).toBe(true);
    expect(reply.card?.accent).toBe("neutral");
    unregisterCommands(registry);
    expect((await run(registry, BOB)).text).toContain("找不到指令");
  });

  it("links the page, says it is open, shows the coins, the terms and the rooms to join", async () => {
    const r = await rigWith();
    const room = await r.desk.open(ALICE, "Alice", r.songId, 0);
    const reply = await run(registryWith(r.desk, r.config), BOB);
    expect(reply.text).toContain("現在可以開房間");
    expect(reply.text).toContain("你有 **100** 魚幣");
    expect(reply.text).toContain("開房 20 魚幣,一間包 4 首、最多 8 人一起唱");
    expect(reply.text).toContain(`**${room.code}**`);
    expect(reply.text).toContain("1 / 8 人唱");
    expect(links(reply)).toEqual([
      { id: "", label: "加入", url: `${SITE}/karaoke/room/${room.code}` },
      { id: "", label: "打開唱 K", url: `${SITE}/karaoke` },
    ]);
  });

  it("leads with the caller's own room", async () => {
    const r = await rigWith();
    const room = await r.desk.open(ALICE, "Alice", r.songId, 0);
    const reply = await run(registryWith(r.desk, r.config), ALICE);
    const first = blocks(reply)[0];
    expect(first?.type).toBe("section");
    if (first?.type === "section") {
      expect(first.text).toContain(`你在房間裡:**${room.code}**`);
      expect(first.button).toMatchObject({
        label: "回到房間",
        url: `${SITE}/karaoke/room/${room.code}`,
      });
    }
    // Not listed again among the others.
    expect(reply.text).toContain("現在沒有其他開著的房間");
    expect(reply.text).toContain("你有 **80** 魚幣");
  });

  it("says it is closed to members, and open to a panel admin to try", async () => {
    const r = await rigWith({ open: false });
    const admin = await r.desk.open(ADMIN, "Admin", r.songId, 0, true).catch(() => null);
    // The admin is not someone she knows: the wallet refuses them a room that costs.
    expect(admin).toBeNull();
    const member = await run(registryWith(r.desk, r.config), BOB);
    expect(member.text).toContain("唱 K 現在沒有開放");
    expect(member.text).not.toContain("開著的房間");
    expect(member.text).not.toContain("現在可以開房間");
    const tried = await run(registryWith(r.desk, r.config), ADMIN);
    expect(tried.text).toContain("唱 K 還沒開放,只有管理員能用");
    expect(tried.text).toContain("現在可以開房間");
    expect(tried.text).toContain("現在看不到");
  });

  it("says why no room can be opened now", async () => {
    const r = await rigWith();
    r.voice.on = false;
    const reply = await run(registryWith(r.desk, r.config), BOB);
    expect(reply.text).toContain("現在不能開房間:她要在語音頻道裡才能開房間");
  });

  it("without site_url says where the page is, with no links", async () => {
    const r = await rigWith({ site_url: "" });
    await r.desk.open(ALICE, "Alice", r.songId, 0);
    const reply = await run(registryWith(r.desk, r.config), BOB);
    expect(links(reply)).toEqual([]);
    expect(reply.text).toContain("唱 K 在會員頁的「唱 K」(/karaoke)");
  });

  it("says so without the karaoke module", async () => {
    const r = await rigWith();
    expect((await run(registryWith(null, r.config), BOB)).text).toContain("沒有開");
  });
});

describe("/me play karaoke: the caller's room's queue", () => {
  it("shows the next songs with who added them and which are still being prepared", async () => {
    const r = await rigWith();
    const room = await r.desk.open(ALICE, "Alice *A*", r.songId, 0);
    await r.desk.queueAdd(room.code, ALICE, "Alice", { text: "https://youtu.be/next" });
    const title = r.service.songView(r.songId)?.title as string;
    const reply = await run(commandsOf(r), ALICE);
    const queue = blocks(reply)[1];
    expect(queue?.type).toBe("text");
    if (queue?.type === "text") {
      expect(queue.text).toContain("**點歌**");
      expect(queue.text).toContain(`1. 「${title}」　Alice \\*A\\*`);
      expect(queue.text).toMatch(/2\. 「.+」　Alice \\\*A\\\*　準備中/u);
    }
    // In a room: no 開房.
    expect(openButton(reply)).toBeUndefined();
  });

  it("says how to pick a song when the queue is empty", async () => {
    const r = await rigWith();
    await r.desk.open(ALICE, "Alice", null, 0);
    const reply = await run(commandsOf(r), ALICE);
    expect(reply.text).toContain("還沒有人點歌:用 `/me play karaoke song:` 點一首");
  });
});

describe("/me play karaoke: 開房", () => {
  it("is offered only to one who may open a room now and has the coins", async () => {
    const r = await rigWith();
    const registry = commandsOf(r);
    expect(openButton(await run(registry, BOB))).toMatchObject({ label: "開房", style: "primary" });
    // Too few coins, a stranger (no coins to see), not in voice: no button.
    r.wallet.balances.set("p-carol", 19);
    expect(openButton(await run(registry, CAROL))).toBeUndefined();
    expect(openButton(await run(registry, STRANGER))).toBeUndefined();
    r.voice.on = false;
    expect(openButton(await run(registry, BOB))).toBeUndefined();
  });

  it("asks first and charges nothing, then opens the room once and links it", async () => {
    const r = await rigWith();
    const registry = commandsOf(r);
    const asked = await press(registry, BOB, ROUTES.open, null);
    expect(asked.result.type).toBe("reply");
    expect(asked.ephemeral).toBe(true);
    const confirm = replyOf(asked);
    expect(confirm.text).toContain("開房要 20 魚幣,你有 100,確定?");
    expect(confirm.session).toMatchObject({ initiatorOnly: true });
    expect(buttons(confirm).map((b) => [b.label, b.id])).toEqual([
      ["確定", componentId(ROUTES.yes)],
      ["取消", componentId(ROUTES.no)],
    ]);
    // Nothing taken, no room.
    expect(charged(r, "p-bob")).toEqual([]);
    expect(r.desk.briefs()).toEqual([]);

    const done = await press(registry, BOB, ROUTES.yes);
    expect(done.result.type).toBe("update");
    const code = r.desk.briefs()[0]?.code as string;
    expect(code).toMatch(/^[A-Z2-9]{6}$/u);
    const card = replyOf(done);
    expect(card.text).toContain(`房間開好了,房號 **${code}**`);
    expect(links(card)).toEqual([{ id: "", label: "進房間", url: `${SITE}/karaoke/room/${code}` }]);
    expect(charged(r, "p-bob")).toEqual([-20]);
    expect((await r.desk.overview(BOB)).mine).toBe(code);
    // The channel's notice, as for any room.
    expect(r.notices.map((n) => n.notice)).toEqual([
      { code, opener: "Bob", state: "open", reason: null },
    ]);
  });

  it("opens and charges once for two presses at the same time and a press later", async () => {
    const r = await rigWith();
    const registry = commandsOf(r);
    const both = await Promise.all([
      press(registry, BOB, ROUTES.yes),
      press(registry, BOB, ROUTES.yes),
    ]);
    expect(both.map((o) => o.result.type).sort()).toEqual(["reply", "update"]);
    const refused = replyOf(both.find((o) => o.result.type === "reply") as ComponentOutcome);
    expect(refused.text).toMatch(/正在開房,等一下|你已經在另一間房間裡了/u);
    expect(r.desk.briefs()).toHaveLength(1);
    expect(charged(r, "p-bob")).toEqual([-20]);
    // A stale confirmation pressed again: the caller is in a room already.
    const later = await press(registry, BOB, ROUTES.yes);
    expect(later.result.type).toBe("reply");
    expect(replyOf(later).text).toContain("你已經在另一間房間裡了");
    expect(charged(r, "p-bob")).toEqual([-20]);
    expect(r.desk.briefs()).toHaveLength(1);
  });

  it("only the one who pressed 開房 may confirm, and only while the confirmation lasts", async () => {
    const r = await rigWith();
    const registry = commandsOf(r);
    const other = await press(registry, CAROL, ROUTES.yes, BOB);
    expect(replyOf(other).text).toContain("只有執行指令的人");
    const expired = await press(registry, BOB, ROUTES.yes, null);
    expect(replyOf(expired).text).toContain("已過期");
    expect(r.wallet.rows).toEqual([]);
    expect(r.desk.briefs()).toEqual([]);
  });

  it("取消 cancels and charges nothing", async () => {
    const r = await rigWith();
    const registry = commandsOf(r);
    const out = await press(registry, BOB, ROUTES.no);
    expect(out.result.type).toBe("update");
    expect(replyOf(out).text).toContain("已取消。");
    expect(r.wallet.rows).toEqual([]);
    expect(r.desk.briefs()).toEqual([]);
  });

  it("refuses in the service's words: not in voice, closed, too few coins, a stranger, in a room", async () => {
    const r = await rigWith();
    const registry = commandsOf(r);
    // Not in voice: at the press, and at 確定 on a confirmation from before.
    r.voice.on = false;
    expect(replyOf(await press(registry, BOB, ROUTES.open, null)).text).toContain(
      "她要在語音頻道裡才能開房間",
    );
    expect(replyOf(await press(registry, BOB, ROUTES.yes)).text).toContain(
      "她要在語音頻道裡才能開房間",
    );
    r.voice.on = true;
    // Too few coins.
    r.wallet.balances.set("p-carol", 5);
    expect(replyOf(await press(registry, CAROL, ROUTES.open, null)).text).toContain(
      "開房要 20 魚幣,你有 5",
    );
    expect(replyOf(await press(registry, CAROL, ROUTES.yes)).text).toContain(
      "開房要 20 魚幣,你有 5",
    );
    // A stranger: asked (no coins to show), then refused by the wallet.
    expect(replyOf(await press(registry, STRANGER, ROUTES.open, null)).text).toContain(
      "開房要 20 魚幣,確定?",
    );
    expect(replyOf(await press(registry, STRANGER, ROUTES.yes)).text).toContain("她還不認識你");
    // In a room already.
    const room = await r.desk.open(ALICE, "Alice", null, 0);
    expect(replyOf(await press(registry, ALICE, ROUTES.open, null)).text).toContain(
      `你已經在房間 **${room.code}** 裡了`,
    );
    expect(r.desk.briefs()).toHaveLength(1);
    expect(charged(r, "p-carol")).toEqual([]);
    expect(charged(r, "p-alice")).toEqual([-20]);
  });

  it("is closed to members while karaoke is, and open to a panel admin to try", async () => {
    const r = await rigWith({ open: false });
    // Alice is a panel admin here (and someone she knows, with coins).
    const registry = commandsOf(r, [ALICE.id]);
    expect(openButton(await run(registry, BOB))).toBeUndefined();
    expect(replyOf(await press(registry, BOB, ROUTES.open, null)).text).toContain(
      "現在沒有開放唱 K",
    );
    expect(replyOf(await press(registry, BOB, ROUTES.yes)).text).toContain("現在沒有開放唱 K");
    expect(charged(r, "p-bob")).toEqual([]);
    const notice = await run(registry, ALICE);
    expect(notice.text).toContain("只有管理員能用");
    expect(openButton(notice)).toBeDefined();
    expect(replyOf(await press(registry, ALICE, ROUTES.open, null)).text).toContain("確定?");
    expect((await press(registry, ALICE, ROUTES.yes)).result.type).toBe("update");
    expect(charged(r, "p-alice")).toEqual([-20]);
  });

  it("without site_url says where the room is, with no link", async () => {
    const r = await rigWith({ site_url: "" });
    const card = replyOf(await press(commandsOf(r), BOB, ROUTES.yes));
    expect(links(card)).toEqual([]);
    expect(card.text).toContain("到會員頁的「唱 K」(/karaoke)就會看到你的房間");
  });
});

describe("/me play karaoke song:", () => {
  it("suggests the ready songs, by id, filtered by what was typed", async () => {
    const r = await rigWith();
    // A song still being prepared is not suggested.
    await r.service.request(BOB, "https://youtu.be/other");
    const registry = commandsOf(r);
    const view = r.service.songView(r.songId) as NonNullable<
      ReturnType<KaraokeService["songView"]>
    >;
    const name = view.artist ? `${view.title} · ${view.artist}` : view.title;
    expect(await suggest(registry, BOB, "")).toEqual([{ name, value: `${SONG_ID}${r.songId}` }]);
    expect(await suggest(registry, BOB, view.title.slice(0, 2).toUpperCase())).toHaveLength(1);
    expect(await suggest(registry, BOB, "沒有這種歌")).toEqual([]);
  });

  it("suggests nothing to a member while karaoke is closed", async () => {
    const r = await rigWith({ open: false });
    expect(await suggest(commandsOf(r), BOB, "")).toEqual([]);
    expect(await suggest(commandsOf(r), ADMIN, "")).toHaveLength(1);
  });

  it("in a room queues there: a picked song, then a link, up to the limit; no coins", async () => {
    const r = await rigWith();
    const registry = commandsOf(r);
    const room = await r.desk.open(BOB, "Bob", null, 0);
    const title = r.service.songView(r.songId)?.title as string;
    const first = await run(registry, BOB, { song: `${SONG_ID}${r.songId}` });
    expect(first.ephemeral).toBe(true);
    expect(first.text).toContain(`點好了:「${title}」,在房間 **${room.code}** 排第 1 首`);
    expect(links(first)).toEqual([
      { id: "", label: "回到房間", url: `${SITE}/karaoke/room/${room.code}` },
    ]);
    const second = await run(registry, BOB, { song: "https://youtu.be/queued" });
    expect(second.text).toContain("排第 2 首");
    expect(second.text).toContain("這首還在準備(排隊中),準備好才會輪到");
    expect(r.worker.asked.at(-1)).toMatchObject({ url: "https://youtu.be/queued" });
    expect(r.desk.briefs()[0]?.queue.map((e) => e.state)).toEqual(["ready", "preparing"]);
    const third = await run(registry, BOB, { song: `${SONG_ID}${r.songId}` });
    expect(third.text).toContain("你已經點了 2 首在等,唱完再點");
    expect(r.desk.briefs()[0]?.queue).toHaveLength(2);
    // Only the room's opening was charged.
    expect(charged(r, "p-bob")).toEqual([-20]);
    expect(r.wallet.balances.get("p-bob")).toBe(80);
  });

  it("outside a room asks for the song: a link is prepared, a known one is said", async () => {
    const r = await rigWith();
    const registry = commandsOf(r);
    const asked = await run(registry, BOB, { song: "https://youtu.be/fresh" });
    expect(asked.text).toContain("開始準備「");
    expect(asked.text).toContain("排隊中");
    expect(asked.text).toContain("你現在不在房間裡");
    expect(links(asked)).toEqual([{ id: "", label: "打開唱 K", url: `${SITE}/karaoke` }]);
    expect(r.worker.asked.at(-1)).toMatchObject({ url: "https://youtu.be/fresh" });
    const again = await run(registry, BOB, { song: "https://youtu.be/fresh" });
    expect(again.text).toContain("正在準備:排隊中");
    expect(r.worker.asked.filter((q) => q.url === "https://youtu.be/fresh")).toHaveLength(1);
    const ready = await run(registry, BOB, { song: `${SONG_ID}${r.songId}` });
    expect(ready.text).toContain("已經準備好了,在唱 K 的歌單裡");
    expect(r.desk.briefs()).toEqual([]);
    expect(r.wallet.rows).toEqual([]);
  });

  it("refuses in the service's words: the daily limit, closed to a member, a stranger, no such song", async () => {
    const r = await rigWith({ daily_songs: 1 });
    const registry = commandsOf(r);
    await run(registry, BOB, { song: "https://youtu.be/one" });
    expect((await run(registry, BOB, { song: "https://youtu.be/two" })).text).toContain(
      "今天已經準備了 1 首(一天 1 首)",
    );
    expect((await run(registry, STRANGER, { song: "https://youtu.be/three" })).text).toContain(
      "她還不認識你",
    );
    expect((await run(registry, BOB, { song: `${SONG_ID}nope` })).text).toContain("沒有這首歌");
    const closed = await rigWith({ open: false });
    const shut = commandsOf(closed);
    expect((await run(shut, BOB, { song: "https://youtu.be/four" })).text).toContain(
      "現在沒有開放唱 K",
    );
    expect((await run(shut, BOB, { song: `${SONG_ID}${closed.songId}` })).text).toContain(
      "現在沒有開放唱 K",
    );
  });

  it("without the song list, a room still takes songs and nothing else does", async () => {
    const r = await rigWith();
    await r.desk.open(BOB, "Bob", null, 0);
    const registry = registryWith(r.desk, r.config, null);
    expect((await run(registry, BOB, { song: `${SONG_ID}${r.songId}` })).text).toContain(
      "排第 1 首",
    );
    expect((await run(registry, CAROL, { song: "https://youtu.be/x" })).text).toContain(
      "唱 K 現在沒有開",
    );
  });
});

describe("a room's notice in the comment channel", () => {
  it("has the code and a 「加入」 link, escapes the name, and says 「已結束」 at the end", () => {
    const open = roomNotice(
      { site_url: `${SITE}/` },
      { code: "AB23CD", opener: "@everyone *x*", state: "open", reason: null },
    );
    expect(open.text).toContain("\\@everyone \\*x\\* 開了一間唱 K 房間,房號 **AB23CD**");
    expect(open.card?.blocks.at(-1)).toEqual({
      type: "buttons",
      buttons: [{ id: "", label: "加入", url: `${SITE}/karaoke/room/AB23CD` }],
    });
    expect(open.ephemeral).toBeUndefined();
    const ended = roomNotice(
      { site_url: SITE },
      { code: "AB23CD", opener: "x", state: "ended", reason: "大家都離開了" },
    );
    expect(ended.text).toContain("唱 K 房間 **AB23CD** 已結束");
    expect(ended.text).toContain("大家都離開了");
    expect(JSON.stringify(ended.card)).not.toContain("url");
    const plain = roomNotice(
      { site_url: "" },
      { code: "AB23CD", opener: "x", state: "open", reason: null },
    );
    expect(JSON.stringify(plain.card)).not.toContain("url");
    expect(plain.text).toContain("輸入房號加入");
  });
});

describe("the comment channel", () => {
  it("is a server's text channel of any platform, as its context key", () => {
    expect(commentContext("discord:111111111111111111:123456789012345678")).toEqual({
      platform: "discord",
      scope: "111111111111111111",
      channel: "123456789012345678",
      kind: "channel",
    });
    expect(commentContext("matrix:example.org:room-1")).toMatchObject({
      platform: "matrix",
      scope: "example.org",
      channel: "room-1",
    });
    expect(commentContext("")).toBeNull();
    expect(KaraokeConfigSchema.safeParse({ comment_channel: "" }).success).toBe(true);
    expect(KaraokeConfigSchema.safeParse({ comment_channel: "123456789012345678" }).success).toBe(
      false,
    );
  });
});
