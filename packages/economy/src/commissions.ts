// Commissioning her (docs/design/v4-plan.md §10): pay coins to ask her for one thing, a poem, a name,
// a small tool, a song she sings, one line of voice, and get it back when she is done.
//
// * Asking charges the kind's price (`commission_prices`; `0` takes a kind off) up front, at most
//   `commissions_per_day` per person and `commissions_open` waiting for her at once. The brief
//   passes the same screen a letter passes. The charge is held: it is only hers once she delivers.
// * She hears of it silently (her working context, a bucket of its own) and `economy.commission`
//   goes on the bus for whatever does the work (the work lane); `list_commissions` shows her what
//   is open. She, or the work lane through this service, then `deliver`s the result (screened as
//   output) or `decline`s it. A delivery puts `commission_share` of the price in her purse (the
//   rest leaves the economy) and `economy.commission.done` on the bus so whoever sends messages can
//   hand the result to the person; it is also kept on the commission for `/me commissions`.
// * Declined, or untouched for `commission_days`, the whole price goes back.
// * Nothing here changes how she feels about anyone, and what she delivers is her own work: it is
//   not an obligation to do whatever was asked (she may decline).
//
// The commission is a document (docs.ts); the coins are ledger rows (reason `commission`, refunds
// keyed on the row), so a crash never loses or doubles a payment.

import { errorMessage } from "@miyoria/kernel";
import {
  type AccountRef,
  customEvent,
  type JsonValue,
  safeName,
  toTimestamp,
} from "@miyoria/types";
import type { EconomyDoc } from "./docs.js";
import { type EconomyService, type Member, STRANGER } from "./economy.js";
import { pickById, shortId } from "./purse.js";
import { EconomyError } from "./types.js";
import {
  COMMISSION_DONE_TOPIC,
  COMMISSION_KINDS,
  COMMISSION_TOPIC,
  type CommissionKind,
  type CommissionResult,
  type CommissionView,
} from "./v2-types.js";

const KIND = "commission";
const DAY_MS = 86_400_000;
const MAX_BRIEF_CHARS = 200;
const MAX_RESULT_CHARS = 1_500;
const MAX_NOTE_CHARS = 100;
const MAX_LIST = 50;

export const NO_COMMISSION = "沒有這個委託";
export const COMMISSION_LABEL: Readonly<Record<CommissionKind, string>> = {
  poem: "寫一首詩",
  name: "取名字",
  tool: "寫個小工具",
  song: "唱指定的歌",
  voice: "錄一句語音",
};

interface Data {
  kind: CommissionKind;
  brief: string;
  price: number;
  key: string;
  /** The ledger row of the charge. */
  entry: string;
  due_at: string;
  name: string;
  result: string | null;
  note: string | null;
  [k: string]: string | number | null;
}

const asData = (d: EconomyDoc) => d.data as unknown as Data;

export class CommissionDesk {
  constructor(private readonly e: EconomyService) {}

