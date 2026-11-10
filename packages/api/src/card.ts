// Member cards (她發給你的卡): a snapshot of how she sees someone at the moment they asked, with a
// random serial, kept so the QR code on it can be checked later.
//
// * `GET /api/member/card`, `POST /api/member/card` `{}`: their latest card, and a new one (routes
//   in `member.ts`; what goes on a card is `cardView` there).
// * `GET /api/public/card/{serial}`: anyone may check a code; unknown, deleted and malformed
//   serials get the same 404.
//
// A card holds what the member page showed, in words, and the frame they chose, nothing else: it
// is built field by field from the stored snapshot, so a field added to the snapshot stays private
// until named here.

import { randomBytes } from "node:crypto";
import { type Economy, EconomyError, EconomyKey, type PaidItem } from "@miyoria/economy";
import { errorMessage, getLogger } from "@miyoria/kernel";
import {
  type MemberCardRecord,
  type MemberCardStore,
  MemberCardStoreKey,
  StoreError,
} from "@miyoria/store";
import {
  type AccountRef,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";
import { type CardWords, POSE_WORDS } from "./card-words.js";
import { ApiError } from "./errors.js";
import { clientKey, localDay, tooMany } from "./public.js";
import { param, type Route } from "./route.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";
import type {
  CardField,
  CardPoseChoice,
  CardPrices,
  IssuedCard,
  MemberCard,
  MemberCards,
} from "./types.js";

const log = getLogger("api.card");

/** Most cards a person may be issued per local day. */
export const CARDS_PER_DAY = 5;
/** Cards an export lists at most. */
const MAX_EXPORTED = 1_000;

const OVER_LIMIT = "今天的卡已經發完了,明天再來";
const NO_STORE = "這個 Core 還不能發卡";
const NO_SUCH_CARD = "這張卡不存在或已經作廢";
const NO_WALLET = "錢包現在不能用";
const BAD_POSE = "這張立繪現在不能選";
const NOTHING_TO_REROLL = "今天沒有可以重抽的卡";

/** Pictures of her per affinity band; `stranger` for someone she does not know (or will not say). */
export const CARD_POSES: Readonly<Record<string, readonly string[]>> = {
  stranger: ["calm", "finger"],
  很差: ["cold"],
  不太好: ["sweat", "smug"],
  普通: ["calm", "finger", "smug"],
  不錯: ["smile", "finger", "hand"],
  很好: ["blush", "squint", "hand"],
  非常好: ["heart", "blush", "squint"],
};

// ---- serials --------------------------------------------------------------------------------

/** Crockford base32: no I, L, O or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SERIAL_CHARS = 12;
const MAX_SERIAL_INPUT = 64;

function formatSerial(body: string): string {
  return `MYR-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** A fresh `MYR-XXXX-XXXX-XXXX`: 60 bits from the system's CSPRNG. */
export function newSerial(): string {
  let bits = randomBytes(8).readBigUInt64BE(0);
  let body = "";
  for (let i = 0; i < SERIAL_CHARS; i++) {
    body = ALPHABET[Number(bits & 31n)] + body;
    bits >>= 5n;
  }
  return formatSerial(body);
}

/**
 * The canonical serial of what someone typed or scanned, `null` when it cannot be one: any case,
 * dashes and spaces optional, and the letters Crockford reads as digits (I, L as 1, O as 0).
 */
export function normalizeSerial(input: string): string | null {
  if (input.length > MAX_SERIAL_INPUT) return null;
  const flat = input.toUpperCase().replace(/[\s-]/g, "");
  if (!flat.startsWith("MYR")) return null;
  const body = flat.slice(3).replace(/[IL]/g, "1").replace(/O/g, "0");
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(body)) return null;
  return formatSerial(body);
}

// ---- cards ----------------------------------------------------------------------------------

/** One of the band's poses, by `random` in [0, 1). */
/** The poses a card of `affinity` may use. */
export function posesFor(affinity: string | null): readonly string[] {
  const poses = (affinity !== null ? CARD_POSES[affinity] : undefined) ?? CARD_POSES.stranger;
  return poses && poses.length > 0 ? poses : ["calm"];
}

