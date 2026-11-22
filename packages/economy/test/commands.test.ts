// `/me wallet`, `/me checkin`, `/me feed` and the wallet buttons, against a fake `Economy`.

import {
  type CardBlock,
  CommandRegistry,
  type CommandReply,
  Permissions,
  panelDefs,
  replyEphemeral,
} from "@miyoria/commands";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { type AccountRef, type ContextKey, type Keepsakes, KeepsakesKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyCommands, PATHS, TRANSFER_SMALL_PRINT, walletText } from "../src/commands.js";
import { STRANGER } from "../src/economy.js";
import {
  type BountyView,
  type Economy,
  EconomyError,
  EconomyKey,
  type FeedItem,
  type WalletView,
} from "../src/types.js";

const ctx: ContextKey = { platform: "discord", scope: null, channel: "9", kind: "dm" };
const acct = (id: string): AccountRef => ({ platform: "discord", id });

function view(over: Partial<WalletView> = {}): WalletView {
  return {
    currency: "魚幣",
    balance: 120,
    can_earn: true,
    today_earned: 30,
    checked_in_today: false,
    streak: 2,
    earn: [
      { reason: "checkin", label: "每日簽到", amount: 10, earned_today: 0, cap: 10 },
      { reason: "talked", label: "和她說話", amount: 10, earned_today: 10, cap: 10 },
      { reason: "voice", label: "在語音陪她", amount: 2, earned_today: 4, cap: 20 },
      { reason: "her_gift", label: "她送你的", amount: 0, earned_today: 0, cap: 30 },
    ],
    shop: [
      { id: "rice", kind: "feed", label: "一碗白飯", price: 10, available: true, why: null },
      { id: "big_bowl", kind: "feed", label: "一大碗白飯", price: 40, available: true, why: null },
    ],
    frames: { owned: [], selected: null },
    hungry: "hungry",
    recent: [],
    on_board: false,
    transfer_fee: 0.05,
    ...over,
  };
}

interface Fake {
  economy: Economy;
  calls: string[];
  state: {
    view: WalletView;
    fail: EconomyError | null;
    full: boolean;
    board: { rank: number; name: string; spent: number }[];
    bounties: BountyView[];
    screenOk: boolean;
  };
}

function fake(): Fake {
  const calls: string[] = [];
  const state = {
    view: view(),
    fail: null as EconomyError | null,
    full: false,
    board: [] as { rank: number; name: string; spent: number }[],
    bounties: [] as BountyView[],
    screenOk: true,
  };
  const economy = {
    wallet: async () => state.view,
    checkin: async () => {
      calls.push("checkin");
      if (state.fail) throw state.fail;
      return { gained: 10, streak: 3, balance: 130 };
    },
    feed: async (_a: AccountRef, item: FeedItem, count: number, key: string) => {
      calls.push(`feed:${item}:${count}:${key}`);
      if (state.fail) throw state.fail;
      if (state.full) {
        return { accepted: false, eaten: 0, charged: 0, balance: 120, message: "她吃飽了,吃不下" };
      }
      return { accepted: true, eaten: 1, charged: 10, balance: 110, message: "她吃了一碗白飯" };
    },
    transfer: async (_a: AccountRef, to: AccountRef, amount: number, key: string) => {
      calls.push(`transfer:${to.platform}:${to.id}:${amount}:${key}`);
      if (state.fail) throw state.fail;
      return { sent: amount, fee: 2, balance: 90, to: "Bob" };
    },
    board: async (limit?: number) => {
      calls.push(`board:${limit}`);
      return state.board;
    },
    screenMessage: async (_a: AccountRef, text: string, key: string) => {
      calls.push(`screen:${text}:${key}`);
      if (state.fail) throw state.fail;
      if (!state.screenOk)
        return { accepted: false, charged: 0, balance: 120, message: "現在沒有開台" };
      return { accepted: true, charged: 30, balance: 90, message: "留言送上大螢幕了" };
    },
    danmaku: async (_a: AccountRef, text: string, key: string) => {
      calls.push(`danmaku:${text}:${key}`);
      if (state.fail) throw state.fail;
      if (!state.screenOk)
        return { accepted: false, charged: 0, balance: 120, message: "這則彈幕沒辦法上螢幕" };
      return {
        accepted: true,
        charged: 5,
        balance: 115,
        message: "彈幕送出了,沒顯示出來的會自動退回",
      };
    },
    bounties: async () => state.bounties,
    // No identity here: no server filter.
    spacesFor: async () => undefined,
    setOnBoard: async (_a: AccountRef, on: boolean) => {
      calls.push(`on_board:${on}`);
      state.view = { ...state.view, on_board: on };
      return true;
    },
  } as unknown as Economy;
  return { economy, calls, state };
}

