// Predictions (docs/design/v4-plan.md §9.1 and §10): people stake coins on how something of hers
// turns out (how she dies this run, what an osu score lands on), and the ones who were right share
// what everybody staked.
//
// * A pool, not a house. Stakes are held as ledger rows (`bet`); when it is settled the winners
//   get `stake * pool / winners' stakes`, floored, and the leftover coins (at most one per winner)
//   go to her purse. Nothing is created: the coins paid out are the coins staked. If nobody was
//   right, or it is called off, every stake is given back.
// * One stake per person per prediction (one option), at most `bet_max` each and `bet_daily_max`
//   a day; betting closes at the time she set (at most `prediction_max_minutes`) and she cannot bet
//   herself. An outcome nobody settles within `prediction_expire_hours` of closing is called off.
// * She opens a prediction and calls its result with her own tools; a game that knows the answer
//   (a verified death, a score) calls `resolve` on the service. Placing a stake also counts as
//   taking part (`prediction_join`, play.ts), which is what pays a few coins for it.
// * The prediction and its stakes are documents (docs.ts); coins live only in the ledger, so
//   settling is idempotent: every payout and refund has a key, and a sweep finishes what a crash
//   left halfway.

import { errorMessage } from "@miyoria/kernel";
import { type AccountRef, newId, toTimestamp } from "@miyoria/types";
import type { EconomyDoc } from "./docs.js";
import { type EconomyService, type Member, STRANGER } from "./economy.js";
import { pickById, shortId } from "./purse.js";
import { EconomyError } from "./types.js";
import type { BetResult, PredictionView, ResolveResult } from "./v2-types.js";

const PREDICTION = "prediction";
const BET = "bet";
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const MAX_QUESTION_CHARS = 80;
const MAX_OPTION_CHARS = 24;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_BETS = 5_000;
/** How long a settled prediction stays on the list. */
const KEEP_MS = 3 * 86_400_000;

export const NO_PREDICTION = "沒有這個預測";
export const BETTING_CLOSED = "這個預測已經截止了";
export const ALREADY_BET = "你已經押過這個預測了";

interface PredictionData {
  question: string;
  options: string[];
  closes_at: string;
  winner: number | null;
  [key: string]: string | number | string[] | null;
}

interface BetData {
  prediction: string;
  option: number;
  amount: number;
  /** The idempotency key of the stake's ledger row, to find the row again. */
  key: string;
  /** The ledger row of the stake. */
  entry: string;
  payout: number;
  [key: string]: string | number;
}

const asPrediction = (d: EconomyDoc) => d.data as unknown as PredictionData;
const asBet = (d: EconomyDoc) => d.data as unknown as BetData;

export class PredictionDesk {
  constructor(private readonly e: EconomyService) {}

