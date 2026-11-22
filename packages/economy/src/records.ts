// What the economy keeps on the store's database (`schema.ts`), as the rest of the economy reads
// and writes it: the record shapes, the interfaces `tables.ts` implements over the economy
// plugin's tables, and the service keys Core provides them under. One database is one character:
// the `profile` the interfaces still take is not part of any key (step 14 of
// docs/design/v5-data.md §8 drops it).
//
// A wallet is a person (identity's `persons.id`), with every person they absorbed, or her purse
// (`PURSE`). Callers that start from an account resolve its person through identity first
// (`EconomyService.member`).

import type { AccountRef, JsonObject, PersonId, ProfileId, Timestamp } from "@miyoria/types";
import { serviceKey } from "@miyoria/types";

/** The wallet of her purse: no person, reserved. */
export const PURSE: PersonId = "self";

// ---- coins ------------------------------------------------------------------------------

/** One row of the coin ledger (docs/design/economy.md §6). Rows are never changed. */
export interface CoinEntry {
  /** ULID. */
  id: string;
  /** The wallet it was written for: a person, or `PURSE`. */
  person: PersonId;
  /** Positive: earned or refunded; negative: spent. A whole number. */
  delta: number;
  /** `checkin`, `talked`, `voice`, `song`, `her_gift`, `feed`, `expression`, `refund`, ... */
  reason: string;
  ref: string | null;
  /** Counts once per wallet; `null`: no key. */
  idem_key: string | null;
  ts: Timestamp;
}

/** At most `limit` of `reasons` since `since`, summed over a wallet (`null`: everyone). */
export interface CoinCap {
  wallet: PersonId | null;
  reasons: readonly string[];
  since: Timestamp;
  limit: number;
}

/** What `CoinLedgerStore.post` checks in the same transaction besides the key. */
export interface CoinRule {
  /** Refused when the balance would go below zero. */
  covered?: boolean;
  /** Earnings: refused when a cap is reached. */
  caps?: readonly CoinCap[];
  /** With `caps`: post what still fits instead of refusing. */
  partial?: boolean;
}

/**
 * `posted`: written (`entry.delta` may be less than asked, with `partial`); `duplicate`: the key
 * was there, `entry` is the first row; `short`: not enough coins; `capped`: a cap is reached.
 */
export type CoinPost =
  | { status: "posted"; entry: CoinEntry; balance: number }
  | { status: "duplicate"; entry: CoinEntry; balance: number }
  | { status: "short"; balance: number }
  | { status: "capped"; balance: number };

/** Coins of one reason on one local day, from the ledger, all wallets. */
export interface LedgerDayTotal {
  /** The local day number: `floor((epoch_ms + offset) / 86_400_000)`. */
  day: number;
  reason: string;
  /** The sum of the rows with `delta > 0`. */
  positive: number;
  /** The sum of the rows with `delta < 0`, as a positive number. */
  negative: number;
}

/** Totals over the whole coin ledger, for the economy's health table (docs/design/v4-plan.md §10). */
export interface LedgerStatsStore {
  /**
   * Coins issued (positive rows) and recovered (negative rows) per local day and reason, from
   * `since` on, all wallets, her purse included. One `GROUP BY`; `offsetMinutes` is the local
   * time zone as minutes east of UTC.
   */
  dailyTotals(
    profile: ProfileId,
    since: Timestamp,
    offsetMinutes: number,
  ): Promise<LedgerDayTotal[]>;
}

/**
 * The coin ledger (docs/design/economy.md §6): append-only, the balance is a sum. `wallet` is a
 * person (with the persons they absorbed) or `PURSE`.
 */
