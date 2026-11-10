// The Discord side of economy 2.0 (docs/design/v4-plan.md §10): `/me quests`, `/me draw` and the
// rest. Same rules as commands.ts: neutral cards, a stranger gets the plain line, the answer to
// anything that moves coins is only for whoever pressed it, and every spend carries a fresh key.

import {
  ArgKind,
  argSpec,
  type CardBlock,
  type CommandRegistry,
  type CommandReply,
  cardReply,
  commandSpec,
  type Invocation,
  notice,
  typedCommand,
} from "@miyoria/commands";
import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import { newId } from "@miyoria/types";
import { STRANGER, WALLET_NODE } from "./economy.js";
import { NO_RECEIVER } from "./transfer.js";
import { EconomyError } from "./types.js";
import { COMMISSION_KINDS, type CommissionKind, type Economy2, Economy2Key } from "./v2-types.js";

const log = getLogger("economy.commands.v2");

export const V2_PATHS = [
  "me quests",
  "me draw",
  "me album",
  "me giveitem",
  "me titles",
  "me predictions",
  "me bet",
  "me commission",
  "me commissions",
  "me room",
  "me shop",
] as const;

const UNAVAILABLE = "錢包現在打不開";

/**
 * What to type for `path` where `inv` came from: Discord regrouped these commands under
 * `/me play` (it allows 25 subcommands per command), other places keep `/me <name>`.
 */
const typed = (inv: Invocation, path: string): string => typedCommand(path, inv.invoker.platform);
/** The same for static texts (descriptions), which are what Discord shows. */
const onDiscord = (path: string): string => typedCommand(path, "discord");

class Handler2 {
  constructor(readonly services: ServiceLookup) {}

  /** An answer: refusals are plain information, not errors. */
  async guard(run: (e: Economy2) => Promise<CommandReply>): Promise<CommandReply> {
    const e = this.services.get(Economy2Key);
    if (!e) return notice("warn", UNAVAILABLE);
    try {
      return await run(e);
    } catch (error) {
      if (error instanceof EconomyError) {
        return error.status === 503 ? notice("warn", error.message) : notice("info", error.message);
      }
      log.warn({ error: errorMessage(error) }, "an economy 2.0 command failed");
      return notice("warn", UNAVAILABLE);
    }
  }