function setup(withEconomy = true) {
  const f = fake();
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
  const services = new ServiceRegistry();
  if (withEconomy) services.provide("test", EconomyKey, f.economy);
  new EconomyCommands().install(registry, services);
  return { ...f, registry };
}

function run(
  registry: CommandRegistry,
  path: string,
  args: Record<string, string | number | boolean> = {},
) {
  return registry.dispatch({
    path: path.split(" "),
    args,
    invoker: acct("5"),
    invoker_display_name: "Bob",
    context: ctx,
    invoker_is_guild_admin: false,
  });
}

function press(registry: CommandRegistry, customId: string) {
  return registry.dispatchComponent({
    custom_id: customId,
    invoker: acct("5"),
    invoker_display_name: "Bob",
    context: ctx,
    invoker_is_guild_admin: false,
  });
}

function replyOf(outcome: Awaited<ReturnType<typeof press>>): CommandReply {
  const result = outcome?.result;
  if (result?.type !== "reply") throw new Error("expected a reply");
  return result.reply;
}

function buttons(reply: CommandReply) {
  return (reply.card?.blocks ?? [])
    .filter((b): b is Extract<CardBlock, { type: "buttons" }> => b.type === "buttons")
    .flatMap((b) => b.buttons);
}

describe("wallet commands", () => {
  it("wallet_card_shows_balance_hunger_and_what_is_left", async () => {
    const { registry } = setup();
    const reply = await run(registry, "me wallet");
    // The wallet answers the channel; a warning or error would still be ephemeral.
    expect(replyEphemeral(registry.get(["me", "wallet"])?.ephemeral ?? true, reply)).toBe(false);
    expect(reply.card?.accent).toBe("neutral");
    expect(reply.text).toContain("120 魚幣");
    expect(reply.text).toContain("今天賺了 30");
    expect(reply.text).toContain("今天還沒簽到，連續 2 天");
    expect(reply.text).toContain("她現在：有點餓");
    // Only what can still be earned: talked is at its cap, her gift is not on demand.
    expect(reply.text).toContain("每日簽到：還能賺 10");
    expect(reply.text).toContain("在語音陪她：還能賺 16");
    expect(reply.text).not.toContain("和她說話：還能賺");
    expect(reply.text).not.toContain("她送你的");
    expect(buttons(reply).map((b) => b.label)).toEqual(["簽到", "餵一碗", "餵鋼盆"]);
    expect(buttons(reply).every((b) => b.disabled !== true)).toBe(true);
    // Her hunger is words, never the number.
    expect(reply.text).not.toMatch(/0\.\d/);
  });

  it("wallet_card_disables_what_cannot_be_pressed", async () => {
    const { registry, state } = setup();
    state.view = view({
      checked_in_today: true,
      shop: view().shop.map((s) => (s.id === "big_bowl" ? { ...s, available: false } : s)),
    });
    const reply = await run(registry, "me wallet");
    expect(reply.text).toContain("今天已簽到，連續 2 天");
    expect(reply.text).not.toContain("每日簽到：還能賺");
    expect(buttons(reply).map((b) => [b.label, b.disabled === true])).toEqual([
      ["簽到", true],
      ["餵一碗", false],
      ["餵鋼盆", true],
    ]);
  });

  it("strangers_get_the_plain_line_and_no_buttons", async () => {
    const { registry, state } = setup();
    state.view = view({ can_earn: false, balance: 0, hungry: null });
    const reply = await run(registry, "me wallet");
    expect(reply.text).toBe(STRANGER);
    expect(buttons(reply)).toEqual([]);
    expect(reply.tone).toBe("info");
  });

  it("buttons_check_in_and_feed_with_a_neutral_card", async () => {
    const { registry, calls } = setup();
    const checkin = await press(registry, "mi:me:wallet:checkin");
    expect(checkin?.ephemeral).toBe(false);
    const cr = replyOf(checkin);
    expect(cr.text).toContain("+10 魚幣");
    expect(cr.text).toContain("連續 3 天");
    expect(cr.card?.accent).toBe("neutral");

    const fr = replyOf(await press(registry, "mi:me:wallet:feed:big_bowl"));
    expect(fr.text).toContain("她吃了一碗白飯");
    expect(fr.text).toContain("剩 110");
    expect(calls[0]).toBe("checkin");
    expect(calls[1]).toMatch(/^feed:big_bowl:1:discord:/);

    // A forged item is refused before it reaches the ledger.
    expect(replyOf(await press(registry, "mi:me:wallet:feed:gold")).tone).toBe("error");
    expect(calls).toHaveLength(2);
  });

  it("refusals_are_neutral_information", async () => {
    const { registry, state } = setup();
    state.full = true;
    const full = await run(registry, "me feed", { item: "rice" });
    expect(full.text).toBe("她吃飽了,吃不下");
    expect(full.tone).toBeUndefined();
    expect(full.card?.accent).toBe("neutral");

    state.fail = new EconomyError(409, "今天已經簽到過了");
    const again = await run(registry, "me checkin");
    expect(again.text).toBe("今天已經簽到過了");
    expect(again.tone).toBe("info");

    state.fail = new EconomyError(402, "魚幣不夠");
    expect((await run(registry, "me feed", { item: "big_bowl" })).tone).toBe("info");

    state.fail = new EconomyError(403, STRANGER);
    expect((await run(registry, "me feed", { item: "rice" })).text).toBe(STRANGER);

    state.fail = new EconomyError(503, "現在沒辦法餵她");
    expect((await run(registry, "me feed", { item: "rice" })).tone).toBe("warn");
  });

  it("checkin_adds_a_paid_fortune_slip_only_when_asked", async () => {
    const f = fake();
    const drawn: string[] = [];
    let refuse: string | null = null;
    const keepsakes = {
      drawFortune: async (_who: unknown, key: string) => {
        drawn.push(key);
        if (refuse) return { ok: false, status: 402, message: refuse };
        return {
          ok: true,
          value: {
            id: "f1",
            date: "2026-11-17",
            rank: "大吉",
            title: "春風得意",
            poem: ["月落烏啼", "江楓漁火"],
            fields: [],
            line: null,
          },
          charged: 10,
          balance: 120,
        };
      },
    } as unknown as Keepsakes;
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
    const services = new ServiceRegistry();
    services.provide("test", EconomyKey, f.economy);
    services.provide("test", KeepsakesKey, keepsakes);
    new EconomyCommands().install(registry, services);

    // Dispatches like the platform does: a follow-up is what the buyer alone sees.
    const asWith = async (args: Record<string, string | number | boolean>, canFollow = true) => {
      const followUps: CommandReply[] = [];
      const reply = await registry.dispatch(
        {
          path: ["me", "checkin"],
          args,
          invoker: acct("5"),
          invoker_display_name: "Bob",
          context: ctx,
          invoker_is_guild_admin: false,
        },
        canFollow ? { followUp: async (r: CommandReply) => void followUps.push(r) } : {},
      );
      return { reply, followUps };
    };

    const plain = await run(registry, "me checkin");
    expect(plain.text).not.toContain("春風得意");
    expect(drawn).toHaveLength(0);

    // The shared reply says a slip was drawn, never what it says; the slip is a private follow-up.
    const asked = await asWith({ fortune: true });
    expect(asked.reply.text).toContain("簽到了，+10 魚幣");
    expect(asked.reply.text).toContain("籤詩花了 10 魚幣，剩 120");
    expect(asked.reply.text).toContain("只有你看得到");
    expect(asked.reply.text).not.toContain("春風得意");
    expect(asked.reply.text).not.toContain("月落烏啼");
    expect(asked.followUps).toHaveLength(1);
    expect(asked.followUps[0]?.ephemeral).toBe(true);
    expect(asked.followUps[0]?.text).toContain("大吉　春風得意");
    expect(asked.followUps[0]?.text).toContain("月落烏啼\n江楓漁火");
    expect(drawn).toHaveLength(1);

    // Where a private message cannot be sent, the slip is not put in the shared reply either.
    const noFollow = await asWith({ fortune: true }, false);
    expect(noFollow.reply.text).toContain("會員頁");
    expect(noFollow.reply.text).not.toContain("春風得意");

    // The slip is refused: the check-in stands, with the reason under it, and nothing private.
    refuse = "魚幣不夠";
    const short = await asWith({ fortune: true });
    expect(short.reply.text).toContain("簽到了，+10 魚幣");
    expect(short.reply.text).toContain("魚幣不夠");
    expect(short.followUps).toHaveLength(0);
    refuse = null;

    // Already checked in: the slip alone is bought, with no second check-in and no reward.
    f.state.view = view({ checked_in_today: true });
    const checkins = f.calls.filter((c) => c === "checkin").length;
    const before = drawn.length;
    const only = await asWith({ fortune: true });
    expect(only.reply.text).toContain("今天已經簽到過了");
    expect(only.reply.text).not.toContain("簽到了，+");
    expect(only.followUps[0]?.text).toContain("春風得意");
    expect(drawn).toHaveLength(before + 1);
    expect(f.calls.filter((c) => c === "checkin")).toHaveLength(checkins);
    // Without the add-on, a second check-in is still the economy's own refusal.
    f.state.fail = new EconomyError(409, "今天已經簽到過了");
    const plainAgain = await run(registry, "me checkin");
    expect(plainAgain.text).toBe("今天已經簽到過了");
    expect(drawn).toHaveLength(before + 1);
    f.state.fail = null;

    // Without the service the check-in still stands.
    const bare = setup();
    const none = await run(bare.registry, "me checkin", { fortune: true });
    expect(none.text).toContain("簽到了");
    expect(none.text).toContain("籤詩現在抽不了");
  });

  it("without_the_economy_the_commands_say_so", async () => {
    const { registry } = setup(false);
    const reply = await run(registry, "me wallet");
    expect(reply.tone).toBe("warn");
    expect(reply.text).toContain("錢包現在打不開");
  });

  it("install_is_idempotent_and_uninstall_removes_everything", () => {
    const f = fake();
    const registry = new CommandRegistry(Permissions.fromStrings([]));
    const services = new ServiceRegistry();
    services.provide("test", EconomyKey, f.economy);
    const commands = new EconomyCommands();
    commands.install(registry, services);
    commands.install(registry, services);
    for (const path of PATHS) expect(registry.get(path.split(" "))).toBeDefined();
    commands.uninstall();
    for (const path of PATHS) expect(registry.get(path.split(" "))).toBeUndefined();
  });

  it("the_me_panel_has_a_wallet_page_over_these_commands", () => {
    const me = panelDefs().find((d) => d.command === "me");
    const page = me?.pages.find((p) => p.id === "wallet");
    expect(page?.status?.map((s) => s.path)).toEqual(["me wallet"]);
    expect(page?.actions.map((a) => [a.label, a.path, a.args])).toEqual([
      ["簽到", "me checkin", undefined],
      ["餵一碗", "me feed", { item: "rice" }],
      ["餵鋼盆", "me feed", { item: "big_bowl" }],
      ["送她別的", "me feed", undefined],
      ["留言上大螢幕", "me screen", undefined],
      ["發彈幕", "me danmaku", undefined],
      ["轉給別人", "me give", undefined],
      ["排行榜", "me board", undefined],
    ]);
    // The form's one field is the argument `/me feed` reads a named gift from.
    const gift = page?.actions.find((a) => a.id === "gift");
    expect(gift?.ask?.fields.map((f) => f.arg)).toEqual(["thing"]);
    const f = fake();
    const registry = new CommandRegistry(Permissions.fromStrings([]));
    const services = new ServiceRegistry();
    services.provide("test", EconomyKey, f.economy);
    new EconomyCommands().install(registry, services);
    const feed = registry.get(["me", "feed"]);
    expect(feed?.args.map((a) => a.name)).toContain("thing");
    const screen = page?.actions.find((a) => a.id === "screen");
    expect(screen?.ask?.fields.map((f) => f.arg)).toEqual(["text"]);
    const danmaku = page?.actions.find((a) => a.id === "danmaku");
    expect(danmaku?.ask?.fields.map((f) => f.arg)).toEqual(["text"]);
    expect(page?.actions.find((a) => a.id === "give")?.ask?.fields.map((f) => f.arg)).toEqual([
      "user",
      "amount",
    ]);
  });

  it("the_me_panel_has_a_wishes_page_for_bounties", () => {
    const me = panelDefs().find((d) => d.command === "me");
    const page = me?.pages.find((p) => p.id === "wishes");
    expect(page?.status?.map((s) => s.path)).toEqual(["me bounties"]);
    expect(page?.actions.map((a) => [a.path, a.ask?.fields.map((f) => f.arg)])).toEqual([
      ["me bounties", undefined],
    ]);
  });

  it("screen_posts_a_message_and_is_public_like_feeding", async () => {
    const { registry, calls, state } = setup();
    expect(registry.get(["me", "screen"])?.ephemeral).toBeFalsy();
    const reply = await run(registry, "me screen", { text: " 加油 " });
    expect(reply.text).toContain("留言送上大螢幕了，花了 30 魚幣，剩 90");
    expect(reply.card?.accent).toBe("neutral");
    expect(calls[0]).toMatch(/^screen:加油:discord:/);
    state.screenOk = false;
    const off = await run(registry, "me screen", { text: "嗨" });
    expect(off.text).toBe("現在沒有開台");
    expect(off.tone).toBeUndefined();
    state.fail = new EconomyError(429, "10 分鐘內只能留一則");
    expect((await run(registry, "me screen", { text: "嗨" })).tone).toBe("info");
    expect((await run(registry, "me screen", { text: "  " })).tone).toBe("warn");
  });

  it("danmaku_sends_one_line_and_every_refusal_is_plain_information", async () => {
    const { registry, calls, state } = setup();
    expect(registry.get(["me", "danmaku"])?.ephemeral).toBeFalsy();
    const reply = await run(registry, "me danmaku", { text: " 好可愛 " });
    expect(reply.text).toBe("彈幕送出了,沒顯示出來的會自動退回。花了 5 魚幣，剩 115。");
    expect(reply.card?.accent).toBe("neutral");
    expect(calls[0]).toMatch(/^danmaku:好可愛:discord:/);
    state.screenOk = false;
    expect((await run(registry, "me danmaku", { text: "嗨" })).text).toBe("這則彈幕沒辦法上螢幕");
    state.fail = new EconomyError(409, "她現在沒有開台,彈幕發不出去");
    const down = await run(registry, "me danmaku", { text: "嗨" });
    expect(down.tone).toBe("info");
    expect(down.text).toContain("她現在沒有開台");
    expect((await run(registry, "me danmaku", { text: "  " })).tone).toBe("warn");
  });

  it("bounties_list_what_she_has_posted", async () => {
    const { registry, state } = setup();
    expect((await run(registry, "me bounties")).text).toContain("沒有貼懸賞");
    state.bounties = [
      {
        id: "b1",
        task: "講一個笑話給她聽",
        reward: 30,
        posted_at: "2026-11-08T00:00:00.000Z",
        expires_at: "2026-11-11T00:00:00.000Z",
      },
    ];
    const reply = await run(registry, "me bounties");
    expect(reply.card?.title).toBe("她的懸賞");
    expect(reply.text).toContain("講一個笑話給她聽　30");
    expect(replyEphemeral(registry.get(["me", "bounties"])?.ephemeral ?? true, reply)).toBe(false);
  });

  it("give_sends_coins_to_a_discord_user_and_says_so_only_to_the_sender", async () => {
    const { registry, calls } = setup();
    const spec = registry.get(["me", "give"]);
    expect(spec?.ephemeral).toBe(true);
    const reply = await run(registry, "me give", { user: "77", amount: 25 });
    expect(reply.text).toBe(
      `轉了 25 魚幣給 Bob，另付手續費 2（燒掉），剩 90。
-# ${TRANSFER_SMALL_PRINT}`,
    );
    expect(TRANSFER_SMALL_PRINT).toContain("禁止用真錢");
    expect(reply.card?.accent).toBe("neutral");
    expect(calls[0]).toMatch(/^transfer:discord:77:25:discord:/);
    // Another platform's account is not someone one can reach, in the receiver's usual words.
    const other = await run(registry, "me give", { user: "slack:9", amount: 5 });
    expect(other.text).toBe("對方現在收不到");
    expect(calls).toHaveLength(1);
  });

  it("give_refusals_are_plain_information", async () => {
    const { registry, state } = setup();
    state.fail = new EconomyError(403, "對方現在收不到");
    const reply = await run(registry, "me give", { user: "77", amount: 5 });
    expect(reply.text).toBe("對方現在收不到");
    expect(reply.tone).toBe("info");
    state.fail = new EconomyError(429, "今天最多轉出 100 魚幣");
    expect((await run(registry, "me give", { user: "77", amount: 5 })).tone).toBe("info");
  });

  it("board_lists_the_top_without_balances_and_joins_or_leaves", async () => {
    const { registry, state, calls } = setup();
    state.board = [
      { rank: 1, name: "Bob", spent: 90 },
      { rank: 2, name: "Amy", spent: 40 },
    ];
    const reply = await run(registry, "me board");
    expect(reply.card?.title).toBe("贊助排行榜");
    expect(reply.text).toContain("1. Bob　90");
    expect(reply.text).toContain("2. Amy　40");
    expect(reply.text).toContain("你已經退出榜單");
    expect(reply.text).toContain("花過就預設在榜上");
    expect(reply.text).not.toContain("120");
    expect(calls).toContain("board:10");
    expect(buttons(reply).map((b) => b.label)).toEqual(["加入排行榜"]);

    const joined = await run(registry, "me board", { join: "on" });
    expect(calls).toContain("on_board:true");
    expect(joined.text).toContain("你在榜上");
    expect(buttons(joined).map((b) => b.label)).toEqual(["退出排行榜"]);

    const left = replyOf(await press(registry, "mi:me:board:set:off"));
    expect(calls).toContain("on_board:false");
    expect(left.text).toContain("你已經退出榜單");
    // A forged value is refused before it reaches the store.
    expect(replyOf(await press(registry, "mi:me:board:set:maybe")).tone).toBe("error");
  });

  it("an_empty_board_and_a_stranger", async () => {
    const { registry, state } = setup();
    expect((await run(registry, "me board")).text).toContain("還沒有人上榜");
    state.view = view({ can_earn: false, on_board: false });
    const reply = await run(registry, "me board");
    expect(buttons(reply)).toEqual([]);
  });

  it("a_new_person_has_no_streak_noise", () => {
    expect(walletText(view({ streak: 0 }))).toContain("簽到：今天還沒簽到\n");
  });
});
