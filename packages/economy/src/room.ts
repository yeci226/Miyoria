// Her room, funded by the audience (docs/design/v4-plan.md §10): furniture, an outfit, a background
// that cost more than anyone gives alone, so people put coins in together until it is hers.
//
// * `room_items` is the catalogue (id, label, price). A pledge is `1..room_pledge_max` coins, never
//   more than what is still missing, and is spent for good (reason `room`): the coins leave the
//   economy, they are not a loan and not a purchase of her regard.
// * Only the total and the number of backers are kept, no names and no ranking: giving more does not
//   put anyone above anyone. When the total reaches the price the item is hers, `economy.room.placed`
//   goes on the bus for whatever draws the room (the stage), and she hears of it silently.
// * One document per item (docs.ts) with the ledger entries already counted, so a crash between the
//   charge and the count is finished by the same key, once, and a refund is never needed.

import { type AccountRef, customEvent, toTimestamp } from "@miyoria/types";
import type { RoomItem } from "./config.js";
import type { EconomyDoc } from "./docs.js";
import { type EconomyService, type Member, STRANGER } from "./economy.js";
import { EconomyError } from "./types.js";
import { ROOM_TOPIC, type RoomFundResult, type RoomView } from "./v2-types.js";

const KIND = "room";
/** The entries kept per item to recognise a pledge that was charged but not yet counted. */
const KEEP_ENTRIES = 300;

export const NO_ROOM_ITEM = "沒有這個東西";
export const ROOM_FULL = "這個已經湊齊了";
export const KIND_LABEL = { furniture: "家具", outfit: "衣服", background: "背景" } as const;

interface Data {
  funded: number;
  backers: number;
  /** Wallet keys that have given, so a backer is counted once. */
  from: string[];
  /** Ledger entries already counted. */
  applied: string[];
  [k: string]: number | string[];
}

const docId = (item: string) => `room:${item}`;
const asData = (d: EconomyDoc) => d.data as unknown as Data;
const walletKey = (who: Member) => who.person.id;

export class RoomDesk {
  constructor(private readonly e: EconomyService) {}

  #catalogue(ref: string): RoomItem | null {
    const want = ref.trim().toLowerCase();
    const items = this.e.config.room_items;
    return items.find((i) => i.id === want) ?? items.find((i) => i.label === ref.trim()) ?? null;
  }

  async #doc(item: RoomItem): Promise<EconomyDoc> {
    const docs = this.e.docs();
    const id = docId(item.id);
    const there = await docs.get(this.e.profile, KIND, id);
    if (there) return there;
    const at = toTimestamp(this.e.now());
    const doc: EconomyDoc = {
      id,
      profile: this.e.profile,
      kind: KIND,
      owner: null,
      status: "funding",
      version: 1,
      data: { funded: 0, backers: 0, from: [], applied: [] },
      created_at: at,
      updated_at: at,
    };
    await docs.create(doc);
    return (await docs.get(this.e.profile, KIND, id)) ?? doc;
  }

  #view(item: RoomItem, doc: EconomyDoc): RoomView {
    const d = asData(doc);
    return {
      id: item.id,
      label: item.label,
      kind: item.kind,
      kind_label: KIND_LABEL[item.kind],
      price: item.price,
      funded: Math.min(d.funded, item.price),
      backers: d.backers,
      placed: doc.status === "placed",
    };
  }

  /** The catalogue with how far each is: what is hers already first. */
  async view(): Promise<RoomView[]> {
    const out: RoomView[] = [];
    for (const item of this.e.config.room_items) out.push(this.#view(item, await this.#doc(item)));
    return out.sort((a, b) => Number(b.placed) - Number(a.placed));
  }

  /** Puts coins into an item; `amount` is cut to what is missing. */
  async fund(
    account: AccountRef,
    ref: string,
    amount: number,
    key: string,
  ): Promise<RoomFundResult> {
    const c = this.e.config;
    if (!Number.isInteger(amount) || amount < 1 || amount > c.room_pledge_max) {
      throw new EconomyError(400, `一次出 1 到 ${c.room_pledge_max} ${c.currency}`);
    }
    const item = this.#catalogue(ref);
    if (!item) throw new EconomyError(409, NO_ROOM_ITEM);
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    const idem = `room:${key}`;
    const done = await this.e.serial(async () => {
      let doc = await this.#doc(item);
      let d = asData(doc);
      const first = await this.e.byKey(who, idem);
      let entryId: string;
      let charged: number;
      let fresh = false;
      if (first) {
        if (d.applied.includes(first.id)) {
          return { doc, charged: -first.delta, fresh: false, completed: false };
        }
        entryId = first.id;
        charged = -first.delta;
      } else {
        if (doc.status === "placed") throw new EconomyError(409, ROOM_FULL);
        charged = Math.min(amount, item.price - d.funded);
        if (charged <= 0) throw new EconomyError(409, ROOM_FULL);
        const spent = await this.e.spend(who, charged, "room", item.id, idem);
        entryId = spent.entry.id;
        fresh = true;
      }
      // Counted under the document's own version, so two processes cannot both add the same pledge.
      for (let tries = 0; tries < 5; tries++) {
        const funded = d.funded + charged;
        const completed = funded >= item.price;
        const from = d.from.includes(walletKey(who)) ? d.from : [...d.from, walletKey(who)];
        const next: Data = {
          funded,
          backers: from.length,
          from,
          applied: [...d.applied, entryId].slice(-KEEP_ENTRIES),
        };
        const status = completed ? "placed" : "funding";
        if (
          await this.e.docs().update(this.e.profile, KIND, doc.id, doc.version, {
            status,
            data: next,
            at: toTimestamp(this.e.now()),
          })
        ) {
          doc = { ...doc, status, version: doc.version + 1, data: next };
          return { doc, charged, fresh, completed };
        }
        const again = await this.e.docs().get(this.e.profile, KIND, doc.id);
        if (!again) break;
        doc = again;
        d = asData(again);
        if (d.applied.includes(entryId)) return { doc, charged, fresh, completed: false };
      }
      throw new EconomyError(503, "現在算不進去，晚點再試");
    });
    if (done.fresh) {
      this.e.record(who, "economy.room.fund", { item: item.id, amount: done.charged });
      await this.e.v2.afterEarn(who);
    }
    if (done.completed) this.#placed(item);
    return {
      item: this.#view(item, done.doc),
      charged: done.charged,
      balance: await this.e.ledger().balance(this.e.profile, who.wallet),
      duplicate: !done.fresh,
    };
  }

  #placed(item: RoomItem): void {
    this.e.publish(customEvent(ROOM_TOPIC, { item: item.id, label: item.label, kind: item.kind }));
    this.e.purse.news(`room:${item.id}`, `大家湊錢把「${item.label}」放進了你的房間`);
  }
}