  quests(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const view = await e.quests(inv.invoker);
      if (view.quests.length === 0) return notice("info", STRANGER);
      const lines = view.quests.map((q) => `${q.done ? "✅" : "⬜"} ${q.label}`);
      const blocks: CardBlock[] = [
        { type: "text", text: lines.join("\n") },
        {
          type: "muted",
          text: `每個 ${view.reward}，三個都完成再加 ${view.bonus}${view.bonus_done ? "（已拿到）" : ""}；今天任務賺了 ${view.earned_today} / ${view.cap}。「聊一件新的事」由她判斷。`,
        },
      ];
      return cardReply(blocks, { accent: "neutral", title: "今天的任務" });
    });
  }

  /** `/me draw`: one draw; the answer is public like feeding her, the odds are on `/me album`. */
  draw(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      // The platform does not hand a command its interaction id, so a press is its own key.
      const r = await e.draw(inv.invoker, `discord:${newId()}`);
      const tail = r.new ? "新的一個" : "重複的，可以送給別人";
      return cardReply(
        [
          {
            type: "text",
            text: `**${r.item.label}**　${r.item.rarity}　${r.item.series}\n${tail}${r.by_pity ? "（保底）" : ""}`,
          },
          { type: "muted", text: `花了 ${r.charged} ${e.currency}，剩 ${r.balance}` },
        ],
        { accent: "neutral", title: "抽收藏" },
      );
    });
  }

  /** `/me album`: the person's own album, the odds and how close the pity is. */
  album(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const a = await e.album(inv.invoker);
      if (!a.member) return notice("info", STRANGER);
      const lines = a.series.map((s) => {
        const items = s.items.map((i) =>
          i.owned > 0 ? `${i.label}${i.owned > 1 ? `×${i.owned}` : ""}` : "？？？",
        );
        const title = s.complete ? `　稱號「${s.title}」` : "";
        return `**${s.label}** ${s.owned_distinct}/${s.total}${title}\n${items.join("、")}`;
      });
      const odds = a.odds.map((o) => `${o.rarity} ${o.percent}%`).join("　");
      const pity =
        a.pity > 0 ? `　連續 ${a.pity} 次沒有 SR 以上一定出 SR（目前 ${a.since_best} 次）` : "";
      return cardReply(
        [
          { type: "text", text: lines.join("\n\n") },
          {
            type: "muted",
            text: `抽一次 ${a.price} ${e.currency}，今天 ${a.draws_today} / ${a.draws_per_day}。機率　${odds}${pity}。稀有度只是標籤，不是她對你的感覺。`,
          },
        ],
        { accent: "neutral", title: "收藏冊" },
      );
    });
  }

  /** `/me giveitem`: a spare copy to another member (the answer is only for the sender). */
  giveItem(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const to = inv.account("user");
      const item = inv.str("item")?.trim() ?? "";
      if (to === null || item === "") return notice("warn", "要送給誰、送哪一個?");
      // The option is a Discord user; another platform's account is not someone one can reach.
      if (to.platform !== inv.invoker.platform) return notice("info", NO_RECEIVER);
      const r = await e.giveItem(inv.invoker, to, item, `discord:${newId()}`);
      return cardReply([{ type: "text", text: `把「${r.label}」送給了 ${r.to}` }], {
        accent: "neutral",
      });
    });
  }

  /** `/me predictions`: what is open to stake on, and how the stakes lie. */
  predictions(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const list = await e.predictions(inv.invoker);
      if (list.length === 0) {
        return cardReply([{ type: "text", text: "現在沒有預測" }], { accent: "neutral" });
      }
      const lines = list.map((p) => {
        const state =
          p.status === "open"
            ? `到 <t:${Math.floor(Date.parse(p.closes_at) / 1000)}:R> 截止`
            : p.status === "closed"
              ? "已截止，等結果"
              : p.status === "resolved"
                ? `結果：${p.winner}`
                : "取消了";
        const options = p.options
          .map((o, i) => `${i + 1}. ${o.label}　${o.staked}（${o.backers} 人）`)
          .join("\n");
        const mine = p.my_bet ? `\n你押了 ${p.my_bet.amount} 在「${p.my_bet.option}」` : "";
        return `**[${p.id}] ${p.question}**　${state}\n${options}${mine}`;
      });
      return cardReply(
        [
          { type: "text", text: lines.join("\n\n") },
          {
            type: "muted",
            text: `猜中的人平分大家押的，不是她出錢；沒人猜中或取消就全部退回。用 ${typed(inv, "me bet")} 押。`,
          },
        ],
        { accent: "neutral", title: "預測" },
      );
    });
  }

  /** `/me bet`: a stake (the answer is only for the sender). */
  bet(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const prediction = inv.str("prediction")?.trim() ?? "";
      const option = inv.str("option")?.trim() ?? "";
      const amount = inv.int("amount");
      if (prediction === "" || option === "" || amount === null) {
        return notice("warn", "要押哪個預測的哪個選項、押多少？");
      }
      const r = await e.placeBet(inv.invoker, prediction, option, amount, `discord:${newId()}`);
      const line = `押了「${r.question}」的「${r.option}」${r.amount} ${e.currency}，剩 ${r.balance}。`;
      return cardReply([{ type: "text", text: line }], { accent: "neutral" });
    });
  }

  /** `/me commission`: pay to ask her for one thing. */
  commission(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const kind = inv.str("kind")?.trim() ?? "";
      const brief = inv.str("brief")?.trim() ?? "";
      if (!COMMISSION_KINDS.includes(kind as CommissionKind) || brief === "") {
        const menu = e.commissionMenu().map((m) => `${m.kind} ${m.label} ${m.price}`);
        return notice(
          "info",
          `要選種類並寫清楚想要什麼。可以委託的：${menu.join("、") || "現在都不接"}`,
        );
      }
      const r = await e.commission(
        inv.invoker,
        kind as CommissionKind,
        brief,
        `discord:${newId()}`,
      );
      return cardReply(
        [
          { type: "text", text: `委託她${r.label}，她收到了` },
          {
            type: "muted",
            text: `花了 ${r.price} ${e.currency}，剩 ${r.balance}。她不想做會全額退回。`,
          },
        ],
        { accent: "neutral", title: "委託" },
      );
    });
  }

  /** `/me commissions`: the person's own, with what she handed in. */
  commissions(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const list = await e.commissions(inv.invoker);
      if (list.length === 0) return notice("info", "還沒有委託過她");
      const state = {
        open: "等她做",
        delivered: "完成了",
        declined: "她沒接，退回了",
        expired: "沒來得及，退回了",
      };
      const lines = list.map(
        (c) =>
          `**[${c.id}] ${c.label}**　${state[c.status]}\n「${c.brief}」${c.result ? `\n${c.result}` : ""}${c.note ? `\n（${c.note}）` : ""}`,
      );
      return cardReply([{ type: "text", text: lines.join("\n\n") }], {
        accent: "neutral",
        title: "你的委託",
      });
    });
  }

  /** `/me room`: where the audience got with her room; with `item` and `amount`, puts coins in. */
  room(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const item = inv.str("item")?.trim() ?? "";
      const amount = inv.int("amount");
      if (item !== "" && amount !== null) {
        const r = await e.fundRoom(inv.invoker, item, amount, `discord:${newId()}`);
        const left = r.item.placed
          ? "湊齊了，放進她的房間了"
          : `${r.item.funded} / ${r.item.price}`;
        return cardReply(
          [
            { type: "text", text: `出了 ${r.charged} ${e.currency}給「${r.item.label}」，${left}` },
            { type: "muted", text: `剩 ${r.balance}` },
          ],
          { accent: "neutral", title: "她的房間" },
        );
      }
      const list = await e.room();
      const lines = list.map(
        (i) =>
          `**${i.label}**（${i.kind_label}）${i.placed ? "　已經在房間裡" : `　${i.funded} / ${i.price}，${i.backers} 人出了`}`,
      );
      return cardReply(
        [
          { type: "text", text: lines.join("\n") },
          {
            type: "muted",
            text: `大家一起出錢佈置她的房間，花掉就不退；出多出少她都一樣。用 ${typed(inv, "me room")} 填 item 和 amount 出錢。`,
          },
        ],
        { accent: "neutral", title: "她的房間" },
      );
    });
  }

  /** `/me shop`: this week's shelf; with `item`, buys it. */
  shop(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const item = inv.str("item")?.trim() ?? "";
      if (item !== "") {
        const r = await e.buyFromShop(inv.invoker, item, `discord:${newId()}`);
        return cardReply(
          [
            { type: "text", text: `買了「${r.item.label}」` },
            { type: "muted", text: `花了 ${r.charged} ${e.currency}，剩 ${r.balance}` },
          ],
          { accent: "neutral", title: "她的小店" },
        );
      }
      const v = await e.shop(inv.invoker);
      const lines = v.items.map((i) => {
        const have = i.owned === true || (typeof i.owned === "number" && i.owned > 0);
        return `**${i.label}**（${i.kind === "title" ? "稱號" : "收藏"}）　${i.price} ${e.currency}${have ? "　已經有了" : ""}`;
      });
      return cardReply(
        [
          { type: "text", text: lines.join("\n") },
          {
            type: "muted",
            text: `每個禮拜換一批，下次 <t:${Math.floor(Date.parse(v.renews_at) / 1000)}:R>。買東西不會改變她對你的感覺。用 ${typed(inv, "me shop")} 填 item 買。`,
          },
        ],
        { accent: "neutral", title: "她的小店" },
      );
    });
  }

  /** `/me titles`: the titles held and the achievements still ahead. */
  titles(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const view = await e.achievements(inv.invoker);
      if (view.achievements.length === 0) return notice("info", STRANGER);
      const done = view.achievements.filter((a) => a.unlocked_at !== null);
      const ahead = view.achievements.filter((a) => a.unlocked_at === null);
      const have =
        view.titles.length === 0
          ? "還沒有稱號"
          : `稱號：${view.titles.map((t) => `「${t}」`).join("")}\n${done.map((a) => `✅ ${a.label}`).join("\n")}`;
      const blocks: CardBlock[] = [
        { type: "text", text: have },
        {
          type: "muted",
          text: `還沒達成：${ahead.map((a) => `${a.label}（+${a.reward}）`).join("、") || "都達成了"}`,
        },
      ];
      return cardReply(blocks, { accent: "neutral", title: "成就和稱號" });
    });
  }
}

