// Record types of every storage area. JSON shapes are identical to the legacy Rust structs
// (snake_case, `Option<T>` as `T | null`, ULIDs as strings, RFC 3339 timestamps).

import type {
  AccountRef,
  ContextKey,
  ContextKind,
  DecisionTrace,
  IncomingMessage,
  JsonObject,
  JsonValue,
  MemoryOrigin,
  PersonId,
  PlatformId,
  ProfileId,
  Timestamp,
  TurnId,
} from "@miyoria/types";
import { incomingText, newId } from "@miyoria/types";

// ---- conversation log -------------------------------------------------------------------

/** One entry of the conversation log. */
export interface LogEntry {
  /** ULID. */
  id: string;
  profile: ProfileId;
  context: ContextKey;
  author: AccountRef;
  author_name: string;
  text: string;
  /** Written by one of her own accounts. */
  is_self: boolean;
  /** Stored with microsecond precision. */
  ts: Timestamp;
  /** The agent turn that produced or consumed this entry. */
  turn: TurnId | null;
}

/** When and in what kind of context someone wrote: what `MessageLog.authoredSince` returns. */
export interface AuthoredEntry {
  ts: Timestamp;
  kind: ContextKind;
}

/**
 * Builds an entry from a platform message, with a fresh id and no turn. Stickers, embeds,
 * attachments and forwards are noted inline in `text` (`incomingText`).
 */
export function logEntryFromIncoming(
  profile: ProfileId,
  message: IncomingMessage,
  isSelf: boolean,
): LogEntry {
  return {
    id: newId(),
    profile,
    context: message.id.context,
    author: message.author.account,
    author_name: message.author.display_name,
    text: incomingText(message),
    is_self: isSelf,
    ts: message.ts,
    turn: null,
  };
}

// ---- member cards -----------------------------------------------------------------------

/** A card she gave someone on the member page: what it showed, kept so its serial can be checked. */
export interface MemberCardRecord {
  /** `MYR-XXXX-XXXX-XXXX`, unique across profiles. */
  serial: string;
  profile: ProfileId;
  /** The session account it was issued to. */
  account: AccountRef;
  /** The person she knew them as then, if any. */
  person: PersonId | null;
  issued_at: Timestamp;
  /** What the card shows; the store does not look inside. */
  snapshot: JsonObject;
}

// ---- fortunes ---------------------------------------------------------------------------

