// The `cards` plugin's tables on the store's database (`schema.ts`): the catalogue, the cards,
// the pity, the dex, wishlists, titles and the old collectibles (`CardStore`).
//
// A card is written by `issue` only: in one `Db.tx` it checks the day's cap again, reads the pity,
// the catalogue and the wishlist, draws (`draw.ts`), writes the card, moves the pity, adds the
// parts to the dex, gives the titles of any series it completes and appends `cards.drawn` (and
// `cards.titled`) to the event log, as the heart writes `heart_person` with `heart.changed`. Paying
// for it is the service's (`service.ts`), outside the transaction. A card issued for something once
// per person (a milestone's tier, the keepsake) carries that as its `issue_key`, unique per person:
// asked again, `issue` answers the card already there. A card nobody paid for neither uses nor
// moves the pity (`pity: false`).
//
// Core's store opens this plugin (`STORE_PLUGINS`); the module `cards` (`module.ts`) owns it. Cards
// are not tradable: nothing here moves a card to another person except a merge of two persons
// that turned out to be one.

import {
  accounts,
  type CategoryData,
  type Db,
  type EventStore,
  type LegacySnapshot,
  type PersonForget,
  type PersonHookResult,
  type PersonMerge,
  persons,
  type StorePlugin,
  tablePart,
} from "@miyoria/store";
import {
  BOND_LADDER,
  type BondTier,
  type PersonId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { isRarity, isSlot, type Part, type Rarity } from "./catalogue.js";
import { completedBy, type WishlistProblem, wishlistProblem } from "./dex.js";
import {
  CardsError,
  type DrawnPart,
  type DrawRules,
  type DrawSnapshot,
  drawCard,
  nextSince,
  type PityView,
  pityView,
  type Random,
  wishedOn,
  withDropPart,
} from "./draw.js";
import { drawnWrite, titledWrite } from "./events.js";
import type { Expression } from "./expressions.js";
import { LEGACY_ITEMS, type LegacyItem } from "./legacy.js";
import { cardsSchema } from "./migrations.js";
import {
  type CardsCardRow,
  type CardsPartRow,
  cardsCard,
  cardsDex,
  cardsDrop,
  cardsKeepsake,
  cardsLegacy,
  cardsMilestone,
  cardsParts,
  cardsPending,
  cardsPity,
  cardsTally,
  cardsTitles,
  cardsWishlist,
} from "./schema.js";

export const CARD_KINDS = ["daily", "milestone", "keepsake", "drop"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/** A field she added to a card: her own label and text. */
export interface CardField {
  label: string;
  text: string;
}

/** The words on a card besides the relationship: who it is for and what she wrote. */
export interface CardFace {
  /** Their name as she knows them. */
  name: string;
  /** Their picture when the card was issued; `null`: none. */
  avatar_url: string | null;
  /** What she calls them; `null`: their name. */
  call_name: string | null;
  /** The line she wrote on it; `null`: none. */
  line: string | null;
  /** Her stamp; `null`: none. */
  stamp: string | null;
  /** Fields she named herself (at most three). */
  fields: CardField[];
  /** The nth card this person was given (their old member cards counted too). */
  number: number;
}

/**
 * The relationship a card shows, in words only (the heart's `PublicBond` at the time): never the
 * raw bond, so a card cannot be used to read it off.
 */
export interface CardRelationship {
  /** The tier's bare name (陌生人, 認識 ... 永恆羈絆, 討厭, 很討厭): what picks the expression. */
  tier: string;
  /** Name and stage: 「知心 II」. */
  tier_label: string;
  closeness: string;
  trust: string;
  familiarity: string;
  public_feeling: string | null;
}

/** One card as stored. */
export interface CardRecord {
  serial: string;
  person: PersonId;
  kind: CardKind;
  rarity: Rarity;
  parts: DrawnPart[];
  expression: Expression;
  foil: boolean;
  seed: number;
  face: CardFace;
  relationship: CardRelationship;
  /** Its picture in the artifact store; `null`: not rendered (yet). */
  artifact_id: string | null;
  /** Coins it cost. */
  price: number;
  pity_hit: boolean;
  /** Wished parts it has. */
  wished: string[];
  /** The frame it was issued in; `null`: none. */
  frame: string | null;
  created_at: Timestamp;
  /** What it was issued for, once per person (`issueKey`); `null`: a card with no such key. */
  issue_key: string | null;
}

/** One part a person has. */
export interface DexEntry {
  part: string;
  first_at: Timestamp;
  /** The card it first came on. */
  first_card: string | null;
  count: number;
}

/** A title a person earned. */
export interface CardTitle {
  series: string;
  title: string;
  card: string | null;
  /** Shown to others; private by default. */
  public: boolean;
  earned_at: Timestamp;
}

/** What `issue` writes. */
export interface IssueInput {
  person: PersonId;
  kind: CardKind;
  serial: string;
  price: number;
  face: CardFace;
  relationship: CardRelationship;
  rules: DrawRules;
  random: Random;
  /** Epoch ms. */
  now: number;
  /** At most `max` cards of `kind` since `since` (epoch ms): checked inside the transaction. */
  cap?: { max: number; since: number };
  /** The frame they chose; default none. */
  frame?: string | null;
  /** A shine they bought for it (an SSR card shines anyway). */
  foil?: boolean;
  /**
   * What the card is issued for, once per person (`issueKey`): when they already have the card of
   * this key, that card is the answer and nothing is drawn or written. Default none.
   */
  key?: string | null;
  /**
   * Whether the pity counts this card (default `true`): a card nobody paid for is drawn at the
   * plain odds and leaves the counter where it is.
   */
  pity?: boolean;
  /** A dropped card: one of its parts is one only a drop can give (`withDropPart`). */
  dropPart?: boolean;
}

/** A card she dropped in a channel (`cards_drop`). */
export interface DropRecord {
  id: string;
  /** `contextKeyString` of the channel. */
  channel: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  claimed_by: PersonId | null;
  claimed_at: Timestamp | null;
  serial: string | null;
}

/** What the cards came to over a span (`CardStore.daySummary`). */
export interface CardsDaySummary {
  /** Cards issued, every kind. */
  cards: number;
  /** Coins their price took. */
  coins: number;
  /** Cards the pity gave an SR-or-better part. */
  pity: number;
  /** Cards she dropped in a channel, picked up or not. */
  drops: number;
}

/** The serial a paid card asked for under a key is charged under, kept until the card is written. */
export interface PendingCard {
  person: PersonId;
  /** The card's `issue_key` (`daily:<request key>`). */
  key: string;
  serial: string;
  created_at: Timestamp;
  /** Ordered with a foil finish. */
  foil: boolean;
}

/** What `issue` did. */
export interface IssuedCard {
  card: CardRecord;
  pity: PityView;
  /** Parts the person had never had. */
  new_parts: string[];
  /** Titles this card earned. */
  titles: CardTitle[];
  /** The card of the input's key was there already: nothing was drawn or written. */
  again: boolean;
}

/** The `issue_key` of a card issued for something once per person. */
export const issueKey = {
  /** A milestone card for entering the tier whose lowest bond is `min`. */
  milestone: (min: number) => `milestone:${min}`,
  /** The keepsake card of someone migrated from the old records. */
  keepsake: "keepsake",
  /** The card a drop in a channel became. */
  drop: (id: string) => `drop:${id}`,
  /** A daily card asked for with a request's Idempotency-Key. */
  daily: (key: string) => `daily:${key}`,
} as const;

/** The lowest bond of the tier a milestone card's `issue_key` names; `null` for any other key. */
function milestoneMin(key: string | null): number | null {
  if (key === null || !key.startsWith("milestone:")) return null;
  const min = Number(key.slice("milestone:".length));
  return Number.isInteger(min) ? min : null;
}

/** The tier a milestone card was given for; `null` for any other card. */
export function milestoneTier(card: Pick<CardRecord, "kind" | "issue_key">): BondTier | null {
  if (card.kind !== "milestone") return null;
  const min = milestoneMin(card.issue_key);
  return min === null ? null : (BOND_LADDER.find((t) => t.min === min) ?? null);
}

/**
 * How many times her line for a keepsake card is asked for before it is left without one (she
 * wrote nothing that passed the checks, or could not write).
 */
export const KEEPSAKE_LINE_TRIES = 3;

/** The kinds of card a day's limit counts (`cards_tally`). */
export const TALLIED_KINDS = ["daily", "drop"] as const;
export type TalliedKind = (typeof TALLIED_KINDS)[number];

const isTallied = (kind: CardKind): kind is TalliedKind =>
  (TALLIED_KINDS as readonly string[]).includes(kind);

/** How long a tally row is kept: a local day starts at most a day back. */
export const TALLY_KEPT_MS = 2 * 86_400_000;

/**
 * Who picked up a drop, once they asked her to forget them: the drop stays taken and counts for its
 * channel's day, and names nobody.
 */
export const FORGOTTEN_CLAIMER = "";

/** The day's cap was reached (by a card issued meanwhile). */
export class CardCapError extends CardsError {
  override name = "CardCapError";
}

// ---- rows -----------------------------------------------------------------------------------

function partOf(row: CardsPartRow): Part {
  if (!isSlot(row.slot) || !isRarity(row.rarity)) {
    throw new CardsError(`part \`${row.id}\` has slot ${row.slot}, rarity ${row.rarity}`);
  }
  return {
    id: row.id,
    slot: row.slot,
    rarity: row.rarity,
    series: row.series,
    name: row.name,
    weight: row.weight,
    enabled: row.enabled,
    drop_only: row.drop_only,
    blank: row.blank,
  };
}

function cardOf(row: CardsCardRow): CardRecord {
  if (!isRarity(row.rarity))
    throw new CardsError(`card \`${row.serial}\` has rarity ${row.rarity}`);
  const face = row.face as Partial<CardFace>;
  return {
    serial: row.serial,
    person: row.person_id,
    kind: row.kind as CardKind,
    rarity: row.rarity,
    parts: row.parts.parts,
    expression: row.parts.expression,
    foil: row.parts.foil,
    seed: row.parts.seed,
    face: {
      name: face.name ?? "",
      avatar_url: face.avatar_url ?? null,
      call_name: face.call_name ?? null,
      line: face.line ?? null,
      stamp: face.stamp ?? null,
      fields: face.fields ?? [],
      number: face.number ?? 0,
    },
    relationship: row.relationship as unknown as CardRelationship,
    artifact_id: row.artifact_id,
    price: row.price,
    pity_hit: row.pity_hit,
    wished: row.wished,
    frame: row.frame,
    created_at: row.created_at,
    issue_key: row.issue_key,
  };
}

const at = (ms: number): Timestamp => toTimestamp(ms);

function pendingOf(row: typeof cardsPending.$inferSelect): PendingCard {
  return {
    person: row.person_id,
    key: row.issue_key,
    serial: row.serial,
    created_at: row.created_at,
    foil: row.foil,
  };
}

/** The ids of the accounts of `persons`, as a subquery. */
function accountsOf(db: Db, persons: readonly PersonId[]) {
  return db.orm
    .select({ id: accounts.id })
    .from(accounts)
    .where(inArray(accounts.person_id, [...persons]));
}

// ---- the store ------------------------------------------------------------------------------

export class CardStore {
  readonly #db: Db;
  readonly #events: EventStore;

  constructor(db: Db, events: EventStore) {
    this.#db = db;
    this.#events = events;
  }

  /** The whole catalogue, by slot then id. */
  catalogue(): Part[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(cardsParts)
      .orderBy(asc(cardsParts.slot), asc(cardsParts.id))
      .all()
      .map(partOf);
  }

  card(serial: string): CardRecord | null {
    this.#db.ensureOpen();
    const row = this.#db.orm.select().from(cardsCard).where(eq(cardsCard.serial, serial)).get();
    return row === undefined ? null : cardOf(row);
  }

  /**
   * The serial a paid card asked for under `key` is charged under: the one kept from an earlier
   * try (`cards_pending`), or `serial`, kept now with whether a foil finish is ordered with it. A
   * retry after a restart is thus the same charge.
   */
  reserve(person: PersonId, key: string, serial: string, now: number, foil = false): string {
    return this.#write(() => {
      const P = cardsPending;
      const kept = this.#db.orm
        .select({ serial: P.serial })
        .from(P)
        .where(and(eq(P.person_id, person), eq(P.issue_key, key)))
        .get();
      if (kept !== undefined) return kept.serial;
      this.#db.orm
        .insert(P)
        .values({ person_id: person, issue_key: key, serial, created_at: at(now), foil })
        .run();
      return serial;
    });
  }

  /**
   * Forgets the serial kept for `key` (no card followed and the coins went back); with `serial`,
   * only while that is the one kept.
   */
  unreserve(person: PersonId, key: string, serial?: string): void {
    this.#write(() => {
      const P = cardsPending;
      const kept = serial === undefined ? undefined : eq(P.serial, serial);
      this.#db.orm
        .delete(P)
        .where(and(eq(P.person_id, person), eq(P.issue_key, key), kept))
        .run();
    });
  }

  /** Every serial kept for a paid card that is not written yet, oldest first. */
  pending(): PendingCard[] {
    this.#db.ensureOpen();
    const P = cardsPending;
    return this.#db.orm
      .select()
      .from(P)
      .orderBy(asc(P.created_at), asc(P.person_id), asc(P.issue_key))
      .all()
      .map(pendingOf);
  }

  /** The serial kept for `key`; `null`: none. */
  pendingOf(person: PersonId, key: string): PendingCard | null {
    this.#db.ensureOpen();
    const P = cardsPending;
    const row = this.#db.orm
      .select()
      .from(P)
      .where(and(eq(P.person_id, person), eq(P.issue_key, key)))
      .get();
    return row === undefined ? null : pendingOf(row);
  }

  /** The card `person` was issued for `key` (`issueKey`); `null`: none. */
  byKey(person: PersonId, key: string): CardRecord | null {
    this.#db.ensureOpen();
    const C = cardsCard;
    const row = this.#db.orm
      .select()
      .from(C)
      .where(and(eq(C.person_id, person), eq(C.issue_key, key)))
      .get();
    return row === undefined ? null : cardOf(row);
  }

  /** Whether `person` was ever given their keepsake card, deleted since or not. */
  keepsakeGiven(person: PersonId): boolean {
    this.#db.ensureOpen();
    const row = this.#db.orm
      .select({ person: cardsKeepsake.person_id })
      .from(cardsKeepsake)
      .where(eq(cardsKeepsake.person_id, person))
      .get();
    return row !== undefined;
  }

  /**
   * Whether `person` was ever given the milestone card of the tier whose lowest bond is `min`,
   * deleted since or not.
   */
  milestoneGiven(person: PersonId, min: number): boolean {
    this.#db.ensureOpen();
    const M = cardsMilestone;
    const row = this.#db.orm
      .select({ person: M.person_id })
      .from(M)
      .where(and(eq(M.person_id, person), eq(M.tier_min, min)))
      .get();
    return row !== undefined;
  }

  /** A person's cards, newest first; `before`: older than that card (the next page). */
  cards(person: PersonId, options: { limit?: number; before?: string } = {}): CardRecord[] {
    this.#db.ensureOpen();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const before = options.before === undefined ? null : this.card(options.before);
    const C = cardsCard;
    const older = before
      ? or(
          lt(C.created_at, before.created_at),
          and(eq(C.created_at, before.created_at), lt(C.serial, before.serial)),
        )
      : undefined;
    return this.#db.orm
      .select()
      .from(C)
      .where(and(eq(C.person_id, person), older))
      .orderBy(desc(C.created_at), desc(C.serial))
      .limit(limit)
      .all()
      .map(cardOf);
  }

  /** Deletes the cards of `person`; how many. */
  deleteCards(person: PersonId): number {
    return this.#write(() =>
      Number(this.#db.orm.delete(cardsCard).where(eq(cardsCard.person_id, person)).run().changes),
    );
  }

  /** How many cards a person has. */
  countOf(person: PersonId): number {
    this.#db.ensureOpen();
    const row = this.#db.orm
      .select({ n: count() })
      .from(cardsCard)
      .where(eq(cardsCard.person_id, person))
      .get();
    return row?.n ?? 0;
  }

  /**
   * Cards of `kind` (a daily or a dropped one) a person got since `since` (epoch ms, at most
   * `TALLY_KEPT_MS` back), counted from `cards_tally`: the cards they asked her to forget too.
   */
  countSince(person: PersonId, kind: TalliedKind, since: number): number {
    this.#db.ensureOpen();
    const T = cardsTally;
    const row = this.#db.orm
      .select({ n: count() })
      .from(T)
      .where(and(eq(T.person_id, person), eq(T.kind, kind), gte(T.at, at(since))))
      .get();
    return row?.n ?? 0;
  }

  /**
   * What the cards came to since `since` (epoch ms), for the module's card on the panel: the cards
   * issued, the coins their price took (a foil, paid apart, not counted), the cards that were the
   * pity's, and the cards she dropped in a channel. The cards of someone she was asked to forget
   * are gone and not counted.
   */
  daySummary(since: number): CardsDaySummary {
    this.#db.ensureOpen();
    const C = cardsCard;
    const issued = this.#db.orm
      .select({
        cards: count(),
        coins: sql<number>`coalesce(sum(${C.price}), 0)`.mapWith(Number),
        pity: sql<number>`coalesce(sum(${C.pity_hit}), 0)`.mapWith(Number),
      })
      .from(C)
      .where(gte(C.created_at, at(since)))
      .get();
    const dropped = this.#db.orm
      .select({ n: count() })
      .from(cardsDrop)
      .where(gte(cardsDrop.created_at, at(since)))
      .get();
    return {
      cards: issued?.cards ?? 0,
      coins: issued?.coins ?? 0,
      pity: issued?.pity ?? 0,
      drops: dropped?.n ?? 0,
    };
  }

  /** Cards in a row without SR or better. */
  pitySince(person: PersonId): number {
    this.#db.ensureOpen();
    const row = this.#db.orm
      .select({ since: cardsPity.since })
      .from(cardsPity)
      .where(eq(cardsPity.person_id, person))
      .get();
    return row?.since ?? 0;
  }

  wishlist(person: PersonId): string[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select({ part: cardsWishlist.part_id })
      .from(cardsWishlist)
      .where(eq(cardsWishlist.person_id, person))
      .orderBy(asc(cardsWishlist.position))
      .all()
      .map((r) => r.part);
  }

  /**
   * Replaces the wishlist with `ids` (at most three, each once, each a collectable part). Returns
   * why not, or `null` once written. An empty list clears it.
   */
  setWishlist(person: PersonId, ids: readonly string[], now: number): WishlistProblem | null {
    return this.#write(() => {
      const problem = wishlistProblem(this.catalogue(), ids);
      if (problem !== null) return problem;
      this.#db.orm.delete(cardsWishlist).where(eq(cardsWishlist.person_id, person)).run();
      if (ids.length > 0) {
        this.#db.orm
          .insert(cardsWishlist)
          .values(
            ids.map((part, i) => ({
              person_id: person,
              part_id: part,
              position: i + 1,
              added_at: at(now),
            })),
          )
          .run();
      }
      return null;
    });
  }

  clearWishlist(person: PersonId): number {
    return this.#write(() =>
      Number(
        this.#db.orm.delete(cardsWishlist).where(eq(cardsWishlist.person_id, person)).run().changes,
      ),
    );
  }

  /** The parts a person has, first drawn first. */
  dex(person: PersonId): DexEntry[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(cardsDex)
      .where(eq(cardsDex.person_id, person))
      .orderBy(asc(cardsDex.first_at), asc(cardsDex.part_id))
      .all()
      .map((row) => ({
        part: row.part_id,
        first_at: row.first_at,
        first_card: row.first_card,
        count: row.count,
      }));
  }

  titles(person: PersonId): CardTitle[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(cardsTitles)
      .where(eq(cardsTitles.person_id, person))
      .orderBy(asc(cardsTitles.earned_at), asc(cardsTitles.series))
      .all()
      .map((row) => ({
        series: row.series,
        title: row.title,
        card: row.card,
        public: row.public,
        earned_at: row.earned_at,
      }));
  }

  /**
   * Makes one of `person`'s titles shown to others (`value` true) or theirs alone. The title as it
   * is now; `null` when they have no title of `series`.
   */
  setTitlePublic(person: PersonId, series: string, value: boolean): CardTitle | null {
    return this.#write(() => {
      const T = cardsTitles;
      const changed = Number(
        this.#db.orm
          .update(T)
          .set({ public: value })
          .where(and(eq(T.person_id, person), eq(T.series, series)))
          .run().changes,
      );
      if (changed === 0) return null;
      return this.titles(person).find((t) => t.series === series) ?? null;
    });
  }

  /**
   * Keepsake cards still without her line, oldest first, at most `limit`: the ones tried fewer
   * than `KEEPSAKE_LINE_TRIES` times.
   */
  keepsakesWithoutLine(limit: number): CardRecord[] {
    this.#db.ensureOpen();
    const C = cardsCard;
    return this.#db.orm
      .select()
      .from(C)
      .where(
        and(
          eq(C.kind, "keepsake"),
          sql`json_extract(${C.face}, '$.line') IS NULL`,
          sql`coalesce(json_extract(${C.face}, '$.line_tries'), 0) < ${KEEPSAKE_LINE_TRIES}`,
        ),
      )
      .orderBy(asc(C.created_at), asc(C.serial))
      .limit(Math.max(limit, 0))
      .all()
      .map(cardOf);
  }

  /**
   * Puts her line on keepsake card `serial`, if it still has none; `null` (she wrote nothing that
   * passed) counts a try instead. The card's picture of record is cleared with a new line (it
   * showed the card without it). Whether the line went on.
   */
  setKeepsakeLine(serial: string, line: string | null): boolean {
    const C = cardsCard;
    const still = and(
      eq(C.serial, serial),
      eq(C.kind, "keepsake"),
      sql`json_extract(${C.face}, '$.line') IS NULL`,
    );
    return this.#write(() => {
      if (line === null) {
        this.#db.orm
          .update(C)
          .set({
            face: sql`json_set(${C.face}, '$.line_tries', coalesce(json_extract(${C.face}, '$.line_tries'), 0) + 1)`,
          })
          .where(still)
          .run();
        return false;
      }
      const changed = this.#db.orm
        .update(C)
        .set({ face: sql`json_set(${C.face}, '$.line', ${line})`, artifact_id: null })
        .where(still)
        .run().changes;
      return Number(changed) > 0;
    });
  }

  /** Records the picture of a card once rendered. Whether there was such a card. */
  setArtifact(serial: string, artifactId: string): boolean {
    return (
      this.#write(() =>
        Number(
          this.#db.orm
            .update(cardsCard)
            .set({ artifact_id: artifactId })
            .where(eq(cardsCard.serial, serial))
            .run().changes,
        ),
      ) > 0
    );
  }

  /**
   * Draws and writes one card, its pity, dex entries, titles and events, in one transaction.
   * Throws a `CardCapError` when `cap` is already reached, a `CardsError` when the catalogue has
   * nothing to draw; nothing is written then.
   */
  issue(input: IssueInput): IssuedCard {
    const { person, now } = input;
    const key = input.key ?? null;
    const counted = input.pity !== false;
    return this.#write(() => {
      const since = this.pitySince(person);
      if (key !== null) {
        const found = this.byKey(person, key);
        if (found !== null) {
          const pity = pityView(since, input.rules.pity);
          return { card: found, pity, new_parts: [], titles: [], again: true };
        }
      }
      if (input.cap) {
        if (!isTallied(input.kind)) throw new CardsError(`no day's cap for ${input.kind} cards`);
        if (this.countSince(person, input.kind, input.cap.since) >= input.cap.max) {
          throw new CardCapError(
            `${person} already has ${input.cap.max} ${input.kind} cards today`,
          );
        }
      }
      const ts = at(now);
      const catalogue = this.catalogue();
      const plain = drawCard({
        catalogue,
        rules: input.rules,
        // A card the pity does not count is drawn at the plain odds.
        since: counted ? since : 0,
        tier: input.relationship.tier,
        random: input.random,
      });
      const drawn = input.dropPart ? withDropPart(plain, catalogue, input.random) : plain;
      const wished = wishedOn(drawn, this.wishlist(person));
      const snapshot: DrawSnapshot = {
        parts: drawn.parts,
        expression: drawn.expression,
        foil: drawn.foil || input.foil === true,
        seed: drawn.seed,
      };
      this.#db.orm
        .insert(cardsCard)
        .values({
          serial: input.serial,
          person_id: person,
          kind: input.kind,
          rarity: drawn.rarity,
          parts: snapshot,
          face: { ...input.face },
          relationship: { ...input.relationship },
          price: input.price,
          pity_hit: drawn.pity_hit,
          wished,
          frame: input.frame ?? null,
          created_at: ts,
          issue_key: key,
        })
        .run();
      if (key !== null) {
        this.#db.orm
          .delete(cardsPending)
          .where(and(eq(cardsPending.person_id, person), eq(cardsPending.issue_key, key)))
          .run();
      }
      if (isTallied(input.kind)) {
        this.#db.orm
          .insert(cardsTally)
          .values({ person_id: person, kind: input.kind, at: ts })
          .run();
        this.#db.orm
          .delete(cardsTally)
          .where(lt(cardsTally.at, at(now - TALLY_KEPT_MS)))
          .run();
      }
      const tier = input.kind === "milestone" ? milestoneMin(key) : null;
      if (tier !== null) {
        this.#db.orm
          .insert(cardsMilestone)
          .values({ person_id: person, tier_min: tier, given_at: ts })
          .onConflictDoNothing()
          .run();
      }
      if (input.kind === "keepsake") {
        this.#db.orm
          .insert(cardsKeepsake)
          .values({ person_id: person, given_at: ts })
          .onConflictDoNothing()
          .run();
      }
      const after = counted ? nextSince(since, drawn.rarity) : since;
      if (counted) {
        this.#db.orm
          .insert(cardsPity)
          .values({ person_id: person, since: after, drawn: 1, updated_at: ts })
          .onConflictDoUpdate({
            target: cardsPity.person_id,
            set: { since: after, drawn: sql`${cardsPity.drawn} + 1`, updated_at: ts },
          })
          .run();
      }
      const before = new Set(this.dex(person).map((e) => e.part));
      const collected = drawn.parts.filter((p) => !p.blank);
      for (const p of collected) {
        this.#db.orm
          .insert(cardsDex)
          .values({
            person_id: person,
            part_id: p.id,
            first_at: ts,
            first_card: input.serial,
            count: 1,
          })
          .onConflictDoUpdate({
            target: [cardsDex.person_id, cardsDex.part_id],
            set: { count: sql`${cardsDex.count} + 1` },
          })
          .run();
      }
      const newParts = collected.filter((p) => !before.has(p.id)).map((p) => p.id);
      const owned = new Set([...before, ...newParts]);
      const known = new Set(this.titles(person).map((t) => t.series));
      const titles: CardTitle[] = [];
      for (const s of completedBy(catalogue, before, owned)) {
        if (known.has(s.id)) continue;
        this.#db.orm
          .insert(cardsTitles)
          .values({
            person_id: person,
            series: s.id,
            title: s.title,
            card: input.serial,
            public: false,
            earned_at: ts,
          })
          .run();
        titles.push({
          series: s.id,
          title: s.title,
          card: input.serial,
          public: false,
          earned_at: ts,
        });
      }
      this.#events.appendNow(
        drawnWrite(
          {
            serial: input.serial,
            person,
            kind: input.kind,
            rarity: drawn.rarity,
            parts: drawn.parts.map((p) => p.id),
            expression: drawn.expression.id,
            price: input.price,
            pity_hit: drawn.pity_hit,
            pity_since: after,
            wished,
            new_parts: newParts,
          },
          ts,
        ),
      );
      for (const t of titles) {
        this.#events.appendNow(
          titledWrite({ person, series: t.series, title: t.title, serial: input.serial }, ts),
        );
      }
      const card = this.card(input.serial);
      if (card === null) throw new CardsError(`card ${input.serial} was not written`);
      return {
        card,
        pity: pityView(after, input.rules.pity),
        new_parts: newParts,
        titles,
        again: false,
      };
    });
  }

  // ---- cards dropped in a channel ------------------------------------------------------------

  /** Records a card she dropped in `channel`, to be picked up until `expires` (epoch ms). */
  addDrop(id: string, channel: string, now: number, expires: number): void {
    this.#write(() => {
      this.#db.orm
        .insert(cardsDrop)
        .values({ id, channel, created_at: at(now), expires_at: at(expires) })
        .run();
    });
  }

  /** Forgets a drop that never reached the channel. */
  removeDrop(id: string): void {
    this.#write(() => {
      this.#db.orm.delete(cardsDrop).where(eq(cardsDrop.id, id)).run();
    });
  }

  drop(id: string): DropRecord | null {
    this.#db.ensureOpen();
    const row = this.#db.orm.select().from(cardsDrop).where(eq(cardsDrop.id, id)).get();
    return row === undefined ? null : { ...row };
  }

  /** The drops of `channel` since `since` (epoch ms), and the latest one's time. */
  dropsSince(channel: string, since: number): { count: number; last: Timestamp | null } {
    this.#db.ensureOpen();
    const D = cardsDrop;
    const today = this.#db.orm
      .select({ n: count() })
      .from(D)
      .where(and(eq(D.channel, channel), gte(D.created_at, at(since))))
      .get();
    const last = this.#db.orm
      .select({ at: D.created_at })
      .from(D)
      .where(eq(D.channel, channel))
      .orderBy(desc(D.created_at))
      .limit(1)
      .get();
    return { count: today?.n ?? 0, last: last?.at ?? null };
  }

  /** Who picked up the last card picked up in `channel`; `null`: nobody yet. */
  lastClaimer(channel: string): PersonId | null {
    this.#db.ensureOpen();
    const D = cardsDrop;
    const row = this.#db.orm
      .select({ by: D.claimed_by })
      .from(D)
      .where(and(eq(D.channel, channel), isNotNull(D.claimed_by)))
      .orderBy(desc(D.claimed_at))
      .limit(1)
      .get();
    return row?.by ?? null;
  }

  /**
   * Takes drop `id` for `person` as the card `serial`, if nobody has and it has not expired at
   * `now`: whether it did. One statement, so of two people at once only one gets it.
   */
  claimDrop(id: string, person: PersonId, serial: string, now: number): boolean {
    const D = cardsDrop;
    return (
      this.#write(() =>
        Number(
          this.#db.orm
            .update(D)
            .set({ claimed_by: person, claimed_at: at(now), serial })
            .where(and(eq(D.id, id), isNull(D.claimed_by), gt(D.expires_at, at(now))))
            .run().changes,
        ),
      ) > 0
    );
  }

  /** Puts back drop `id` that `person` took but got no card from. */
  releaseDrop(id: string, person: PersonId): void {
    const D = cardsDrop;
    this.#write(() => {
      this.#db.orm
        .update(D)
        .set({ claimed_by: null, claimed_at: null, serial: null })
        .where(and(eq(D.id, id), eq(D.claimed_by, person)))
        .run();
    });
  }

  // ---- the old collectibles ------------------------------------------------------------------

  /**
   * Copies the old collectibles (`economy_docs` of kind `item`) into `cards_legacy`, each once (by
   * the old document's id). Nothing when the economy's table is not there. How many were new.
   */
  importLegacy(): number {
    return this.#write(() => {
      const table = this.#db.get(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'economy_docs'",
      );
      if (table === undefined) return 0;
      const rows = this.#db.all(
        "SELECT d.id, d.owner_account_id, d.data, d.created_at FROM economy_docs d " +
          "JOIN accounts a ON a.id = d.owner_account_id " +
          "WHERE d.kind = 'item' AND d.id NOT IN (SELECT id FROM cards_legacy)",
      );
      let added = 0;
      for (const row of rows) {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(String(row.data)) as Record<string, unknown>;
        } catch {
          data = {};
        }
        const item = typeof data.item === "string" ? data.item : String(row.id);
        const known = LEGACY_ITEMS[item];
        const rarity = typeof data.rarity === "string" ? data.rarity : (known?.rarity ?? "N");
        const source = typeof data.source === "string" ? data.source : "draw";
        added += this.#db.run(
          "INSERT OR IGNORE INTO cards_legacy (id, account_id, item, name, rarity, series, source, acquired_at) " +
            "VALUES ($id, $account, $item, $name, $rarity, $series, $source, $at)",
          {
            id: String(row.id),
            account: String(row.owner_account_id),
            item,
            name: known?.name ?? item,
            rarity,
            series: known?.series ?? null,
            source,
            at: Number(row.created_at),
          },
        );
      }
      return added;
    });
  }

  /** The old collectibles of a person (through their accounts), copies counted together. */
  legacy(person: PersonId): LegacyItem[] {
    this.#db.ensureOpen();
    const L = cardsLegacy;
    const rows = this.#db.orm
      .select()
      .from(L)
      .where(inArray(L.account_id, accountsOf(this.#db, [person])))
      .orderBy(asc(L.acquired_at), asc(L.id))
      .all();
    const out = new Map<string, LegacyItem>();
    for (const r of rows) {
      const seen = out.get(r.item);
      if (seen) seen.count += 1;
      else {
        out.set(r.item, {
          item: r.item,
          name: r.name,
          rarity: r.rarity,
          series: r.series,
          count: 1,
          first_at: r.acquired_at,
        });
      }
    }
    return [...out.values()];
  }

  /**
   * What the import from the V4 database kept of `person` for their keepsake (`persons.legacy`,
   * docs/design/v5-data.md D4); `null` for someone it did not bring.
   */
  importedLegacy(person: PersonId): LegacySnapshot | null {
    this.#db.ensureOpen();
    const row = this.#db.orm
      .select({ legacy: persons.legacy })
      .from(persons)
      .where(eq(persons.id, person))
      .get();
    return row?.legacy ?? null;
  }

  // ---- people ---------------------------------------------------------------------------------

  /**
   * Deletes every row of `ids` (a person and everyone merged into them). Rows per table. The old
   * collectibles stay: they were bought with coins, and the economy keeps what coins bought (its
   * own rows of them are kept too, so a deleted copy would only come back at the next start). So
   * does the mark that they were given their keepsake (`cards_keepsake`, a person id and a time):
   * what makes them eligible (`persons.legacy`) outlives a forget too, and asking to be forgotten
   * is no way to a second one. And so do the serials kept for paid cards not written yet
   * (`cards_pending`): their coins are still taken, and the settling (`CardService.settlePending`)
   * gives them back and deletes the rows within minutes; deleted now, the coins would stay taken.
   * What the day's limits count stays too (`cards_tally`: a person id, a kind and a time, two days
   * at most), so a forget is no way to a fresh day's cards; and a drop they picked up stays taken,
   * naming nobody (`FORGOTTEN_CLAIMER`), so its channel's day keeps its count. And so do the tiers
   * they were given a milestone card for (`cards_milestone`): the heart forgets their tier floor,
   * and climbing back is no way to a second card for a tier.
   */
  forgetPerson(ids: readonly PersonId[]): Record<string, number> {
    if (ids.length === 0) return {};
    const list = [...ids];
    return this.#write(() => {
      const o = this.#db.orm;
      return {
        cards_card: Number(
          o.delete(cardsCard).where(inArray(cardsCard.person_id, list)).run().changes,
        ),
        cards_pity: Number(
          o.delete(cardsPity).where(inArray(cardsPity.person_id, list)).run().changes,
        ),
        cards_dex: Number(
          o.delete(cardsDex).where(inArray(cardsDex.person_id, list)).run().changes,
        ),
        cards_wishlist: Number(
          o.delete(cardsWishlist).where(inArray(cardsWishlist.person_id, list)).run().changes,
        ),
        cards_titles: Number(
          o.delete(cardsTitles).where(inArray(cardsTitles.person_id, list)).run().changes,
        ),
        cards_drop: Number(
          o
            .update(cardsDrop)
            .set({ claimed_by: FORGOTTEN_CLAIMER, serial: null })
            .where(inArray(cardsDrop.claimed_by, list))
            .run().changes,
        ),
      };
    });
  }

  /**
   * `absorb`'s rows as `keep`'s: the cards move, the pity keeps the longer run, the dex adds up
   * (earliest first time), the titles join, and `keep`'s wishlist wins when both have one. The old
   * collectibles go with their accounts, which identity moves.
   */
  merge(keep: PersonId, absorb: PersonId): PersonHookResult {
    if (keep === absorb) return { counts: {} };
    return this.#write((): PersonHookResult => {
      const p = { keep, absorb };
      // A milestone or keepsake both had stays a card of theirs, no longer the one of its key.
      this.#db.run(
        `UPDATE cards_card SET issue_key = NULL WHERE person_id = $absorb AND issue_key IN
           (SELECT issue_key FROM cards_card WHERE person_id = $keep AND issue_key IS NOT NULL)`,
        p,
      );
      const cards = Number(
        this.#db.orm
          .update(cardsCard)
          .set({ person_id: keep })
          .where(eq(cardsCard.person_id, absorb))
          .run().changes,
      );
      this.#db.run(
        `INSERT INTO cards_pity (person_id, since, drawn, updated_at)
         SELECT $keep, since, drawn, updated_at FROM cards_pity WHERE person_id = $absorb
         ON CONFLICT (person_id) DO UPDATE SET since = max(since, excluded.since), drawn = drawn + excluded.drawn, updated_at = max(updated_at, excluded.updated_at)`,
        p,
      );
      const pity = Number(
        this.#db.orm.delete(cardsPity).where(eq(cardsPity.person_id, absorb)).run().changes,
      );
      this.#db.run(
        `INSERT INTO cards_dex (person_id, part_id, first_at, first_card, count)
         SELECT $keep, part_id, first_at, first_card, count FROM cards_dex WHERE person_id = $absorb
         ON CONFLICT (person_id, part_id) DO UPDATE SET
           count = count + excluded.count,
           first_card = CASE WHEN excluded.first_at < first_at THEN excluded.first_card ELSE first_card END,
           first_at = min(first_at, excluded.first_at)`,
        p,
      );
      const dex = Number(
        this.#db.orm.delete(cardsDex).where(eq(cardsDex.person_id, absorb)).run().changes,
      );
      this.#db.run(
        `INSERT OR IGNORE INTO cards_titles (person_id, series, title, card, public, earned_at)
         SELECT $keep, series, title, card, public, earned_at FROM cards_titles WHERE person_id = $absorb`,
        p,
      );
      const titles = Number(
        this.#db.orm.delete(cardsTitles).where(eq(cardsTitles.person_id, absorb)).run().changes,
      );
      if (this.wishlist(keep).length === 0) {
        this.#db.orm
          .update(cardsWishlist)
          .set({ person_id: keep })
          .where(eq(cardsWishlist.person_id, absorb))
          .run();
      }
      this.#db.orm.delete(cardsWishlist).where(eq(cardsWishlist.person_id, absorb)).run();
      this.#db.orm
        .update(cardsDrop)
        .set({ claimed_by: keep })
        .where(eq(cardsDrop.claimed_by, absorb))
        .run();
      // A tier either was given a milestone card for gives the kept person none again.
      this.#db.run(
        `INSERT INTO cards_milestone (person_id, tier_min, given_at)
         SELECT $keep, tier_min, given_at FROM cards_milestone WHERE person_id = $absorb
         ON CONFLICT (person_id, tier_min) DO UPDATE SET given_at = min(given_at, excluded.given_at)`,
        p,
      );
      this.#db.orm.delete(cardsMilestone).where(eq(cardsMilestone.person_id, absorb)).run();
      // What the day's limits counted of either is the kept person's.
      this.#db.orm
        .update(cardsTally)
        .set({ person_id: keep })
        .where(eq(cardsTally.person_id, absorb))
        .run();
      // A try still pending under the absorbed id is the kept person's: retried by them, or settled
      // (its coins given back). One whose key the kept person has a try of too keeps its serial
      // under a key nobody asks for, so it is only settled.
      this.#db.run(
        `UPDATE cards_pending SET person_id = $keep,
           issue_key = CASE WHEN EXISTS (SELECT 1 FROM cards_pending k
             WHERE k.person_id = $keep AND k.issue_key = cards_pending.issue_key)
           THEN issue_key || '#' || serial ELSE issue_key END
         WHERE person_id = $absorb`,
        p,
      );
      // Either one given a keepsake: the kept person was.
      this.#db.run(
        `INSERT OR IGNORE INTO cards_keepsake (person_id, given_at)
         SELECT $keep, given_at FROM cards_keepsake WHERE person_id = $absorb`,
        p,
      );
      this.#db.orm.delete(cardsKeepsake).where(eq(cardsKeepsake.person_id, absorb)).run();
      return { counts: { cards, pity, dex, titles } };
    });
  }

  #write<T>(fn: () => T): T {
    this.#db.ensureOpen();
    return this.#db.tx(fn);
  }
}