export function unregisterV2(registry: CommandRegistry): void {
  for (const path of V2_PATHS) registry.unregister(path);
}

export function registerV2(registry: CommandRegistry, services: ServiceLookup): void {
  const handler = new Handler2(services);
  registry.register(
    commandSpec("me quests", "今天的三個小任務：聊新的事、玩遊戲、聽完一首歌", {
      permission: WALLET_NODE,
    }),
    (inv) => handler.quests(inv),
  );
  registry.register(
    commandSpec(
      "me draw",
      `花魚幣抽一次收藏（眼鏡、背景、手上的東西…），機率在 ${onDiscord("me album")}`,
      {
        permission: WALLET_NODE,
      },
    ),
    (inv) => handler.draw(inv),
  );
  registry.register(
    commandSpec("me album", "你的收藏冊、抽收藏的機率和保底", {
      permission: WALLET_NODE,
      ephemeral: true,
    }),
    (inv) => handler.album(inv),
  );
  registry.register(
    commandSpec("me giveitem", "把重複的收藏送給她認識的另一個人（只送重複的）", {
      args: [
        argSpec("user", "要送給誰", ArgKind.user),
        argSpec("item", "哪一個收藏（名字）", ArgKind.string),
      ],
      permission: WALLET_NODE,
      ephemeral: true,
    }),
    (inv) => handler.giveItem(inv),
  );
  registry.register(
    commandSpec("me predictions", "現在能押的預測：選項、押了多少、你押了什麼", {
      permission: WALLET_NODE,
    }),
    (inv) => handler.predictions(inv),
  );
  registry.register(
    commandSpec("me bet", "押魚幣猜預測的結果（猜中的人平分大家押的）", {
      args: [
        argSpec("prediction", `預測的代號（${onDiscord("me predictions")} 看）`, ArgKind.string),
        argSpec("option", "選項的號碼或名字", ArgKind.string),
        argSpec("amount", "押多少魚幣", ArgKind.integer),
      ],
      permission: WALLET_NODE,
      ephemeral: true,
    }),
    (inv) => handler.bet(inv),
  );
  registry.register(
    commandSpec("me commission", "付魚幣委託她做一件事（她不做會全額退回）", {
      args: [
        argSpec(
          "kind",
          "poem 詩、name 取名、tool 小工具、song 唱歌、voice 一句語音",
          ArgKind.string,
        ),
        argSpec("brief", "想請她做什麼", ArgKind.string),
      ],
      permission: WALLET_NODE,
    }),
    (inv) => handler.commission(inv),
  );
  registry.register(
    commandSpec("me commissions", "你委託過她的事和她交的成品", {
      permission: WALLET_NODE,
      ephemeral: true,
    }),
    (inv) => handler.commissions(inv),
  );
  registry.register(
    commandSpec("me room", "看她的房間大家湊到哪了，或出魚幣一起佈置", {
      args: [
        argSpec("item", "要出錢的東西（名字或代號），不填就只看", ArgKind.string, {
          required: false,
        }),
        argSpec("amount", "出多少魚幣", ArgKind.integer, { required: false }),
      ],
      permission: WALLET_NODE,
    }),
    (inv) => handler.room(inv),
  );
  registry.register(
    commandSpec("me shop", "她這個禮拜的小店，或買一樣東西", {
      args: [
        argSpec("item", "要買的東西（名字或代號），不填就只看", ArgKind.string, {
          required: false,
        }),
      ],
      permission: WALLET_NODE,
    }),
    (inv) => handler.shop(inv),
  );
  registry.register(
    commandSpec("me titles", "你的稱號和成就", { permission: WALLET_NODE, ephemeral: true }),
    (inv) => handler.titles(inv),
  );
}
