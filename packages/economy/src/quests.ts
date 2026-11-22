// Three small quests a day (docs/design/v5-architecture.md §9.4, v5-play.md §11.1): one with her
// (talk to her about something new), one with other people (a game, or a song heard to its end
// together), and one she thought of for them from what she remembers of them. Each pays
// `quest_reward`, all three add `quest_bonus`, and `quest_cap` is the day's most.
//
// A quest done is a ledger row: reason `quest`, ref the quest id (`new_topic:<topic>` for the
// first), key `quest:<day>:<id>`. So "done today" is read off the ledger and a replayed event or a
// restart pays nothing twice. The bonus row has ref `all`. The day is the economy's local day
// (`utc_offset_minutes`).
//
// Who says a quest is done:
// * `new_topic`: she, when she judges that the person told her about something new
//   (`complete_quest`); a topic repeated within `quest_topic_days` does not count.
// * `together`: a party game that ended with at least `quest_together_min_people` people taking
//   part (party.ts), a song she sang to its end while that many sat through it in her voice
//   channel (earn.ts), and the `game_*` activities of play.ts (games with others by definition).
// * `her_pick`: she, when they did the thing she thought of (`complete_quest` with `her_pick`).
//
// Today's `her_pick` is written once per person and day, the first time they (or she, with
// `check_quests`) look at today's quests: by whoever provides `QuestPickerKey` (the api module:
// from the memories the member page shows them, in her voice, nobody else named), within
// `quest_pick_secs`; without one, or when it gives nothing, it is one of `PLAIN_PICKS`. It is kept
// as an economy document (`quest_pick:<person>:<day>`, created once), so it never changes during
// the day and a restart keeps it. An admin's look at someone's quests does not choose it. The
// economy's sweep deletes the ones older than `PICK_KEEP_DAYS` days.

import { errorMessage } from "@miyoria/runtime/kernel";
import { type AccountRef, toTimestamp } from "@miyoria/types";
import type { EconomyDoc } from "./docs.js";
import type { EconomyService, Member } from "./economy.js";
import { EconomyError } from "./types.js";
import {
  type QuestId,
  QuestPickerKey,
  type QuestResult,
  type QuestsView,
  type QuestView,
} from "./v2-types.js";

export const QUESTS: readonly { id: QuestId; label: string; hint: string }[] = [
  {
    id: "new_topic",
    label: "跟她聊一件新的事",
    hint: "她聽了覺得是她還不知道的事,就由她算完成",
  },
  {
    id: "together",
    label: "和大家一起玩一場",
    hint: "和別人一起玩完一場派對遊戲,或在語音裡和別人一起聽她唱完一首歌",
  },
  {
    id: "her_pick",
    label: "她替你想的一件事",
    hint: "她從記得你的事裡想的;做到了跟她說,由她判斷",
  },
];

/**
 * The quests of before (2026-11-21) as today's: a game played or a song heard on the day the
 * quests changed counts as `together`, so it is not paid a second time that day.
 */
const LEGACY: Readonly<Record<string, QuestId>> = {
  play_game: "together",
  listen_song: "together",
};

/**
 * What `her_pick` is when she could not think of one: small things anyone can do by talking to
 * her, no coins, nothing to buy or prove. One is chosen by person and day.
 */
export const PLAIN_PICKS: readonly string[] = [
  "跟她說說你今天過得怎麼樣",
  "告訴她一首你最近常聽的歌",
  "跟她分享一件今天讓你笑出來的事",
  "跟她說一件你最近想做的事",
  "問她一個你一直想問她的問題",
  "跟她說說你今天吃了什麼",
];

/** The longest `her_pick` kept (characters); a longer one she wrote is not used. */
export const MAX_PICK_CHARS = 30;

/**
 * Days a `her_pick` is kept after its own: only today's is ever read, the rest is room to look
 * back. The sweep deletes older ones (`QuestDesk.prune`).
 */
export const PICK_KEEP_DAYS = 7;
/** Picks one prune deletes at most; a backlog goes over the next sweeps. */
const PRUNE_ROWS = 500;

const PICK = "quest_pick";
const MAX_ROWS = 2_000;
const MAX_TOPIC_CHARS = 40;

/** A topic as the repeat check compares it: lower case, no spaces or punctuation. */
export function topicKey(topic: string): string {
  const flat = topic.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  return [...flat].slice(0, MAX_TOPIC_CHARS).join("");
}

/** The plain quest of `person` on `day`: the same one all day, a different one most days. */
export function plainPick(person: string, day: number): string {
  // FNV-1a over the person and the day: no state, the same on every restart.
  let h = 0x811c9dc5;
  for (const ch of `${person}:${day}`) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PLAIN_PICKS[h % PLAIN_PICKS.length] ?? PLAIN_PICKS[0] ?? "";
}

/** Her words for a quest, flattened to one line; `null` when empty or too long to keep. */
export function cleanPick(text: string | null): string | null {
  if (text === null) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "" || [...flat].length > MAX_PICK_CHARS) return null;
  return flat;
}