export function pickPose(affinity: string | null, random: () => number): string {
  const list = posesFor(affinity);
  const i = Math.min(Math.max(Math.floor(random() * list.length), 0), list.length - 1);
  return list[i] as string;
}

const text = (v: JsonValue | undefined): string | null => (typeof v === "string" ? v : null);

function fieldsOf(v: JsonValue | undefined): CardField[] {
  if (!Array.isArray(v)) return [];
  const out: CardField[] = [];
  for (const f of v) {
    if (!isJsonObject(f)) continue;
    const label = text(f.label);
    const body = text(f.text);
    if (label !== null && body !== null) out.push({ label, text: body });
  }
  return out;
}

/** A stored card as it may leave, or `null` when the snapshot is not one. */
function issuedCard(r: MemberCardRecord): IssuedCard | null {
  const s = r.snapshot;
  const name = text(s.name);
  const pose = text(s.pose);
  const number = s.number;
  if (name === null || pose === null || typeof number !== "number" || !Number.isInteger(number)) {
    return null;
  }
  return {
    serial: r.serial,
    issued_at: r.issued_at,
    name,
    avatar_url: text(s.avatar_url),
    number,
    call_name: text(s.call_name),
    relationship: text(s.relationship),
    affinity: text(s.affinity),
    trust: text(s.trust),
    familiarity: text(s.familiarity),
    public_feeling: text(s.public_feeling),
    // Cards from before she wrote on them have none of these.
    line: text(s.line),
    stamp: text(s.stamp),
    fields: fieldsOf(s.fields),
    pose,
    // Cards from before frames have none.
    frame: text(s.frame),
    foil: s.foil === true,
    voided_at: text(s.voided_at),
  };
}

/** The serial a reroll replaced; such cards do not count toward the day's cards. */
const rerollOf = (r: MemberCardRecord): string | null => text(r.snapshot.reroll_of);

function snapshotOf(card: IssuedCard): JsonObject {
  const { serial: _serial, issued_at: _at, fields, ...rest } = card;
  return { ...rest, fields: fields.map((f) => ({ label: f.label, text: f.text })) };
}

/** Whose cards these are. */
export interface CardHolder {
  session: SessionRecord;
  /** The session account and every account of the person she knows them as. */
  accounts: readonly AccountRef[];
  person: PersonId | null;
}

/** Start of the current local day, as public stats count days. */
function todayStart(state: ApiState): string {
  const offset = state.publicSide.config.utc_offset_minutes;
  return toTimestamp(localDay(state.now(), offset) * 86_400_000 - offset * 60_000);
}

/** Recent cards looked at for "today" and "latest"; a day holds a handful. */
const RECENT = 100;

interface Today {
  /** Cards that count toward the day's limit (a reroll's card replaces one, so it does not). */
  issued: number;
  rerolls: number;
  /** Their newest card that is not voided, with the record it came from. */
  latest: MemberCardRecord | null;
}

async function todayOf(
  state: ApiState,
  store: MemberCardStore,
  holder: CardHolder,
): Promise<Today> {
  const since = Date.parse(todayStart(state));
  const recent = await store.listFor(state.profile(), holder.accounts, RECENT);
  let issued = 0;
  let rerolls = 0;
  for (const r of recent) {
    if (Date.parse(r.issued_at) < since) continue;
    if (rerollOf(r) === null) issued++;
    else rerolls++;
  }
  const latest = recent.find((r) => text(r.snapshot.voided_at) === null) ?? null;
  return { issued, rerolls, latest };
}

/** What `item` costs and whether it is on sale, or `null` without a wallet. */
function offer(
  economy: Economy | undefined,
  item: PaidItem,
): { price: number; per_day: number } | null {
  if (!economy) return null;
  const { price, per_day } = economy.price(item);
  return per_day > 0 ? { price, per_day } : null;
}

function posesOf(affinity: string | null): CardPoseChoice[] {
  return posesFor(affinity).map((id) => ({ id, label: POSE_WORDS[id] ?? id }));
}

