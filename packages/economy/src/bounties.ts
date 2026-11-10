// Bounties (docs/design/economy.md §13): a task she pays for out of her own purse. Another way to
// earn, and the money comes from her side, not out of thin air.
//
// * She posts one (`post_bounty`): the reward is held out of her purse (`bounty_hold`), the task
//   passes the same gate as a deal (`guardTask`), at most `bounties_open` at once.
// * She judges who did it and awards it to the person talking to her (`award_bounty`), never to
//   herself, once per bounty. Cancelled or run out, the hold goes back to the purse.
// * Bounties persist in `BountyStore`; a sweep ends what ran out.

import { errorMessage } from "@miyoria/kernel";
import { type Bounty, BountyStoreKey } from "@miyoria/store";
import { type AccountRef, type ContextKey, newId, safeName, toTimestamp } from "@miyoria/types";
import { cleanTask, guardTask } from "./deals.js";
import type { EconomyService } from "./economy.js";
import { STRANGER } from "./economy.js";
import { PURSE_PLATFORM, pickById } from "./purse.js";
import { type BountyView, EconomyError } from "./types.js";

export const NO_BOUNTY = "沒有這個懸賞";
export const TOO_MANY = "同時開著的懸賞到上限了";
const DAY_MS = 86_400_000;
const VIEW_LIMIT = 10;

export interface PostBountyRequest {
  task: string;
  reward: number;
  context: ContextKey | null;
}

export class BountyBoard {
  constructor(private readonly e: EconomyService) {}

  #store() {
    const store = this.e.services.get(BountyStoreKey);
    if (!store) throw new EconomyError(503, "懸賞現在打不開");
    return store;
  }

  async #open(): Promise<Bounty[]> {
    return this.#store().list(this.e.profile, { statuses: ["open"], limit: 50 });
  }

  /** She posts a bounty, paid from her purse. Throws `EconomyError` / `DealRefusal`. */
  async post(req: PostBountyRequest): Promise<Bounty> {
    const c = this.e.config;
    const task = cleanTask(req.task);
    if (task === "") throw new EconomyError(400, "要寫清楚要做什麼");
    if (!Number.isInteger(req.reward) || req.reward < 1 || req.reward > c.bounty_max) {
      throw new EconomyError(400, `獎金要 1 到 ${c.bounty_max}`);
    }
    await guardTask(this.e, null, task, req.context, { noun: "懸賞", why: "她自己貼的懸賞" });
    const store = this.#store();
    const bounty = await this.e.serial(async (): Promise<Bounty> => {
      if ((await this.#open()).length >= c.bounties_open) {
        throw new EconomyError(429, `${TOO_MANY}(${c.bounties_open} 個)`);
      }
      const id = newId();
      const held = await this.e.purse.debit(req.reward, "bounty_hold", id, `bounty:${id}`);
      if (held.status !== "posted") throw new EconomyError(402, "你的錢包不夠");
      const now = this.e.now();
      const made: Bounty = {
        id,
        profile: this.e.profile,
        task,
        reward: req.reward,
        hold: held.entry.id,
        status: "open",
        created_at: toTimestamp(now),
        expires_at: toTimestamp(now + c.bounty_days * DAY_MS),
        closed_at: null,
        winner: null,
      };
      try {
        await store.create(made);
      } catch (error) {
        await this.e.purse.credit(req.reward, "bounty_return", id, `bounty-back:${id}`);
        throw error;
      }
      return made;
    });
    this.e.purse.audit("economy.bounty.post", { bounty: bounty.id, reward: bounty.reward });
    await this.e.purse.refresh();
    return bounty;
  }

  /** The bounty `ref` names among the open ones, or `NO_BOUNTY`. */
  async #pick(ref: string): Promise<Bounty> {
    const found = pickById(await this.#open(), ref);
    if (!found) throw new EconomyError(409, NO_BOUNTY);
    return found;
  }

  /** She pays the reward to the person talking to her. Returns what they got. */
  async award(
    account: AccountRef,
    ref: string,
  ): Promise<{ bounty: Bounty; paid: number; name: string }> {
    if (account.platform === PURSE_PLATFORM) throw new EconomyError(400, "不能給自己");
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    const store = this.#store();
    const bounty = await this.e.serial(async (): Promise<Bounty> => {
      const open = await this.#pick(ref);
      const closed = toTimestamp(this.e.now());
      const moved = await store.transition(open.id, ["open"], {
        status: "awarded",
        closed_at: closed,
        winner: who.account,
      });
      if (!moved) throw new EconomyError(409, NO_BOUNTY);
      const won: Bounty = { ...open, status: "awarded", closed_at: closed, winner: who.account };
      try {
        await this.e.ledger().post(
          {
            id: newId(),
            profile: this.e.profile,
            account: who.account,
            delta: open.reward,
            reason: "bounty",
            ref: open.id,
            idem_key: `bounty:${open.id}`,
            ts: closed,
          },
          { wallet: who.wallet },
        );
      } catch (error) {
        await this.e.purse.credit(open.reward, "bounty_return", open.id, `bounty-back:${open.id}`);
        throw error;
      }
      return won;
    });
    this.e.record(who, "economy.bounty.award", { bounty: bounty.id, reward: bounty.reward });
    this.e.purse.news(
      `bounty:${bounty.id}:awarded`,
      `你把懸賞「${bounty.task}」的 ${bounty.reward} ${this.e.config.currency}給了${safeName(who.name)}`,
    );
    await this.e.purse.refresh();
    return { bounty, paid: bounty.reward, name: who.name };
  }

  /** She takes a bounty down; the hold goes back to her purse. */
  async cancel(ref: string): Promise<Bounty> {
    return this.#end(ref, "cancelled");
  }

  async #end(ref: string | Bounty, status: "cancelled" | "expired"): Promise<Bounty> {
    const store = this.#store();
    const ended = await this.e.serial(async (): Promise<Bounty> => {
      const open = typeof ref === "string" ? await this.#pick(ref) : ref;
      const closed = toTimestamp(this.e.now());
      const moved = await store.transition(open.id, ["open"], { status, closed_at: closed });
      if (!moved) throw new EconomyError(409, NO_BOUNTY);
      await this.e.purse.credit(open.reward, "bounty_return", open.id, `bounty-back:${open.id}`);
      return { ...open, status, closed_at: closed };
    });
    this.e.purse.audit(`economy.bounty.${status}`, { bounty: ended.id, reward: ended.reward });
    this.e.purse.news(
      `bounty:${ended.id}:${status}`,
      `懸賞「${ended.task}」${status === "cancelled" ? "你取消了" : "到期了沒人領"},` +
        `${ended.reward} ${this.e.config.currency}回到你的錢包`,
    );
    await this.e.purse.refresh();
    return ended;
  }

  /** Ends what ran out: the hold goes back to the purse. */
  async sweep(): Promise<void> {
    const now = this.e.now();
    for (const b of await this.#open()) {
      if (Date.parse(b.expires_at) > now) continue;
      try {
        await this.#end(b, "expired");
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error), bounty: b.id }, "cannot end a bounty");
      }
    }
  }

  /** The bounties she has open, newest first. */
  async view(): Promise<BountyView[]> {
    const store = this.e.services.get(BountyStoreKey);
    if (!store) return [];
    const rows = await store.list(this.e.profile, { statuses: ["open"], limit: VIEW_LIMIT });
    return rows.map((b) => ({
      id: b.id,
      task: b.task,
      reward: b.reward,
      posted_at: b.created_at,
      expires_at: b.expires_at,
    }));
  }
}
