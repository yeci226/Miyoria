// Her purse (docs/design/economy.md §13): coins that are hers. Rows of the same ledger on a
// synthetic account, `{ platform: "self", id: <profile> }`, which no platform adapter produces, so
// it cannot be a person's wallet. Money gets in by her share of paid gifts and by goals that are
// reached; it leaves as treats, expressions she buys herself, and bounties.
//
// * A share (`her_share`, floored) of what someone pays to feed her, write her, send an expression
//   or put a message or a dedication on screen goes in the purse, keyed on the source row, so it
//   is paid once and taken back once if that charge is refunded.
// * She sees what she has and what she is saving for in her working context: the `purse` bucket
//   (one entry, replaced when it changes) and `purse_news` (what just happened).
// * Money in her purse is hers to spend: it counts toward none of the caps on `give_coins`.

import { ActuatorRegistryKey } from "@miyoria/actions";
import { errorMessage } from "@miyoria/kernel";
import { SingerKey } from "@miyoria/sing";
import {
  AuditLogKey,
  BountyStoreKey,
  type CoinEntry,
  type CoinPost,
  GoalStoreKey,
} from "@miyoria/store";
import {
  type AccountRef,
  accountRefString,
  EventLogKey,
  type JsonValue,
  newId,
  Principals,
  safeName,
  toTimestamp,
} from "@miyoria/types";
import type { EconomyService, Member } from "./economy.js";
import { EconomyError, GIFT_EXPRESSIONS, type GiftExpression } from "./types.js";

/** The platform of the purse's account. */
export const PURSE_PLATFORM = "self";
/** Ledger reasons whose price she gets a share of. */
export const SHARED_REASONS: readonly string[] = [
  "feed",
  "letter",
  "expression",
  "screen_message",
  "dedication",
];
const DAY_MS = 86_400_000;
const MAX_ROWS = 2_000;
const MAX_NEWS = 6;
const NOT_ENOUGH = "你的錢包不夠";
export const EXPRESSION_WORD: Readonly<Record<GiftExpression, string>> = {
  heart: "愛心眼",
  blush: "臉紅",
  squint: "＞＜",
};
/** How long a bought expression shows. */
const SELF_EXPRESSION_SECONDS = 8;

/** The last characters of an id: what she and the tools call it. */
export function shortId(id: string): string {
  return id.slice(-6).toLowerCase();
}

/** The one of `rows` that `ref` names: its whole id or its short form, if exactly one does. */
export function pickById<T extends { id: string }>(rows: readonly T[], ref: string): T | null {
  const want = ref.trim().toLowerCase();
  if (want === "") return null;
  const found = rows.filter((r) => r.id.toLowerCase() === want || shortId(r.id) === want);
  return found.length === 1 ? (found[0] ?? null) : null;
}

export class Purse {
  #shown = "";

  constructor(private readonly e: EconomyService) {}

  /** The account her coins are rows of. */
  get account(): AccountRef {
    return { platform: PURSE_PLATFORM, id: this.e.profile };
  }

