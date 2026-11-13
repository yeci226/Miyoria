// Crowdfunding goals (docs/design/economy.md §13): she asks for a number of coins and says what she
// will do when it is met, so people can chip in toward it.
//
// * She decides (her tools, agency-tools.ts); this file is what is true afterwards. One open goal
//   at a time. What she promises passes the same gate as a deal (`guardTask`): the screen, the
//   owners' rules and what is hers to decide.
// * A pledge is held (a `goal_pledge` row of the pledger's wallet, so it cannot be spent twice).
//   When the total reaches the target the goal is `reached`, the held coins become hers (one
//   `goal_funds` row of the purse) and she is told it is a promise now; a card says so where the
//   pledge that met it was made (none without a place, notices.ts). Short at the deadline, or
//   if she withdraws it, every pledge is returned once.
// * Goals persist in `GoalStore`; a sweep ends what ran out and finishes what a restart cut short.
// * A reached goal's promise is owed until it is marked kept (`fulfill`): by the owner on the panel,
//   or by her when she says she did it. Until then her purse block reminds her; after, it does not.

import { errorMessage } from "@miyoria/kernel";
import { type Goal, type GoalFulfiller, GoalStoreKey } from "@miyoria/store";
import { type AccountRef, type ContextKey, newId, toTimestamp } from "@miyoria/types";
import { cleanText, guardTask } from "./deals.js";
import type { EconomyService } from "./economy.js";
import { STRANGER } from "./economy.js";
import { postCard } from "./notices.js";
import { receipt } from "./receipt.js";
import { EconomyError, type GoalView, type PledgeResult } from "./types.js";

export const MAX_TITLE_CHARS = 30;
export const MAX_PROMISE_CHARS = 60;
export const OPEN_GOAL = "已經有一個目標在進行了";
export const NO_GOAL = "現在沒有進行中的目標";
export const GOAL_OVER = "這個目標已經結束了";
export const NOT_OWED = "沒有湊滿、還沒做到的目標";
export const ALREADY_KEPT = "這個目標已經記成做到了";
const DAY_MS = 86_400_000;
const VIEW_LIMIT = 10;

export interface ProposeGoalRequest {
  title: string;
  promise: string;
  target: number;
  days: number;
  /** Where she is when she proposes it (the rules read it). */
  context: ContextKey | null;
}

export class GoalDesk {
  constructor(private readonly e: EconomyService) {}

