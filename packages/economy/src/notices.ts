// What people see when they earned something they did not ask for in that moment: an achievement
// unlocked, a daily quest done by sitting through a song or playing a game, coins for a song they
// requested, a goal they pledged to that got met.
//
// * Earned through something they did (a command, her tool): a muted line on that answer, never a
//   second card (`unlockLines`, `bonusLine`).
// * Earned by an event (a song sung to the end, a game over, a goal met): ONE neutral card for the
//   whole event where it happened, everyone on it (`eventCard`, `postCard`). Mentions render but
//   never ping (`someone`, and the platform sends cards without pings).
// * No known place, no card: a background sweep posts nothing, and a channel is never guessed.

import { type CardBlock, type CommandReply, cardReply, ReplySinkKey } from "@miyoria/commands";
import { errorMessage } from "@miyoria/kernel";
import type { AccountRef, ContextKey } from "@miyoria/types";
import type { EconomyService } from "./economy.js";
import { someone } from "./receipt.js";
import type { AchievementUnlocked, QuestResult } from "./v2-types.js";

/** One unlock: `🏅 解鎖「連續簽到 30 天」,稱號「全勤」+100`, with who on a shared card. */
export function unlockLine(u: AchievementUnlocked, who: AccountRef | null = null): string {
  return `🏅 ${who === null ? "" : `${someone(who)} `}解鎖「${u.label}」,稱號「${u.title}」+${u.paid}`;
}

export function unlockLines(
  list: readonly AchievementUnlocked[] | undefined,
  who: AccountRef | null = null,
): string[] {
  return (list ?? []).map((u) => unlockLine(u, who));
}

/** All three daily quests done: `三個任務都完成,再加 15 🎉` (`who` first on a shared card). */
export function bonusLine(bonus: number, who = ""): string {
  return `${who === "" ? "" : `${who} `}三個任務都完成,再加 ${bonus} 🎉`;
}

/** Lines for a muted block, or `null` when there are none. */
export function mutedText(lines: readonly (string | null | undefined)[]): string | null {
  const kept = lines.filter((l): l is string => typeof l === "string" && l !== "");
  return kept.length === 0 ? null : kept.join("\n");
}

/** What one person got out of an event. */
export interface Earned {
  account: AccountRef;
  paid: number;
}

/** `@a +10`, `@a @b 各 +10`, or `@a +10 @b +5` when the amounts differ. */
export function amounts(list: readonly Earned[]): string {
  const first = list[0];
  if (first === undefined) return "";
  if (list.length > 1 && list.every((e) => e.paid === first.paid)) {
    return `${list.map((e) => someone(e.account)).join(" ")} 各 +${first.paid}`;
  }
  return list.map((e) => `${someone(e.account)} +${e.paid}`).join(" ");
}

/** People who did a daily quest at one event, with what it paid and what it unlocked. */
export interface QuestDone {
  account: AccountRef;
  result: QuestResult;
}

/** The quests of an event: who got paid, and the muted extras (bonuses, unlocks). */
export function questParts(done: readonly QuestDone[]): {
  paid: Earned[];
  bonuses: string[];
  unlocks: string[];
} {
  const paid = done
    .filter((d) => d.result.status === "paid" && d.result.paid > 0)
    .map((d) => ({ account: d.account, paid: d.result.paid }));
  const byBonus = new Map<number, AccountRef[]>();
  for (const d of done) {
    if (d.result.bonus <= 0) continue;
    byBonus.set(d.result.bonus, [...(byBonus.get(d.result.bonus) ?? []), d.account]);
  }
  const bonuses = [...byBonus].map(([bonus, who]) =>
    bonusLine(bonus, who.map((a) => someone(a)).join(" ")),
  );
  const unlocks = done.flatMap((d) => unlockLines(d.result.unlocked, d.account));
  return { paid, bonuses, unlocks };
}

/** One card for one event: a bold title, who got what, the extras muted; `null` when empty. */
export function eventCard(
  title: string,
  lines: readonly string[],
  extras: readonly string[],
): CommandReply | null {
  if (lines.length === 0 && extras.length === 0) return null;
  const blocks: CardBlock[] = [{ type: "text", text: [`**${title}**`, ...lines].join("\n") }];
  const muted = mutedText(extras);
  if (muted !== null) blocks.push({ type: "muted", text: muted });
  return cardReply(blocks, { accent: "neutral" });
}

/**
 * Posts `card` where the event happened (not awaited: nothing waits for the platform). Nothing is
 * posted without a context, a card, or a platform that can post into that context.
 */
export function postCard(
  e: EconomyService,
  context: ContextKey | null | undefined,
  card: CommandReply | null,
): boolean {
  if (!context || card === null) return false;
  const sink = e.services.get(ReplySinkKey);
  if (!sink?.sendCard || sink.platform !== context.platform) return false;
  try {
    sink.sendCard(context, { ...card, ephemeral: false }).catch((error: unknown) => {
      e.log.warn({ err: errorMessage(error) }, "could not post an economy card");
    });
  } catch (error) {
    e.log.warn({ err: errorMessage(error) }, "could not post an economy card");
    return false;
  }
  return true;
}