  #entry(delta: number, reason: string, ref: string | null, key: string | null): CoinEntry {
    return {
      id: newId(),
      profile: this.e.profile,
      account: this.account,
      delta,
      reason,
      ref,
      idem_key: key,
      ts: toTimestamp(this.e.now()),
    };
  }

  async balance(): Promise<number> {
    return this.e.ledger().balance(this.e.profile, [this.account]);
  }

  /** Puts `amount` in (once per `key`). */
  credit(amount: number, reason: string, ref: string | null, key: string): Promise<CoinPost> {
    return this.e.ledger().post(this.#entry(amount, reason, ref, key), { wallet: [this.account] });
  }

  /** Takes `amount` out (once per `key`); `short` when she has less. */
  debit(amount: number, reason: string, ref: string | null, key: string): Promise<CoinPost> {
    return this.e
      .ledger()
      .post(this.#entry(-amount, reason, ref, key), { wallet: [this.account], covered: true });
  }

  /** What left the purse under `reasons` since the day began. */
  async spentToday(reasons: readonly string[]): Promise<number> {
    const rows = await this.e.ledger().entries(this.e.profile, [this.account], {
      reasons,
      since: this.e.todayStart(),
      limit: MAX_ROWS,
    });
    return rows.filter((r) => r.delta < 0).reduce((n, r) => n - r.delta, 0);
  }

  // ---- her share ------------------------------------------------------------------------

  /**
   * Her share of what `entry` charged, once. Only the paid gifts have one, unless `force` (a
   * deal's escrow is hers when she is given it). Never throws: a gift is not undone by this.
   */
  async share(entry: CoinEntry, force = false): Promise<number> {
    try {
      if (entry.delta >= 0 || (!force && !SHARED_REASONS.includes(entry.reason))) return 0;
      const amount = Math.floor(-entry.delta * this.e.config.her_share);
      if (amount < 1) return 0;
      const post = await this.credit(amount, "her_share", entry.id, `share:${entry.id}`);
      if (post.status !== "posted") return 0;
      this.#later();
      return amount;
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "cannot add her share of a gift");
      return 0;
    }
  }

  /** A charge was refunded: her share of it goes back (as much as she still has of it). */
  async claw(entry: CoinEntry): Promise<void> {
    try {
      if (!SHARED_REASONS.includes(entry.reason) && entry.reason !== "deal_escrow") return;
      const ledger = this.e.ledger();
      const wallet = [this.account];
      const shared = await ledger.byKey(this.e.profile, wallet, `share:${entry.id}`);
      if (!shared) return;
      const amount = Math.min(shared.delta, Math.max(await this.balance(), 0));
      if (amount < 1) return;
      const post = await ledger.post(
        this.#entry(-amount, "her_share_back", entry.id, `shareback:${entry.id}`),
        { wallet },
      );
      if (post.status === "posted") this.#later();
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "cannot take back her share of a gift");
    }
  }

  /**
   * Returns a held charge to the account that paid it, once (the same key `Economy.refund` uses, so
   * the two cannot both pay). Works for someone she no longer lets in.
   */
  async giveBack(held: { id: string; account: AccountRef; amount: number }): Promise<boolean> {
    const ledger = this.e.ledger();
    const wallet = [held.account];
    const key = `refund:${held.id}`;
    if ((await ledger.byKey(this.e.profile, wallet, key)) !== null) return false;
    const post = await ledger.post(
      {
        id: newId(),
        profile: this.e.profile,
        account: held.account,
        delta: held.amount,
        reason: "refund",
        ref: held.id,
        idem_key: key,
        ts: toTimestamp(this.e.now()),
      },
      { wallet },
    );
    return post.status === "posted";
  }

  // ---- what she spends it on ------------------------------------------------------------

  /**
   * A treat for someone she knows, from her purse: up to what she has, what one person may get per
   * day and what everyone may. Returns what was given (less than asked near a cap, `0` at one).
   */
  async treat(
    who: Member,
    amount: number,
    reason: string,
  ): Promise<{ given: number; left: number }> {
    const c = this.e.config;
    const text = [...reason.replace(/\s+/g, " ").trim()].slice(0, 100).join("") || null;
    return this.e.serial(async () => {
      const since = this.e.todayStart();
      const got = await this.e.ledger().entries(this.e.profile, who.wallet, {
        reasons: ["purse_gift"],
        since,
        limit: MAX_ROWS,
      });
      const personLeft = c.treat_per_person - got.reduce((n, r) => n + r.delta, 0);
      const totalLeft = c.treat_total - (await this.spentToday(["purse_treat"]));
      const balance = await this.balance();
      const given = Math.min(amount, personLeft, totalLeft, balance);
      if (given < 1) return { given: 0, left: balance };
      const id = newId();
      const out = await this.debit(given, "purse_treat", id, `treat:${id}`);
      if (out.status !== "posted") return { given: 0, left: out.balance };
      try {
        await this.e.ledger().post(
          {
            id: newId(),
            profile: this.e.profile,
            account: who.account,
            delta: given,
            reason: "purse_gift",
            ref: text,
            idem_key: `treat:${id}`,
            ts: toTimestamp(this.e.now()),
          },
          { wallet: who.wallet },
        );
      } catch (error) {
        await this.credit(given, "purse_return", id, `treat-back:${id}`);
        throw error;
      }
      this.e.record(who, "economy.treat", { given, reason: text });
      await this.refresh();
      return { given, left: out.balance };
    });
  }

  /**
   * An expression on her own face, paid from her purse (the price is `expression`): only while the
   * stage is up and she is not singing; the coins come back when it does not show.
   */
  async buyExpression(expression: GiftExpression): Promise<{ paid: number; left: number }> {
    if (!GIFT_EXPRESSIONS.includes(expression)) throw new EconomyError(400, "沒有這個表情");
    const c = this.e.config;
    const s = this.e.services;
    if (c.self_expressions_per_day === 0) throw new EconomyError(429, "現在不能買");
    const stage = s.get(ActuatorRegistryKey);
    if (!stage?.get("stage.expression")) throw new EconomyError(409, "現在沒有開台");
    if (this.#singing()) throw new EconomyError(409, "你正在唱歌");
    const id = newId();
    const paid = await this.e.serial(async () => {
      const rows = await this.e.ledger().entries(this.e.profile, [this.account], {
        reasons: ["purse_expression", "purse_return"],
        since: this.e.todayStart(),
        limit: MAX_ROWS,
      });
      const returned = new Set(rows.filter((r) => r.reason === "purse_return").map((r) => r.ref));
      const bought = rows.filter((r) => r.reason === "purse_expression" && !returned.has(r.id));
      if (bought.length >= c.self_expressions_per_day) {
        throw new EconomyError(429, `今天最多買 ${c.self_expressions_per_day} 次`);
      }
      const post = await this.debit(c.expression, "purse_expression", expression, `expr:${id}`);
      if (post.status !== "posted") throw new EconomyError(402, NOT_ENOUGH);
      return post.entry;
    });
    // The stage holds the face for seconds: it is asked outside the turns.
    let shown = false;
    try {
      const outcome = await stage.invoke({
        principal: Principals.panel("economy"),
        capability: "stage.expression",
        args: { expression, seconds: SELF_EXPRESSION_SECONDS },
        why: "她用自己的錢買的表情",
        turn: null,
      });
      shown = outcome.status === "done" && !this.#singing();
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "the stage did not take her expression");
    }
    if (!shown) {
      await this.credit(c.expression, "purse_return", paid.id, `expr-back:${id}`);
      await this.refresh();
      throw new EconomyError(409, "表情沒有出來,錢已經回到錢包");
    }
    await this.refresh();
    return { paid: c.expression, left: await this.balance() };
  }

  #singing(): boolean {
    try {
      return this.e.services.get(SingerKey)?.playing() != null;
    } catch {
      return false;
    }
  }

  // ---- what she knows -------------------------------------------------------------------

  #later(): void {
    void this.refresh().catch((error: unknown) => {
      this.e.log.warn({ err: errorMessage(error) }, "cannot update her purse note");
    });
  }

  /** Her purse in words, for her working context. */
  async describe(): Promise<string> {
    const s = this.e.services;
    const c = this.e.config;
    const now = this.e.now();
    const parts = [`你的小錢包有 ${await this.balance()} ${c.currency}(別人送你的禮物分你一份)`];
    const days = (iso: string) => Math.max(Math.ceil((Date.parse(iso) - now) / DAY_MS), 0);
    const goals = await s.get(GoalStoreKey)?.list(this.e.profile, { limit: 10 });
    for (const g of goals ?? []) {
      if (g.status === "open") {
        const raised = (await s.get(GoalStoreKey)?.pledges(g.id))?.reduce(
          (n, p) => n + p.amount,
          0,
        );
        parts.push(
          `你在存的目標「${g.title}」:${raised ?? 0}/${g.target},還有 ${days(g.deadline)} 天,` +
            `湊到了你要:${g.promise}`,
        );
      } else if (
        g.status === "reached" &&
        g.closed_at !== null &&
        now - Date.parse(g.closed_at) < c.goal_keep_days * DAY_MS
      ) {
        parts.push(`你答應過大家的(目標「${g.title}」湊到了):${g.promise}`);
      }
    }
    const bounties = await s.get(BountyStoreKey)?.list(this.e.profile, {
      statuses: ["open"],
      limit: 10,
    });
    for (const b of bounties ?? []) {
      parts.push(`你貼的懸賞[${shortId(b.id)}]「${b.task}」${b.reward} ${c.currency}`);
    }
    return `${parts.join("。")}。`;
  }

  /** Writes the purse into her working context when it changed. */
  async refresh(): Promise<void> {
    const text = await this.describe();
    if (text === this.#shown) return;
    this.#shown = text;
    this.#observe("purse", "replace-self", "purse:state", text, false);
  }

  /** Something that just happened to her money, silently. `by` is a person's name, if any. */
  news(key: string, text: string, by: string | null = null): void {
    const line = by === null ? text : text.replace("{who}", safeName(by));
    this.#observe("purse_news", "append-self", key, line, by !== null);
  }

  #observe(
    writer: string,
    op: "replace-self" | "append-self",
    key: string,
    summary: string,
    untrusted: boolean,
  ): void {
    const log = this.e.services.get(EventLogKey);
    if (!log) return;
    try {
      log.observe(
        {
          source: "economy.purse",
          silent: true,
          salience: "notable",
          attention_key: key,
          revision: 1,
          summary,
          addressed_to_her: false,
          from: null,
          context: null,
        },
        {
          buckets: [
            op === "replace-self"
              ? { op, writer, owner: "economy", untrusted }
              : { op, writer, owner: "economy", untrusted, max_entries: MAX_NEWS },
          ],
          person: null,
        },
      );
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "cannot tell her about her purse");
    }
  }

  /** A line in the audit log for something done with her money. */
  audit(action: string, detail: JsonValue): void {
    const audit = this.e.services.get(AuditLogKey);
    if (!audit) return;
    const actor = accountRefString(this.account);
    void audit
      .append({
        id: newId(),
        at: toTimestamp(this.e.now()),
        actor,
        action,
        target: actor,
        detail,
        ok: true,
      })
      .catch((error: unknown) => {
        this.e.log.warn({ err: errorMessage(error), action }, "cannot write audit entry");
      });
  }
}
