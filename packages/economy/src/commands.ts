// `/me wallet`, `/me checkin`, `/me feed`: the coin wallet in Discord (docs/design/economy.md §7).
//
// The `/me i` panel has a wallet page (status line `me wallet`, buttons that run `me checkin` /
// `me feed`), and `me wallet` also carries the same three buttons when run on its own. Same
// ledger and daily limits as the web panel. Every answer is a neutral system card (public
// unless `[modules.commands.visibility]` says otherwise); her own reaction to being fed is her
// normal message.

import {
  type AnyComponentRoute,
  ArgKind,
  argSpec,
  BOARD_SCOPE_ARG,
  boardScope,
  boardScopeArg,
  type CardBlock,
  type CardButton,
  type CommandRegistry,
  type CommandReply,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  defineRoute,
  type Invocation,
  notice,
  pictureParts,
} from "@miyoria/commands";
import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/runtime/kernel";
import { type KeepsakeFortune, KeepsakesKey, newId, PicturesKey, PlacesKey } from "@miyoria/types";
import { registerV2, unregisterV2 } from "./commands-v2.js";
import { STRANGER, WALLET_NODE } from "./economy.js";
import {
  askGift,
  giftRoutes,
  registerGiftCommands,
  unregisterGiftCommands,
} from "./gift-commands.js";
import { mutedText, unlockLines } from "./notices.js";
import { NO_RECEIVER } from "./transfer.js";
import {
  type Economy,
  EconomyError,
  EconomyKey,
  FEED_ITEMS,
  type FeedItem,
  type Hunger,
  type WalletView,
} from "./types.js";
import { coinName, pronounOf, transferSmallPrint } from "./words.js";

/**
 * Under every transfer, with the default coin name (`transferSmallPrint` of `words.ts`). Discord
 * draws a line that starts with `-# ` as small print.
 */
export const TRANSFER_SMALL_PRINT = transferSmallPrint();

const log = getLogger("economy.commands");

export const PATHS = [
  "me wallet",
  "me checkin",
  "me feed",
  "me give",
  "me board",
  "me screen",
  "me danmaku",
  "me bounties",
] as const;

const R = {
  checkin: "me:wallet:checkin",
  feed: "me:wallet:feed",
  board: "me:board:set",
} as const;

/** Bounties `/me bounties` lists. */
const BOUNTY_PLACES = 10;