/**
 * `GET /api/member/card`. `view` is what the member page shows them now: its affinity band says
 * which pictures they may choose.
 */
export async function memberCards(
  state: ApiState,
  holder: CardHolder,
  view: MemberCard,
): Promise<MemberCards> {
  const store = state.optional(MemberCardStoreKey);
  const economy = state.optional(EconomyKey);
  const reroll = offer(economy, "card_reroll");
  const prices: CardPrices = {
    pose: offer(economy, "card_pose")?.price ?? null,
    foil: offer(economy, "card_foil")?.price ?? null,
    reroll: reroll?.price ?? null,
  };
  const poses = posesOf(view.affinity);
  if (!store) {
    return { latest: null, today: 0, per_day: CARDS_PER_DAY, poses, prices, rerolls_left: 0 };
  }
  const today = await todayOf(state, store, holder);
  const start = Date.parse(todayStart(state));
  const fresh = today.latest !== null && Date.parse(today.latest.issued_at) >= start;
  return {
    latest: today.latest ? issuedCard(today.latest) : null,
    today: today.issued,
    per_day: CARDS_PER_DAY,
    poses,
    prices,
    rerolls_left: reroll && fresh ? Math.max(reroll.per_day - today.rerolls, 0) : 0,
  };
}

/** The frame they chose for their cards; none when the wallet cannot say. */
async function frameOf(state: ApiState, account: AccountRef): Promise<string | null> {
  try {
    return (await state.optional(EconomyKey)?.selectedFrame(account)) ?? null;
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot read the card frame");
    return null;
  }
}

/** Issues run one at a time, so two clicks cannot both take the last card of the day. */
const issuing = new WeakMap<ApiState, Promise<unknown>>();

function serialized<T>(state: ApiState, run: () => Promise<T>): Promise<T> {
  const before = issuing.get(state) ?? Promise.resolve();
  const next = before.then(run, run);
  issuing.set(
    state,
    next.catch(() => undefined),
  );
  return next;
}

/** Whether they may still be given a card today (checked again when it is issued). */
export async function canIssue(state: ApiState, holder: CardHolder): Promise<boolean> {
  const store = state.optional(MemberCardStoreKey);
  if (!store) return false;
  return (await todayOf(state, store, holder)).issued < CARDS_PER_DAY;
}

/** What a card is issued with besides her words. */
interface Extras {
  pose: string | null;
  foil: boolean;
  /** The card a reroll replaces: no day limit, and it keeps its number. */
  replaces: IssuedCard | null;
}

async function issue(
  state: ApiState,
  store: MemberCardStore,
  holder: CardHolder,
  view: MemberCard,
  words: CardWords | null,
  extras: Extras,
): Promise<IssuedCard> {
  const profile = state.profile();
  if (!extras.replaces && (await todayOf(state, store, holder)).issued >= CARDS_PER_DAY) {
    throw new ApiError(429, OVER_LIMIT);
  }
  const card: IssuedCard = {
    serial: newSerial(),
    issued_at: toTimestamp(state.now()),
    name: holder.session.name,
    avatar_url: holder.session.avatar_url,
    number: extras.replaces?.number ?? (await store.countFor(profile, holder.accounts)) + 1,
    call_name: view.call_name,
    relationship: view.relationship,
    affinity: view.affinity,
    trust: view.trust,
    familiarity: view.familiarity,
    public_feeling: view.public_feeling,
    line: words?.line ?? null,
    stamp: words?.stamp ?? null,
    fields: words?.fields ?? [],
    pose: extras.pose ?? words?.pose ?? pickPose(view.affinity, state.random),
    frame: await frameOf(state, holder.session.account),
    foil: extras.foil,
    voided_at: null,
  };
  const snapshot = snapshotOf(card);
  if (extras.replaces) snapshot.reroll_of = extras.replaces.serial;
  // 60 bits do not collide; a retry costs nothing if they ever do.
  for (let attempt = 0; ; attempt++) {
    try {
      await store.issue({
        serial: card.serial,
        profile,
        account: holder.session.account,
        person: holder.person,
        issued_at: card.issued_at,
        snapshot,
      });
      return card;
    } catch (error) {
      if (!(error instanceof StoreError) || !/already exists/.test(error.message) || attempt >= 2) {
        throw error;
      }
      card.serial = newSerial();
    }
  }
}

