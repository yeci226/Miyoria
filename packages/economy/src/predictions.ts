// Predictions (docs/design/v4-plan.md §9.1 and §10, v5-play.md §4.2): people stake coins on how
// something of hers turns out, and the ones who were right share what everybody staked, less a cut
// that is burned.
//
// * A pool, not a house. Stakes are held as ledger rows (`bet`); when it is settled the winners
//   share the pool less `prediction_rake` (5%: floored, burned: no row takes it), each
//   `stake * prize / winners' stakes`, floored, and the leftover coins (at most one per winner) go
//   to her purse. Nothing is created: the coins paid out are at most the coins staked. If nobody
//   was right, or it is called off, every stake is given back in full.
// * One stake per person per prediction (one option), at most `bet_max` each and `bet_daily_max`
//   a day; betting closes at the time she set (at most `prediction_max_minutes`) and she cannot bet
//   herself.
// * Who settles it, written on the prediction (`settled_by`) and in the audit:
//   - `auto`: a prediction opened on something she runs whose result the system sees itself
//     (`prediction-watch.ts`: a turtle soup guessed or not, a game goal of hers done or not). Its
//     options are fixed by that, betting closes within `prediction_auto_close_minutes`, and she
//     cannot call it by hand. Nothing anyone types settles one.
//   - `her`: she calls the result of one of her own with her tool.
//   - `admin`: the owner settles or calls off any of them from the panel.
//   - `expired`: nobody could tell in time (`prediction_auto_wait_minutes` after closing for an
//     automatic one, `prediction_expire_hours` for hers): every stake goes back.
// * Placing a stake also counts as taking part (`prediction_join`, play.ts).
// * The prediction and its stakes are documents (docs.ts); coins live only in the ledger, so
//   settling is idempotent: every payout and refund has a key, and a sweep finishes what a crash
//   left halfway.

import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type ContextKey,
  type JsonValue,
  newId,
  PlacesKey,
  toTimestamp,
} from "@miyoria/types";
import type { EconomyDoc } from "./docs.js";
import { type EconomyService, type Member, STRANGER } from "./economy.js";
import { PredictionWatch } from "./prediction-watch.js";
import { pickById, shortId } from "./purse.js";
import { mayTakePart, spaceName, spaceToOpen } from "./spaces.js";
import { EconomyError } from "./types.js";
import type {
  BetResult,
  PredictionSettledBy,
  PredictionSourceKind,
  PredictionView,
  ResolveResult,
} from "./v2-types.js";

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
/** A bet on a prediction of a server they are not in (`{server}`: its name). */
export const NOT_THERE =
  "這個預測是{server}的,只有那裡的成員能押(在那個伺服器說過話、用過指令或進過語音就算)";

/** The options of a prediction that settles by itself, by what settles it. */
export const AUTO_OPTIONS: Readonly<Record<PredictionSourceKind, readonly [string, string]>> = {
  soup: ["猜中", "沒猜中"],
  goal: ["做到", "沒做到"],
};

/** What settles an automatic prediction: the thing it is bound to when it opened. */
export interface PredictionSource {
  kind: PredictionSourceKind;
  /** The soup's session id, or the goal as the game director put it. */
  ref: string;
  /** The game: `soup`, or the game director's game id. */
  game: string;
  /** What it settles on, for people (`這碗海龜湯`, `目標「蓋房子」`). */
  label: string;
}

interface PredictionData {
  question: string;
  options: string[];
  closes_at: string;
  winner: number | null;
  /** `null`: hers to call. */
  source?: PredictionSource | null;
  settled_by?: PredictionSettledBy | null;
  /** The cut burned when it was resolved with winners (the rate then, so a re-run pays the same). */
  rake_rate?: number;
  [key: string]: JsonValue | PredictionSource | PredictionSettledBy | undefined;
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

/** How a prediction is settled, as people read it. */
function settlesLabel(source: PredictionSource | null): string {
  if (source === null) return "她公布結果";
  return `照${source.label}的結果自動結算`;
}

export class PredictionDesk {
  /** What she runs that predictions can be bound to and settled on. */
  readonly watch: PredictionWatch;

