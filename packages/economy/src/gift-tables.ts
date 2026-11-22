// The `gifts` plugin's tables on the store's database (`gift-schema.ts`): the free-form gifts
// members named and what became of them, and the price of each name (docs/design/economy.md §16).
// The coins are rows of the economy's ledger, keyed by these ids; nothing here moves any.
//
// Core's store opens this plugin (`STORE_PLUGINS`); the module `economy` uses it. A person asking
// to be forgotten has their identity taken out of every gift row (person, account, name): the
// public collection then shows the gift without a giver, and their own list no longer has it. A
// gift still waiting for her answer is marked `refund_due` and given back by the next sweep (the
// person stays on that row until the refund is written). The ledger is not touched.

import {
  type CategoryData,
  type Db,
  type PersonHookResult,
  type PersonMerge,
  type StorePlugin,
  tablePart,
} from "@miyoria/store";
import { type AccountRef, type PersonId, type Timestamp, toTimestamp } from "@miyoria/types";
import { and, count, desc, eq, gte, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { giftSchema } from "./gift-migrations.js";
import {
  type GIFT_STATUSES,
  type GiftPriceRow,
  type GiftRequestRow,
  giftsPrices,
  giftsRequests,
} from "./gift-schema.js";
import type { GiftKind, GiftRefusal } from "./gift-words.js";

export type GiftStatus = (typeof GIFT_STATUSES)[number];
export type GiftPricedBy = "model" | "cache" | "pinned" | "fallback" | "rule";
export type GiftSource = "discord" | "web";

/** One gift a member named. */
export interface GiftRecord {
  id: string;
  person: PersonId | null;
  account: AccountRef | null;
  name: string;
  item: string;
  item_key: string;
  kind: GiftKind | null;
  /** The old scheme's tier; `null` from the NT$ estimates on. */
  tier: number | null;
  price: number;
  /** The NT$ estimate the price came from; `null` for a coin pin or the fallback. */
  twd: number | null;
  priced_by: GiftPricedBy;
  asked_model: boolean;
  hunger: number;
  status: GiftStatus;
  reason: string | null;
  source: GiftSource;
  request_key: string;
  entry_id: string | null;
  line: string | null;
  favourite: boolean;
  answered_by: "her" | "system" | "admin" | null;
  refunded_by: string | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  confirmed_at: Timestamp | null;
  answer_due: Timestamp | null;
  answered_at: Timestamp | null;
  refunded_at: Timestamp | null;
}

export type NewGift = Omit<
  GiftRecord,
  | "entry_id"
  | "line"
  | "favourite"
  | "answered_by"
  | "refunded_by"
  | "confirmed_at"
  | "answer_due"
  | "answered_at"
  | "refunded_at"
>;

/** What may change on a gift once it is written. */
export type GiftPatch = Partial<
  Pick<
    GiftRecord,
    | "status"
    | "reason"
    | "hunger"
    | "entry_id"
    | "line"
    | "favourite"
    | "answered_by"
    | "refunded_by"
    | "confirmed_at"
    | "answer_due"
    | "answered_at"
    | "refunded_at"
  >
>;

/** A name's price: a cached answer of the model, or the owner's pin or block. */
export interface GiftPrice {
  item_key: string;
  item: string;
  kind: GiftKind | null;
  /** The old scheme's tier (kept on old rows). */
  tier: number | null;
  /** The model's estimate, or the owner's pin, in NT$ (follows the rate). */
  twd: number | null;
  /** The owner's pin in coins (does not follow the rate). */
  coins: number | null;
  refuse: GiftRefusal | null;
  source: "model" | "pinned" | "blocked";
  by: string | null;
  at: Timestamp;
}

function giftOf(r: GiftRequestRow): GiftRecord {
  return {
    id: r.id,
    person: r.person_id,
    account:
      r.platform !== null && r.account_id !== null
        ? { platform: r.platform, id: r.account_id }
        : null,
    name: r.name,
    item: r.item,
    item_key: r.item_key,
    kind: r.kind as GiftKind | null,
    tier: r.tier,
    price: r.price,
    twd: r.twd,
    priced_by: r.priced_by as GiftPricedBy,
    asked_model: r.asked_model,
    hunger: r.hunger,
    status: r.status as GiftStatus,
    reason: r.reason,
    source: r.source as GiftSource,
    request_key: r.request_key,
    entry_id: r.entry_id,
    line: r.line,
    favourite: r.favourite,
    answered_by: r.answered_by as GiftRecord["answered_by"],
    refunded_by: r.refunded_by,
    created_at: r.created_at,
    expires_at: r.expires_at,
    confirmed_at: r.confirmed_at,
    answer_due: r.answer_due,
    answered_at: r.answered_at,
    refunded_at: r.refunded_at,
  };
}

function priceOf(r: GiftPriceRow): GiftPrice {
  return {
    item_key: r.item_key,
    item: r.item,
    kind: r.kind as GiftKind | null,
    tier: r.tier,
    twd: r.twd,
    coins: r.coins,
    refuse: r.refuse as GiftRefusal | null,
    source: r.source,
    by: r.by,
    at: r.at,
  };
}

/** The persons forgotten gifts are filed under: none. */
const FORGOTTEN = "";

export class GiftTables {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #write<T>(fn: () => T): T {
    this.#db.ensureOpen();
    return this.#db.tx(fn);
  }

  // ---- gifts --------------------------------------------------------------------------------

  insert(gift: NewGift): GiftRecord {
    return this.#write(() => {
      this.#db.orm
        .insert(giftsRequests)
        .values({
          id: gift.id,
          person_id: gift.person,
          platform: gift.account?.platform ?? null,
          account_id: gift.account?.id ?? null,
          name: gift.name,
          item: gift.item,
          item_key: gift.item_key,
          kind: gift.kind,
          tier: gift.tier,
          price: gift.price,
          twd: gift.twd,
          priced_by: gift.priced_by,
          asked_model: gift.asked_model,
          hunger: gift.hunger,
          status: gift.status,
          reason: gift.reason,
          source: gift.source,
          request_key: gift.request_key,
          created_at: gift.created_at,
          expires_at: gift.expires_at,
        })
        .run();
      return this.get(gift.id) as GiftRecord;
    });
  }

  get(id: string): GiftRecord | null {
    this.#db.ensureOpen();
    const row = this.#db.orm.select().from(giftsRequests).where(eq(giftsRequests.id, id)).get();
    return row === undefined ? null : giftOf(row);
  }

  /** The gift a person asked for under `key`, or `null`. */
  byKey(persons: readonly PersonId[], key: string): GiftRecord | null {
    if (persons.length === 0) return null;
    this.#db.ensureOpen();
    const row = this.#db.orm
      .select()
      .from(giftsRequests)
      .where(
        and(inArray(giftsRequests.person_id, [...persons]), eq(giftsRequests.request_key, key)),
      )
      .get();
    return row === undefined ? null : giftOf(row);
  }

  /**
   * Changes a gift that is in one of `from` (any status when empty); `null` when it is not (a
   * second press, a sweep that came first).
   */
  move(id: string, from: readonly GiftStatus[], patch: GiftPatch): GiftRecord | null {
    return this.#write(() => {
      const where =
        from.length === 0
          ? eq(giftsRequests.id, id)
          : and(eq(giftsRequests.id, id), inArray(giftsRequests.status, [...from]));
      const changes = Number(
        this.#db.orm.update(giftsRequests).set(patch).where(where).run().changes,
      );
      return changes === 0 ? null : this.get(id);
    });
  }

  /** A person's gifts (their merged persons too), newest first. */
  mine(persons: readonly PersonId[], limit: number, since?: Timestamp): GiftRecord[] {
    if (persons.length === 0) return [];
    this.#db.ensureOpen();
    const who = inArray(giftsRequests.person_id, [...persons]);
    return this.#db.orm
      .select()
      .from(giftsRequests)
      .where(since === undefined ? who : and(who, gte(giftsRequests.created_at, since)))
      .orderBy(desc(giftsRequests.created_at), desc(giftsRequests.id))
      .limit(limit)
      .all()
      .map(giftOf);
  }

  /** The newest gifts in any of `statuses` (every status when empty). */
  recent(limit: number, statuses: readonly GiftStatus[] = []): GiftRecord[] {
    this.#db.ensureOpen();
    const q = this.#db.orm.select().from(giftsRequests);
    const filtered =
      statuses.length === 0 ? q : q.where(inArray(giftsRequests.status, [...statuses]));
    return filtered
      .orderBy(desc(giftsRequests.created_at), desc(giftsRequests.id))
      .limit(limit)
      .all()
      .map(giftOf);
  }

  /** Her favourites, newest first. */
  favourites(limit: number): GiftRecord[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(giftsRequests)
      .where(and(eq(giftsRequests.status, "accepted"), eq(giftsRequests.favourite, true)))
      .orderBy(desc(giftsRequests.answered_at), desc(giftsRequests.id))
      .limit(limit)
      .all()
      .map(giftOf);
  }

  /** Price questions asked since `since`: by these persons, or by everyone (`null`). */
  asked(since: Timestamp, persons: readonly PersonId[] | null): number {
    this.#db.ensureOpen();
    const base = and(eq(giftsRequests.asked_model, true), gte(giftsRequests.created_at, since));
    const where =
      persons === null ? base : and(base, inArray(giftsRequests.person_id, [...persons]));
    const row = this.#db.orm.select({ n: count() }).from(giftsRequests).where(where).get();
    return Number(row?.n ?? 0);
  }

  /** Gifts in `status` whose time (`expires_at` for pending, `answer_due` else) is up at `now`. */
  due(status: "pending" | "confirmed" | "refund_due", now: Timestamp, limit: number): GiftRecord[] {
    this.#db.ensureOpen();
    const time =
      status === "pending"
        ? lte(giftsRequests.expires_at, now)
        : status === "confirmed"
          ? lte(giftsRequests.answer_due, now)
          : isNotNull(giftsRequests.entry_id);
    return this.#db.orm
      .select()
      .from(giftsRequests)
      .where(and(eq(giftsRequests.status, status), time))
      .orderBy(giftsRequests.created_at)
      .limit(limit)
      .all()
      .map(giftOf);
  }

  // ---- prices -------------------------------------------------------------------------------

  price(key: string): GiftPrice | null {
    this.#db.ensureOpen();
    const row = this.#db.orm.select().from(giftsPrices).where(eq(giftsPrices.item_key, key)).get();
    return row === undefined ? null : priceOf(row);
  }

  /**
   * Writes a name's price. The model's answer never replaces the owner's pin or block
   * (`false`); the owner's replaces anything.
   */
  putPrice(price: GiftPrice): boolean {
    return this.#write(() => {
      const had = this.price(price.item_key);
      if (had !== null && had.source !== "model" && price.source === "model") return false;
      const values = {
        item_key: price.item_key,
        item: price.item,
        kind: price.kind,
        tier: price.tier,
        twd: price.twd,
        coins: price.coins,
        refuse: price.refuse,
        source: price.source,
        by: price.by,
        at: price.at,
      };
      this.#db.orm
        .insert(giftsPrices)
        .values(values)
        .onConflictDoUpdate({ target: giftsPrices.item_key, set: values })
        .run();
      return true;
    });
  }

  /** Takes a name's price out (the next ask prices it again); `false` when there was none. */
  dropPrice(key: string): boolean {
    return this.#write(
      () =>
        Number(
          this.#db.orm.delete(giftsPrices).where(eq(giftsPrices.item_key, key)).run().changes,
        ) > 0,
    );
  }

  /** The owner's pins and blocks, newest first. */
  overrides(limit: number): GiftPrice[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(giftsPrices)
      .where(ne(giftsPrices.source, "model"))
      .orderBy(desc(giftsPrices.at))
      .limit(limit)
      .all()
      .map(priceOf);
  }

  // ---- people -------------------------------------------------------------------------------

  /**
   * A forgotten person's gifts: no person, account or name any more. One waiting for her answer
   * keeps the person until the sweep gave it back (`refund_due`); one waiting for 確認 is gone.
   */
  forgetPerson(ids: readonly PersonId[]): Record<string, number> {
    if (ids.length === 0) return {};
    const list = [...ids];
    return this.#write(() => {
      const o = this.#db.orm;
      const mine = inArray(giftsRequests.person_id, list);
      const held = Number(
        o
          .update(giftsRequests)
          .set({ status: "refund_due", platform: null, account_id: null, name: FORGOTTEN })
          .where(and(mine, eq(giftsRequests.status, "confirmed")))
          .run().changes,
      );
      const asked = Number(
        o
          .update(giftsRequests)
          .set({ status: "cancelled" })
          .where(and(mine, eq(giftsRequests.status, "pending")))
          .run().changes,
      );
      const rest = Number(
        o
          .update(giftsRequests)
          .set({ person_id: null, platform: null, account_id: null, name: FORGOTTEN })
          .where(and(mine, ne(giftsRequests.status, "refund_due")))
          .run().changes,
      );
      return { gifts_requests: rest, gifts_held: held, gifts_cancelled: asked };
    });
  }

  /** Takes the person out of a gift the sweep settled after they were forgotten. */
  anonymise(id: string): void {
    this.#write(() => {
      this.#db.orm
        .update(giftsRequests)
        .set({ person_id: null, platform: null, account_id: null, name: FORGOTTEN })
        .where(eq(giftsRequests.id, id))
        .run();
    });
  }

  merge(keep: PersonId, absorb: PersonId): PersonHookResult {
    if (keep === absorb) return { counts: {} };
    return this.#write((): PersonHookResult => {
      // A request key is a retry's; the merged ones get one nobody will ask for.
      const rows = this.#db.orm
        .select({ id: giftsRequests.id })
        .from(giftsRequests)
        .where(eq(giftsRequests.person_id, absorb))
        .all();
      for (const { id } of rows) {
        this.#db.orm
          .update(giftsRequests)
          .set({ person_id: keep, request_key: `merged:${id}` })
          .where(eq(giftsRequests.id, id))
          .run();
      }
      return { counts: { gifts_requests: rows.length } };
    });
  }
}