  #docs() {
    return this.e.docs();
  }

  async #open(): Promise<EconomyDoc[]> {
    return this.#docs().list(this.e.profile, KIND, { statuses: ["open"], limit: MAX_LIST });
  }

  /** What `kind` costs now, `0` when it is off. */
  price(kind: CommissionKind): number {
    return this.e.config.commission_prices[kind] ?? 0;
  }

  /** The kinds on offer with their prices. */
  menu(): { kind: CommissionKind; label: string; price: number }[] {
    return COMMISSION_KINDS.map((kind) => ({
      kind,
      label: COMMISSION_LABEL[kind],
      price: this.price(kind),
    })).filter((m) => m.price > 0);
  }

  // ---- asking ----------------------------------------------------------------------------

  async ask(
    account: AccountRef,
    kind: CommissionKind,
    briefText: string,
    key: string,
  ): Promise<CommissionResult> {
    const c = this.e.config;
    if (!COMMISSION_KINDS.includes(kind)) throw new EconomyError(400, "沒有這種委託");
    const price = this.price(kind);
    if (price <= 0 || c.commissions_per_day <= 0) throw new EconomyError(400, "現在不接這種委託");
    const brief = briefText.trim();
    if (brief === "" || [...brief].length > MAX_BRIEF_CHARS) {
      throw new EconomyError(400, `要寫清楚想請她做什麼(1 到 ${MAX_BRIEF_CHARS} 個字)`);
    }
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    const idem = `commission:${key}`;
    const made = await this.e.serial(async (): Promise<{ doc: EconomyDoc; fresh: boolean }> => {
      const first = await this.e.byKey(who, idem);
      if (first) {
        const doc = await this.#docs().get(this.e.profile, KIND, first.id);
        if (doc) return { doc, fresh: false };
        // The charge is there but the commission was not written: finish it, once.
        if ((await this.e.byKey(who, `refund:${first.id}`)) !== null) {
          throw new EconomyError(409, "這個委託沒有成立，已經退回，再委託一次");
        }
        return { doc: await this.#write(who, first.id, kind, brief, price, idem), fresh: false };
      }
      if (!this.e.passes(who, brief)) throw new EconomyError(400, "這個委託通不過審查");
      const rows = await this.e.rowsToday(who);
      const refunded = new Set(rows.filter((r) => r.reason === "refund").map((r) => r.ref));
      const today = rows.filter((r) => r.reason === "commission" && !refunded.has(r.id)).length;
      if (today >= c.commissions_per_day) {
        throw new EconomyError(429, `今天最多委託 ${c.commissions_per_day} 次`);
      }
      if ((await this.#open()).length >= c.commissions_open) {
        throw new EconomyError(429, "她手上等著做的委託滿了，晚點再來");
      }
      const spent = await this.e.spend(who, price, "commission", kind, idem);
      try {
        return {
          doc: await this.#write(who, spent.entry.id, kind, brief, price, idem),
          fresh: true,
        };
      } catch (error) {
        await this.e.refundOnce(who, spent.entry);
        throw error;
      }
    });
    if (made.fresh) {
      this.#announce(who, made.doc);
      this.e.record(who, "economy.commission", { kind, price });
      await this.e.v2.afterEarn(who);
    }
    return {
      id: shortId(made.doc.id),
      kind,
      label: COMMISSION_LABEL[kind],
      price,
      balance: await this.e.ledger().balance(this.e.profile, who.wallet),
      duplicate: !made.fresh,
    };
  }

  async #write(
    who: Member,
    id: string,
    kind: CommissionKind,
    brief: string,
    price: number,
    key: string,
  ): Promise<EconomyDoc> {
    const now = this.e.now();
    const at = toTimestamp(now);
    const data: Data = {
      kind,
      brief,
      price,
      key,
      entry: id,
      due_at: toTimestamp(now + this.e.config.commission_days * DAY_MS),
      name: safeName(who.name),
      result: null,
      note: null,
    };
    const doc: EconomyDoc = {
      id,
      profile: this.e.profile,
      kind: KIND,
      owner: who.account,
      status: "open",
      version: 1,
      data,
      created_at: at,
      updated_at: at,
    };
    if (!(await this.#docs().create(doc))) {
      const there = await this.#docs().get(this.e.profile, KIND, id);
      if (there) return there;
      throw new EconomyError(503, "委託現在寫不進去");
    }
    return doc;
  }

  /** She hears of it, silently, and whatever does the work is told on the bus. */
  #announce(who: Member, doc: EconomyDoc): void {
    const d = asData(doc);
    const code = shortId(doc.id);
    this.e.tell(
      who,
      "economy.commission",
      `economy:commission:${doc.id}`,
      `${d.name}委託你${COMMISSION_LABEL[d.kind]}[${code}]:「${d.brief}」(付了 ${d.price} ${this.e.config.currency}，做完用 deliver_commission 交給他，不想做可以 decline_commission 退錢)`,
      "commissions",
      10,
    );
    const payload: JsonValue = {
      id: code,
      commission: doc.id,
      kind: d.kind,
      brief: d.brief,
      name: d.name,
      account: { platform: who.account.platform, id: who.account.id },
      price: d.price,
      due_at: d.due_at,
    };
    this.e.publish(customEvent(COMMISSION_TOPIC, payload));
  }

  // ---- doing them ------------------------------------------------------------------------

  async #pick(ref: string): Promise<EconomyDoc> {
    const found = pickById(await this.#open(), ref);
    if (!found) throw new EconomyError(409, NO_COMMISSION);
    return found;
  }

  /** The commissions waiting for her, oldest first. */
  async waiting(): Promise<CommissionView[]> {
    const rows = (await this.#open()).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return rows.map((d) => this.#view(d));
  }

  /** She (or the work lane) hands in the result; `commission_share` of the price is hers. */
  async deliver(ref: string, text: string): Promise<CommissionView> {
    const body = text.trim();
    if (body === "" || [...body].length > MAX_RESULT_CHARS) {
      throw new EconomyError(400, `交的東西要 1 到 ${MAX_RESULT_CHARS} 個字`);
    }
    const done = await this.e.serial(async (): Promise<EconomyDoc> => {
      const doc = await this.#pick(ref);
      const d = asData(doc);
      if (!doc.owner) throw new EconomyError(409, NO_COMMISSION);
      // What she hands over is read as output, like anything shown to people.
      if (!this.e.passes({ account: this.e.purse.account }, body)) {
        throw new EconomyError(400, "這份東西通不過審查");
      }
      const next = { ...d, result: body };
      const moved = await this.#docs().update(this.e.profile, KIND, doc.id, doc.version, {
        status: "delivered",
        data: next,
        at: toTimestamp(this.e.now()),
      });
      if (!moved) throw new EconomyError(409, NO_COMMISSION);
      const mine = Math.floor(d.price * this.e.config.commission_share);
      if (mine > 0) {
        await this.e.purse.credit(mine, "commission_pay", doc.id, `commission-pay:${doc.id}`);
      }
      return { ...doc, status: "delivered", version: doc.version + 1, data: next };
    });
    const d = asData(done);
    this.e.publish(
      customEvent(COMMISSION_DONE_TOPIC, {
        id: shortId(done.id),
        status: "delivered",
        kind: d.kind,
        account: done.owner ? { platform: done.owner.platform, id: done.owner.id } : null,
        text: body,
      }),
    );
    this.e.purse.audit("economy.commission.deliver", { commission: done.id });
    await this.e.purse.refresh();
    return this.#view(done);
  }

  /** She will not do it: the whole price goes back. */
  async decline(ref: string, why: string): Promise<CommissionView> {
    const note = [...why.trim()].slice(0, MAX_NOTE_CHARS).join("");
    const doc = await this.e.serial(async () => this.#end(await this.#pick(ref), "declined", note));
    this.e.publish(
      customEvent(COMMISSION_DONE_TOPIC, {
        id: shortId(doc.id),
        status: "declined",
        kind: asData(doc).kind,
        account: doc.owner ? { platform: doc.owner.platform, id: doc.owner.id } : null,
        text: note,
      }),
    );
    this.e.purse.audit("economy.commission.decline", { commission: doc.id });
    return this.#view(doc);
  }

  async #end(doc: EconomyDoc, status: "declined" | "expired", note: string): Promise<EconomyDoc> {
    const d = asData(doc);
    const owner = doc.owner;
    if (!owner) throw new EconomyError(409, NO_COMMISSION);
    const next = { ...d, note: note === "" ? null : note };
    const moved = await this.#docs().update(this.e.profile, KIND, doc.id, doc.version, {
      status,
      data: next,
      at: toTimestamp(this.e.now()),
    });
    if (!moved) throw new EconomyError(409, NO_COMMISSION);
    // Works for someone she no longer lets in: what was paid is theirs.
    await this.e.purse.giveBack({ id: d.entry, account: owner, amount: d.price });
    return { ...doc, status, version: doc.version + 1, data: next };
  }

  /** Gives back what she did not get to in `commission_days`. */
  async sweep(): Promise<void> {
    const now = this.e.now();
    for (const doc of await this.#open()) {
      if (Date.parse(asData(doc).due_at) > now) continue;
      try {
        await this.e.serial(() => this.#end(doc, "expired", "她沒有來得及做"));
      } catch (error) {
        this.e.log.warn(
          { err: errorMessage(error), commission: doc.id },
          "cannot end a commission",
        );
      }
    }
  }

  // ---- reading ---------------------------------------------------------------------------

  #view(doc: EconomyDoc): CommissionView {
    const d = asData(doc);
    return {
      id: shortId(doc.id),
      kind: d.kind,
      label: COMMISSION_LABEL[d.kind],
      brief: d.brief,
      price: d.price,
      status: doc.status as CommissionView["status"],
      created_at: doc.created_at,
      due_at: d.due_at,
      result: d.result,
      note: d.note,
    };
  }

  /** A person's own commissions, newest first, at most 20. */
  async mine(account: AccountRef): Promise<CommissionView[]> {
    const who = await this.e.member(account);
    if (!who) return [];
    const rows = await this.#docs().list(this.e.profile, KIND, { owners: who.wallet, limit: 20 });
    return rows.map((d) => this.#view(d));
  }
}
