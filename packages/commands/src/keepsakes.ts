// `/me card` and `/me fortune` (docs/design/v4-plan.md §9.3): the card she gives and today's
// fortune slip, the same ones the member page gives, through the `Keepsakes` service the api
// module provides. Without it (api off, no wallet) the answer is a neutral notice.
//
// Both answers are neutral cards only the person sees; what she wrote is shown as written. `/me
// card` shows today's card and issues one only when there is none yet today; with `action` it
// issues another one today (`foil` makes it a foil card, paid) or rerolls today's newest (paid).
// A chosen picture stays on the member page: it is picked by looking at the pictures. `/me
// fortune` draws once a day and shows the same slip when asked again, for nothing.

import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import {
  type KeepsakeCard,
  type KeepsakeCards,
  type KeepsakeFortune,
  type KeepsakeResult,
  KeepsakesKey,
  newId,
} from "@miyoria/types";
import type { CommandRegistry } from "./registry.js";
import { type CardBlock, type CommandReply, cardReply, notice } from "./reply.js";
import { ArgKind, argSpec, commandSpec, type Invocation } from "./spec.js";

const log = getLogger("commands.keepsakes");

/** Members have these through `me.*`. */
export const CARD_NODE = "me.card";
export const FORTUNE_NODE = "me.fortune";

const UNAVAILABLE = "這個功能現在不能用。";

/** `/me card action:…`: another card today, or today's newest written again. */
export const CARD_NEW = "再發一張";
export const CARD_REROLL = "重抽";

/** What it cost, under the card. */
function paidLine(charged: number, balance: number | null): CardBlock | null {
  if (charged <= 0) return null;
  return { type: "muted", text: `花了 ${charged}${balance === null ? "" : `，剩 ${balance}`}` };
}

function cardText(card: KeepsakeCard): CardBlock[] {
  const head = [`第 ${card.number} 張`, card.relationship, card.foil ? "閃卡" : null]
    .filter((x) => x !== null && x !== "")
    .join("　");
  const lines = [head];
  if (card.line) lines.push(card.line);
  if (card.fields.length > 0)
    lines.push(card.fields.map((f) => `${f.label}：${f.text}`).join("\n"));
  const blocks: CardBlock[] = [{ type: "text", text: lines.join("\n") }];
  blocks.push({ type: "muted", text: `編號 ${card.serial}` });
  return blocks;
}

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

/** Under today's card: how many were given, and what else `/me card` can do. */
function todayHint(today: KeepsakeCards): string {
  const parts = [`今天發了 ${today.today} / ${today.per_day} 張。`];
  if (today.today < today.per_day) {
    const foil = today.prices.foil === null ? "" : `，加 foil 做成閃卡（${today.prices.foil}）`;
    parts.push(`要再一張用 action:${CARD_NEW}${foil}。`);
  }
  if (today.rerolls_left > 0 && today.prices.reroll !== null) {
    parts.push(
      `想請她重寫這張用 action:${CARD_REROLL}（${today.prices.reroll}，今天還能 ${today.rerolls_left} 次）。`,
    );
  }
  parts.push("選圖到會員頁。");
  return parts.join("");
}

/** A refusal is plain information; only "not now" is a warning. */
function refusal(result: Extract<KeepsakeResult<unknown>, { ok: false }>): CommandReply {
  return notice(result.status >= 500 ? "warn" : "info", result.message);
}

export function registerKeepsakes(registry: CommandRegistry, services: ServiceLookup): void {
  const who = (inv: Invocation) => ({
    account: inv.invoker,
    name: inv.invoker_display_name,
    avatar_url: null,
  });
  const guard = async (run: () => Promise<CommandReply>): Promise<CommandReply> => {
    try {
      return await run();
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "a keepsake command failed");
      return notice("warn", UNAVAILABLE);
    }
  };

  registry.register(
    commandSpec("me card", "她給你的卡片：今天還沒有就發一張，有了就看今天的", {
      permission: CARD_NODE,
      ephemeral: true,
      args: [
        argSpec(
          "action",
          `${CARD_NEW}：今天再發一張新卡；${CARD_REROLL}：今天最新那張請她重寫（要花魚幣）`,
          ArgKind.choice([CARD_NEW, CARD_REROLL]),
          { required: false },
        ),
        argSpec("foil", "新卡做成閃卡（要花魚幣）", ArgKind.boolean, { required: false }),
      ],
    }),
    (inv) =>
      guard(async () => {
        const keepsakes = services.get(KeepsakesKey);
        if (!keepsakes) return notice("info", UNAVAILABLE);
        const action = inv.str("action");
        const foil = inv.bool("foil") === true;
        const key = `discord:${newId()}`;
        if (action === CARD_REROLL) {
          if (foil) return notice("info", "閃卡要用「再發一張」發新卡；重抽只會請她重寫今天那張。");
          const redone = await keepsakes.rerollCard(who(inv), key);
          if (!redone.ok) return refusal(redone);
          const blocks = cardText(redone.value);
          const paid = paidLine(redone.charged, redone.balance);
          if (paid) blocks.push(paid);
          return cardReply(blocks, { accent: "neutral", title: "重抽的卡片" });
        }
        const today = await keepsakes.cardsToday(inv.invoker);
        const fresh = action !== CARD_NEW && !foil;
        if (fresh && today.latest !== null && today.today > 0) {
          const blocks = cardText(today.latest);
          blocks.push({ type: "muted", text: todayHint(today) });
          return cardReply(blocks, { accent: "neutral", title: "你的卡片" });
        }
        const issued = await keepsakes.issueCard(who(inv), key, { foil });
        if (!issued.ok) return refusal(issued);
        const blocks = cardText(issued.value);
        const paid = paidLine(issued.charged, issued.balance);
        if (paid) blocks.push(paid);
        return cardReply(blocks, { accent: "neutral", title: "你的卡片" });
      }),
  );

  registry.register(
    commandSpec("me fortune", "抽今天的籤詩（一天一支，要花魚幣；再問一次還是同一支）", {
      permission: FORTUNE_NODE,
      ephemeral: true,
    }),
    (inv) =>
      guard(async () => {
        const keepsakes = services.get(KeepsakesKey);
        if (!keepsakes) return notice("info", UNAVAILABLE);
        const drawn = await keepsakes.drawFortune(who(inv), `discord:${newId()}`);
        if (!drawn.ok) return refusal(drawn);
        const blocks = slipText(drawn.value);
        if (drawn.charged > 0) {
          blocks.push({
            type: "muted",
            text: `花了 ${drawn.charged}${drawn.balance === null ? "" : `，剩 ${drawn.balance}`}`,
          });
        }
        return cardReply(blocks, { accent: "neutral", title: "今日籤詩" });
      }),
  );
}
