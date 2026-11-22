// Her cards (她發給你的卡) on the API: the daily card (docs/design/v5-play.md §2) issued through the
// cards plugin (`CardsKey`), and the member cards of before it, kept exactly as they were (owner
// decision: 舊卡保持原樣).
//
// * `GET /api/member/card`, `POST /api/member/card` `{ foil? }`: their latest card and what the day
//   allows, and a new daily card (routes in `member.ts`; what goes on a card is `cardView` there).
//   A daily card costs `[modules.cards] price` fish coins, the first of the day too, at most
//   `daily_cap` a day; the parts are drawn by the public odds and her expression follows the
//   relationship. Frames and the foil finish still apply; the foil is paid with the card through
//   the cards (`CardWallet.foil`). The day and the balance (for the card and its foil) are checked
//   before she is asked to write anything, so a refused card costs no model call.
// * `GET /api/public/card/{serial}`: anyone may check a code, daily or older; unknown, deleted and
//   malformed serials get the same 404. A daily card's check also lists the titles its holder made
//   public (`cards_titles.public`); a private title is never on it.
// * A card she dropped in a channel is picked up from its button (`claimDropCard`, through
//   `KeepsakesKey`): free, written like a daily card.
//
// A card holds what the member page showed, in words, the frame they chose, and on a daily card
// the parts drawn onto it: it is built field by field from the stored snapshot, so a field added to
// the snapshot stays private until named here.

import type {
  CardPart,
  CardPrices,
  IssuedCard,
  MemberCard,
  MemberCards,
  PublicCard,
} from "@miyoria/contracts/api";
import { type Economy, EconomyKey, STRANGER } from "@miyoria/economy";
import {
  CARD_TEXTS,
  type CardFace,
  type CardRecord,
  type CardRelationship,
  CardsKey,
  CardWalletKey,
  cardRelationship,
  type DailyRefusal,
  type DropRefusal,
  portraitPose,
  refusalText,
} from "@miyoria/play/cards";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { type MemberCardRecord, MemberCardStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  CurrencyKey,
  DEFAULT_CURRENCY,
  HeartKey,
  isJsonObject,
  type JsonValue,
  type PersonId,
} from "@miyoria/types";
import type { CardWords } from "./card-words.js";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { heartRows } from "./heart-rows.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";

const log = getLogger("api.card");

/** Most cards a person may be issued per local day when the cards plugin cannot say. */
export const CARDS_PER_DAY = 5;
/** Cards an export lists at most. */
const MAX_EXPORTED = 1_000;
/** Recent older cards looked at for "latest". */
const RECENT = 100;

const NO_STORE = "這個 Core 還不能發卡";
const NO_SUCH_CARD = "這張卡不存在或已經作廢";
const NO_WALLET = "錢包現在不能用";

// ---- serials --------------------------------------------------------------------------------

const MAX_SERIAL_INPUT = 64;

