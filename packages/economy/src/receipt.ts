// Receipt cards: what moved in coins, shown to everyone as a neutral card next to her reply.
//
// She used to read the amounts out herself ("扣了你 20 幣,你還剩 80"): from a tool result only
// she saw, so the numbers came out in her voice and her words. Money is a system fact; the card
// says it, and she only reacts (the action executor posts `ActionResult.receipt` where the turn
// is and tells her so: `@miyoria/actions` registry).

import { type CardBlock, type CommandReply, cardReply } from "@miyoria/commands";
import type { AccountRef } from "@miyoria/types";

/** Somebody on the card: a Discord mention (rendered, never pinging), else a neutral word. */
export function someone(account: AccountRef | null): string {
  return account !== null && account.platform === "discord" && /^[1-9]\d*$/.test(account.id)
    ? `<@${account.id}>`
    : "對方";
}

/** A receipt: a bold title, one line of what happened, and the numbers in a muted line. */
export function receipt(title: string, line: string, numbers?: string | null): CommandReply {
  const blocks: CardBlock[] = [{ type: "text", text: `**${title}**\n${line}` }];
  if (numbers) blocks.push({ type: "muted", text: numbers });
  return cardReply(blocks, { accent: "neutral" });
}