// ---- the plugin -----------------------------------------------------------------------------

/** What people gave her is part of their coins and relationship, kept with the ledger. */
const giftData: readonly CategoryData[] = [
  {
    category: "relationships",
    parts: [
      tablePart("gifts_requests", "gifts_requests", "node", "created_at", "created_at, id", {
        id: "text",
        person_id: "text",
        platform: "text",
        account_id: "text",
        name: "text",
        item: "text",
        item_key: "text",
        kind: "text",
        tier: "num",
        price: "num",
        twd: "num",
        priced_by: "text",
        asked_model: "bool",
        hunger: "num",
        status: "text",
        reason: "text",
        source: "text",
        request_key: "text",
        entry_id: "text",
        line: "text",
        favourite: "bool",
        answered_by: "text",
        refunded_by: "text",
        created_at: "ts",
        expires_at: "ts",
        confirmed_at: "ts",
        answer_due: "ts",
        answered_at: "ts",
        refunded_at: "ts",
      }),
      tablePart("gifts_prices", "gifts_prices", "node", "at", "at, item_key", {
        item_key: "text",
        item: "text",
        kind: "text",
        tier: "num",
        twd: "num",
        coins: "num",
        refuse: "text",
        source: "text",
        by: "text",
        at: "ts",
      }),
    ],
  },
];

/** The `gifts` plugin's tables and code (`StorePlugin`). */
export const giftTables: StorePlugin<GiftTables> = {
  schema: giftSchema,
  open: ({ db }) => new GiftTables(db),
  data: giftData,
  forgetPerson: (opened, request) => ({ counts: opened.forgetPerson(request.ids) }),
  mergePerson: (opened, { keep, absorb }: PersonMerge) => opened.merge(keep, absorb),
};

/** `ms` as a stored time. */
export const giftTime = (ms: number): Timestamp => toTimestamp(ms);
