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
} from "@miyoria/commands";
import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import { newId } from "@miyoria/types";
import { registerV2, unregisterV2 } from "./commands-v2.js";
import { MAX_LETTER_CHARS, STRANGER, WALLET_NODE } from "./economy.js";
import { NO_RECEIVER } from "./transfer.js";
import {
  type Economy,
  EconomyError,
  EconomyKey,
  FEED_ITEMS,
  type FeedItem,
  type GoalView,
  type Hunger,
  type WalletView,
} from "./types.js";

const log = getLogger("economy.commands");

export const PATHS = [
  "me wallet",
  "me checkin",
  "me feed",
  "me give",
  "me board",
  "me screen",
  "me letter",
  "me goals",
  "me pledge",
  "me bounties",
] as const;

const R = {
  checkin: "me:wallet:checkin",
  feed: "me:wallet:feed",
  board: "me:board:set",
  pledge: "me:goal:pledge",
} as const;

/** Quick pledge buttons on the goals card; the exact amount is `/me pledge`. */
const PLEDGE_BUTTONS = [10, 50] as const;

/** Bounties `/me bounties` lists. */
const BOUNTY_PLACES = 10;

/** A Discord timestamp (shown in the reader's own time zone). */
function when(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:R>` : iso;
}

/** Places `/me board` lists. */
const BOARD_PLACES = 10;

const HUNGER_WORD: Readonly<Record<Hunger, string>> = {
  full: "吃飽了",
  ok: "還不餓",
  hungry: "有點餓",
  starving: "餓壞了",
};

const UNAVAILABLE = "錢包現在打不開";

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

/** A neutral result card (written into the `/me i` panel when pressed there). */
function result(text: string): CommandReply {
  return cardReply([{ type: "text", text }], { accent: "neutral" });
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

  wallet(inv: Invocation): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const view = await economy.wallet(inv.invoker);
      // A stranger or a blocked person: the same plain line as the web page, no buttons.
      if (!view.can_earn) return notice("info", STRANGER);
      const price = (item: FeedItem) => view.shop.find((s) => s.id === item);
      const blocks: CardBlock[] = [
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
      return cardReply(blocks, { accent: "neutral", title: "錢包" });
    });
  }

  checkin(inv: Invocation): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const r = await economy.checkin(inv.invoker);
      const view = await economy.wallet(inv.invoker);
      return result(
        `簽到了，+${r.gained} ${view.currency}。連續 ${r.streak} 天，現在有 ${r.balance} ${view.currency}。`,
      );
    });
  }

  feed(inv: Invocation, item: FeedItem): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      // The platform does not hand a command its interaction id, so a press is its own key.
      const r = await economy.feed(inv.invoker, item, 1, `discord:${newId()}`);
      if (!r.accepted) return result(r.message);
      const view = await economy.wallet(inv.invoker);
      return result(`${r.message}，花了 ${r.charged} ${view.currency}，剩 ${r.balance}。`);
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
      const r = await economy.transfer(inv.invoker, to, amount, `discord:${newId()}`);
      const view = await economy.wallet(inv.invoker);
      return result(`轉了 ${r.sent} ${view.currency}給 ${r.to}，剩 ${r.balance}。`);
    });
  }

  /** `/me board`: the sponsor board; `on` joins or leaves it first. */
  board(inv: Invocation, on: boolean | null): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      if (on !== null && !(await economy.setOnBoard(inv.invoker, on))) {
        return notice("info", STRANGER);
      }
      const [lines, view] = await Promise.all([
        economy.board(BOARD_PLACES),
        economy.wallet(inv.invoker),
      ]);
      const text =
        lines.length === 0
          ? "還沒有人上榜"
          : lines.map((l) => `${l.rank}. ${l.name}　${l.spent}`).join("\n");
      const blocks: CardBlock[] = [
        { type: "text", text },
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
              ? { id: componentId(R.board, "off"), label: "退出排行榜" }
              : { id: componentId(R.board, "on"), label: "加入排行榜", style: "primary" },
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
      const r = await economy.screenMessage(inv.invoker, text, `discord:${newId()}`);
      if (!r.accepted) return result(r.message);
      const view = await economy.wallet(inv.invoker);
      return result(`${r.message}，花了 ${r.charged} ${view.currency}，剩 ${r.balance}。`);
    });
  }

  /** `/me letter`: a short letter to her (paid; the answer is only for the sender). */
  letter(inv: Invocation): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const text = inv.str("text")?.trim() ?? "";
      if (text === "") return notice("warn", "要寫什麼?");
      const r = await economy.letter(inv.invoker, text, `discord:${newId()}`);
      if (!r.accepted) return result(r.message);
      const view = await economy.wallet(inv.invoker);
      return result(`${r.message}，花了 ${r.charged} ${view.currency}，剩 ${r.balance}。`);
    });
  }

  /** `/me goals`: her open goal (and the last one that ended), with quick pledge buttons. */
  goals(inv: Invocation): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const [goals, view] = await Promise.all([
        economy.goals(inv.invoker),
        economy.wallet(inv.invoker),
      ]);
      const open = goals.find((g) => g.status === "open");
      const ended = goals.find((g) => g.status !== "open");
      const blocks: CardBlock[] = [];
      if (open) {
        blocks.push({ type: "text", text: goalText(open, view.currency) });
        if (view.can_earn) {
          blocks.push({
            type: "buttons",
            buttons: PLEDGE_BUTTONS.map(
              (n): CardButton => ({
                id: componentId(R.pledge, open.id, String(n)),
                label: `投 ${n}`,
              }),
            ),
          });
        }
      } else {
        blocks.push({ type: "text", text: "她現在沒有開著的目標" });
      }
      if (ended) blocks.push({ type: "muted", text: `上一個：${goalEnded(ended)}` });
      return cardReply(blocks, { accent: "neutral", title: "她的目標" });
    });
  }

  /** `/me pledge`: coins to the open goal (the answer is only for the sender). */
  pledge(inv: Invocation, amount: number | null, goalId: string | null): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      if (amount === null) return notice("warn", "要投多少?");
      const id =
        goalId ?? (await economy.goals(inv.invoker)).find((g) => g.status === "open")?.id ?? null;
      if (id === null) return notice("info", "她現在沒有開著的目標");
      const r = await economy.pledge(inv.invoker, id, amount, `discord:${newId()}`);
      const view = await economy.wallet(inv.invoker);
      const tail = r.reached ? "目標到了。" : "";
      return result(
        `投了 ${r.pledged} ${view.currency}，現在 ${r.raised} / ${r.target}，剩 ${r.balance}。${tail}`,
      );
    });
  }

  /** `/me bounties`: what she has posted. */
  bounties(): Promise<CommandReply> {
    return this.#guard(async (economy) => {
      const list = (await economy.bounties()).slice(0, BOUNTY_PLACES);
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

/** One goal as lines: title, promise, progress, deadline, what this person put in. */
export function goalText(g: GoalView, currency: string): string {
  const lines = [
    `**${g.title}**`,
    `她答應：${g.promise}`,
    `${g.raised} / ${g.target} ${currency}　到 ${when(g.deadline)}`,
  ];
  if (g.my_pledge > 0) lines.push(`你投了 ${g.my_pledge}`);
  return lines.join("\n");
}

function goalEnded(g: GoalView): string {
  const word = {
    reached: "達成了",
    expired: "沒湊滿，已退回",
    cancelled: "取消了，已退回",
    open: "",
  }[g.status];
  return `${g.title}　${word}`;
}

function unregister(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
  unregisterV2(registry);
}

function register(registry: CommandRegistry, handler: Handler): void {
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
    defineRoute<boolean>({
      route: R.board,
      parse: (p) => (p[0] === "on" ? true : p[0] === "off" ? false : null),
      handle: async (inv, on) => ComponentResult.reply(await handler.board(inv, on)),
    }),
  ];
  const goalRoutes: AnyComponentRoute[] = [
    defineRoute<{ goal: string; amount: number }>({
      route: R.pledge,
      ephemeral: true,
      parse: (p) => {
        const amount = Number(p[1]);
        return p[0] && PLEDGE_BUTTONS.some((n) => n === amount) ? { goal: p[0], amount } : null;
      },
      handle: async (inv, { goal, amount }) =>
        ComponentResult.reply(await handler.pledge(inv, amount, goal)),
    }),
  ];
  registry.register(
    commandSpec("me wallet", "你的魚幣：餘額、今天還能賺多少，可以簽到和餵她", {
      permission: WALLET_NODE,
    }),
    (inv) => handler.wallet(inv),
    { components: routes },
  );
  registry.register(
    commandSpec("me checkin", "每日簽到，領魚幣", { permission: WALLET_NODE }),
    (inv) => handler.checkin(inv),
  );
  registry.register(
    commandSpec("me feed", "用魚幣餵她一碗飯", {
      args: [argSpec("item", "要餵什麼", ArgKind.choice(FEED_ITEMS))],
      permission: WALLET_NODE,
    }),
    (inv) => {
      const item = inv.str("item");
      return isFeedItem(item)
        ? handler.feed(inv, item)
        : Promise.resolve(notice("warn", "沒有這種食物"));
    },
  );
  registry.register(
    commandSpec("me give", "把魚幣轉給她認識的另一個人", {
      args: [
        argSpec("user", "要轉給誰", ArgKind.user),
        argSpec("amount", "多少魚幣", ArgKind.integer),
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
      ],
      permission: WALLET_NODE,
    }),
    (inv) => {
      const join = inv.str("join");
      return handler.board(inv, join === "on" ? true : join === "off" ? false : null);
    },
    { components: boardRoutes },
  );
  registry.register(
    commandSpec("me screen", "花魚幣在直播大螢幕上留一則短留言（60 字內）", {
      args: [argSpec("text", "留言", ArgKind.string)],
      permission: WALLET_NODE,
    }),
    (inv) => handler.screen(inv),
  );
  registry.register(
    commandSpec("me letter", `花魚幣寫一封信給她（${MAX_LETTER_CHARS} 字內，她有空會看）`, {
      args: [argSpec("text", "信的內容", ArgKind.string)],
      permission: WALLET_NODE,
      ephemeral: true,
    }),
    (inv) => handler.letter(inv),
  );
  registry.register(
    commandSpec("me goals", "她現在的目標：要做什麼、湊到哪、你投了多少", {
      permission: WALLET_NODE,
    }),
    (inv) => handler.goals(inv),
    { components: goalRoutes },
  );
  registry.register(
    commandSpec("me pledge", "把魚幣投給她現在的目標", {
      args: [argSpec("amount", "多少魚幣", ArgKind.integer)],
      permission: WALLET_NODE,
      ephemeral: true,
    }),
    (inv) => handler.pledge(inv, inv.int("amount"), null),
  );
  registry.register(commandSpec("me bounties", "她貼著的懸賞", { permission: WALLET_NODE }), () =>
    handler.bounties(),
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