  #docs() {
    return this.e.docs();
  }

  async #predictions(statuses: readonly string[], limit = 50): Promise<EconomyDoc[]> {
    return this.#docs().list(this.e.profile, PREDICTION, { statuses, limit });
  }

  async #bets(predictionId?: string, statuses?: readonly string[]): Promise<EconomyDoc[]> {
    const all = await this.#docs().list(this.e.profile, BET, {
      ...(statuses ? { statuses } : {}),
      limit: MAX_BETS,
    });
    return predictionId === undefined
      ? all
      : all.filter((b) => asBet(b).prediction === predictionId);
  }

  async #pick(ref: string, statuses: readonly string[]): Promise<EconomyDoc> {
    const found = pickById(await this.#predictions(statuses), ref);
    if (!found) throw new EconomyError(409, NO_PREDICTION);
    return found;
  }

  /** The 0-based option that `which` names: a number from 1, or the option's words. */
  #option(options: readonly string[], which: string | number): number {
    if (typeof which === "number" || /^\d+$/.test(which.trim())) {
      const n = Number(which) - 1;
      if (Number.isInteger(n) && n >= 0 && n < options.length) return n;
    } else {
      const at = options.indexOf(which.trim());
      if (at >= 0) return at;
    }
    throw new EconomyError(400, "沒有這個選項");
  }

  // ---- opening ---------------------------------------------------------------------------

  /** She (or a game) opens a prediction people can stake on for `minutes`. */
  async open(req: {
    question: string;
    options: readonly string[];
    minutes: number;
  }): Promise<PredictionView> {
    const c = this.e.config;
    const question = req.question.trim();
    const options = req.options.map((o) => o.trim());
    if (question === "" || [...question].length > MAX_QUESTION_CHARS) {
      throw new EconomyError(400, `題目要 1 到 ${MAX_QUESTION_CHARS} 個字`);
    }
    if (
      options.length < MIN_OPTIONS ||
      options.length > MAX_OPTIONS ||
      options.some((o) => o === "" || [...o].length > MAX_OPTION_CHARS) ||
      new Set(options).size !== options.length
    ) {
      throw new EconomyError(
        400,
        `要 ${MIN_OPTIONS} 到 ${MAX_OPTIONS} 個不同的選項,每個最多 ${MAX_OPTION_CHARS} 個字`,
      );
    }
    if (
      !Number.isInteger(req.minutes) ||
      req.minutes < 1 ||
      req.minutes > c.prediction_max_minutes
    ) {
      throw new EconomyError(400, `截止時間要 1 到 ${c.prediction_max_minutes} 分鐘`);
    }
    const as = { account: this.e.purse.account };
    if (!this.e.passes(as, [question, ...options].join(" "))) {
      throw new EconomyError(400, "這個預測通不過審查");
    }
    const made = await this.e.serial(async (): Promise<EconomyDoc> => {
      const open = await this.#predictions(["open"]);
      if (open.length >= c.predictions_open) {
        throw new EconomyError(429, `同時開著的預測到上限了(${c.predictions_open} 個)`);
      }
      const now = this.e.now();
      const at = toTimestamp(now);
      const data: PredictionData = {
        question,
        options,
        closes_at: toTimestamp(now + req.minutes * MIN_MS),
        winner: null,
      };
      const doc: EconomyDoc = {
        id: newId(),
        profile: this.e.profile,
        kind: PREDICTION,
        owner: null,
        status: "open",
        version: 1,
        data,
        created_at: at,
        updated_at: at,
      };
      await this.#docs().create(doc);
      return doc;
    });
    this.e.purse.audit("economy.prediction.open", { prediction: made.id });
    return this.#view(made, [], null);
  }

  // ---- staking ---------------------------------------------------------------------------

  async bet(
    account: AccountRef,
    ref: string,
    which: string | number,
    amount: number,
    key: string,
  ): Promise<BetResult> {
    const c = this.e.config;
    if (c.bet_max <= 0 || c.bet_daily_max <= 0) throw new EconomyError(400, "現在不開放預測");
    if (!Number.isInteger(amount) || amount < 1 || amount > c.bet_max) {
      throw new EconomyError(400, `一次最多押 ${c.bet_max}`);
    }
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    const idem = `bet:${key}`;
    const out = await this.e.serial(async (): Promise<BetResult> => {
      const pred = await this.#pick(ref, ["open"]);
      const data = asPrediction(pred);
      const option = this.#option(data.options, which);
      const betId = `bet:${pred.id}:${who.person.id}`;
      const mine = await this.#docs().get(this.e.profile, BET, betId);
      if (mine) {
        if (asBet(mine).key === idem) {
          return this.#betResult(pred, mine, who, true);
        }
        throw new EconomyError(409, ALREADY_BET);
      }
      if (Date.parse(data.closes_at) <= this.e.now()) throw new EconomyError(409, BETTING_CLOSED);
      const rows = await this.e.rowsToday(who);
      const refunded = new Set(rows.filter((r) => r.reason === "refund").map((r) => r.ref));
      const staked = rows
        .filter((r) => r.reason === "bet" && !refunded.has(r.id))
        .reduce((n, r) => n - r.delta, 0);
      if (staked + amount > c.bet_daily_max) {
        throw new EconomyError(429, `一天最多押 ${c.bet_daily_max}(今天押了 ${staked})`);
      }
      const spent = await this.e.spend(who, amount, "bet", `${pred.id}:${option}`, idem);
      const at = toTimestamp(this.e.now());
      const bet: EconomyDoc = {
        id: betId,
        profile: this.e.profile,
        kind: BET,
        owner: who.account,
        status: "open",
        version: 1,
        data: {
          prediction: pred.id,
          option,
          amount,
          key: idem,
          entry: spent.entry.id,
          payout: 0,
        } satisfies BetData,
        created_at: at,
        updated_at: at,
      };
      let created = false;
      try {
        created = await this.#docs().create(bet);
      } finally {
        if (!created) await this.e.refundOnce(who, spent.entry);
      }
      if (!created) throw new EconomyError(409, ALREADY_BET);
      this.e.record(who, "economy.bet", { prediction: pred.id, option, amount });
      return this.#betResult(pred, bet, who, false, spent.balance);
    });
    if (!out.duplicate) {
      // Taking part pays a little (play.ts, under its daily limits).
      await this.e.v2.play.award(account, "prediction_join", out.stake_id);
      await this.e.v2.afterEarn(who);
    }
    return { ...out, balance: await this.e.ledger().balance(this.e.profile, who.wallet) };
  }

  #betResult(
    pred: EconomyDoc,
    bet: EconomyDoc,
    _who: Member,
    duplicate: boolean,
    balance = 0,
  ): BetResult {
    const p = asPrediction(pred);
    const b = asBet(bet);
    return {
      prediction: shortId(pred.id),
      question: p.question,
      option: p.options[b.option] ?? "",
      amount: b.amount,
      balance,
      duplicate,
      stake_id: bet.id,
    };
  }

  // ---- settling --------------------------------------------------------------------------

  /** Calls the result of an open prediction (by her, or by a game that knows). Settles it. */
  async resolve(ref: string, which: string | number): Promise<ResolveResult> {
    const result = await this.e.serial(async (): Promise<ResolveResult> => {
      const pred = await this.#pick(ref, ["open"]);
      const data = asPrediction(pred);
      const winner = this.#option(data.options, which);
      const moved = await this.#docs().update(this.e.profile, PREDICTION, pred.id, pred.version, {
        status: "resolved",
        data: { ...data, winner },
        at: toTimestamp(this.e.now()),
      });
      if (!moved) throw new EconomyError(409, NO_PREDICTION);
      return this.#settle({
        ...pred,
        status: "resolved",
        version: pred.version + 1,
        data: { ...data, winner },
      });
    });
    this.e.purse.audit("economy.prediction.resolve", { prediction: result.id });
    return result;
  }

  /** Calls an open prediction off: every stake is given back. */
  async cancel(ref: string): Promise<ResolveResult> {
    const result = await this.e.serial(async (): Promise<ResolveResult> => {
      const pred = await this.#pick(ref, ["open"]);
      const moved = await this.#docs().update(this.e.profile, PREDICTION, pred.id, pred.version, {
        status: "cancelled",
        data: pred.data,
        at: toTimestamp(this.e.now()),
      });
      if (!moved) throw new EconomyError(409, NO_PREDICTION);
      return this.#settle({ ...pred, status: "cancelled", version: pred.version + 1 });
    });
    this.e.purse.audit("economy.prediction.cancel", { prediction: result.id });
    return result;
  }

  /**
   * Pays or returns every stake of a prediction that is resolved or cancelled and is still open.
   * Every row has a key, so running it again after a crash only does what is left.
   */
  async #settle(pred: EconomyDoc): Promise<ResolveResult> {
    const data = asPrediction(pred);
    // Every stake, settled or not: the pool is what was staked, however far a crash got.
    const everyone = await this.#bets(pred.id);
    const label = shortId(pred.id);
    const winner = pred.status === "resolved" ? data.winner : null;
    const pool = everyone.reduce((n, b) => n + asBet(b).amount, 0);
    const winning = winner === null ? [] : everyone.filter((b) => asBet(b).option === winner);
    const winPool = winning.reduce((n, b) => n + asBet(b).amount, 0);
    const refundAll = pred.status === "cancelled" || winPool === 0;
    const payoutOf = (b: BetData) => Math.floor((b.amount * pool) / winPool);
    for (const bet of everyone.filter((b) => b.status === "open")) {
      const b = asBet(bet);
      const owner = bet.owner;
      if (!owner) continue;
      try {
        if (refundAll) {
          await this.e.purse.giveBack({ id: b.entry, account: owner, amount: b.amount });
          await this.#close(bet, "refunded", b.amount);
        } else if (b.option === winner) {
          const payout = payoutOf(b);
          const who = await this.e.holder(owner);
          await this.e
            .ledger()
            .post(this.e.entryFor(who, payout, "bet_win", pred.id, `betwin:${bet.id}`), {
              wallet: who.wallet,
            });
          await this.#close(bet, "won", payout);
        } else {
          await this.#close(bet, "lost", 0);
        }
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error), bet: bet.id }, "cannot settle a stake");
      }
    }
    const paid = refundAll ? pool : winning.reduce((n, b) => n + payoutOf(asBet(b)), 0);
    // What the floors left over is hers: at most a coin per winner (keyed, so once).
    const dust = refundAll ? 0 : pool - paid;
    if (dust > 0) {
      await this.e.purse
        .credit(dust, "bet_dust", pred.id, `bet-dust:${pred.id}`)
        .catch(() => undefined);
    }
    const text = refundAll
      ? `預測「${data.question}」${pred.status === "cancelled" ? "取消了" : "沒有人猜中"},大家的 ${pool} ${this.e.config.currency}退回去了`
      : `預測「${data.question}」的結果是「${data.options[winner ?? 0]}」,${winning.length} 個人猜中,分了 ${pool} ${this.e.config.currency}`;
    this.e.purse.news(`prediction:${pred.id}:${pred.status}`, text);
    return {
      id: label,
      winner: winner === null ? null : (data.options[winner] ?? null),
      winners: winning.length,
      pool,
      paid,
      refunded: refundAll,
    };
  }

  async #close(bet: EconomyDoc, status: string, payout: number): Promise<void> {
    const cur = await this.#docs().get(this.e.profile, BET, bet.id);
    if (!cur || cur.status !== "open") return;
    await this.#docs().update(this.e.profile, BET, bet.id, cur.version, {
      status,
      data: { ...cur.data, payout },
      at: toTimestamp(this.e.now()),
    });
  }

  /** Called off what nobody settled in time, and finishes settlements a crash left halfway. */
  async sweep(): Promise<void> {
    const now = this.e.now();
    const expire = this.e.config.prediction_expire_hours * HOUR_MS;
    for (const pred of await this.#predictions(["open"])) {
      if (Date.parse(asPrediction(pred).closes_at) + expire > now) continue;
      try {
        await this.cancel(pred.id);
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error), prediction: pred.id }, "cannot call off");
      }
    }
    for (const status of ["resolved", "cancelled"]) {
      for (const pred of await this.#predictions([status], 20)) {
        if ((await this.#bets(pred.id, ["open"])).length === 0) continue;
        await this.e
          .serial(() => this.#settle(pred))
          .catch((error: unknown) => {
            this.e.log.warn({ err: errorMessage(error), prediction: pred.id }, "cannot finish");
          });
      }
    }
  }

  // ---- reading ---------------------------------------------------------------------------

  #view(pred: EconomyDoc, bets: readonly EconomyDoc[], mine: EconomyDoc | null): PredictionView {
    const data = asPrediction(pred);
    const mineBet = mine ? asBet(mine) : null;
    const total = bets.reduce((n, b) => n + asBet(b).amount, 0);
    const now = this.e.now();
    const status =
      pred.status === "open" && Date.parse(data.closes_at) <= now
        ? "closed"
        : (pred.status as "open" | "resolved" | "cancelled");
    return {
      id: shortId(pred.id),
      question: data.question,
      options: data.options.map((label, i) => {
        const on = bets.filter((b) => asBet(b).option === i);
        const staked = on.reduce((n, b) => n + asBet(b).amount, 0);
        return {
          label,
          staked,
          backers: on.length,
          // What a coin on this option would return if it won now.
          multiplier: staked > 0 ? Math.round((total / staked) * 100) / 100 : null,
        };
      }),
      total,
      closes_at: data.closes_at,
      status,
      winner: data.winner === null ? null : (data.options[data.winner] ?? null),
      my_bet:
        mine && mineBet
          ? {
              option: data.options[mineBet.option] ?? "",
              amount: mineBet.amount,
              outcome:
                mine.status === "won"
                  ? "won"
                  : mine.status === "lost"
                    ? "lost"
                    : mine.status === "refunded"
                      ? "refunded"
                      : "open",
              payout: mineBet.payout,
            }
          : null,
    };
  }

  /** The predictions open now and the ones settled lately, with this person's own stake. */
  async view(account: AccountRef | null): Promise<PredictionView[]> {
    const who = account === null ? null : await this.e.member(account);
    const now = this.e.now();
    const preds = (await this.#predictions(["open", "resolved", "cancelled"], 30)).filter(
      (p) => p.status === "open" || now - Date.parse(p.updated_at) < KEEP_MS,
    );
    const bets = await this.#bets();
    return Promise.all(
      preds.map(async (p) => {
        const here = bets.filter((b) => asBet(b).prediction === p.id);
        const mine = who
          ? (here.find((b) => b.id === `bet:${p.id}:${who.person.id}`) ?? null)
          : null;
        return this.#view(p, here, mine);
      }),
    );
  }
}
