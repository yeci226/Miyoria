// The Discord side of economy 2.0 (docs/design/v4-plan.md §10): `/me quests`, `/me bet` and the
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
import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/runtime/kernel";
import { newId } from "@miyoria/types";
import { STRANGER, WALLET_NODE } from "./economy.js";
import { EconomyError, EconomyKey } from "./types.js";
import { type Economy2, Economy2Key } from "./v2-types.js";
import { coinName, pronounOf } from "./words.js";

const log = getLogger("economy.commands.v2");

export const V2_PATHS = ["me quests", "me titles", "me predictions", "me bet", "me room"] as const;

const UNAVAILABLE = "錢包現在打不開";

/**
 * What to type for `path` where `inv` came from: Discord regrouped these commands under
 * `/me play` (it allows 25 subcommands per command), other places keep `/me <name>`.
 */
const typed = (inv: Invocation, path: string): string => typedCommand(path, inv.invoker.platform);
/**
 * The same for static texts (descriptions): they are registered once, before anyone invokes, and
 * the platform that shows command descriptions is Discord.
 */
const onDiscord = (path: string): string => typedCommand(path, "discord");
/** A fresh idempotency key for a press, on the invoker's platform (`discord:<ulid>` on Discord). */
const pressKey = (inv: Invocation): string => `${inv.context.platform}:${newId()}`;

class Handler2 {
  constructor(readonly services: ServiceLookup) {}

  /** The servers a list shown where `inv` was run covers (`spaces.ts`); `undefined`: all. */
  async spaces(inv: Invocation): Promise<string[] | undefined> {
    return this.services.get(EconomyKey)?.spacesFor(inv.context, inv.invoker);
  }

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
      const view = await e.quests(inv.invoker, { pick: true });
      if (view.quests.length === 0) return notice("info", STRANGER);
      const lines = view.quests.map(
        (q) =>
          `${q.done ? "✅" : "⬜"} ${q.id === "her_pick" ? `她替你想的：${q.label}` : q.label}`,
      );
      const blocks: CardBlock[] = [
        { type: "text", text: lines.join("\n") },
        {
          type: "muted",
          text: `每個 ${view.reward}，三個都完成再加 ${view.bonus}${view.bonus_done ? "（已拿到）" : ""}；今天任務賺了 ${view.earned_today} / ${view.cap}。「聊一件新的事」和她替你想的那件由她判斷；「一起玩」要和別人一起玩完一場派對遊戲，或在語音裡一起聽她唱完一首歌。`,
        },
      ];
      return cardReply(blocks, { accent: "neutral", title: "今天的任務" });
    });
  }

  /**
   * `/me predictions`: what is open to stake on, and how the stakes lie: this server's (in a DM,
   * those of the servers the invoker is in, each named when there are several).
   */
  predictions(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const spaces = await this.spaces(inv);
      const list = await e.predictions(inv.invoker, spaces);
      const servers = new Set(list.map((p) => p.space?.id ?? null));
      const named = inv.context.scope === null && servers.size > 1;
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
        const how =
          p.status === "open" || p.status === "closed"
            ? p.settles.label
            : (p.settled_by?.note ?? "");
        const options = p.options
          .map((o, i) => `${i + 1}. ${o.label}　${o.staked}（${o.backers} 人）`)
          .join("\n");
        const mine = p.my_bet ? `\n你押了 ${p.my_bet.amount} 在「${p.my_bet.option}」` : "";
        const server = named && p.space?.name ? `\n-# 在「${p.space.name}」` : "";
        return `**[${p.id}] ${p.question}**　${state}${server}${how ? `\n-# ${how}` : ""}\n${options}${mine}`;
      });
      return cardReply(
        [
          { type: "text", text: lines.join("\n\n") },
          {
            type: "muted",
            text: `猜中的人平分大家押的（抽一點燒掉），不是她出錢；沒人猜中、取消或看不出結果就全部退回。用 ${typed(inv, "me bet")} 押。`,
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
      const r = await e.placeBet(inv.invoker, prediction, option, amount, pressKey(inv));
      const line = `押了「${r.question}」的「${r.option}」${r.amount} ${e.currency}，剩 ${r.balance}。`;
      return cardReply([{ type: "text", text: line }], { accent: "neutral" });
    });
  }

  /** `/me room`: where the audience got with her room; with `item` and `amount`, puts coins in. */
  room(inv: Invocation): Promise<CommandReply> {
    return this.guard(async (e) => {
      const item = inv.str("item")?.trim() ?? "";
      const amount = inv.int("amount");
      if (item !== "" && amount !== null) {
        const r = await e.fundRoom(inv.invoker, item, amount, pressKey(inv));
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
  const coin = coinName(services);
  const her = pronounOf(services);
  registry.register(
    commandSpec("me quests", "今天的三個小任務：聊新的事、和大家一起玩、她替你想的一件事", {
      permission: WALLET_NODE,
      // Her pick comes from what she remembers of them: only for whoever asked.
      ephemeral: true,
    }),
    (inv) => handler.quests(inv),
  );
  registry.register(
    commandSpec("me predictions", "現在能押的預測：選項、押了多少、你押了什麼", {
      permission: WALLET_NODE,
    }),
    (inv) => handler.predictions(inv),
  );
  registry.register(
    commandSpec("me bet", `押${coin}猜預測的結果（猜中的人平分大家押的）`, {
      args: [
        argSpec("prediction", `預測的代號（${onDiscord("me predictions")} 看）`, ArgKind.string),
        argSpec("option", "選項的號碼或名字", ArgKind.string),
        argSpec("amount", `押多少${coin}`, ArgKind.integer),
      ],
      permission: WALLET_NODE,
      ephemeral: true,
    }),
    (inv) => handler.bet(inv),
  );
  registry.register(
    commandSpec("me room", `看${her}的房間大家湊到哪了，或出${coin}一起佈置`, {
      args: [
        argSpec("item", "要出錢的東西（名字或代號），不填就只看", ArgKind.string, {
          required: false,
        }),
        argSpec("amount", `出多少${coin}`, ArgKind.integer, { required: false }),
      ],
      permission: WALLET_NODE,
    }),
    (inv) => handler.room(inv),
  );
  registry.register(
    commandSpec("me titles", "你的稱號和成就", { permission: WALLET_NODE, ephemeral: true }),
    (inv) => handler.titles(inv),
  );
}