function paid(error: unknown): never {
  if (error instanceof EconomyError) throw new ApiError(error.status, error.message);
  throw error;
}

async function giveBack(economy: Economy, account: AccountRef, entries: readonly string[]) {
  for (const id of entries) {
    try {
      await economy.refund(account, id);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot refund a card charge");
    }
  }
}

/** Charges for what they asked; every charge made so far is given back if one is refused. */
async function charge(
  economy: Economy,
  account: AccountRef,
  items: readonly [PaidItem, string][],
  ref: string | null,
): Promise<{ entries: string[]; duplicate: boolean }> {
  const entries: string[] = [];
  let duplicate = false;
  try {
    for (const [item, key] of items) {
      const p = await economy.purchase(account, item, key, ref);
      entries.push(p.entry_id);
      duplicate ||= p.duplicate;
    }
  } catch (error) {
    if (!duplicate) await giveBack(economy, account, entries);
    paid(error);
  }
  return { entries, duplicate };
}

/** Their newest card, for a retry whose charge was already made. */
async function lastIssued(
  state: ApiState,
  store: MemberCardStore,
  holder: CardHolder,
): Promise<IssuedCard> {
  const card = (await todayOf(state, store, holder)).latest;
  const out = card ? issuedCard(card) : null;
  if (!out) throw new ApiError(409, NOTHING_TO_REROLL);
  return out;
}

/** What they ask for on top of a plain card. */
export interface CardOrder {
  /** A picture of her from their band, or null to let her choose. */
  pose: string | null;
  foil: boolean;
  /** The request's Idempotency-Key; each charge derives its own from it. */
  key: string;
}

/**
 * `POST /api/member/card`: a card of `view`, what the member page shows them right now, with what
 * she writes on it (`write`, run once the card is paid for; null for no words). A chosen pose and
 * a foil finish are charged first and given back if no card follows.
 */
export async function issueCard(
  state: ApiState,
  holder: CardHolder,
  view: MemberCard,
  write: () => Promise<CardWords | null>,
  order: CardOrder = { pose: null, foil: false, key: "" },
): Promise<IssuedCard> {
  const store = state.optional(MemberCardStoreKey);
  if (!store) throw ApiError.unavailable(NO_STORE);
  const { pose, foil } = order;
  if (pose !== null && !posesFor(view.affinity).includes(pose)) throw ApiError.badRequest(BAD_POSE);
  const items: [PaidItem, string][] = [];
  if (pose !== null) items.push(["card_pose", `${order.key}:pose`]);
  if (foil) items.push(["card_foil", `${order.key}:foil`]);
  const account = holder.session.account;
  const economy = state.optional(EconomyKey);
  if (items.length > 0 && !economy) throw ApiError.unavailable(NO_WALLET);
  // Nobody pays for a card the day's limit would refuse.
  if (items.length > 0 && !(await canIssue(state, holder))) throw new ApiError(429, OVER_LIMIT);
  const bought = economy && items.length > 0 ? await charge(economy, account, items, null) : null;
  if (bought?.duplicate) return lastIssued(state, store, holder);
  try {
    const words = await write();
    return await serialized(state, () =>
      issue(state, store, holder, view, words, { pose, foil, replaces: null }),
    );
  } catch (error) {
    if (economy && bought) await giveBack(economy, account, bought.entries);
    throw error;
  }
}

/**
 * `POST /api/member/card/reroll`: today's newest card, not voided, is replaced by a new one she
 * writes afresh (`card_reroll`, charged on the old serial). The old one is voided; if the new one
 * cannot be issued the charge is given back and the old one stands.
 */
