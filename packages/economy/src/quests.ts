// Three small quests a day (docs/design/v4-plan.md §10): talk to her about something new, take part
// in a game, hear a song to its end. Each pays `quest_reward`, all three add `quest_bonus`, and
// `quest_cap` is the day's most.
//
// A quest done is a ledger row: reason `quest`, ref the quest id (`new_topic:<topic>` for the
// first), key `quest:<day>:<id>`. So "done today" is read off the ledger and a replayed event or a
// restart pays nothing twice. The bonus row has ref `all`.
//
// Who says a quest is done: games tick `play_game` (play.ts pays them), the singer's end-of-song
// cue ticks `listen_song` for everyone who sat through it in her voice channel (earn.ts), and she
// herself ticks `new_topic` when she judges that the person told her about something new
// (`complete_quest`): a topic repeated within `quest_topic_days` does not count.

import type { AccountRef } from "@miyoria/types";
import type { EconomyService, Member } from "./economy.js";
import { EconomyError } from "./types.js";
import type { QuestId, QuestResult, QuestsView } from "./v2-types.js";

export const QUESTS: readonly { id: QuestId; label: string }[] = [
  { id: "new_topic", label: "跟她聊一件新的事" },
  { id: "play_game", label: "參加一場遊戲" },
  { id: "listen_song", label: "聽完一首歌" },
];

const MAX_ROWS = 2_000;
const MAX_TOPIC_CHARS = 40;

/** A topic as the repeat check compares it: lower case, no spaces or punctuation. */
export function topicKey(topic: string): string {
  const flat = topic.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  return [...flat].slice(0, MAX_TOPIC_CHARS).join("");
}

export class QuestDesk {
  constructor(private readonly e: EconomyService) {}

  async #doneToday(who: Member): Promise<Set<string>> {
    const rows = await this.e.ledger().entries(this.e.profile, who.wallet, {
      reasons: ["quest"],
      since: this.e.todayStart(),
      limit: MAX_ROWS,
    });
    return new Set(rows.map((r) => (r.ref ?? "").split(":")[0] ?? ""));
  }

  async view(account: AccountRef): Promise<QuestsView> {
    const c = this.e.config;
    const who = await this.e.member(account);
    const done = who ? await this.#doneToday(who) : new Set<string>();
    const earned = who
      ? (
          await this.e.ledger().entries(this.e.profile, who.wallet, {
            reasons: ["quest"],
            since: this.e.todayStart(),
            limit: MAX_ROWS,
          })
        ).reduce((n, r) => n + r.delta, 0)
      : 0;
    return {
      quests: who ? QUESTS.map((q) => ({ id: q.id, label: q.label, done: done.has(q.id) })) : [],
      reward: c.quest_reward,
      bonus: c.quest_bonus,
      bonus_done: done.has("all"),
      earned_today: earned,
      cap: c.quest_cap,
    };
  }

  /** The quest done for `account`; a stranger is answered, not thrown at. */
  async completeFor(account: AccountRef, id: QuestId, topic?: string): Promise<QuestResult> {
    const who = await this.e.member(account);
    if (!who) return { status: "stranger", paid: 0, bonus: 0, all_done: false };
    return this.complete(who, id, topic);
  }

  async complete(who: Member, id: QuestId, topic?: string): Promise<QuestResult> {
    const c = this.e.config;
    const day = this.e.today();
    let ref: string = id;
    if (id === "new_topic") {
      const key = topicKey(topic ?? "");
      if (key === "") throw new EconomyError(400, "要說是聊了什麼新的事");
      ref = `new_topic:${key}`;
    }
    const result = await this.e.serial(async (): Promise<QuestResult> => {
      const done = await this.#doneToday(who);
      if (done.has(id)) return { status: "done", paid: 0, bonus: 0, all_done: done.has("all") };
      if (id === "new_topic") {
        const since = this.e.dayStart(day - c.quest_topic_days);
        const rows = await this.e.ledger().entries(this.e.profile, who.wallet, {
          reasons: ["quest"],
          since,
          limit: MAX_ROWS,
        });
        if (rows.some((r) => r.ref === ref)) {
          return { status: "repeat", paid: 0, bonus: 0, all_done: false };
        }
      }
      const cap = { reasons: ["quest"], limit: c.quest_cap };
      const paid = await this.e.faucet(
        who,
        "quest",
        c.quest_reward,
        `quest:${day}:${id}`,
        ref,
        cap,
        true,
      );
      if (paid.status !== "paid") return { status: "capped", paid: 0, bonus: 0, all_done: false };
      done.add(id);
      let bonus = 0;
      if (QUESTS.every((q) => done.has(q.id)) && !done.has("all")) {
        const b = await this.e.faucet(
          who,
          "quest",
          c.quest_bonus,
          `quest:${day}:all`,
          "all",
          cap,
          true,
        );
        bonus = b.paid;
        if (b.status === "paid") done.add("all");
      }
      return { status: "paid", paid: paid.paid, bonus, all_done: done.has("all") };
    });
    if (result.status !== "paid") return result;
    const unlocked = await this.e.v2.afterEarn(who);
    return unlocked.length > 0 ? { ...result, unlocked } : result;
  }
}