interface Pick {
  text: string;
  by: "her" | "fallback";
}

function pickOf(doc: EconomyDoc): Pick {
  const text = typeof doc.data.text === "string" ? doc.data.text : "";
  return { text, by: doc.data.by === "her" ? "her" : "fallback" };
}

export class QuestDesk {
  /** Picks being written now, by document id: two looks at once ask her once. */
  readonly #writing = new Map<string, Promise<Pick>>();
  /** The day the last prune found nothing more to delete: the next is due on another day. */
  #prunedOn: number | null = null;

  constructor(private readonly e: EconomyService) {}

  /**
   * Deletes the picks of days more than `PICK_KEEP_DAYS` ago; how many went. Once a day, a backlog
   * `PRUNE_ROWS` at a time. The ledger rows of quests done are not touched.
   */
  async prune(): Promise<number> {
    const day = this.e.today();
    if (this.#prunedOn === day) return 0;
    const before = this.e.dayStart(day - PICK_KEEP_DAYS);
    const gone = await this.e.docs().prune(this.e.profile, PICK, before, PRUNE_ROWS);
    if (gone < PRUNE_ROWS) this.#prunedOn = day;
    return gone;
  }

  async #rowsToday(who: Member) {
    return this.e.ledger().entries(this.e.profile, who.wallet, {
      reasons: ["quest"],
      since: this.e.todayStart(),
      limit: MAX_ROWS,
    });
  }

  /** The quests done today (and `all` for the bonus), the ones of before read as today's. */
  #doneOf(rows: readonly { ref: string | null }[]): Set<string> {
    return new Set(
      rows.map((r) => {
        const id = (r.ref ?? "").split(":")[0] ?? "";
        return LEGACY[id] ?? id;
      }),
    );
  }

  #pickId(who: Member, day: number): string {
    return `${PICK}:${who.person.id}:${day}`;
  }

  /** Today's `her_pick`; written now when `write` and it is not chosen yet, else `null`. */
  async #pick(who: Member, write: boolean): Promise<Pick | null> {
    const day = this.e.today();
    const id = this.#pickId(who, day);
    const have = await this.e.docs().get(this.e.profile, PICK, id);
    if (have) return pickOf(have);
    if (!write) return null;
    const running = this.#writing.get(id);
    if (running !== undefined) return running;
    const writing = this.#write(who, id, day).finally(() => this.#writing.delete(id));
    this.#writing.set(id, writing);
    return writing;
  }

  async #write(who: Member, id: string, day: number): Promise<Pick> {
    const c = this.e.config;
    const picker = c.quest_pick_by_her ? this.e.services.get(QuestPickerKey) : undefined;
    let text: string | null = null;
    if (picker) {
      try {
        text = cleanPick(
          await picker.pick(who.account, AbortSignal.timeout(c.quest_pick_secs * 1000)),
        );
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error) }, "she could not think of a quest");
      }
      if (text !== null && !this.e.passes(who, text)) text = null;
    }
    const pick: Pick =
      text === null ? { text: plainPick(who.person.id, day), by: "fallback" } : { text, by: "her" };
    const at = toTimestamp(this.e.now());
    const doc: EconomyDoc = {
      id,
      kind: PICK,
      owner: who.account,
      status: "set",
      version: 1,
      data: { day, text: pick.text, by: pick.by },
      created_at: at,
      updated_at: at,
    };
    if (await this.e.docs().create(doc)) return pick;
    // Written by another process meanwhile: theirs stands.
    const again = await this.e.docs().get(this.e.profile, PICK, id);
    return again ? pickOf(again) : pick;
  }

  async view(account: AccountRef, opts: { pick?: boolean } = {}): Promise<QuestsView> {
    const c = this.e.config;
    const who = await this.e.member(account);
    const rows = who ? await this.#rowsToday(who) : [];
    const done = this.#doneOf(rows);
    const pick = who ? await this.#pick(who, opts.pick === true) : null;
    const quests: QuestView[] = who
      ? QUESTS.map((q) => ({
          id: q.id,
          label: q.id === "her_pick" && pick ? pick.text : q.label,
          hint: q.hint,
          done: done.has(q.id),
          by: q.id === "her_pick" ? (pick?.by ?? null) : null,
        }))
      : [];
    return {
      quests,
      reward: c.quest_reward,
      bonus: c.quest_bonus,
      bonus_done: done.has("all"),
      earned_today: rows.reduce((n, r) => n + r.delta, 0),
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
    // Nobody can have done what she has not thought of yet.
    if (id === "her_pick" && (await this.#pick(who, false)) === null) {
      return { status: "unpicked", paid: 0, bonus: 0, all_done: false };
    }
    const result = await this.e.serial(async (): Promise<QuestResult> => {
      const done = this.#doneOf(await this.#rowsToday(who));
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