  constructor(private readonly e: EconomyService) {
    this.watch = new PredictionWatch(e, this);
  }

  #docs() {
    return this.e.docs();
  }

  #places() {
    return this.e.services.get(PlacesKey);
  }

  /** Predictions by status, newest first; `spaces`: only those servers' (and the ones of none). */
  async #predictions(
    statuses: readonly string[],
    limit = 50,
    spaces?: readonly string[],
  ): Promise<EconomyDoc[]> {
    return this.#docs().list(this.e.profile, PREDICTION, {
      statuses,
      limit,
      ...(spaces ? { spaces } : {}),
    });
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

  #settledBy(
    by: PredictionSettledBy["by"],
    note: string,
    who: string | null = null,
  ): PredictionSettledBy {
    return { by, note, at: toTimestamp(this.e.now()), who };
  }

  // ---- opening ---------------------------------------------------------------------------

  /**
   * She opens a prediction people can stake on for `minutes`. With `settle_by` it is bound to the
   * soup or game goal of hers going on now (`context`: where she is, to tell soups apart) and
   * settles by itself; its options are then fixed by that and the ones given are not used. It
   * belongs to the server of `context` (with none, the primary): only that server's members see it
   * and may bet, and `predictions_open` counts per server.
   */
  async open(req: {
    question: string;
    options: readonly string[];
    minutes: number;
    settle_by?: PredictionSourceKind | null;
    context?: ContextKey | null;
  }): Promise<PredictionView> {
    const c = this.e.config;
    const question = req.question.trim();
    const kind = req.settle_by ?? null;
    let source: PredictionSource | null = null;
    if (kind !== null) {
      source = this.watch.bind(kind, req.context ?? null);
      if (source === null) {
        throw new EconomyError(
          409,
          kind === "soup"
            ? "現在沒有正在玩的海龜湯可以讓預測自己結算"
            : "現在看不到她在做的遊戲目標,沒辦法讓預測自己結算",
        );
      }
    }
    const options = source ? [...AUTO_OPTIONS[source.kind]] : req.options.map((o) => o.trim());
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
    // Betting on what settles by itself closes early: the result may come at any moment.
    const minutes = source ? Math.min(req.minutes, c.prediction_auto_close_minutes) : req.minutes;
    const as = { account: this.e.purse.account };
    if (!this.e.passes(as, [question, ...options].join(" "))) {
      throw new EconomyError(400, "這個預測通不過審查");
    }
    const space = spaceToOpen(this.#places(), req.context);
    const made = await this.e.serial(async (): Promise<EconomyDoc> => {
      const open = await this.#predictions(["open"], 50, space === null ? undefined : [space]);
      if (open.length >= c.predictions_open) {
        throw new EconomyError(429, `同時開著的預測到上限了(${c.predictions_open} 個)`);
      }
      const now = this.e.now();
      const at = toTimestamp(now);
      const data: PredictionData = {
        question,
        options,
        closes_at: toTimestamp(now + minutes * MIN_MS),
        winner: null,
        source,
        settled_by: null,
      };
      const doc: EconomyDoc = {
        id: newId(),
        kind: PREDICTION,
        owner: null,
        status: "open",
        version: 1,
        data: data as unknown as EconomyDoc["data"],
        created_at: at,
        updated_at: at,
        space,
      };
      await this.#docs().create(doc);
      return doc;
    });
    this.e.purse.audit("economy.prediction.open", {
      prediction: made.id,
      settles: source === null ? "her" : source.kind,
      space,
    });
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
      const places = this.#places();
      if (!mayTakePart(places, who.person.id, pred.space)) {
        throw new EconomyError(
          403,
          NOT_THERE.replace("{server}", spaceName(places, pred.space ?? "")),
        );
      }
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
        space: pred.space ?? null,
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

  /** She calls the result of one of hers; one that settles by itself is not hers to call. */
  async resolve(ref: string, which: string | number): Promise<ResolveResult> {
    const pred = await this.#pick(ref, ["open"]);
    const source = asPrediction(pred).source ?? null;
    if (source !== null) {
      throw new EconomyError(409, `這個預測會${settlesLabel(source)},不用你公布`);
    }
    return this.#resolve(pred.id, which, this.#settledBy("her", "她公布的結果"));
  }

  /** The owner settles any open prediction by hand (`who`: the operator, for the record). */
  async resolveByAdmin(ref: string, which: string | number, who: string): Promise<ResolveResult> {
    const pred = await this.#pick(ref, ["open"]);
    return this.#resolve(pred.id, which, this.#settledBy("admin", "管理員公布的結果", who));
  }

  /** Calls an open prediction off: every stake is given back. */
  async cancel(ref: string, settled?: PredictionSettledBy): Promise<ResolveResult> {
    const by = settled ?? this.#settledBy("her", "她取消了,全部退回");
    const result = await this.e.serial(async (): Promise<ResolveResult> => {
      const pred = await this.#pick(ref, ["open"]);
      const data = { ...asPrediction(pred), settled_by: by };
      const moved = await this.#docs().update(this.e.profile, PREDICTION, pred.id, pred.version, {
        status: "cancelled",
        data: data as unknown as EconomyDoc["data"],
        at: toTimestamp(this.e.now()),
      });
      if (!moved) throw new EconomyError(409, NO_PREDICTION);
      return this.#settle({
        ...pred,
        status: "cancelled",
        version: pred.version + 1,
        data: data as unknown as EconomyDoc["data"],
      });
    });
    this.e.purse.audit("economy.prediction.cancel", {
      prediction: result.id,
      by: by.by,
      who: by.who,
    });
    return result;
  }

  /** The owner calls one off by hand. */
  cancelByAdmin(ref: string, who: string): Promise<ResolveResult> {
    return this.cancel(ref, this.#settledBy("admin", "管理員取消了,全部退回", who));
  }

  async #resolve(
    id: string,
    which: string | number,
    by: PredictionSettledBy,
  ): Promise<ResolveResult> {
    const result = await this.e.serial(async (): Promise<ResolveResult> => {
      const pred = await this.#pick(id, ["open"]);
      const winner = this.#option(asPrediction(pred).options, which);
      const data: PredictionData = {
        ...asPrediction(pred),
        winner,
        settled_by: by,
        rake_rate: this.e.config.prediction_rake,
      };
      const moved = await this.#docs().update(this.e.profile, PREDICTION, pred.id, pred.version, {
        status: "resolved",
        data: data as unknown as EconomyDoc["data"],
        at: toTimestamp(this.e.now()),
      });
      if (!moved) throw new EconomyError(409, NO_PREDICTION);
      return this.#settle({
        ...pred,
        status: "resolved",
        version: pred.version + 1,
        data: data as unknown as EconomyDoc["data"],
      });
    });
    this.e.purse.audit("economy.prediction.resolve", {
      prediction: result.id,
      by: by.by,
      who: by.who,
      winner: result.winner,
      rake: result.rake,
    });
    return result;
  }

  /**
   * What the system saw of a thing predictions are bound to: settles every open one bound to it.
   * `result` is the winning option, `null` when the outcome cannot be told (then every stake goes
   * back); `match.ref` absent: every one bound to `kind` in `match.game` (the game went away).
   */
  async settleFrom(
    kind: PredictionSourceKind,
    match: { ref?: string; game: string },
    result: number | null,
    note: string,
  ): Promise<ResolveResult[]> {
    const bound = (await this.#predictions(["open"])).filter((p) => {
      const s = asPrediction(p).source ?? null;
      return (
        s !== null &&
        s.kind === kind &&
        s.game === match.game &&
        (match.ref === undefined || s.ref === match.ref)
      );
    });
    const done: ResolveResult[] = [];
    for (const pred of bound) {
      const by = this.#settledBy("auto", note);
      try {
        done.push(
          result === null
            ? await this.cancel(pred.id, by)
            : // Options are named from 1.
              await this.#resolve(pred.id, result + 1, by),
        );
      } catch (error) {
        // Settled by someone else meanwhile (the owner): theirs stands.
        this.e.log.warn({ err: errorMessage(error), prediction: pred.id }, "cannot settle");
      }
    }
    return done;
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
    // The cut is burned: the stakes left the wallets already, and no row pays it to anyone.
    const rake = refundAll ? 0 : Math.floor(pool * (data.rake_rate ?? 0));
    const prize = pool - rake;
    const payoutOf = (b: BetData) => Math.floor((b.amount * prize) / winPool);
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
          if (payout > 0) {
            await this.e
              .ledger()
              .post(this.e.entryFor(who, payout, "bet_win", pred.id, `betwin:${bet.id}`));
          }
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
    const dust = refundAll ? 0 : prize - paid;
    if (dust > 0) {
      await this.e.purse
        .credit(dust, "bet_dust", pred.id, `bet-dust:${pred.id}`)
        .catch(() => undefined);
    }
    const cur = this.e.config.currency;
    const how = data.settled_by?.note ?? "";
    const text = refundAll
      ? `預測「${data.question}」${pred.status === "cancelled" ? "取消了" : "沒有人猜中"},大家的 ${pool} ${cur}退回去了${how ? `(${how})` : ""}`
      : `預測「${data.question}」的結果是「${data.options[winner ?? 0]}」${how ? `(${how})` : ""},${winning.length} 個人猜中,分了 ${prize} ${cur}${rake > 0 ? `,${rake} ${cur}燒掉` : ""}`;
    this.e.purse.news(`prediction:${pred.id}:${pred.status}`, text);
    return {
      id: label,
      winner: winner === null ? null : (data.options[winner] ?? null),
      winners: winning.length,
      pool,
      paid,
      rake,
      refunded: refundAll,
    };
  }

  async #close(bet: EconomyDoc, status: string, payout: number): Promise<void> {
    const cur = await this.#docs().get(this.e.profile, BET, bet.id);
    if (cur?.status !== "open") return;
    await this.#docs().update(this.e.profile, BET, bet.id, cur.version, {
      status,
      data: { ...cur.data, payout },
      at: toTimestamp(this.e.now()),
    });
  }

  /** Calls off what nobody could settle in time, and finishes settlements a crash left halfway. */
  async sweep(): Promise<void> {
    const c = this.e.config;
    const now = this.e.now();
    for (const pred of await this.#predictions(["open"])) {
      const data = asPrediction(pred);
      const auto = (data.source ?? null) !== null;
      const wait = auto
        ? c.prediction_auto_wait_minutes * MIN_MS
        : c.prediction_expire_hours * HOUR_MS;
      if (Date.parse(data.closes_at) + wait > now) continue;
      const note = auto
        ? `截止後 ${c.prediction_auto_wait_minutes} 分鐘還不知道結果,全部退回`
        : `截止後 ${c.prediction_expire_hours} 小時沒有人公布,全部退回`;
      try {
        await this.cancel(pred.id, this.#settledBy("expired", note));
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
    const source = data.source ?? null;
    const space = pred.space ?? null;
    // The cut a win would take: today's rate while it is open, the one it was settled with after.
    const rate = pred.status === "open" ? this.e.config.prediction_rake : (data.rake_rate ?? 0);
    const prize = total - Math.floor(total * rate);
    return {
      id: shortId(pred.id),
      space:
        space === null ? null : { id: space, name: this.#places()?.space(space)?.name ?? null },
      question: data.question,
      options: data.options.map((label, i) => {
        const on = bets.filter((b) => asBet(b).option === i);
        const staked = on.reduce((n, b) => n + asBet(b).amount, 0);
        return {
          label,
          staked,
          backers: on.length,
          // What a coin on this option would return if it won now (the cut taken).
          multiplier: staked > 0 ? Math.round((prize / staked) * 100) / 100 : null,
        };
      }),
      total,
      closes_at: data.closes_at,
      status,
      winner: data.winner === null ? null : (data.options[data.winner] ?? null),
      settles: { kind: source === null ? "her" : source.kind, label: settlesLabel(source) },
      settled_by: data.settled_by ?? null,
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

  /**
   * The predictions open now and the ones settled lately, with this person's own stake; `spaces`:
   * only those servers' (and the ones of no server), all of them without.
   */
  async view(account: AccountRef | null, spaces?: readonly string[]): Promise<PredictionView[]> {
    const who = account === null ? null : await this.e.member(account);
    const now = this.e.now();
    const preds = (await this.#predictions(["open", "resolved", "cancelled"], 30, spaces)).filter(
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