export interface CoinLedgerStore extends LedgerStatsStore {
  /**
   * Appends `entry` in one transaction with its checks: the key (once per wallet), the caps of
   * `rule`, the balance.
   */
  post(entry: CoinEntry, rule?: CoinRule): Promise<CoinPost>;
  /**
   * Appends `rows` (one wallet, each with its own key) in one transaction: all of them or none.
   * The first row's key decides a retry (`duplicate`, with that row); with `covered`, refused
   * (`short`) when their sum would take the balance below zero. The exchange books a sale and its
   * burned fee this way, so the fee is a row of its own without a moment the two disagree.
   */
  postAll?(rows: readonly CoinEntry[], rule?: { covered?: boolean }): Promise<CoinPost>;
  balance(profile: ProfileId, wallet: PersonId): Promise<number>;
  /** Rows of the wallet, newest first, at most `limit`; `reasons` and `since` narrow them. */
  entries(
    profile: ProfileId,
    wallet: PersonId,
    filter: { reasons?: readonly string[]; since?: Timestamp; limit: number },
  ): Promise<CoinEntry[]>;
  /** The first row of the wallet with this key, or `null`. */
  byKey(profile: ProfileId, wallet: PersonId, key: string): Promise<CoinEntry | null>;
  /** The card frame the wallet chose last, or `null`. */
  selectedFrame(profile: ProfileId, wallet: PersonId): Promise<string | null>;
  selectFrame(
    profile: ProfileId,
    wallet: PersonId,
    frame: string | null,
    at: Timestamp,
  ): Promise<void>;
  /** Whether the wallet is on the sponsor board: yes unless it left. */
  onBoard(profile: ProfileId, wallet: PersonId): Promise<boolean>;
  /** Puts the wallet on the board or takes it off. It never touches the frame choice. */
  setOnBoard(profile: ProfileId, wallet: PersonId, on: boolean): Promise<void>;
  /** The persons that left the board, at most `limit`. */
  offBoard(profile: ProfileId, limit: number): Promise<PersonId[]>;
  /**
   * What each wallet spent since `since` on `reasons`, biggest first, at most `limit`: negative
   * rows that were not refunded.
   * A person another one absorbed is counted in the absorbing one's line; `account` is the
   * person's first account (`null` if it has none), her purse is never a line.
   */
  spent(
    profile: ProfileId,
    reasons: readonly string[],
    since: Timestamp,
    limit: number,
  ): Promise<{ person: PersonId; account: AccountRef | null; spent: number }[]>;
}

// ---- fortunes ---------------------------------------------------------------------------

/** A fortune slip she wrote for someone (docs/design/economy.md §13), at most one per local day. */
export interface FortuneRecord {
  /** ULID. */
  id: string;
  /** The session account it was written for. */
  account: AccountRef;
  person: PersonId | null;
  /** The local day number it belongs to (the API's `utc_offset_minutes`). */
  day: number;
  issued_at: Timestamp;
  /** The `fortune` ledger row that paid for it, to refund or to find it again. */
  entry: string | null;
  /** The slip itself; the store does not look inside. */
  slip: JsonObject;
}

/**
 * Fortune slips she wrote on the member page (docs/design/economy.md §13), at most one per person
 * per local day. "Theirs" are the slips of any of `accounts`.
 */
export interface FortuneStore {
  /** Stores a slip; `false` when one of these `accounts` already has one for that `day`. */
  put(record: FortuneRecord, accounts: readonly AccountRef[]): Promise<boolean>;
  /** The slip of `day` of any of `accounts`, or `null`. */
  forDay(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    day: number,
  ): Promise<FortuneRecord | null>;
  /** The slips of `accounts`, newest first, at most `limit`. */
  listFor(
    profile: ProfileId,
    accounts: readonly AccountRef[],
    limit: number,
  ): Promise<FortuneRecord[]>;
  /** Deletes every slip of `accounts`; returns how many. */
  deleteFor(profile: ProfileId, accounts: readonly AccountRef[]): Promise<number>;
}

// ---- bounties ---------------------------------------------------------------------------

/**
 * `open`: posted, the reward is held; `awarded`: paid to someone; `cancelled` / `expired`: the held
 * coins went back to her purse.
 */
export type BountyStatus = "open" | "awarded" | "cancelled" | "expired";

/** A task she pays for out of her own purse (docs/design/economy.md §13). */
export interface Bounty {
  /** ULID. */
  id: string;
  task: string;
  reward: number;
  /** The purse's hold row in the coin ledger. */
  hold: string;
  status: BountyStatus;
  created_at: Timestamp;
  expires_at: Timestamp;
  closed_at: Timestamp | null;
  /** The account it was paid to, once awarded. */
  winner: AccountRef | null;
  /**
   * The Space (identity's `spaces.id`) it was posted in: where it is shown and who can win it.
   * `null` when she knew of no Space (open to everyone she knows).
   */
  space: string | null;
}

/** What `BountyStore.transition` changes besides the status. */
export interface BountyPatch {
  status: BountyStatus;
  closed_at?: Timestamp | null;
  winner?: AccountRef | null;
}