  #store() {
    const store = this.e.services.get(GoalStoreKey);
    if (!store) throw new EconomyError(503, "目標現在打不開");
    return store;
  }

  /** The goal people can pledge to, if she has one. */
  async open(): Promise<Goal | null> {
    return (await this.#store().list(this.e.profile, { statuses: ["open"], limit: 1 }))[0] ?? null;
  }

  async #raised(goal: string): Promise<number> {
    return (await this.#store().pledges(goal)).reduce((n, p) => n + p.amount, 0);
  }

  // ---- her side -------------------------------------------------------------------------

  /** She asks for a goal. Throws `EconomyError` / `DealRefusal`. */
  async propose(req: ProposeGoalRequest): Promise<Goal> {
    const c = this.e.config;
    const title = cleanText(req.title, MAX_TITLE_CHARS);
    const promise = cleanText(req.promise, MAX_PROMISE_CHARS);
    if (title === "" || promise === "") throw new EconomyError(400, "要寫清楚目標和你會做什麼");
    if (!Number.isInteger(req.target) || req.target < 1 || req.target > c.goal_max_target) {
      throw new EconomyError(400, `目標要 1 到 ${c.goal_max_target}`);
    }
    if (!Number.isInteger(req.days) || req.days < 1 || req.days > c.goal_max_days) {
      throw new EconomyError(400, `要 1 到 ${c.goal_max_days} 天`);
    }
    await guardTask(this.e, null, `${title} ${promise}`, req.context, {
      noun: "目標",
      why: "大家一起湊的目標",
    });
    const store = this.#store();
    const goal = await this.e.serial(async (): Promise<Goal> => {
      if ((await this.open()) !== null) throw new EconomyError(409, OPEN_GOAL);
      const now = this.e.now();
      const made: Goal = {
        id: newId(),
        profile: this.e.profile,
        title,
        promise,
        target: req.target,
        status: "open",
        created_at: toTimestamp(now),
        deadline: toTimestamp(now + req.days * DAY_MS),
        closed_at: null,
      };
      await store.create(made);
      return made;
    });
    this.e.purse.audit("economy.goal.propose", {
      goal: goal.id,
      target: goal.target,
      days: req.days,
    });
    await this.e.purse.refresh();
    return goal;
  }

  /** She withdraws the open goal; every pledge goes back. */
  async cancel(): Promise<{ goal: Goal; refunded: number }> {
    const store = this.#store();
    const goal = await this.e.serial(async (): Promise<Goal> => {
      const open = await this.open();
      if (!open) throw new EconomyError(409, NO_GOAL);
      const closed = toTimestamp(this.e.now());
      const moved = await store.transition(open.id, ["open"], {
        status: "cancelled",
        closed_at: closed,
      });
      if (!moved) throw new EconomyError(409, NO_GOAL);
      return { ...open, status: "cancelled", closed_at: closed };
    });
    const refunded = await this.#returnAll(goal);
    this.e.purse.audit("economy.goal.cancel", { goal: goal.id, refunded });
    this.e.purse.news(
      `goal:${goal.id}:cancelled`,
      `你取消了目標「${goal.title}」,大家投的 ${refunded} ${this.e.config.currency}都退回去了`,
    );
    await this.e.purse.refresh();
    return { goal, refunded };
  }

  /** Gives every pledge of an ended goal back, once each. Returns the coins returned. */
  async #returnAll(goal: Goal): Promise<number> {
    let total = 0;
    for (const p of await this.#store().pledges(goal.id)) {
      try {
        if (await this.e.purse.giveBack({ id: p.id, account: p.account, amount: p.amount })) {
          total += p.amount;
        }
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error), goal: goal.id }, "cannot return a pledge");
      }
    }
    return total;
  }

  // ---- pledging -------------------------------------------------------------------------

  async pledge(
    account: AccountRef,
    goalId: string,
    amount: number,
    key: string,
    context: ContextKey | null = null,
  ): Promise<PledgeResult> {
    if (!Number.isInteger(amount) || amount < 1) throw new EconomyError(400, "至少 1");
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    const c = this.e.config;
    const store = this.#store();
    const out = await this.e.serial(async () => {
      const goal = await store.get(goalId);
      if (!goal || goal.profile !== this.e.profile) throw new EconomyError(400, "沒有這個目標");
      const idem = `pledge:${key}`;
      const first = await this.e.ledger().byKey(this.e.profile, who.wallet, idem);
      if (first) {
        const raised = await this.#raised(goal.id);
        return {
          goal,
          pledge: {
            pledged: -first.delta,
            raised,
            target: goal.target,
            reached: goal.status === "reached",
            balance: await this.e.ledger().balance(this.e.profile, who.wallet),
            duplicate: true,
          },
          fresh: false,
        };
      }
      if (goal.status !== "open" || Date.parse(goal.deadline) <= this.e.now()) {
        throw new EconomyError(409, GOAL_OVER);
      }
      const pledges = await store.pledges(goal.id);
      const raised = pledges.reduce((n, p) => n + p.amount, 0);
      const mine = pledges
        .filter((p) =>
          who.wallet.some((a) => a.platform === p.account.platform && a.id === p.account.id),
        )
        .reduce((n, p) => n + p.amount, 0);
      const room = Math.min(c.goal_pledge_max - mine, goal.target - raised);
      if (room < 1) throw new EconomyError(429, `每個人最多投 ${c.goal_pledge_max}`);
      const pledged = Math.min(amount, room);
      const spent = await this.e.spend(who, pledged, "goal_pledge", goal.id, idem);
      try {
        await store.addPledge({
          id: spent.entry.id,
          goal: goal.id,
          profile: this.e.profile,
          account: who.account,
          amount: pledged,
          created_at: toTimestamp(this.e.now()),
        });
      } catch (error) {
        await this.e.refundOnce(who, spent.entry);
        throw error;
      }
      const total = raised + pledged;
      return {
        goal,
        pledge: {
          pledged,
          raised: total,
          target: goal.target,
          reached: total >= goal.target,
          balance: spent.balance,
          duplicate: false,
        },
        fresh: true,
      };
    });
    if (!out.fresh) return out.pledge;
    this.e.record(who, "economy.goal.pledge", { goal: out.goal.id, amount: out.pledge.pledged });
    this.e.purse.news(
      `goal:${out.goal.id}:pledge:${newId()}`,
      `{who}投了 ${out.pledge.pledged} ${c.currency}給你的目標「${out.goal.title}」(${out.pledge.raised}/${out.goal.target})`,
      who.name,
    );
    if (out.pledge.reached) await this.#reach(out.goal, out.pledge.raised, context);
    else await this.e.purse.refresh();
    return out.pledge;
  }

  /** The target is met: the pledges are hers, and so is the promise; a card says so, once. */
  async #reach(goal: Goal, raised: number, context: ContextKey | null): Promise<void> {
    const moved = await this.e.serial(() =>
      this.#store().transition(goal.id, ["open"], {
        status: "reached",
        closed_at: toTimestamp(this.e.now()),
      }),
    );
    if (!moved) return;
    postCard(
      this.e,
      context,
      receipt(
        `🎯「${goal.title}」湊滿了!`,
        `她答應的:${goal.promise}`,
        `大家湊了 ${raised} ${this.e.config.currency}`,
      ),
    );
    await this.#fund(goal);
  }

  /** Moves the pledges of a reached goal into her purse (once: the key is the goal's). */
  async #fund(goal: Goal): Promise<void> {
    const total = await this.#raised(goal.id);
    const post = await this.e.purse.credit(total, "goal_funds", goal.id, `goal:${goal.id}`);
    if (post.status !== "posted") return;
    this.e.purse.audit("economy.goal.reached", { goal: goal.id, raised: total });
    this.e.purse.news(
      `goal:${goal.id}:reached`,
      `大家湊到了「${goal.title}」:${total} ${this.e.config.currency}已經進了你的錢包。` +
        `你答應過要:${goal.promise}。這是你對大家的承諾,記得做到。`,
    );
    await this.e.purse.refresh();
  }

  // ---- the promise ----------------------------------------------------------------------

  /** Reached goals, newest first, kept or still owed (the panel lists them). */
  async reached(): Promise<Goal[]> {
    return this.#store().list(this.e.profile, { statuses: ["reached"], limit: VIEW_LIMIT });
  }

  /**
   * Marks a reached goal's promise kept. `goalId` `null`: the newest one still owed (her own
   * report). Throws `EconomyError` 409 when there is none or it was marked already.
   */
  async fulfill(goalId: string | null, by: GoalFulfiller): Promise<Goal> {
    const store = this.#store();
    const kept = await this.e.serial(async (): Promise<Goal> => {
      const goal =
        goalId === null
          ? ((await this.reached()).find((g) => g.fulfilled_at === undefined) ?? null)
          : await store.get(goalId);
      if (!goal || goal.profile !== this.e.profile || goal.status !== "reached") {
        throw new EconomyError(409, NOT_OWED);
      }
      if (goal.fulfilled_at !== undefined) throw new EconomyError(409, ALREADY_KEPT);
      const at = toTimestamp(this.e.now());
      if (!(await store.fulfill(goal.id, by, at))) throw new EconomyError(409, ALREADY_KEPT);
      return { ...goal, fulfilled_at: at, fulfilled_by: by };
    });
    this.e.purse.audit("economy.goal.fulfilled", { goal: kept.id, by });
    this.e.purse.news(
      `goal:${kept.id}:fulfilled`,
      by === "owner"
        ? `主人把目標「${kept.title}」記成做到了(你答應的:${kept.promise}),謝謝大家。`
        : `你把目標「${kept.title}」記成做到了(你答應的:${kept.promise})。`,
    );
    await this.e.purse.refresh();
    return kept;
  }

  // ---- time -----------------------------------------------------------------------------

  /** Ends goals past their deadline (every pledge returned) and finishes interrupted ones. */
  async sweep(): Promise<void> {
    const store = this.e.services.get(GoalStoreKey);
    if (!store) return;
    const now = this.e.now();
    for (const goal of await store.list(this.e.profile, { statuses: ["open"], limit: 20 })) {
      if (Date.parse(goal.deadline) > now) continue;
      try {
        const closed = toTimestamp(now);
        const moved = await this.e.serial(() =>
          store.transition(goal.id, ["open"], { status: "expired", closed_at: closed }),
        );
        if (!moved) continue;
        const refunded = await this.#returnAll(goal);
        this.e.purse.news(
          `goal:${goal.id}:expired`,
          `目標「${goal.title}」時間到了沒有湊滿,大家投的 ${refunded} ${this.e.config.currency}都退回去了`,
        );
        this.e.purse.audit("economy.goal.expired", { goal: goal.id, refunded });
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error), goal: goal.id }, "cannot end a goal");
      }
    }
    // A reached goal whose coins did not get to her purse (stopped in between) gets them now.
    for (const goal of await store.list(this.e.profile, { statuses: ["reached"], limit: 5 })) {
      await this.#fund(goal).catch((error: unknown) => {
        this.e.log.warn({ err: errorMessage(error), goal: goal.id }, "cannot fund a goal");
      });
    }
    await this.e.purse.refresh();
  }

  // ---- what people see ------------------------------------------------------------------

  /** The open goal and the ones that ended lately, newest first. */
  async view(account: AccountRef): Promise<GoalView[]> {
    const store = this.e.services.get(GoalStoreKey);
    if (!store) return [];
    const who = await this.e.member(account);
    const mine = who ? who.wallet : [account];
    const keep = this.e.now() - this.e.config.goal_keep_days * DAY_MS;
    const rows = (await store.list(this.e.profile, { limit: VIEW_LIMIT * 2 }))
      .filter(
        (g) => g.status === "open" || (g.closed_at !== null && Date.parse(g.closed_at) >= keep),
      )
      .slice(0, VIEW_LIMIT);
    const out: GoalView[] = [];
    for (const g of rows) {
      const pledges = await store.pledges(g.id);
      out.push({
        id: g.id,
        title: g.title,
        promise: g.promise,
        target: g.target,
        raised: pledges.reduce((n, p) => n + p.amount, 0),
        my_pledge: pledges
          .filter((p) =>
            mine.some((a) => a.platform === p.account.platform && a.id === p.account.id),
          )
          .reduce((n, p) => n + p.amount, 0),
        deadline: g.deadline,
        status: g.status,
        fulfilled: g.fulfilled_at !== undefined,
      });
    }
    return out;
  }
}
