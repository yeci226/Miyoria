// `/me card` and `/me fortune` (docs/design/v4-plan.md §9.3): the card she gives and today's
// fortune slip, the same ones the member page gives, through the `Keepsakes` service the api
// module provides. Without it (api off, no wallet) the answer is a neutral notice.
//
// Both answers are neutral cards only the person sees; what she wrote is shown as written. `/me
// card` shows today's card and issues one only when there is none yet today (more cards, and a
// chosen picture or a foil finish, are on the member page); `/me fortune` draws once a day and
// shows the same slip when asked again, for nothing.

import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import {
  type KeepsakeCard,
  type KeepsakeFortune,
  type KeepsakeResult,
  KeepsakesKey,
  newId,
} from "@miyoria/types";
import type { CommandRegistry } from "./registry.js";
import { type CardBlock, type CommandReply, cardReply, notice } from "./reply.js";
import { commandSpec, type Invocation } from "./spec.js";

const log = getLogger("commands.keepsakes");

/** Members have these through `me.*`. */
export const CARD_NODE = "me.card";
export const FORTUNE_NODE = "me.fortune";

const UNAVAILABLE = "這個功能現在不能用。";

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
    }),
    (inv) =>
      guard(async () => {
        const keepsakes = services.get(KeepsakesKey);
        if (!keepsakes) return notice("info", UNAVAILABLE);
        const today = await keepsakes.cardsToday(inv.invoker);
        if (today.latest !== null && today.today > 0) {
          const blocks = cardText(today.latest);
          blocks.push({
            type: "muted",
            text: `今天發了 ${today.today} / ${today.per_day} 張。要選圖或做成閃卡，到會員頁。`,
          });
          return cardReply(blocks, { accent: "neutral", title: "你的卡片" });
        }
        const issued = await keepsakes.issueCard(who(inv), `discord:${newId()}`);
        if (!issued.ok) return refusal(issued);
        return cardReply(cardText(issued.value), { accent: "neutral", title: "你的卡片" });
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
