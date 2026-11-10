// Her daily posts (docs/design/v4-plan.md §8.4, row 8 of §16): after she did something of her own,
// she may post about it in one channel the owner named, a few times a day.
//
// Off by default: without `[modules.mind.daily_posts] enabled = true` and a channel, nothing is
// offered and nothing is posted anywhere. When on, a post is still never written here: what she
// did becomes a proposal for that channel (§15: nothing in the background speaks), the main line
// decides whether and what to post, and the owner's rules, the channel's level, quiet hours, the
// pause and the budget all come first. The daily cap counts every offer (an offer refused by a
// rule is given back), so she can never post more than `max_per_day`, whatever the main line does
// with them. The content is what really ran (`LifeBook`), never made up (Developer Policy item 13).

import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import { LlmRouterKey } from "@miyoria/llm";
import type { SettingsStore } from "@miyoria/store";
import {
  ArbiterKey,
  CHAT_START,
  type Clock,
  type ContextKey,
  type DailyPosts,
  IntentSinkKey,
  isJsonObject,
  type LifeEntry,
  newImpulse,
  type ProfileId,
  ProposalBoardKey,
  toTimestamp,
} from "@miyoria/types";
import type { DailyPostsConfig } from "../config.js";
import { LIFE_ACTIVITIES } from "./activities.js";

const log = getLogger("mind.posts");

/** Settings key prefix of the daily count (`mind:posts:<day>`). */
export const POSTS_PREFIX = "mind:posts:";
const MINUTE_MS = 60_000;
/** An offer stays on the board this long. */
const OFFER_TTL_MS = 60 * MINUTE_MS;
/** Channel levels where she does not post on her own. */
const SILENT_LEVELS = new Set(["off", "mention-only"]);
/** What is worth a post: everything she did on her own except talking to people. */
const POSTABLE = new Set(LIFE_ACTIVITIES.filter((a) => a.id !== "care").map((a) => a.id));

export interface DailyPostDeskOptions {
  config: DailyPostsConfig;
  store: SettingsStore | null;
  profile: ProfileId;
  clock: Clock;
  services: ServiceLookup;
  /** Her day of `at` (`LifeBook.dayOf`). */
  dayOf(at: number): string;
}

/** Why an offer was not made, or `offered`. */
export type OfferResult = "offered" | string;

/** `DailyPostsKey`. */
export class DailyPostDesk implements DailyPosts {
  readonly #o: DailyPostDeskOptions;
  #day = "";
  #used = 0;
  #last: number | null = null;

  constructor(options: DailyPostDeskOptions) {
    this.#o = options;
  }

  channel(): ContextKey | null {
    const c = this.#o.config;
    if (!c.enabled || c.guild === null || c.channel === null || c.max_per_day === 0) return null;
    return { platform: c.platform, scope: c.guild, channel: c.channel, kind: "channel" };
  }

  #roll(now: number): void {
    const day = this.#o.dayOf(now);
    if (day === this.#day) return;
    this.#day = day;
    this.#used = 0;
  }

  left(): number {
    if (this.channel() === null) return 0;
    this.#roll(this.#o.clock.now());
    return Math.max(this.#o.config.max_per_day - this.#used, 0);
  }

  async load(): Promise<void> {
    const store = this.#o.store;
    if (!store) return;
    const now = this.#o.clock.now();
    this.#roll(now);
    const saved = await store.get(this.#o.profile, `${POSTS_PREFIX}${this.#day}`);
    if (isJsonObject(saved) && typeof saved.used === "number") {
      this.#used = Math.max(this.#used, saved.used);
      this.#last = typeof saved.last === "number" ? saved.last : this.#last;
    }
  }

  #save(): void {
    const store = this.#o.store;
    if (!store) return;
    void store
      .set(this.#o.profile, `${POSTS_PREFIX}${this.#day}`, { used: this.#used, last: this.#last })
      .catch((error: unknown) => log.warn({ err: errorMessage(error) }, "cannot save the count"));
  }

  /** Why she may not post now, `null`: she may. */
  #refusal(entry: LifeEntry, now: number): string | null {
    const channel = this.channel();
    if (channel === null) return "daily posts are off";
    if (!POSTABLE.has(entry.activity)) return "nothing to post about";
    if (this.left() === 0) return "today's posts are used up";
    const gap = this.#o.config.min_gap_mins * MINUTE_MS;
    if (this.#last !== null && now - this.#last < gap) return "posted lately";
    const s = this.#o.services;
    const limits = s.get(ArbiterKey)?.ledger(null).limits ?? null;
    if (limits?.paused) return "autonomy is paused";
    if (limits?.quiet_hours?.active) return "quiet hours";
    const budget = s.get(LlmRouterKey)?.budgetState() ?? "ok";
    if (budget !== "ok") return `budget ${budget}`;
    const level = s.get(IntentSinkKey)?.ceiling?.(channel) ?? null;
    if (level !== null && SILENT_LEVELS.has(level.mode)) return `channel level ${level.mode}`;
    return null;
  }

  /** Offers a post about `entry` to the main line when everything allows it. */
  async offer(entry: LifeEntry): Promise<OfferResult> {
    const now = this.#o.clock.now();
    const refusal = this.#refusal(entry, now);
    if (refusal !== null) return refusal;
    const channel = this.channel() as ContextKey;
    const max = this.#o.config.max_per_day;
    const n = this.#used + 1;
    const label = LIFE_ACTIVITIES.find((a) => a.id === entry.activity)?.label ?? entry.activity;
    const what =
      `你剛${label}:${entry.what}。想的話可以在你的日常頻道貼一則(今天第 ${n} 則,最多 ${max} 則),` +
      "只寫你真的做了的事;不想貼就不用。";
    const attention = { key: `daily_post:${this.#day}:${n}`, repeat_after_ms: OFFER_TTL_MS };
    // Reserve first: two offers racing never pass the cap.
    this.#used = n;
    this.#last = now;
    this.#save();
    const giveBack = (why: string): OfferResult => {
      this.#used = Math.max(this.#used - 1, 0);
      this.#save();
      return why;
    };
    try {
      const board = this.#o.services.get(ProposalBoardKey);
      if (board) {
        const outcome = await board.propose({
          what,
          why: "日常貼文",
          capability: CHAT_START,
          expires: toTimestamp(now + OFFER_TTL_MS),
          source: "plan",
          context: channel,
          about: null,
          person: null,
          goal: null,
          attention,
        });
        return outcome.state === "dropped" ? giveBack(outcome.detail) : "offered";
      }
      const arbiter = this.#o.services.get(ArbiterKey);
      if (arbiter) {
        const decision = await arbiter.submit(
          newImpulse(
            {
              source: "plan",
              context: channel,
              capability: CHAT_START,
              ttlMs: OFFER_TTL_MS,
              why: "日常貼文",
              hint: what,
              coalesce_key: "daily_post",
              attention,
            },
            now,
          ),
        );
        return decision.verdict === "accepted" ||
          decision.verdict === "deferred" ||
          decision.verdict === "merged"
          ? "offered"
          : giveBack(decision.detail);
      }
      return giveBack("nobody to hand it to");
    } catch (error) {
      return giveBack(errorMessage(error));
    }
  }
}