/** Bounties she posted from her purse (docs/design/economy.md §13). */
export interface BountyStore {
  create(bounty: Bounty): Promise<void>;
  get(id: string): Promise<Bounty | null>;
  /** Changes the bounty only while its status is one of `from`; `false` when it was not. */
  transition(id: string, from: readonly BountyStatus[], patch: BountyPatch): Promise<boolean>;
  /**
   * Bounties newest first; `statuses` narrows them, and `spaces` to the ones of those Spaces (and
   * the ones of no Space).
   */
  list(
    profile: ProfileId,
    filter: { statuses?: readonly BountyStatus[]; spaces?: readonly string[]; limit: number },
  ): Promise<Bounty[]>;
}

// ---- economy documents ------------------------------------------------------------------

/**
 * One document of economy 2.0 (docs/design/v4-plan.md §10): a prediction and its bets, what the
 * audience funded of her room, and what retired features left (a collectible drawn before drawing
 * was removed, which the cards plugin copies; a commission). Coins are never kept here; every
 * balance change is a row of the coin ledger.
 */
export interface EconomyDoc {
  /** ULID, or a deterministic id that makes `create` idempotent (a card trait: `card:<n>:<trait>`). */
  id: string;
  /** `item`, `prediction`, `bet`, `commission` (retired, still kept), `room`. */
  kind: string;
  /** Who it belongs to; `null` for what belongs to nobody in particular (a prediction, a room item). */
  owner: AccountRef | null;
  /** Kind-specific state word (`open`, `held`, `unlocked`, ...). */
  status: string;
  /** Starts at 1; `update` bumps it. */
  version: number;
  data: JsonObject;
  created_at: Timestamp;
  updated_at: Timestamp;
  /**
   * The Space (identity's `spaces.id`) it belongs to: a prediction and its bets. `null` (or left
   * out) for what belongs to no Space. Set when it is created; never changed.
   */
  space?: string | null;
}

export interface DocFilter {
  /** Only documents owned by one of these accounts. */
  owners?: readonly AccountRef[];
  statuses?: readonly string[];
  /** Only documents of these Spaces, and the ones of no Space. */
  spaces?: readonly string[];
  limit: number;
}

/** What `EconomyDocStore.update` writes. */
export interface DocUpdate {
  status: string;
  data: JsonObject;
  /** Replaces the owner when given (`null` included). */
  owner?: AccountRef | null;
  at: Timestamp;
}

/**
 * The versioned documents of economy 2.0: predictions and bets, her room, and the collectibles and
 * commissions of retired features (docs/design/v4-plan.md §10). One table, keyed by (kind, id).
 */
export interface EconomyDocStore {
  /** Stores `doc`; `false` when the id already exists (nothing changes). */
  create(doc: EconomyDoc): Promise<boolean>;
  get(profile: ProfileId, kind: string, id: string): Promise<EconomyDoc | null>;
  /**
   * Compare and set: replaces status, data (and the owner when `next.owner` is given, `null`
   * included) and bumps the version, only when the stored version is `expected`. `false` otherwise.
   */
  update(
    profile: ProfileId,
    kind: string,
    id: string,
    expected: number,
    next: DocUpdate,
  ): Promise<boolean>;
  /** Newest first (by creation, the id breaking a tie), at most `filter.limit`. */
  list(profile: ProfileId, kind: string, filter: DocFilter): Promise<EconomyDoc[]>;
  /**
   * Deletes at most `limit` documents of `kind` created before `before`, oldest first; how many
   * went. Only for kinds that are of use for a while and say nothing about coins (today's quest
   * picks); what coins were paid for is never pruned.
   */
  prune(profile: ProfileId, kind: string, before: Timestamp, limit: number): Promise<number>;
}

// Service keys: Core provides the economy plugin's tables under them (`store.plugin`).
export const CoinLedgerStoreKey = serviceKey<CoinLedgerStore>("CoinLedgerStore");
export const LedgerStatsKey = serviceKey<LedgerStatsStore>("LedgerStats");
export const FortuneStoreKey = serviceKey<FortuneStore>("FortuneStore");
export const BountyStoreKey = serviceKey<BountyStore>("BountyStore");
export const EconomyDocsKey = serviceKey<EconomyDocStore>("EconomyDocs");