// ---- the plugin -----------------------------------------------------------------------------

/** A person's cards are part of their relationship with her, like the member cards were. */
const cardsData: readonly CategoryData[] = [
  {
    category: "relationships",
    parts: [
      tablePart("cards_card", "cards_card", "node", "created_at", "created_at", {
        serial: "text",
        person_id: "text",
        kind: "text",
        rarity: "text",
        parts: "json",
        face: "json",
        relationship: "json",
        artifact_id: "text",
        price: "num",
        pity_hit: "bool",
        wished: "json",
        frame: "text",
        created_at: "ts",
        issue_key: "text",
      }),
      tablePart("cards_pity", "cards_pity", "node", "updated_at", "person_id", {
        person_id: "text",
        since: "num",
        drawn: "num",
        updated_at: "ts",
      }),
      tablePart("cards_dex", "cards_dex", "node", "first_at", "person_id, part_id", {
        person_id: "text",
        part_id: "text",
        first_at: "ts",
        first_card: "text",
        count: "num",
      }),
      tablePart("cards_wishlist", "cards_wishlist", "node", "added_at", "person_id, position", {
        person_id: "text",
        part_id: "text",
        position: "num",
        added_at: "ts",
      }),
      tablePart("cards_titles", "cards_titles", "node", "earned_at", "person_id, series", {
        person_id: "text",
        series: "text",
        title: "text",
        card: "text",
        public: "bool",
        earned_at: "ts",
      }),
      tablePart("cards_drop", "cards_drop", "node", "created_at", "created_at", {
        id: "text",
        channel: "text",
        created_at: "ts",
        expires_at: "ts",
        claimed_by: "text",
        claimed_at: "ts",
        serial: "text",
      }),
      tablePart("cards_milestone", "cards_milestone", "node", "given_at", "person_id, tier_min", {
        person_id: "text",
        tier_min: "num",
        given_at: "ts",
      }),
      tablePart("cards_tally", "cards_tally", "node", "at", "at, person_id", {
        person_id: "text",
        kind: "text",
        at: "ts",
      }),
      tablePart("cards_legacy", "cards_legacy", "node", "acquired_at", "account_id, acquired_at", {
        id: "text",
        account_id: "text",
        item: "text",
        name: "text",
        rarity: "text",
        series: "text",
        source: "text",
        acquired_at: "ts",
      }),
    ],
  },
  // Who was given their keepsake: it goes with the people, as `persons.legacy` that made them
  // eligible does, not with their relationship (a wipe of that leaves them eligible).
  //
  // And the serials of paid cards charged and not written yet: a wipe of the relationships leaves
  // them, so the settling (`CardService.settlePending`) still gives back what was charged under
  // them (nothing, when the wallet was wiped with the relationships). A wipe is a set of
  // statements with no code before it, so the store cannot settle them first; and a deleted row is
  // a charge nothing would ever give back. Only a wipe of the people takes them, and with them the
  // persons and the wallets.
  {
    category: "people",
    parts: [
      tablePart("cards_keepsake", "cards_keepsake", "node", "given_at", "person_id", {
        person_id: "text",
        given_at: "ts",
      }),
      tablePart("cards_pending", "cards_pending", "node", "created_at", "person_id, issue_key", {
        person_id: "text",
        issue_key: "text",
        serial: "text",
        created_at: "ts",
        foil: "bool",
      }),
    ],
  },
];

/** The `cards` plugin's tables and code (`StorePlugin`). */
export const cardsTables: StorePlugin<CardStore> = {
  schema: cardsSchema,
  open: ({ db, events }) => new CardStore(db, events),
  data: cardsData,
  forgetPerson: (opened, request: PersonForget) => ({
    counts: opened.forgetPerson(request.ids),
  }),
  mergePerson: (opened, { keep, absorb }: PersonMerge) => opened.merge(keep, absorb),
};