/** A Discord timestamp (shown in the reader's own time zone). */
function when(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:R>` : iso;
}

/** Places `/me board` lists. */
const BOARD_PLACES = 10;

/**
 * A fresh idempotency key for a press, on the invoker's platform (`discord:<ulid>` on Discord, as
 * before): the platform does not hand a command its interaction id, so a press is its own key.
 */
const pressKey = (inv: Invocation): string => `${inv.context.platform}:${newId()}`;

const HUNGER_WORD: Readonly<Record<Hunger, string>> = {
  full: "吃飽了",
  ok: "還不餓",
  hungry: "有點餓",
  starving: "餓壞了",
};

const UNAVAILABLE = "錢包現在打不開";
const NO_SLIP = "今天的籤詩現在抽不了。";

/** A fortune slip as it is shown: rank and title, the poem, her fields and line. */
function slipText(slip: KeepsakeFortune): CardBlock[] {
  const lines = [`**${slip.rank}　${slip.title}**`, slip.poem.join("\n")];
  if (slip.fields.length > 0)
    lines.push(slip.fields.map((f) => `${f.label}：${f.text}`).join("\n"));
  if (slip.line) lines.push(slip.line);
  return [
    { type: "text", text: lines.join("\n\n") },
    { type: "muted", text: slip.date },
  ];
}

/** Buttons of the wallet card: label of `me feed <item>` (dessert is web only). */
const FEED_BUTTONS: readonly { item: FeedItem; label: string }[] = [
  { item: "rice", label: "餵一碗" },
  { item: "big_bowl", label: "餵鋼盆" },
];

function isFeedItem(raw: string | null | undefined): raw is FeedItem {
  return FEED_ITEMS.includes(raw as FeedItem);
}

/** The wallet as text: balance, today, check-in, her hunger, what is left to earn. */
export function walletText(view: WalletView): string {
  const lines = [
    `**${view.balance} ${view.currency}**　今天賺了 ${view.today_earned}`,
    view.checked_in_today
      ? `簽到：今天已簽到，連續 ${view.streak} 天`
      : view.streak > 0
        ? `簽到：今天還沒簽到，連續 ${view.streak} 天`
        : "簽到：今天還沒簽到",
  ];
  if (view.hungry !== null) lines.push(`她現在：${HUNGER_WORD[view.hungry]}`);
  const left = view.earn
    .filter((e) => e.reason !== "her_gift" && e.cap - e.earned_today > 0)
    .filter((e) => e.reason !== "checkin" || !view.checked_in_today)
    .map((e) => `・${e.label}：還能賺 ${e.cap - e.earned_today}`);
  lines.push(left.length > 0 ? `今天還能賺\n${left.join("\n")}` : "今天能賺的都賺完了");
  return lines.join("\n");
}

/** A neutral result card (written into the `/me i` panel when pressed there), extras muted. */
function result(text: string, muted: string | null = null): CommandReply {
  const blocks: CardBlock[] = [{ type: "text", text }];
  if (muted) blocks.push({ type: "muted", text: muted });
  return cardReply(blocks, { accent: "neutral" });
}

class Handler {
  constructor(readonly services: ServiceLookup) {}

  /** An economy answer: refusals (stranger, limits, full) are plain information, not errors. */
  async #guard(run: (economy: Economy) => Promise<CommandReply>): Promise<CommandReply> {
    const economy = this.services.get(EconomyKey);
    if (!economy) return notice("warn", UNAVAILABLE);
    try {
      return await run(economy);
    } catch (error) {
      if (error instanceof EconomyError) {
        return error.status === 503 ? notice("warn", error.message) : notice("info", error.message);
      }
      log.warn({ error: errorMessage(error) }, "wallet command failed");
      return notice("warn", UNAVAILABLE);
    }
  }

  wallet(inv: Invocation, picture = true): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const view = await economy.wallet(inv.invoker);
      // A stranger or a blocked person: the same plain line as the web page, no buttons.
      if (!view.can_earn) return notice("info", STRANGER);
      const price = (item: FeedItem) => view.shop.find((s) => s.id === item);
      // This week's coins as a picture over the text (docs/design/v5-play.md §11.5).
      const drawn = picture ? await this.#picture(inv) : pictureParts(null);
      const blocks: CardBlock[] = [
        ...drawn.blocks,
        { type: "text", text: walletText(view) },
        {
          type: "buttons",
          buttons: [
            {
              id: componentId(R.checkin),
              label: "簽到",
              style: "primary",
              disabled: view.checked_in_today,
            },
            ...FEED_BUTTONS.map(
              ({ item, label }): CardButton => ({
                id: componentId(R.feed, item),
                label,
                disabled: price(item)?.available === false,
              }),
            ),
          ],
        },
      ];
      const prices = FEED_BUTTONS.map(({ item, label }) => {
        const shop = price(item);
        return shop ? `${label} ${shop.price}` : null;
      }).filter((t) => t !== null);
      if (prices.length > 0)
        blocks.push({ type: "muted", text: `${prices.join("・")} ${view.currency}` });
      return cardReply(blocks, { accent: "neutral", title: "錢包", files: drawn.files });
    });
  }

  /** The wallet's picture; nothing without the renderer or when it cannot be drawn. */
  async #picture(inv: Invocation): Promise<ReturnType<typeof pictureParts>> {
    try {
      const result = await this.services
        .get(PicturesKey)
        ?.forMember({ account: inv.invoker, name: inv.invoker_display_name }, "wallet");
      return pictureParts(result?.file);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot draw the wallet");
      return pictureParts(null);
    }
  }

  /**
   * `/me checkin`; with `fortune` also today's fortune slip, paid. A day that was checked in
   * already still buys the slip alone, with no second reward. The slip is asked after the
   * check-in went through, and a refusal of it is a line under the check-in, never an error. What
   * she wrote is private: the reply only says a slip was drawn, the slip itself goes to the buyer
   * as an ephemeral follow-up.
   */
  checkin(inv: Invocation, fortune = false): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const view = await economy.wallet(inv.invoker);
      const slipOnly = fortune && view.checked_in_today;
      const r = slipOnly ? null : await economy.checkin(inv.invoker);
      const head = r
        ? `簽到了，+${r.gained} ${view.currency}。連續 ${r.streak} 天，現在有 ${r.balance} ${view.currency}。`
        : `今天已經簽到過了，這次只買籤詩，沒有再領${view.currency}。`;
      const unlocked = mutedText(unlockLines(r?.unlocked));
      if (!fortune) return result(head, unlocked);
      const blocks: CardBlock[] = [{ type: "text", text: head }];
      const slip = await this.#slip(inv, view.currency);
      for (const line of slip.public) blocks.push({ type: "muted", text: line });
      if (unlocked) blocks.push({ type: "muted", text: unlocked });
      return cardReply(blocks, { accent: "neutral" });
    });
  }

  /**
   * Buys today's slip. Its text goes to the buyer alone (an ephemeral follow-up); `public` is
   * what the shared reply may say: that one was drawn and what it cost, or why there is none.
   */
  async #slip(inv: Invocation, currency: string): Promise<{ public: string[] }> {
    const keepsakes = this.services.get(KeepsakesKey);
    if (!keepsakes) return { public: [NO_SLIP] };
    try {
      const drawn = await keepsakes.drawFortune(
        { account: inv.invoker, name: inv.invoker_display_name, avatar_url: null },
        pressKey(inv),
      );
      if (!drawn.ok) return { public: [drawn.message] };
      const left = drawn.balance === null ? "" : `，剩 ${drawn.balance}`;
      const paid = drawn.charged > 0 ? `籤詩花了 ${drawn.charged} ${currency}${left}。` : "";
      if (!inv.canFollowUp()) return { public: [`${paid}籤詩到會員頁看。`] };
      try {
        await inv.followUp(
          cardReply(slipText(drawn.value), {
            accent: "neutral",
            title: "今日籤詩",
            ephemeral: true,
          }),
        );
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "cannot send a slip privately");
        return { public: [`${paid}籤詩到會員頁看。`] };
      }
      return { public: [`${paid}今天的籤詩抽好了，只有你看得到。`] };
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "a check-in's fortune failed");
      return { public: [NO_SLIP] };
    }
  }

  feed(inv: Invocation, item: FeedItem): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const r = await economy.feed(inv.invoker, item, 1, pressKey(inv));
      if (!r.accepted) return result(r.message);
      const view = await economy.wallet(inv.invoker);
      return result(
        `${r.message}，花了 ${r.charged} ${view.currency}，剩 ${r.balance}。`,
        mutedText(unlockLines(r.unlocked)),
      );
    });
  }

  /** `/me give`: coins to another member (the answer is only for the sender). */
  give(inv: Invocation): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const to = inv.account("user");
      const amount = inv.int("amount");
      if (to === null || amount === null) return notice("warn", "要轉給誰、轉多少?");
      // The option is a Discord user; another platform's account is not someone one can reach.
      if (to.platform !== inv.invoker.platform) return notice("info", NO_RECEIVER);
      const r = await economy.transfer(inv.invoker, to, amount, pressKey(inv));
      const view = await economy.wallet(inv.invoker);
      return result(
        `轉了 ${r.sent} ${view.currency}給 ${r.to}，另付手續費 ${r.fee}（燒掉），剩 ${r.balance}。
-# ${transferSmallPrint(view.currency)}`,
      );
    });
  }

  /**
   * `/me board`: the sponsor board; `on` joins or leaves it first. `scope` is the `範圍` option
   * (in a server that server's members by default, in a DM everyone; `board-scope.ts`).
   */
  board(inv: Invocation, on: boolean | null, scope: string | null): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      if (on !== null && !(await economy.setOnBoard(inv.invoker, on))) {
        return notice("info", STRANGER);
      }
      const where = boardScope(this.services.get(PlacesKey), inv.context, scope);
      const [lines, view] = await Promise.all([
        economy.board(BOARD_PLACES, where.members ?? undefined),
        economy.wallet(inv.invoker),
      ]);
      // The join / leave button shows the same list again after the press.
      const all = scope === "全部" ? ["all"] : [];
      const text =
        lines.length === 0
          ? "還沒有人上榜"
          : lines.map((l) => `${l.rank}. ${l.name}　${l.spent}`).join("\n");
      const blocks: CardBlock[] = [
        { type: "text", text },
        ...(where.label === "" ? [] : [{ type: "muted" as const, text: where.label }]),
        {
          type: "muted",
          text: `最近花在她身上的${view.currency}（餵食、信、表情、商店買的東西、獻詞、目標等等），花過就預設在榜上，不想上榜可以退出；不顯示餘額。`,
        },
      ];
      if (view.can_earn) {
        blocks.push({
          type: "buttons",
          buttons: [
            view.on_board
              ? { id: componentId(R.board, "off", ...all), label: "退出排行榜" }
              : { id: componentId(R.board, "on", ...all), label: "加入排行榜", style: "primary" },
          ],
        });
        blocks.push({
          type: "muted",
          text: view.on_board ? "你在榜上（花過就會列出來）" : "你已經退出榜單",
        });
      }
      return cardReply(blocks, { accent: "neutral", title: "贊助排行榜" });
    });
  }

  /** `/me screen`: a short message on the stream's screen (paid; public like feeding her). */
  screen(inv: Invocation): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const text = inv.str("text")?.trim() ?? "";
      if (text === "") return notice("warn", "要寫什麼?");
      const r = await economy.screenMessage(inv.invoker, text, pressKey(inv));
      if (!r.accepted) return result(r.message);
      const view = await economy.wallet(inv.invoker);
      return result(`${r.message}，花了 ${r.charged} ${view.currency}，剩 ${r.balance}。`);
    });
  }

  /**
   * `/me danmaku`: one short line that crosses her stream (paid; given back by itself when the
   * overlay did not show it). Every refusal is a plain line; nothing is charged for one.
   */
  danmaku(inv: Invocation): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const text = inv.str("text")?.trim() ?? "";
      if (text === "") return notice("warn", "要寫什麼?");
      const r = await economy.danmaku(inv.invoker, text, pressKey(inv));
      if (!r.accepted) return result(r.message);
      const view = await economy.wallet(inv.invoker);
      return result(`${r.message}。花了 ${r.charged} ${view.currency}，剩 ${r.balance}。`);
    });
  }

  /**
   * `/me bounties`: what she has posted in this server (in a DM: in the servers the invoker is
   * in). Only a member of a bounty's server can be paid it.
   */
  bounties(inv: Invocation): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const spaces = await economy.spacesFor(inv.context, inv.invoker);
      const list = (await economy.bounties(spaces)).slice(0, BOUNTY_PLACES);
      if (list.length === 0) return result("她現在沒有貼懸賞");
      const lines = list.map((b) => `・${b.task}　${b.reward}　到 ${when(b.expires_at)}`);
      return cardReply(
        [
          { type: "text", text: lines.join("\n") },
          { type: "muted", text: "誰完成由她判定，獎金付給正在跟她說話的人。" },
        ],
        { accent: "neutral", title: "她的懸賞" },
      );
    });
  }
}