/** A fortune slip she wrote for someone (docs/design/economy.md §13), at most one per local day. */
export interface FortuneRecord {
  /** ULID. */
  id: string;
  profile: ProfileId;
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

// ---- coins ------------------------------------------------------------------------------

/** One row of the coin ledger (docs/design/economy.md §6). Rows are never changed. */
export interface CoinEntry {
  /** ULID. */
  id: string;
  profile: ProfileId;
  /** The account it was written for; a wallet is all accounts of a person. */
  account: AccountRef;
  /** Positive: earned or refunded; negative: spent. A whole number. */
  delta: number;
  /** `checkin`, `talked`, `voice`, `song`, `her_gift`, `feed`, `letter`, `refund`, ... */
  reason: string;
  ref: string | null;
  /** Counts once per account; `null`: no key. */
  idem_key: string | null;
  ts: Timestamp;
}

/** At most `limit` of `reasons` since `since`, summed over `accounts` (`null`: everyone). */
export interface CoinCap {
  accounts: readonly AccountRef[] | null;
  reasons: readonly string[];
  since: Timestamp;
  limit: number;
}

/** What `CoinLedgerStore.post` checks in the same transaction. */
export interface CoinRule {
  /** The accounts that are one wallet with the entry's (its balance, its keys). */
  wallet: readonly AccountRef[];
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

// ---- deals ------------------------------------------------------------------------------

/**
 * `open`: she took the deal, the task is not done; `owed`: she says it is done, payment awaited;
 * `settled`: paid (or escrow released); `broken`: not paid by its due time; `refunded`: escrow
 * returned; `cancelled`: ended with nothing to return.
 */
export type DealStatus = "open" | "owed" | "settled" | "broken" | "refunded" | "cancelled";

/** A bribe she accepted (docs/design/economy.md §12): someone's promise of a reward for a task. */
export interface Deal {
  /** ULID. */
  id: string;
  profile: ProfileId;
  /** The account that made it (the speaker); its wallet pays. */
  account: AccountRef;
  /** `rice`, `big_bowl` or `dessert`. */
  item: string;
  count: number;
  /** What the reward costs in coins, fixed when the deal was made. */
  value: number;
  /** What she will do, short. */
  task: string;
  /** Paid into escrow at once (`escrow` is its ledger row). */
  prepaid: boolean;
  /** The escrow's coin ledger row id. */
  escrow: string | null;
  status: DealStatus;
  created_at: Timestamp;
  /** When she said she did it. */
  done_at: Timestamp | null;
  /** Unpaid deals: when payment is due once she is done; escrow deals: the refund time. */
  due_at: Timestamp | null;
  closed_at: Timestamp | null;
}

/** What `DealStore.transition` changes besides the status. */
export interface DealPatch {
  status: DealStatus;
  done_at?: Timestamp | null;
  due_at?: Timestamp | null;
  closed_at?: Timestamp | null;
}

// ---- goals and bounties -----------------------------------------------------------------

/**
 * `open`: people may pledge; `reached`: the target was met and the pledges are hers (a promise);
 * `expired`: the deadline passed short, every pledge was returned; `cancelled`: she withdrew it,
 * every pledge was returned.
 */
export type GoalStatus = "open" | "reached" | "expired" | "cancelled";

/** A crowdfunding goal of hers (docs/design/economy.md §13): what she will do if it is met. */
export interface Goal {
  /** ULID. */
  id: string;
  profile: ProfileId;
  title: string;
  /** What she will do when the target is reached. */
  promise: string;
  target: number;
  status: GoalStatus;
  created_at: Timestamp;
  deadline: Timestamp;
  closed_at: Timestamp | null;
}

/** What `GoalStore.transition` changes besides the status. */
export interface GoalPatch {
  status: GoalStatus;
  closed_at?: Timestamp | null;
}

/** Coins held for a goal; `id` is the escrow's coin ledger row. */
export interface GoalPledge {
  id: string;
  goal: string;
  profile: ProfileId;
  account: AccountRef;
  amount: number;
  created_at: Timestamp;
}

/**
 * `open`: posted, the reward is held; `awarded`: paid to someone; `cancelled` / `expired`: the held
 * coins went back to her purse.
 */
export type BountyStatus = "open" | "awarded" | "cancelled" | "expired";

/** A task she pays for out of her own purse (docs/design/economy.md §13). */
export interface Bounty {
  /** ULID. */
  id: string;
  profile: ProfileId;
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
}

/** What `BountyStore.transition` changes besides the status. */
export interface BountyPatch {
  status: BountyStatus;
  closed_at?: Timestamp | null;
  winner?: AccountRef | null;
}

// ---- persona overrides ------------------------------------------------------------------

/** One version of a persona section override. */
export interface PersonaOverride {
  profile: ProfileId;
  /** Persona section, e.g. `"identity"` or `"style"`. */
  key: string;
  /** Starts at 1 and increases by 1 per edit of the same section. */
  version: number;
  body: string;
  /** Who made the edit, e.g. `"panel:owen"` or `"discord:1234"`. */
  edited_by: string;
  edited_at: Timestamp;
}

// ---- people -----------------------------------------------------------------------------

/** A platform account linked to a person. */
export interface Account {
  account: AccountRef;
  /** Most recently seen display name. */
  display_name: string;
  first_seen: Timestamp;
  last_seen: Timestamp;
}

/** A cross-platform person with their accounts. */
export interface Person {
  id: PersonId;
  /** Display name of the account the person was first seen with. */
  display_name: string;
  created_at: Timestamp;
  /** Ordered by first sight. */
  accounts: Account[];
}

// ---- decisions --------------------------------------------------------------------------

/** One attention decision of the agent, for "why did she (not) reply" views. */
export interface DecisionRecord {
  /** ULID. */
  id: string;
  profile: ProfileId;
  ts: Timestamp;
  trace: DecisionTrace;
}

// ---- long-term memory -------------------------------------------------------------------

/**
 * `episode`: something that happened ("昨晚大家一起打 Minecraft,Owen 掉進岩漿");
 * `fact`: about a person or the world ("Owen 喜歡拉麵"); `self_note`: her own experiences,
 * opinions and promises; `followup`: something to bring up later (has `due`).
 */
export type MemoryKind = "episode" | "fact" | "self_note" | "followup";

/** Privacy scope: where a memory may be recalled. Internally tagged (`{"type": "guild", ...}`). */
export type MemoryScope =
  /** Anywhere (her own general knowledge and self notes). */
  | { type: "global" }
  /** Anywhere in one guild / server. */
  | { type: "guild"; platform: PlatformId; guild: string }
  /** Only in one channel (or voice channel). */
  | { type: "channel"; context: ContextKey }
  /** Only in the DM with this account. */
  | { type: "dm"; account: AccountRef }
  /** Anywhere this person is present (e.g. their name, how to address them). */
  | { type: "person"; person: PersonId };

/** The account a memory came from, with the name it had then. */
export interface MemorySource {
  account: AccountRef;
  name: string;
}

export interface MemoryRecord {
  /** ULID. */
  id: string;
  profile: ProfileId;
  kind: MemoryKind;
  scope: MemoryScope;
  /** People the memory is about. */
  subjects: PersonId[];
  content: string;
  /** Space-separated search tokens (already segmented, e.g. with jieba). */
  tokens: string;
  embedding: number[] | null;
  /** 0..1 */
  importance: number;
  /** 0..1 */
  confidence: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  last_accessed: Timestamp | null;
  access_count: number;
  /** Where it was learned. */
  source_context: ContextKey | null;
  /**
   * Who told her, for notes she wrote because someone said so (`remember`); read back as
   * "X said …", never as fact. `null` for memories she extracted herself (and old records).
   */
  source: MemorySource | null;
  /**
   * Whether she lived it or was told it. `unknown` for records written before origins were
   * recorded (the migration marks them so instead of guessing). Absent reads as `unknown`.
   */
  origin?: MemoryOrigin;
  /**
   * EventLog ids the memory came from (or `msg:<id>` of a chat line the log has no event for).
   * Empty for `unknown`. Absent reads as empty.
   */
  source_events?: string[];
  /** Followups: earliest time to bring it up. */
  due: Timestamp | null;
  /** Followups: already brought up. */
  done: boolean;
  /** Replaced by a newer record (kept for history, never recalled). */
  superseded_by: string | null;
}

export interface MemoryQuery {
  profile: ProfileId;
  /**
   * Only records in one of these scopes are returned. `person` scopes for present people must
   * be listed explicitly too.
   */
  scopes: MemoryScope[];
  /** `null` = every kind. */
  kinds: MemoryKind[] | null;
  /** Full-text tokens (OR-ed). */
  tokens: string[];
  /** Nearest-neighbour search when set (cosine). */
  embedding: number[] | null;
  limit: number;
}

export interface MemoryHit {
  record: MemoryRecord;
  /** Full-text relevance, 0 when it only matched by vector. */
  text_score: number;
  /** Cosine similarity, `null` when no embedding was searched / stored. */
  vector_score: number | null;
}

export interface MemoryFilter {
  subject: PersonId | null;
  scope: MemoryScope | null;
  kind: MemoryKind | null;
  /** Only records created before this time (pagination). */
  before: Timestamp | null;
  include_superseded: boolean;
  limit: number;
}

export interface PrunePolicy {
  /** Only episodes created before this time are candidates ... */
  created_before: Timestamp;
  /** ... with importance at most this ... */
  max_importance: number;
  /** ... and not accessed since this time. */
  not_accessed_since: Timestamp;
}

// ---- relationships ----------------------------------------------------------------------

/** How one profile (character) feels about one person. */
export interface Relationship {
  profile: ProfileId;
  person: PersonId;
  /** -100..100 */
  affinity: number;
  /** 0..100 */
  trust: number;
  /** 0..100 */
  familiarity: number;
  /** e.g. `owner`, `friend`, `regular`, `troll`, `blocked`. */
  tags: string[];
  /** Her impression of the person, maintained by the LLM. */
  notes: string;
  /** How she addresses them. */
  call_name: string | null;
  interactions: number;
  last_interaction: Timestamp | null;
  updated_at: Timestamp;
}

/** One change, kept for history and for daily caps. */
export interface RelationshipDelta {
  at: Timestamp;
  affinity: number;
  trust: number;
  familiarity: number;
  /** e.g. `"appraisal: praise"`, `"admin: reset"`. */
  reason: string;
}

// ---- permissions ------------------------------------------------------------------------

/** A role and the permission nodes it grants. Node patterns may end in `.*` or be `"*"`. */
export interface RoleDefinition {
  name: string;
  /**
   * Higher outranks lower (owner 100, admin 80, moderator 60, trusted 40, user 20,
   * restricted 10, blocked 0).
   */
  rank: number;
  grants: string[];
  denies: string[];
  /** Built-in roles can be edited but not deleted. */
  builtin: boolean;
}

/** Internally tagged (`{"type": "global"}`). */
export type AuthScope =
  | { type: "global" }
  | { type: "guild"; platform: PlatformId; guild: string }
  | { type: "channel"; context: ContextKey };

export interface RoleAssignment {
  account: AccountRef;
  role: string;
  scope: AuthScope;
  /** e.g. `"discord:123"` or `"config"`. */
  granted_by: string;
  at: Timestamp;
}

/** Platform role (e.g. a Discord role id) → Miyoria role, per guild. */
export interface RoleMapping {
  platform: PlatformId;
  guild: string;
  platform_role: string;
  role: string;
}

/** Allow / deny a node for a role in one scope (e.g. `voice.join` for `user` in one guild). */
export interface NodeOverride {
  scope: AuthScope;
  role: string;
  node: string;
  allow: boolean;
}

export interface AuditEntry {
  /** ULID. */
  id: string;
  at: Timestamp;
  /** Who did it, e.g. `"discord:123"`, `"api"`, `"cli"`. */
  actor: string;
  /** e.g. `"module.disable"`, `"role.assign"`, `"memory.forget"`. */
  action: string;
  target: string;
  detail: JsonValue;
  ok: boolean;
}
