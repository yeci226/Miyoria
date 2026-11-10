// Deals (docs/design/economy.md §12): someone's promise of a snack for something small she does.
//
// * She decides (her tools, tools.ts); this file is what is true afterwards. A deal belongs to its
//   speaker's wallet, never to a name in the arguments. One open deal per person, a few per day.
// * Payment is read off the ledger, not from her memory or the model: a feed of the speaker's
//   (any way it was made: panel, Discord command, talking to her) worth the reward, between her
//   saying she did the task and the due time, settles it. A prepaid deal is escrow: charged at
//   once, released to her as an ordinary gift when she says she did it, refunded when she backs
//   out or does not do it in time.
// * Not paid in time is a broken promise: trust and affinity fall (outside the gain caps), her
//   emotions turn toward that person, she keeps a memory of it, and each later one costs more.
// * Deals persist in `DealStore`; a sweep ends what ran out.
// * A deal can only be about what is hers to decide: the screen (`#guard`) refuses tasks the
//   moderation, an owner rule, a forbidden or gated capability or a missing permission stops.

import { ActuatorRegistryKey, capabilityMatches } from "@miyoria/actions";
import { errorMessage } from "@miyoria/kernel";
import {
  type CoinEntry,
  type Deal,
  type DealStatus,
  DealStoreKey,
  PeopleStoreKey,
} from "@miyoria/store";
import {
  type AccountRef,
  AuthorizerKey,
  type ContextKey,
  customEvent,
  DirectivesKey,
  type JsonValue,
  newId,
  PersonNoteWriterKey,
  Principals,
  RelationshipEffectsKey,
  SOCIAL_EVENT_TOPIC,
  safeName,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import type { EconomyService, Member } from "./economy.js";
import { feedLabel, MAX_FEED_COUNT, STRANGER } from "./economy.js";
import { type DealView, EconomyError, FEED_ITEMS, type FeedItem } from "./types.js";

/** A deal the screen refuses (not the speaker's money or luck: what it is about). */
export class DealRefusal extends EconomyError {
  readonly forbidden = true;

  constructor(message: string) {
    super(400, message);
  }
}

export const MAX_TASK_CHARS = 60;
export const NO_DEAL = "你們沒有進行中的約定";
export const OPEN_DEAL = "你們還有一個約定沒結束";
export const DEALS_LIMIT = "今天的約定到上限了";
/** The working-context bucket her deal notes go to. */
const WRITER = "deals";
const MAX_NOTES = 6;
/** Open and owed deals read at once: a sweep's and a person's. */
const MAX_LIVE = 500;
const MAX_DAY_DEALS = 50;
const MAX_FEED_ROWS = 500;
const VIEW_LIMIT = 10;
const LIVE: readonly DealStatus[] = ["open", "owed"];

/** Tasks that stand for something she can only do through a gated capability. */
const TASK_CAPABILITIES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/唱|歌|sing/i, ["sing.play"]],
  [/開台|開播|直播|stream/i, ["stream.start"]],
  [/語音|voice/i, ["voice.join"]],
  [/麥塊|minecraft|我的世界|遊戲|game/i, ["game.start"]],
  [/私訊|\bdm\b/i, ["message.dm"]],
  [/表情|臉紅|愛心眼|expression/i, ["stage.expression"]],
  [/場景|scene/i, ["stage.scene"]],
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** One line of at most `max` characters. */
export function cleanText(text: string, max: number): string {
  return [...text.replace(CONTROL, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("");
}

/** One line of at most `MAX_TASK_CHARS` characters. */
export function cleanTask(task: string): string {
  return cleanText(task, MAX_TASK_CHARS);
}

/**
 * What she may promise (the gate of the bribe, shared by deals, goals and bounties): the text
 * passes moderation, no owner rule forbids it, and what it stands for is something she may do.
 * `who` is the person it is for (their permissions are checked), `null` for her own promise.
 * Throws `DealRefusal`.
 */
export async function guardTask(
  e: EconomyService,
  who: Member | null,
  task: string,
  context: ContextKey | null,
  about: { noun: string; why: string },
): Promise<void> {
  const s = e.services;
  if (!e.passes(who ?? { account: e.purse.account }, task)) {
    throw new DealRefusal(`這個${about.noun}的內容不行`);
  }
  const directives = s.get(DirectivesKey);
  const forbids = directives?.forbids({
    what: task,
    why: about.why,
    steps: [task],
    person: who ? e.handleOf(who.person.id) : null,
    context,
  });
  if (forbids) throw new DealRefusal(`有規則不允許:${forbids.text}`);
  const names = new Set<string>();
  for (const [pattern, capabilities] of TASK_CAPABILITIES) {
    if (pattern.test(task)) for (const name of capabilities) names.add(name);
  }
  if (names.size === 0) return;
  const registry = s.get(ActuatorRegistryKey);
  for (const name of names) {
    const capability = registry?.get(name);
    if (!registry || !capability) throw new DealRefusal("這件事現在做不到");
    if (registry.paused) throw new DealRefusal("她現在被暫停了,不能答應");
    if (registry.config.forbidden.some((p) => capabilityMatches(p, name))) {
      throw new DealRefusal("這件事不允許做");
    }
    // Review and approval are for her own judgement and the owners: a snack does not buy them.
    if (capability.risk === "high") throw new DealRefusal(`這件事要經過審核,不能用${about.noun}買`);
    if (who && capability.permission !== null) {
      const allowed = s.get(AuthorizerKey)?.allows(who.account, capability.permission);
      if (!allowed) throw new DealRefusal("你本來就沒有權限要她做這件事");
    }
    // An owner rule on the capability itself: denied or waiting for approval, a snack buys neither.
    const verdict = await directives?.check({
      capability: name,
      args: {},
      principal: Principals.self(context, who?.account ?? null),
    });
    if (verdict && verdict.outcome !== "allow") throw new DealRefusal("有規則不允許這件事");
  }
}

export interface MakeDealRequest {
  item: FeedItem;
  count: number;
  task: string;
  /** Escrow: charged now, hers when she says she did it. */
  prepaid: boolean;
  /** Where the speaker is talking to her (the rules read it). */
  context: ContextKey | null;
}

export interface MadeDeal {
  deal: Deal;
  /** What the reward is worth in coins. */
  value: number;
  /** The speaker's balance after the escrow (when there is one). */
  balance: number;
}

export interface DealDoneResult {
  deal: Deal;
  /** `released`: the escrow is hers now; `owed`: they have until `deal.due_at` to pay. */
  state: "released" | "owed";
}

/** The person behind a deal, with the accounts that pay. */
interface Payer {
  member: Member;
}

export class DealDesk {
  constructor(private readonly e: EconomyService) {}

  #store() {
    const store = this.e.services.get(DealStoreKey);
    if (!store) throw new EconomyError(503, "約定現在打不開");
    return store;
  }

  /** What the reward costs. */
  value(item: FeedItem, count: number): number {
    return this.e.config[item] * count;
  }

  // ---- making one -----------------------------------------------------------------------

  /** The request is well formed, the speaker is someone she knows and the screen passes it. */
  async #prepare(
    account: AccountRef,
    req: MakeDealRequest,
  ): Promise<{ who: Member; task: string; value: number }> {
    if (!FEED_ITEMS.includes(req.item)) throw new EconomyError(400, "沒有這種食物");
    if (!Number.isInteger(req.count) || req.count < 1 || req.count > MAX_FEED_COUNT) {
      throw new EconomyError(400, `一次最多 ${MAX_FEED_COUNT} 份`);
    }
    const task = cleanTask(req.task);
    if (task === "") throw new EconomyError(400, "要說清楚她要做什麼");
    const who = await this.#known(account);
    await this.#guard(who, task, req.context);
    return { who, task, value: this.value(req.item, req.count) };
  }

  /** One open deal per person, a few per day. */
  async #limits(who: Member): Promise<void> {
    const store = this.#store();
    const live = await store.forAccounts(this.e.profile, who.wallet, { statuses: LIVE, limit: 1 });
    if (live.length > 0) throw new EconomyError(409, OPEN_DEAL);
    const today = await store.forAccounts(this.e.profile, who.wallet, {
      since: this.e.todayStart(),
      limit: MAX_DAY_DEALS,
    });
    if (today.length >= this.e.config.deals_per_day) throw new EconomyError(429, DEALS_LIMIT);
  }

  /**
   * What `make` would refuse, without writing anything (a voice deal is asked about first).
   * Throws `EconomyError` / `DealRefusal`.
   */
  async precheck(account: AccountRef, req: MakeDealRequest): Promise<void> {
    const { who, value } = await this.#prepare(account, req);
    await this.#limits(who);
    if (req.prepaid && (await this.e.ledger().balance(this.e.profile, who.wallet)) < value) {
      throw new EconomyError(402, `${this.e.config.currency}不夠`);
    }
  }

  /** She accepted: records the deal of the speaker (and charges the escrow when prepaid). */
  async make(account: AccountRef, req: MakeDealRequest): Promise<MadeDeal> {
    const { who, task, value } = await this.#prepare(account, req);
    const c = this.e.config;
    const store = this.#store();
    return this.e.serial(async () => {
      await this.#limits(who);
      const id = newId();
      const now = this.e.now();
      let escrow: CoinEntry | null = null;
      let balance = 0;
      if (req.prepaid) {
        const spent = await this.e.spend(who, value, "deal_escrow", id, `deal:${id}`);
        escrow = spent.entry;
        balance = spent.balance;
      }
      const deal: Deal = {
        id,
        profile: this.e.profile,
        account: who.account,
        item: req.item,
        count: req.count,
        value,
        task,
        prepaid: req.prepaid,
        escrow: escrow?.id ?? null,
        status: "open",
        created_at: toTimestamp(now),
        done_at: null,
        // Until then it is "do it by"; saying it is done sets the payment deadline.
        due_at: toTimestamp(now + c.deal_timeout_s * 1000),
        closed_at: null,
      };
      try {
        await store.create(deal);
      } catch (error) {
        if (escrow) await this.e.refundOnce(who, escrow);
        throw error;
      }
      const label = feedLabel(req.item, req.count);
      this.#note(
        who,
        deal,
        "open",
        req.prepaid
          ? `你答應了${safeName(who.name)}:${task},他先付了${label}的錢(在託管,你做完才算你的)`
          : `你答應了${safeName(who.name)}:${task},做完他給你${label}(還沒付)`,
      );
      this.e.record(who, "economy.deal.make", {
        deal: id,
        item: req.item,
        count: req.count,
        value,
        prepaid: req.prepaid,
      });
      return { deal, value, balance };
    });
  }

  /**
   * What a deal may be about (the gate of the bribe): the task passes moderation, no owner rule
   * forbids it, and what it stands for is something she may do for this person.
   */
  async #guard(who: Member, task: string, context: ContextKey | null): Promise<void> {
    await guardTask(this.e, who, task, context, { noun: "約定", why: "收零食的約定" });
  }

  // ---- her side -------------------------------------------------------------------------

  /** She says she did the task of the speaker's open deal. */
  async done(account: AccountRef): Promise<DealDoneResult> {
    const who = await this.#known(account);
    const store = this.#store();
    const c = this.e.config;
    const result = await this.e.serial(async (): Promise<DealDoneResult> => {
      const deal = await this.#live(who);
      if (!deal) throw new EconomyError(409, NO_DEAL);
      if (deal.status === "owed") throw new EconomyError(409, "你已經說過做完了,等對方付");
      const now = this.e.now();
      if (deal.prepaid) {
        const closed = toTimestamp(now);
        const moved = await store.transition(deal.id, ["open"], {
          status: "settled",
          done_at: closed,
          due_at: null,
          closed_at: closed,
        });
        if (!moved) throw new EconomyError(409, "這個約定已經結束了");
        return {
          deal: { ...deal, status: "settled", done_at: closed, due_at: null, closed_at: closed },
          state: "released",
        };
      }
      const done = toTimestamp(now);
      const due = toTimestamp(now + c.deal_due_s * 1000);
      const moved = await store.transition(deal.id, ["open"], {
        status: "owed",
        done_at: done,
        due_at: due,
      });
      if (!moved) throw new EconomyError(409, "這個約定已經結束了");
      return { deal: { ...deal, status: "owed", done_at: done, due_at: due }, state: "owed" };
    });
    const label = feedLabel(result.deal.item as FeedItem, result.deal.count);
    if (result.state === "released") {
      await this.#release(who, result.deal);
      this.#note(who, result.deal, "settled", `${safeName(who.name)}先付的${label}給你了,約定完成`);
      await this.#kept(who, result.deal);
    } else {
      this.#note(
        who,
        result.deal,
        "owed",
        `你做完了:${result.deal.task}。${safeName(who.name)}欠你${label},` +
          `${Math.round(c.deal_due_s / 60)} 分鐘內要付`,
      );
    }
    this.e.record(who, "economy.deal.done", { deal: result.deal.id, state: result.state });
    return result;
  }

  /** She backs out: escrow goes back, an unpaid deal just ends. Costs her nothing. */
  async cancel(
    account: AccountRef,
  ): Promise<{ deal: Deal; refunded: boolean; endedToday: number }> {
    const who = await this.#known(account);
    const store = this.#store();
    const deal = await this.e.serial(async () => {
      const open = await this.#live(who);
      if (!open) throw new EconomyError(409, NO_DEAL);
      const closed = toTimestamp(this.e.now());
      const status: DealStatus = open.prepaid ? "refunded" : "cancelled";
      const moved = await store.transition(open.id, LIVE, {
        status,
        due_at: null,
        closed_at: closed,
      });
      if (!moved) throw new EconomyError(409, "這個約定已經結束了");
      return { ...open, status, due_at: null, closed_at: closed };
    });
    const refunded = deal.prepaid && (await this.#refundEscrow(who, deal));
    const endedToday = await this.#endedToday();
    this.#note(
      who,
      deal,
      deal.status,
      `你取消了和${safeName(who.name)}的約定(${deal.task})` +
        `${refunded ? ",預付的錢已經退回去" : ""}。今天已經有 ${endedToday} 個約定沒做成`,
    );
    this.e.record(who, "economy.deal.cancel", { deal: deal.id, refunded });
    return { deal, refunded, endedToday };
  }

  /** How many deals ended today without her being paid or paid out. */
  async #endedToday(): Promise<number> {
    const rows = await this.#store().byStatus(this.e.profile, ["cancelled", "refunded"], {
      since: this.e.todayStart(),
      limit: MAX_LIVE,
    });
    return rows.length;
  }

  /** The speaker's deal that is not over yet. */
  async #live(who: Member): Promise<Deal | null> {
    const rows = await this.#store().forAccounts(this.e.profile, who.wallet, {
      statuses: LIVE,
      limit: 1,
    });
    return rows[0] ?? null;
  }

  // ---- payment --------------------------------------------------------------------------

  /** A feed of `who` went through: it may be what they owed. */
  async paid(who: Member): Promise<void> {
    const store = this.e.services.get(DealStoreKey);
    if (!store) return;
    const rows = await store.forAccounts(this.e.profile, who.wallet, {
      statuses: ["owed"],
      limit: 1,
    });
    const deal = rows[0];
    if (deal) await this.#settleIfPaid(who, deal);
  }

  /**
   * What the speaker's wallet fed her since she said she was done, up to the due time: feeds not
   * refunded, in coins. This is the only proof of payment.
   */
  async #fed(who: Member, deal: Deal): Promise<number> {
    if (deal.done_at === null) return 0;
    const rows = await this.e.ledger().entries(this.e.profile, who.wallet, {
      reasons: ["feed", "refund"],
      since: deal.done_at,
      limit: MAX_FEED_ROWS,
    });
    const refunded = new Set(rows.filter((r) => r.reason === "refund").map((r) => r.ref));
    const until = deal.due_at === null ? Number.POSITIVE_INFINITY : Date.parse(deal.due_at);
    return rows
      .filter((r) => r.reason === "feed" && !refunded.has(r.id) && Date.parse(r.ts) <= until)
      .reduce((n, r) => n - r.delta, 0);
  }

  async #settleIfPaid(who: Member, deal: Deal): Promise<boolean> {
    if ((await this.#fed(who, deal)) < deal.value) return false;
    const closed = toTimestamp(this.e.now());
    const moved = await this.#store().transition(deal.id, ["owed"], {
      status: "settled",
      due_at: null,
      closed_at: closed,
    });
    if (!moved) return false;
    const settled: Deal = { ...deal, status: "settled", due_at: null, closed_at: closed };
    const label = feedLabel(deal.item as FeedItem, deal.count);
    this.#note(who, settled, "settled", `${safeName(who.name)}付了你${label},約定完成`);
    await this.#kept(who, settled);
    this.e.record(who, "economy.deal.settled", { deal: deal.id, value: deal.value });
    return true;
  }

  /** A deal paid for: a little trust (inside the daily caps). */
  async #kept(who: Member, deal: Deal): Promise<void> {
    const trust = this.e.config.deal_kept_trust;
    const effects = this.e.services.get(RelationshipEffectsKey);
    if (!effects || trust <= 0) return;
    try {
      await effects.gain(
        who.person.id,
        { kind: "deal_kept", affinity: 0, trust, kind_cap: null },
        this.e.now(),
      );
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error), deal: deal.id }, "cannot add a kept deal");
    }
  }

  async #release(who: Member, deal: Deal): Promise<void> {
    try {
      const entry = await this.e.ledger().byKey(this.e.profile, who.wallet, `deal:${deal.id}`);
      if (!entry) return;
      await this.e.release(who, entry, deal.item as FeedItem, deal.count);
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error), deal: deal.id }, "cannot release the escrow");
    }
  }

  async #refundEscrow(who: Member, deal: Deal): Promise<boolean> {
    try {
      const entry = await this.e.ledger().byKey(this.e.profile, who.wallet, `deal:${deal.id}`);
      if (!entry) return false;
      return await this.e.serial(() => this.e.refundOnce(who, entry));
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error), deal: deal.id }, "cannot refund the escrow");
      return false;
    }
  }

  // ---- time -----------------------------------------------------------------------------

  /** Ends what ran out: unpaid deals become broken promises, escrow times out. */
  async sweep(): Promise<void> {
    const store = this.e.services.get(DealStoreKey);
    if (!store) return;
    const now = this.e.now();
    const live = await store.byStatus(this.e.profile, LIVE, { limit: MAX_LIVE });
    for (const deal of live) {
      if (deal.due_at === null || Date.parse(deal.due_at) > now) continue;
      try {
        await this.#expire(deal);
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error), deal: deal.id }, "cannot end a deal");
      }
    }
  }

  async #expire(deal: Deal): Promise<void> {
    const payer = await this.#payer(deal.account);
    const store = this.#store();
    const closed = toTimestamp(this.e.now());
    if (deal.status === "owed") {
      // The ledger first: a feed that arrived before the due time still counts.
      if (payer && (await this.#settleIfPaid(payer.member, deal))) return;
      const moved = await store.transition(deal.id, ["owed"], {
        status: "broken",
        due_at: null,
        closed_at: closed,
      });
      if (moved && payer) await this.#broke(payer.member, { ...deal, status: "broken" });
      return;
    }
    // Not done in time: nothing was kept or broken, escrow goes back.
    const status: DealStatus = deal.prepaid ? "refunded" : "cancelled";
    const moved = await store.transition(deal.id, ["open"], {
      status,
      due_at: null,
      closed_at: closed,
    });
    if (!moved || !payer) return;
    const ended: Deal = { ...deal, status, due_at: null, closed_at: closed };
    const refunded = deal.prepaid && (await this.#refundEscrow(payer.member, ended));
    this.#note(
      payer.member,
      ended,
      status,
      `你沒在時間內做${safeName(payer.member.name)}的約定(${deal.task}),就算了` +
        `${refunded ? ",預付的錢已經退回去" : ""}`,
    );
    this.e.record(payer.member, "economy.deal.expired", { deal: deal.id, refunded });
  }

  /** She did it and was not paid by the due time. */
  async #broke(who: Member, deal: Deal): Promise<void> {
    const c = this.e.config;
    const store = this.#store();
    const earlier = (
      await store.forAccounts(this.e.profile, who.wallet, { statuses: ["broken"], limit: 50 })
    ).filter((d) => d.id !== deal.id).length;
    const times = Math.min(c.broken_growth ** earlier, c.broken_cap);
    const now = this.e.now();
    const label = feedLabel(deal.item as FeedItem, deal.count);
    const name = safeName(who.name);
    const effects = this.e.services.get(RelationshipEffectsKey);
    try {
      await effects?.penalty(
        who.person.id,
        {
          affinity: c.broken_affinity * times,
          trust: c.broken_trust * times,
          reason: "deal: broken_promise",
        },
        now,
      );
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error), deal: deal.id }, "cannot hold a broken promise");
    }
    // Her emotions: anger and resentment toward them, stronger each time.
    const payload: JsonValue = {
      person: who.person.id,
      name: who.name,
      kind: "broken_promise",
      source: "economy",
      scale: Math.round(Math.min(0.4 + 0.2 * earlier, 1) * 100) / 100,
      context: null,
    };
    this.e.publish(customEvent(SOCIAL_EVENT_TOPIC, payload));
    // A memory of it, through the normal path: she recalls it when they are next here.
    const writer = this.e.services.get(PersonNoteWriterKey);
    if (writer) {
      try {
        await writer.note(who.person.id, `${name} 答應給我${label},我照做了卻沒給`, {
          importance: Math.round(Math.min(0.7 + 0.1 * earlier, 0.95) * 100) / 100,
          at: toTimestamp(now),
        });
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error), deal: deal.id }, "cannot remember a deal");
      }
    }
    this.#note(
      who,
      deal,
      "broken",
      `${name}答應給你${label},你做了(${deal.task})卻沒收到:食言,這是第 ${earlier + 1} 次。` +
        "下次可以要他先付",
    );
    this.e.record(who, "economy.deal.broken", { deal: deal.id, earlier, times });
  }

  /** The person behind `account`, even when she no longer lets them in (a broken promise stays). */
  async #payer(account: AccountRef): Promise<Payer | null> {
    const known = await this.e.member(account);
    if (known) return { member: known };
    const person = await this.e.services.get(PeopleStoreKey)?.personByAccount(account);
    if (!person) return null;
    const own = person.accounts.find((a) => a.account.id === account.id);
    return {
      member: {
        account,
        person,
        wallet: person.accounts.map((a) => a.account),
        name: own?.display_name ?? person.display_name,
      },
    };
  }

  async #known(account: AccountRef): Promise<Member> {
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    return who;
  }

  // ---- what she and the wallet see ------------------------------------------------------

  #note(who: Member, deal: Deal, state: string, text: string): void {
    this.e.tell(who, "economy.deal", `deal:${deal.id}:${state}`, text, WRITER, MAX_NOTES);
  }

  /** The wallet's list: newest first, cancelled ones left out. */
  async view(who: Member): Promise<DealView[]> {
    const store = this.e.services.get(DealStoreKey);
    if (!store) return [];
    const rows = await store.forAccounts(this.e.profile, who.wallet, { limit: VIEW_LIMIT * 2 });
    return rows
      .filter((d) => d.status !== "cancelled")
      .slice(0, VIEW_LIMIT)
      .map((d) => ({
        task: d.task,
        reward_label: feedLabel(d.item as FeedItem, d.count),
        status: d.status as DealView["status"],
        due_at: d.status === "open" || d.status === "owed" ? (d.due_at as Timestamp | null) : null,
      }));
  }
}