function unregister(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
  unregisterV2(registry);
  unregisterGiftCommands(registry);
}

function register(registry: CommandRegistry, handler: Handler): void {
  const coin = coinName(handler.services);
  const her = pronounOf(handler.services);
  const routes: AnyComponentRoute[] = [
    {
      route: R.checkin,
      handle: async (inv) => ComponentResult.reply(await handler.checkin(inv)),
    },
    defineRoute<FeedItem>({
      route: R.feed,
      parse: (p) => (isFeedItem(p[0]) ? p[0] : null),
      handle: async (inv, item) => ComponentResult.reply(await handler.feed(inv, item)),
    }),
  ];
  const boardRoutes: AnyComponentRoute[] = [
    defineRoute<{ on: boolean; scope: string | null }>({
      route: R.board,
      parse: (p) => {
        const on = p[0] === "on" ? true : p[0] === "off" ? false : null;
        return on === null ? null : { on, scope: p[1] === "all" ? "全部" : null };
      },
      handle: async (inv, { on, scope }) =>
        ComponentResult.reply(await handler.board(inv, on, scope)),
    }),
  ];
  registry.register(
    commandSpec("me wallet", `你的${coin}：餘額、今天還能賺多少，可以簽到和餵${her}`, {
      args: [
        argSpec("picture", "附上這一週收支的圖（預設附上；false 只要文字）", ArgKind.boolean, {
          required: false,
        }),
      ],
      permission: WALLET_NODE,
    }),
    (inv) => handler.wallet(inv, inv.bool("picture") !== false),
    { components: routes },
  );
  registry.register(
    commandSpec("me checkin", `每日簽到，領${coin}（可以加買今天的籤詩）`, {
      args: [
        argSpec(
          "fortune",
          `順便抽今天的籤詩（要花${coin}；已經簽到過也能只買籤詩）`,
          ArgKind.boolean,
          {
            required: false,
          },
        ),
      ],
      permission: WALLET_NODE,
    }),
    (inv) => handler.checkin(inv, inv.bool("fortune") === true),
  );
  registry.register(
    commandSpec("me feed", `用${coin}餵${her}一碗飯，或自己取名送${her}一樣東西`, {
      args: [
        argSpec("item", "要餵什麼（白飯、鋼盆、甜點）", ArgKind.choice(FEED_ITEMS), {
          required: false,
        }),
        argSpec(
          "thing",
          "或自己寫要送她什麼，例如「一杯珍奶」（先報價，你確認了才扣）",
          ArgKind.string,
          {
            required: false,
          },
        ),
      ],
      permission: WALLET_NODE,
    }),
    (inv) => {
      // A gift named in words (gift-commands.ts): a quote to confirm, or a fixed food fed at once.
      const thing = inv.str("thing")?.trim() ?? "";
      if (thing !== "")
        return askGift(handler.services, inv, thing, (food) => handler.feed(inv, food));
      const item = inv.str("item");
      return isFeedItem(item)
        ? handler.feed(inv, item)
        : Promise.resolve(notice("warn", "要餵什麼?選一樣,或在 thing 寫要送她的東西"));
    },
    { components: giftRoutes(handler.services) },
  );
  registerGiftCommands(registry, handler.services);
  registry.register(
    commandSpec("me give", `把${coin}轉給${her}認識的另一個人（另收手續費，會燒掉）`, {
      args: [
        argSpec("user", "要轉給誰", ArgKind.user),
        argSpec("amount", `對方收到多少${coin}（手續費你另付）`, ArgKind.integer),
      ],
      permission: WALLET_NODE,
      ephemeral: true,
    }),
    (inv) => handler.give(inv),
  );
  registry.register(
    commandSpec("me board", "贊助排行榜：看前 10 名；花過就預設上榜，隨時可以退出", {
      args: [
        argSpec("join", "加入（回到榜上）或退出排行榜（選填）", ArgKind.choice(["on", "off"]), {
          required: false,
        }),
        boardScopeArg(),
      ],
      permission: WALLET_NODE,
    }),
    (inv) => {
      const join = inv.str("join");
      return handler.board(
        inv,
        join === "on" ? true : join === "off" ? false : null,
        inv.str(BOARD_SCOPE_ARG),
      );
    },
    { components: boardRoutes },
  );
  registry.register(
    commandSpec("me screen", `花${coin}在直播大螢幕上留一則短留言（60 字內）`, {
      args: [argSpec("text", "留言", ArgKind.string)],
      permission: WALLET_NODE,
    }),
    (inv) => handler.screen(inv),
  );
  registry.register(
    commandSpec("me danmaku", `花${coin}在${her}直播的畫面上發一則彈幕（從右邊飄過的短句）`, {
      args: [argSpec("text", "彈幕", ArgKind.string)],
      permission: WALLET_NODE,
    }),
    (inv) => handler.danmaku(inv),
  );
  registry.register(
    commandSpec("me bounties", "她貼著的懸賞", { permission: WALLET_NODE }),
    (inv) => handler.bounties(inv),
  );
}

/**
 * Remembers which registry the commands went into, so they can be removed on stop and
 * re-registered when the `commands` module provides a different registry.
 */
export class EconomyCommands {
  #installed: CommandRegistry | null = null;

  /** Registers the commands in `registry` unless already there. */
  install(registry: CommandRegistry, services: ServiceLookup): void {
    if (this.#installed === registry) return;
    if (this.#installed !== null) {
      unregister(this.#installed);
      this.#installed = null;
    }
    try {
      register(registry, new Handler(services));
      registerV2(registry, services);
      this.#installed = registry;
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "could not register wallet commands");
      unregister(registry);
    }
  }

  uninstall(): void {
    if (this.#installed !== null) {
      unregister(this.#installed);
      this.#installed = null;
    }
  }
}