function formatSerial(body: string): string {
  return `MYR-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
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

// ---- cards as the API shows them --------------------------------------------------------------

const text = (v: JsonValue | undefined): string | null => (typeof v === "string" ? v : null);

function fieldsOf(v: JsonValue | undefined): IssuedCard["fields"] {
  if (!Array.isArray(v)) return [];
  const out: IssuedCard["fields"] = [];
  for (const f of v) {
    if (!isJsonObject(f)) continue;
    const label = text(f.label);
    const body = text(f.text);
    if (label !== null && body !== null) out.push({ label, text: body });
  }
  return out;
}

/** An older member card as it may leave, or `null` when the snapshot is not one. */
function olderCard(r: MemberCardRecord): IssuedCard | null {
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
    rarity: null,
    parts: [],
    expression: null,
  };
}

/** Someone she has not met reads as before: no relationship on the card at all. */
const STRANGER_TIER = "陌生人";

/** A daily card as it may leave: its words, the parts drawn onto it and her expression. */
export function dailyCard(c: CardRecord): IssuedCard {
  const r = c.relationship;
  const known = r.tier !== STRANGER_TIER;
  const parts: CardPart[] = c.parts
    .filter((p) => !p.blank)
    .map((p) => ({ id: p.id, slot: p.slot, name: p.name, rarity: p.rarity }));
  return {
    serial: c.serial,
    issued_at: c.created_at,
    name: c.face.name,
    avatar_url: c.face.avatar_url,
    number: c.face.number,
    call_name: c.face.call_name,
    relationship: known ? r.tier_label : null,
    affinity: known ? r.closeness : null,
    trust: known ? r.trust : null,
    familiarity: known ? r.familiarity : null,
    public_feeling: known ? r.public_feeling : null,
    line: c.face.line,
    stamp: c.face.stamp,
    fields: c.face.fields,
    // Her picture until the rendered one exists: the fixed portrait nearest her expression.
    pose: portraitPose(c.expression.id),
    frame: c.frame,
    foil: c.foil,
    voided_at: null,
    rarity: c.rarity,
    parts,
    expression: c.expression.name,
    kind: c.kind,
  };
}

/** Whose cards these are. */
export interface CardHolder {
  /** Only who it was issued to is read: their account, name and picture. */
  session: Pick<SessionRecord, "account" | "name" | "avatar_url">;
  /** The session account and every account of the person she knows them as. */
  accounts: readonly AccountRef[];
  person: PersonId | null;
}

/** Their newest older card that is not voided. */
async function latestOlder(state: ApiState, holder: CardHolder): Promise<IssuedCard | null> {
  const store = state.optional(MemberCardStoreKey);
  if (!store) return null;
  const recent = await store.listFor(state.profile(), holder.accounts, RECENT);
  const latest = recent.find((r) => text(r.snapshot.voided_at) === null);
  return latest ? olderCard(latest) : null;
}

/** What `item` costs and whether it is on sale, or `null` without a wallet. */
function offer(economy: Economy | undefined, item: "card_foil"): number | null {
  if (!economy) return null;
  const { price, per_day } = economy.price(item);
  return per_day > 0 ? price : null;
}

/** `GET /api/member/card`: their latest card, today's count, the prices, their coins, the pity. */
export async function memberCards(state: ApiState, holder: CardHolder): Promise<MemberCards> {
  const cards = state.optional(CardsKey);
  const economy = state.optional(EconomyKey);
  const person = holder.person;
  const newest = cards && person ? (cards.cards(person, { limit: 1 })[0] ?? null) : null;
  const latest = newest ? dailyCard(newest) : await latestOlder(state, holder);
  const prices: CardPrices = {
    card: cards ? cards.config.price : null,
    foil: offer(economy, "card_foil"),
  };
  if (!cards) {
    return { latest, today: 0, per_day: CARDS_PER_DAY, prices, balance: null, pity: null };
  }
  const per_day = cards.config.daily_cap;
  if (person === null) {
    return { latest, today: 0, per_day, prices, balance: null, pity: null };
  }
  let balance: number | null = null;
  try {
    balance =
      (await state.optional(CardWalletKey)?.balance({ person, account: holder.session.account })) ??
      null;
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot read a balance for the cards");
  }
  return {
    latest,
    today: per_day - cards.dailyLeft(person),
    per_day,
    prices,
    balance,
    pity: cards.pity(person),
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

/** What each refusal of a daily card answers with. */
const REFUSAL_STATUS: Readonly<Record<DailyRefusal["reason"], number>> = {
  daily_cap: 429,
  capped: 429,
  insufficient: 402,
  no_wallet: 503,
  no_foil: 400,
  refused: 403,
};

/** The coins' name of this profile (`[modules.economy] currency`). */
const coinsOf = (state: ApiState): string => state.optional(CurrencyKey) ?? DEFAULT_CURRENCY;

/** A refusal of the cards as the error the routes answer with. */
function refusedCard(r: DailyRefusal, currency: string): ApiError {
  // A wallet that has no balance for them will not take their coins: for the economy, someone she
  // does not know or has blocked, who are answered alike.
  if (r.reason === "refused" && r.message === CARD_TEXTS.no_wallet) {
    return new ApiError(403, STRANGER);
  }
  const status = REFUSAL_STATUS[r.reason];
  return new ApiError(status, r.reason === "no_wallet" ? NO_WALLET : refusalText(r, currency));
}

/** A card she gave them is evidence for her nightly reflection on them (`card`). Never throws. */
function cardEvidence(state: ApiState, person: PersonId, card: IssuedCard) {
  try {
    state.optional(HeartKey)?.evidence?.({
      person,
      kind: "card",
      detail: `拿到了你的第 ${card.number} 張卡片${card.rarity ? `(${card.rarity})` : ""}${card.foil ? "(閃卡)" : ""}`,
      weight: null,
      at: state.now(),
    });
  } catch (error) {
    log.warn({ err: errorMessage(error) }, "cannot record a card as evidence");
  }
}

/** What they ask for on top of a plain card. */
export interface CardOrder {
  foil: boolean;
  /** The request's Idempotency-Key. */
  key: string;
}

/** A daily card issued, and what this request took for it (nothing for a retry's answer). */
export interface IssuedDaily {
  card: IssuedCard;
  charged: number;
}

/**
 * `POST /api/member/card`: a daily card of `view`, what the member page shows them right now,
 * with what she writes on it (`write`, asked only once the day and the coins allow the card; null
 * for no words). `hidden`: someone she will not say anything about gets a stranger's card. A foil
 * finish is paid with the card, through the cards (both charges keyed by the card's serial, both
 * given back if no card follows). A retry with the same Idempotency-Key (`order.key`), after a
 * restart too, answers the card the first try made, as it was: the cards keep the key on the card,
 * and the serial and the foil ordered before the charges.
 */
export async function issueCard(
  state: ApiState,
  holder: CardHolder,
  view: MemberCard,
  write: () => Promise<CardWords | null>,
  order: CardOrder = { foil: false, key: "" },
  hidden = false,
): Promise<IssuedCard> {
  return (await issueDaily(state, holder, view, write, order, hidden)).card;
}

/** `issueCard`, with what it charged. */
export async function issueDaily(
  state: ApiState,
  holder: CardHolder,
  view: MemberCard,
  write: () => Promise<CardWords | null>,
  order: CardOrder = { foil: false, key: "" },
  hidden = false,
): Promise<IssuedDaily> {
  const cards = state.optional(CardsKey);
  if (!cards) throw ApiError.unavailable(NO_STORE);
  const person = holder.person;
  if (person === null) throw new ApiError(403, STRANGER);
  // Before the day's limit is asked: the card a retry is for may be the day's last.
  const again = cards.dailyByKey(person, order.key);
  if (again) return { card: dailyCard(again), charged: 0 };
  const account = holder.session.account;
  const payer = { person, account };
  // Nobody pays for a card the day or the wallet would refuse.
  const quote = await cards.quote(payer, order);
  if (!quote.ok) throw refusedCard(quote, coinsOf(state));
  // Her line for them goes on the card as the page shows it (nobody else named, moderation passed),
  // never as it is stored: anyone with the serial can read the card.
  const relationship: CardRelationship = hidden
    ? cardRelationship(null)
    : {
        ...cardRelationship(heartRows(state)?.get(person) ?? null),
        public_feeling: view.public_feeling,
      };
  const older = await state
    .optional(MemberCardStoreKey)
    ?.countFor(state.profile(), holder.accounts);
  const face = async (): Promise<CardFace> => {
    const words = await write();
    return {
      name: holder.session.name,
      avatar_url: holder.session.avatar_url,
      call_name: view.call_name,
      line: words?.line ?? null,
      stamp: words?.stamp ?? null,
      fields: words?.fields ?? [],
      number: (older ?? 0) + cards.count(person) + 1,
    };
  };
  const result = await cards.issueDaily(payer, face, {
    frame: await frameOf(state, account),
    foil: order.foil,
    relationship,
    key: order.key,
  });
  if (!result.ok) throw refusedCard(result, coinsOf(state));
  const card = dailyCard(result.issued.card);
  if (!result.issued.again) cardEvidence(state, person, card);
  return { card, charged: result.charged };
}

/** What a refused pick-up answers with. */
const DROP_STATUS: Readonly<Record<DropRefusal, number>> = {
  drop_gone: 404,
  drop_expired: 410,
  drop_taken: 409,
  drop_cap: 429,
  drop_skipped: 409,
  no_face: 403,
};

/**
 * Picks up the card she dropped as `drop` in a channel (docs/design/v5-play.md §6.2) for the
 * holder: free, written like a daily card of `view` (her words through `write`, asked only once
 * the drop is theirs). Someone she does not know, or will not say anything about, cannot pick one
 * up, and is answered like a stranger.
 */
export async function claimDropCard(
  state: ApiState,
  holder: CardHolder,
  view: MemberCard,
  write: () => Promise<CardWords | null>,
  drop: string,
  hidden: boolean,
): Promise<IssuedCard> {
  const cards = state.optional(CardsKey);
  if (!cards) throw ApiError.unavailable(NO_STORE);
  const person = holder.person;
  if (person === null || hidden) throw new ApiError(403, STRANGER);
  const relationship: CardRelationship = {
    ...cardRelationship(heartRows(state)?.get(person) ?? null),
    public_feeling: view.public_feeling,
  };
  const older = await state
    .optional(MemberCardStoreKey)
    ?.countFor(state.profile(), holder.accounts);
  const result = await cards.claimDrop(person, drop, async () => {
    const words = await write();
    return {
      face: {
        name: holder.session.name,
        avatar_url: holder.session.avatar_url,
        call_name: view.call_name,
        line: words?.line ?? null,
        stamp: words?.stamp ?? null,
        fields: words?.fields ?? [],
        number: (older ?? 0) + cards.count(person) + 1,
      },
      relationship,
    };
  });
  if (!result.ok) {
    const message = result.reason === "no_face" ? STRANGER : CARD_TEXTS[result.reason];
    throw new ApiError(DROP_STATUS[result.reason], message);
  }
  const card = dailyCard(result.issued.card);
  if (!result.issued.again) cardEvidence(state, person, card);
  return card;
}

/** Their cards for the export, newest first: daily cards, then the older ones. */
export async function cardsOf(
  state: ApiState,
  accounts: readonly AccountRef[],
  person: PersonId | null,
): Promise<IssuedCard[]> {
  const cards = state.optional(CardsKey);
  const daily = cards && person ? cards.cards(person, { limit: 500 }).map(dailyCard) : [];
  const store = state.optional(MemberCardStoreKey);
  const older = store ? await store.listFor(state.profile(), accounts, MAX_EXPORTED) : [];
  return [...daily, ...older.map(olderCard).filter((c): c is IssuedCard => c !== null)];
}

/** Deletes every card of theirs (forgetting), daily and older; they then fail the check. */
export async function deleteCards(
  state: ApiState,
  accounts: readonly AccountRef[],
  person: PersonId | null,
): Promise<number> {
  const cards = state.optional(CardsKey);
  const daily = cards && person ? cards.deleteCards(person) : 0;
  const store = state.optional(MemberCardStoreKey);
  return daily + (store ? await store.deleteFor(state.profile(), accounts) : 0);
}

// ---- the public check -----------------------------------------------------------------------

/** What every answer of the check carries: a card can be deleted, so nobody may keep the answer. */
const CHECK_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** The card behind a canonical serial, daily or older; `null` when there is none. */
async function bySerial(state: ApiState, serial: string): Promise<IssuedCard | null> {
  const daily = state.optional(CardsKey)?.card(serial);
  if (daily) return dailyCard(daily);
  const store = state.optional(MemberCardStoreKey);
  if (!store) return null;
  const found = await store.bySerial(state.profile(), serial);
  return found && isJsonObject(found.snapshot) ? olderCard(found) : null;
}

/**
 * The titles the holder of a daily card chose to show others (a title is theirs alone until they
 * make it public); none on an older member card, or when the cards cannot say.
 */
function shownTitles(state: ApiState, serial: string): string[] {
  const cards = state.optional(CardsKey);
  const daily = cards?.card(serial);
  if (!cards || !daily) return [];
  return cards.publicTitles(daily.person).map((t) => t.title);
}

/** `GET /api/public/card/{serial}`: the card, and its holder's public titles. */
async function checkCard(state: ApiState, c: ApiContext, input: string): Promise<PublicCard> {
  const wait = state.publicSide.admitCardCheck(state.publicSide.client(c));
  if (wait !== null) throw ApiError.tooMany(wait);
  const missing = () => new ApiError(404, NO_SUCH_CARD, CHECK_HEADERS);
  const serial = normalizeSerial(input);
  if (serial === null) throw missing();
  let card: IssuedCard | null;
  let titles: string[];
  try {
    card = await bySerial(state, serial);
    titles = card ? shownTitles(state, serial) : [];
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot check a card");
    throw new ApiError(503, "not available right now", CHECK_HEADERS);
  }
  if (!card) throw missing();
  return { ...card, titles };
}

/** `GET /api/public/card/{serial}`; served only while the public side is on (see `rpc.ts`). */
export const cardCheckRpc = {
  card: os.public.card.handler(async ({ input, context }) => {
    const card = await checkCard(context.state, context.c, input.params.serial);
    for (const [name, value] of Object.entries(CHECK_HEADERS)) context.resHeaders?.set(name, value);
    return card;
  }),
};

/**
 * The card behind a serial for a page that is open to anyone (the link preview): `null` for a
 * malformed, unknown, voided or unreadable one, so nothing of it leaves.
 */
export async function publicCard(state: ApiState, input: string): Promise<IssuedCard | null> {
  const serial = normalizeSerial(input);
  if (serial === null) return null;
  try {
    const card = await bySerial(state, serial);
    return card && card.voided_at === null ? card : null;
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot read a card for its preview");
    return null;
  }
}