export async function rerollCard(
  state: ApiState,
  holder: CardHolder,
  view: MemberCard,
  write: () => Promise<CardWords | null>,
  key: string,
): Promise<IssuedCard> {
  const store = state.optional(MemberCardStoreKey);
  if (!store) throw ApiError.unavailable(NO_STORE);
  const economy = state.optional(EconomyKey);
  if (!economy) throw ApiError.unavailable(NO_WALLET);
  const account = holder.session.account;
  const rerollable = async (): Promise<MemberCardRecord> => {
    const latest = (await todayOf(state, store, holder)).latest;
    if (!latest || Date.parse(latest.issued_at) < Date.parse(todayStart(state))) {
      throw new ApiError(409, NOTHING_TO_REROLL);
    }
    return latest;
  };
  const old = await rerollable();
  const bought = await charge(economy, account, [["card_reroll", key]], old.serial);
  if (bought.duplicate) return lastIssued(state, store, holder);
  try {
    const words = await write();
    return await serialized(state, async () => {
      // Another reroll may have got here first.
      const current = await rerollable();
      const replaces = issuedCard(current);
      if (current.serial !== old.serial || !replaces) throw new ApiError(409, NOTHING_TO_REROLL);
      const profile = state.profile();
      await store.amend(profile, current.serial, {
        ...current.snapshot,
        voided_at: toTimestamp(state.now()),
      });
      try {
        return await issue(state, store, holder, view, words, {
          pose: null,
          foil: replaces.foil,
          replaces,
        });
      } catch (error) {
        await store.amend(profile, current.serial, current.snapshot);
        throw error;
      }
    });
  } catch (error) {
    await giveBack(economy, account, bought.entries);
    throw error;
  }
}

/** Their cards for the export, newest first. */
export async function cardsOf(state: ApiState, accounts: readonly AccountRef[]) {
  const store = state.optional(MemberCardStoreKey);
  if (!store) return [];
  const records = await store.listFor(state.profile(), accounts, MAX_EXPORTED);
  return records.map(issuedCard).filter((c): c is IssuedCard => c !== null);
}

/** Deletes every card of `accounts` (forgetting); they then fail the check. */
export async function deleteCards(state: ApiState, accounts: readonly AccountRef[]) {
  const store = state.optional(MemberCardStoreKey);
  return store ? store.deleteFor(state.profile(), accounts) : 0;
}

// ---- the public check -----------------------------------------------------------------------

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // A card can be deleted: nobody may keep the answer.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** `GET /api/public/card/{serial}`. */
async function checkCard(state: ApiState, c: ApiContext): Promise<Response> {
  const wait = state.publicSide.admitCardCheck(clientKey(c));
  if (wait !== null) return tooMany(wait);
  const missing = () => answer(404, { error: NO_SUCH_CARD });
  const serial = normalizeSerial(param(c, "serial"));
  const store = state.optional(MemberCardStoreKey);
  if (serial === null || !store) return missing();
  let found: MemberCardRecord | null;
  try {
    found = await store.bySerial(state.profile(), serial);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot check a card");
    return answer(503, { error: "not available right now" });
  }
  const card = found && isJsonObject(found.snapshot) ? issuedCard(found) : null;
  return card ? answer(200, card) : missing();
}

/** The public card check; none when `[modules.api.public] enabled` is off. */
export function cardCheckRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  return [
    {
      method: "GET",
      path: "/api/public/card/:serial",
      public: true,
      handler: (c) => checkCard(state, c),
    },
  ];
}

/**
 * The card behind a serial for a page that is open to anyone (the link preview): `null` for a
 * malformed, unknown, voided or unreadable one, so nothing of it leaves.
 */
export async function publicCard(state: ApiState, input: string): Promise<IssuedCard | null> {
  const serial = normalizeSerial(input);
  const store = state.optional(MemberCardStoreKey);
  if (serial === null || !store) return null;
  try {
    const found = await store.bySerial(state.profile(), serial);
    const card = found && isJsonObject(found.snapshot) ? issuedCard(found) : null;
    return card && card.voided_at === null ? card : null;
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot read a card for its preview");
    return null;
  }
}
