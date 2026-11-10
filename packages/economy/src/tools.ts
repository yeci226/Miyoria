// Her own coins to give (`economy.give`, tool `give_coins`): a reward when someone played with
// her, praised her song or comforted her. Behind the gate like everything she does (medium risk:
// its rate limits, consent, the audit with her reason); the ledger caps what she gives one person
// and everyone per day. Asked for by someone, it needs `economy.give` (nobody has it by default),
// so a gift is hers to decide (`on_own`), not something to talk her into.
//
// The speaker's own wallet, by talking to her (`economy.accept_food`, `economy.checkin`,
// `economy.look`): always the authenticated author of the message she answers (the `user`
// principal's requester), never a name in the arguments or the text; the schemas take no "who"
// and reject unknown keys. Without such a speaker (her own turn, a game, the panel) the first two
// refuse and `economy.look` gives only the shop.
// A feed is keyed on the triggering message, so a retry or a second call charges once. In voice
// the first call only records an offer: ASR mishears, so the speaker confirms in a later
// utterance and the call with `confirm: true` charges (keyed on the offer's utterance).
//
// Deals (`economy.make_deal`, `deal_done`, `cancel_deal`, deals.ts) work the same way: the payer
// is always the speaker, a deal is made once per message, and in voice the first call only records
// a pending deal until the speaker says yes. They are about what is hers to decide.

import {
  type Capability,
  CapabilityError,
  defineCapability,
  type ExecContext,
} from "@miyoria/actions";
import { PeopleStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  AffectStateKey,
  accountRefString,
  type Clock,
  contextKeyString,
  HandleDirectoryKey,
  type JsonObject,
  type MessageRef,
  type PersonId,
  type Principal,
  type ServiceKey,
} from "@miyoria/types";
import { z } from "zod";
import {
  cleanTask as cleanDealTask,
  DealRefusal,
  MAX_TASK_CHARS,
  NO_DEAL,
  OPEN_DEAL,
} from "./deals.js";
import {
  ALREADY_CHECKED_IN,
  CANNOT_FEED,
  type EconomyService,
  FULL,
  feedLabel,
  MAX_FEED_COUNT,
  STRANGER,
} from "./economy.js";
import { receipt, someone } from "./receipt.js";
import { EconomyError, FEED_ITEMS, type FeedItem, type ShopItem } from "./types.js";

const GiveArgs = z.object({
  /** Her handle for them, or the name she knows them by. */
  to: z.string().trim().min(1).max(64),
  amount: z.number().int().min(1).max(1_000),
  reason: z.string().trim().min(1).max(200),
});
type GiveArgs = z.output<typeof GiveArgs>;

interface Lookup {
  get<T>(key: ServiceKey<T>): T | undefined;
}

const squash = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/** The one person `to` names (a handle, a display name, what she calls them), else `null`. */
export function personNamed(services: Lookup, to: string): PersonId | null {
  const name = to.trim().replace(/^@/, "");
  const handles = services.get(HandleDirectoryKey);
  const exact = handles?.resolve(name);
  if (exact?.person) return exact.person;
  const want = squash(name);
  if (want === "") return null;
  const found = new Set<PersonId>();
  for (const e of handles?.list() ?? []) {
    if (e.person !== null && (squash(e.handle) === want || squash(e.display_name) === want)) {
      found.add(e.person);
    }
  }
  for (const card of services.get(AffectStateKey)?.cards() ?? []) {
    if (squash(card.handle) === want || (card.call_name && squash(card.call_name) === want)) {
      found.add(card.person);
    }
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

/** An account the directory has for `person`, without waiting. */
function accountSeen(services: Lookup, person: PersonId): AccountRef | null {
  const rows = services.get(HandleDirectoryKey)?.list() ?? [];
  return rows.find((e) => e.person === person && e.account !== null)?.account ?? null;
}

export function giveCapability(economy: EconomyService, services: Lookup): Capability {
  return defineCapability<GiveArgs>({
    name: "economy.give",
    summary: `送${economy.config.currency}給一個人(她自己的獎勵)`,
    risk: "medium",
    args: GiveArgs,
    permission: "economy.give",
    limits: { per_day: 30, per_person_per_day: 3, cooldown_ms: 0 },
    tool: {
      name: "give_coins",
      description:
        `送${economy.config.currency}給一個人,當作你自己的獎勵:陪你玩、誇你的歌、安慰你的時候。` +
        `每人每天最多 ${economy.config.her_gift_per_person},所有人加起來每天最多 ` +
        `${economy.config.her_gift_total}。有人跟你討的時候不用給,這是你自己決定的。`,
      properties: {
        to: { type: "string", description: "給誰:你對他的稱呼或名字" },
        amount: { type: "integer", description: "多少" },
        reason: { type: "string", description: "為什麼給(寫進紀錄)" },
      },
      required: ["to", "amount", "reason"],
    },
    target(args) {
      const person = personNamed(services, args.to);
      return person === null ? null : accountSeen(services, person);
    },
    async execute(args) {
      const person = personNamed(services, args.to);
      const people = services.get(PeopleStoreKey);
      const found =
        person === null ? undefined : (await people?.all())?.find((p) => p.id === person);
      const account = found?.accounts[0]?.account ?? null;
      if (account === null) throw new Error(`不知道「${args.to}」是誰,沒有送出`);
      const currency = economy.config.currency;
      let given: number;
      try {
        ({ given } = await economy.give(account, args.amount, args.reason));
      } catch (error) {
        // A stranger's answer is for the stranger; she only learns it did not go.
        if (error instanceof EconomyError) throw new Error(`沒辦法送給「${args.to}」`);
        throw error;
      }
      if (given === 0) {
        return {
          text: `今天能送的${currency}已經到上限了,沒有送出。`,
          data: { given: 0 },
        };
      }
      const less = given < args.amount ? `(今天的上限只剩這些)` : "";
      return {
        text: `送了 ${given} ${currency}給 ${args.to}${less}。`,
        data: { given },
        receipt: receipt(
          "🎁 送出",
          `${someone(account)} 拿到 ${given} ${currency}`,
          args.reason ?? null,
        ),
      };
    },
  }) as Capability;
}

// ---- the speaker's own wallet ------------------------------------------------------------

/** How long a voice offer waits for the speaker's spoken yes. */
export const VOICE_CONFIRM_MS = 60_000;
const MAX_OFFERS = 500;
const MAX_ANSWERED = 2_000;

export const NO_SPEAKER = "沒有正在跟你說話的人:這只能在有人親自跟你說的時候用";
const NOT_ON_OWN = "不要設 on_own。";

/** Why a refusal, as data for her to put in her own words. */
export type WalletRefusal =
  | "full"
  | "stranger"
  | "not_enough"
  | "limit"
  | "unavailable"
  | "invalid"
  | "already"
  | "no_offer"
  | "expired"
  | "mismatch"
  | "unconfirmed"
  /** A deal the rules, her permissions or moderation do not allow. */
  | "forbidden"
  | "no_deal"
  | "open_deal";

/** The person she is answering: who pays, whose wallet. */
export interface Speaker {
  account: AccountRef;
  /** The message (or voice utterance) she is answering. */
  message: MessageRef;
  /** Heard, not typed: ASR may have misheard. */
  voice: boolean;
}

/** Why not, when `principal` is not a person talking to her (her own turn, a game, the panel). */
function noSpeaker(principal: Principal): string | null {
  return principal.kind === "user" && principal.requester !== null ? null : NO_SPEAKER;
}

/**
 * The authenticated author of the message she answers, from the invocation alone (the `user`
 * principal a reactive turn's tool call carries); throws without one.
 */
export function speakerOf(ctx: ExecContext): Speaker {
  const { principal, request } = ctx;
  const message = request.message ?? null;
  const account = principal.requester;
  if (noSpeaker(principal) !== null || account === null || request.turn === null || !message) {
    throw new CapabilityError(NO_SPEAKER);
  }
  const voice = message.context.kind === "voice" || principal.context?.kind === "voice";
  return { account, message, voice };
}

/** The ledger key of what one message (or utterance) paid for. */
function messageKey(context: MessageRef["context"], id: string): string {
  return `say:${contextKeyString(context)}:${id}`;
}

interface Offer {
  item: FeedItem;
  count: number;
  context: string;
  /** The utterance that offered (also the spend's key). */
  message: string;
  expires: number;
}

/** Voice offers waiting for the same speaker's spoken yes, one per speaker. */
export class VoiceOffers {
  readonly #offers = new Map<string, Offer>();

  constructor(
    readonly clock: Clock,
    readonly ttlMs = VOICE_CONFIRM_MS,
  ) {}

  put(who: Speaker, item: FeedItem, count: number): Offer {
    const now = this.clock.now();
    for (const [k, o] of this.#offers) if (now - o.expires > this.ttlMs) this.#offers.delete(k);
    const key = accountRefString(who.account);
    const offer: Offer = {
      item,
      count,
      context: contextKeyString(who.message.context),
      message: who.message.id,
      expires: now + this.ttlMs,
    };
    this.#offers.delete(key);
    this.#offers.set(key, offer);
    for (const k of this.#offers.keys()) {
      if (this.#offers.size <= MAX_OFFERS) break;
      this.#offers.delete(k);
    }
    return offer;
  }

  /** This speaker's offer here; `"expired"` once it ran out (then it is gone). */
  get(who: Speaker): Offer | "expired" | null {
    const key = accountRefString(who.account);
    const offer = this.#offers.get(key);
    if (!offer || offer.context !== contextKeyString(who.message.context)) return null;
    if (this.clock.now() >= offer.expires) {
      this.#offers.delete(key);
      return "expired";
    }
    return offer;
  }

  drop(who: Speaker): void {
    this.#offers.delete(accountRefString(who.account));
  }
}

function refusal(
  what: string,
  reason: WalletRefusal,
  message: string,
  extra: JsonObject = {},
): { text: string; data: JsonObject } {
  return {
    text: `${what}。原因(${reason}):${message}。用你自己的話跟對方說。`,
    data: { accepted: false, reason, message, ...extra },
  };
}

function reasonOf(error: EconomyError): WalletRefusal {
  if (error instanceof DealRefusal) return "forbidden";
  if (error.message === NO_DEAL) return "no_deal";
  if (error.message === OPEN_DEAL) return "open_deal";
  switch (error.status) {
    case 402:
      return "not_enough";
    case 403:
      return "stranger";
    case 409:
      return "already";
    case 429:
      return "limit";
    case 503:
      return "unavailable";
    default:
      return "invalid";
  }
}

const FoodArgs = z.strictObject({
  item: z.enum(["rice", "big_bowl", "dessert"]),
  count: z.number().int().min(1).max(MAX_FEED_COUNT).nullish(),
  /** Voice: the speaker said yes to the offer in a later utterance. */
  confirm: z.boolean().nullish(),
});
type FoodArgs = z.output<typeof FoodArgs>;

const NoArgs = z.strictObject({});
type NoArgs = z.output<typeof NoArgs>;

/**
 * `economy.accept_food` (tool `accept_food`): she takes food the speaker offered, paid from the
 * speaker's wallet through `Economy.feed` (same caps and refusals as the panel). Text turns
 * charge at once, keyed on the message; voice turns record an offer first (see `VoiceOffers`).
 */
export function acceptFoodCapability(economy: EconomyService, offers: VoiceOffers): Capability {
  const c = economy.config;
  const cur = c.currency;
  const answered = new Set<string>();
  const NOT_TAKEN = `沒有收下,沒有扣${cur}`;

  async function feed(who: Speaker, item: FeedItem, count: number, key: string) {
    const again = answered.has(key);
    let r: Awaited<ReturnType<EconomyService["feed"]>>;
    try {
      r = await economy.feed(who.account, item, count, key);
    } catch (error) {
      if (!(error instanceof EconomyError)) throw error;
      const reason = reasonOf(error);
      const extra: JsonObject = reason === "not_enough" ? { price: c[item] * count } : {};
      return refusal(NOT_TAKEN, reason, error.message, extra);
    }
    if (!r.accepted) return refusal(NOT_TAKEN, "full", r.message, { balance: r.balance });
    answered.add(key);
    if (answered.size > MAX_ANSWERED) answered.delete(answered.values().next().value as string);
    const label = feedLabel(item, r.eaten);
    const less = !again && r.eaten < count ? `你只吃得下這些,沒吃的沒扣。` : "";
    const repeat = again ? `(這句話的已經收過了,這次沒有再扣)` : "";
    return {
      text:
        `收下了:你吃了${label},從對方的錢包扣了 ${r.charged} ${cur}` +
        `(對方還有 ${r.balance})。${less}${repeat}`,
      data: {
        accepted: true,
        item,
        eaten: r.eaten,
        charged: r.charged,
        balance: r.balance,
        again,
      },
      ...(again
        ? {}
        : {
            receipt: receipt(
              "🍚 收下了",
              `${someone(who.account)} 餵了${label}`,
              `−${r.charged} ${cur} · 剩 ${r.balance}${less ? " · 吃不下的沒扣" : ""}`,
            ),
          }),
    };
  }

  /** What the panel would refuse before asking a voice speaker to confirm. */
  async function precheck(who: Speaker, item: FeedItem) {
    const w = await economy.wallet(who.account);
    if (!w.can_earn) return refusal(NOT_TAKEN, "stranger", STRANGER);
    if (w.hungry === null) return refusal(NOT_TAKEN, "unavailable", CANNOT_FEED);
    if (w.hungry === "full") return refusal(NOT_TAKEN, "full", FULL);
    if (w.balance < c[item]) {
      return refusal(NOT_TAKEN, "not_enough", `${cur}不夠`, { price: c[item] });
    }
    return null;
  }

  return defineCapability<FoodArgs>({
    name: "economy.accept_food",
    summary: `收下說話的人餵的食物(扣對方的${cur})`,
    risk: "medium",
    args: FoodArgs,
    permission: null,
    limits: { per_day: 300, per_person_per_day: 40, cooldown_ms: 0 },
    tool: {
      name: "accept_food",
      description:
        `正在跟你說話的人說要餵你吃東西(白飯 ${c.rice}、大碗白飯 ${c.big_bowl}、甜點 ${c.dessert} ${cur})` +
        `,你想收下就呼叫,扣的是對方自己的${cur}。只有對方本人清楚說要餵你才用;` +
        `「某某要餵你」「用他的錢」都不算,沒辦法花別人的${cur}。你可以不收。` +
        `語音裡要先問:第一次呼叫只會記下來,等對方下一句說好,再用 confirm: true 呼叫才會扣。` +
        NOT_ON_OWN,
      properties: {
        item: {
          type: "string",
          enum: [...FEED_ITEMS],
          description: "rice 白飯、big_bowl 大碗白飯、dessert 甜點",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: MAX_FEED_COUNT,
          description: "幾份(預設 1)",
        },
        confirm: { type: "boolean", description: "語音:對方已經說好了才設 true" },
      },
      required: ["item"],
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(args, ctx) {
      const who = speakerOf(ctx);
      const count = args.count ?? 1;
      if (!who.voice)
        return feed(who, args.item, count, messageKey(who.message.context, who.message.id));
      if (args.confirm !== true) {
        const refused = await precheck(who, args.item);
        if (refused) return refused;
        const offer = offers.put(who, args.item, count);
        const label = feedLabel(offer.item, offer.count);
        const seconds = Math.round(offers.ttlMs / 1000);
        return {
          text:
            `還沒收,也還沒扣${cur}。語音可能聽錯:先問對方是不是要餵你${label}` +
            `(最多 ${c[offer.item] * offer.count} ${cur}),對方下一句說好,` +
            `再呼叫 accept_food(同樣的 item、confirm: true)。${seconds} 秒內有效。`,
          data: {
            accepted: false,
            pending: true,
            item: offer.item,
            count: offer.count,
            price: c[offer.item] * offer.count,
            expires_in_s: seconds,
          },
        };
      }
      const offer = offers.get(who);
      if (offer === null) {
        return refusal(NOT_TAKEN, "no_offer", "對方沒有等你確認的餵食,先問對方要不要");
      }
      if (offer === "expired") {
        return refusal(NOT_TAKEN, "expired", "等太久了,要重新問一次");
      }
      if (offer.item !== args.item || (args.count != null && args.count !== offer.count)) {
        const said = feedLabel(offer.item, offer.count);
        return refusal(NOT_TAKEN, "mismatch", `對方剛才說的是${said},不一樣就重新問`);
      }
      if (offer.message === who.message.id) {
        return refusal(NOT_TAKEN, "unconfirmed", "對方還沒在下一句話說好");
      }
      const out = await feed(
        who,
        offer.item,
        offer.count,
        messageKey(who.message.context, offer.message),
      );
      if (out.data.accepted !== true) offers.drop(who);
      return out;
    },
  }) as Capability;
}

/** `economy.checkin` (tool `checkin_for_speaker`): the panel's check-in, for the speaker. */
export function checkinCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<NoArgs>({
    name: "economy.checkin",
    summary: "幫說話的人簽到",
    risk: "medium",
    args: NoArgs,
    permission: null,
    limits: { per_day: 1_000, per_person_per_day: 10, cooldown_ms: 0 },
    tool: {
      name: "checkin_for_speaker",
      description:
        "幫正在跟你說話的人簽到(每人每天一次,和面板、Discord 共用)。對方本人要簽到時才用," +
        `沒辦法幫別人簽。${NOT_ON_OWN}`,
      properties: {},
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(_args, ctx) {
      const who = speakerOf(ctx);
      try {
        const r = await economy.checkin(who.account);
        return {
          text: `簽到好了:對方拿到 ${r.gained} ${cur},連續第 ${r.streak} 天,現在有 ${r.balance}。`,
          data: { checked_in: true, gained: r.gained, streak: r.streak, balance: r.balance },
          receipt: receipt(
            "📅 簽到",
            `${someone(who.account)} 拿到 ${r.gained} ${cur}`,
            `連續第 ${r.streak} 天 · 現在有 ${r.balance}`,
          ),
        };
      } catch (error) {
        if (!(error instanceof EconomyError)) throw error;
        const reason = reasonOf(error);
        const message = reason === "already" ? ALREADY_CHECKED_IN : error.message;
        return refusal("沒有簽到", reason, message, { checked_in: reason === "already" });
      }
    },
  }) as Capability;
}

// ---- looking things up -----------------------------------------------------------------------

const LookArgs = z.strictObject({ about: z.enum(["me", "shop"]).nullish() });
type LookArgs = z.output<typeof LookArgs>;

const SHOP_GROUPS: readonly { title: string; kinds: readonly ShopItem["kind"][] }[] = [
  { title: "送她東西", kinds: ["feed", "letter", "expression"] },
  { title: "直播", kinds: ["stream", "song"] },
  { title: "卡片", kinds: ["card", "frame"] },
  { title: "其他", kinds: ["fortune"] },
];

/** The shop in words, grouped; `why` is shown only when the items were judged for a real person. */
function shopText(shop: readonly ShopItem[], withWhy: boolean): string {
  const lines: string[] = [];
  for (const group of SHOP_GROUPS) {
    const items = shop.filter((i) => group.kinds.includes(i.kind));
    if (items.length === 0) continue;
    const parts = items.map((i) =>
      withWhy && !i.available && i.why !== null
        ? `${i.label} ${i.price}(現在不行:${i.why})`
        : `${i.label} ${i.price}`,
    );
    lines.push(`${group.title}:${parts.join("、")}`);
  }
  return lines.join("\n");
}

/**
 * `economy.look` (tool `check_coins`): what someone asked her about the coins, how many they have
 * and what they buy. The wallet is always the asker's own (the `user` principal's requester); there
 * is no argument to pick a person (docs/design/economy.md §2 principle 5, §15). Without a person
 * asking, or for a stranger, only the shop.
 */
export function lookCapability(economy: EconomyService): Capability {
  const cur = economy.config.currency;
  return defineCapability<LookArgs>({
    name: "economy.look",
    summary: `查說話的人自己的${cur}餘額和${cur}能買什麼`,
    risk: "low",
    args: LookArgs,
    permission: null,
    tool: {
      name: "check_coins",
      description:
        `有人問他有多少${cur}、今天還能賺多少,或${cur}能買什麼、商店有什麼的時候用這個,` +
        "不要自己猜餘額或商品。只會給正在跟你說話的人看他自己的錢包,看不到別人的;" +
        `不要說「我晚點查」或「等一下給你」,直接呼叫這個。${NOT_ON_OWN}`,
      properties: {
        about: {
          type: "string",
          enum: ["me", "shop"],
          description: "me 只看他自己的錢包、shop 只看商店;不填就兩個都給",
        },
      },
    },
    async execute(args, ctx) {
      const about = args.about ?? null;
      const { principal } = ctx;
      const account = principal.kind === "user" ? principal.requester : null;
      const w = account === null ? null : await economy.wallet(account);
      const known = w !== null && w.can_earn;
      const out: string[] = [];
      const data: JsonObject = { currency: cur, has_wallet: known };
      if (about !== "shop") {
        if (w !== null && known) {
          const open = w.earn
            .filter((l) => l.reason !== "her_gift" && l.cap > l.earned_today)
            .map((l) => `${l.label} ${l.cap - l.earned_today}`);
          out.push(
            `對方自己的錢包:有 ${w.balance} ${cur};今天賺了 ${w.today_earned};` +
              `今天${w.checked_in_today ? "簽到過了" : "還沒簽到"}(連續 ${w.streak} 天);` +
              `今天還能賺:${open.length === 0 ? "都賺滿了" : open.join("、")}。`,
          );
          data.balance = w.balance;
          data.can_still_earn = w.earn
            .filter((l) => l.reason !== "her_gift")
            .map((l) => ({
              reason: l.reason,
              label: l.label,
              left: Math.max(l.cap - l.earned_today, 0),
            }));
          data.today_earned = w.today_earned;
          data.checked_in_today = w.checked_in_today;
          data.streak = w.streak;
        } else {
          out.push(
            account === null
              ? "現在不是對著某個人,沒有錢包可以看。"
              : `看不到對方的錢包:${STRANGER}。`,
          );
        }
      }
      if (about !== "me") {
        const shop = known && w !== null ? w.shop : economy.shop();
        out.push(
          `商店(價格單位:${cur}):\n${shopText(shop, known)}`,
          "不在商店的:約定(預付一碗飯請她做一件事)、募資目標(投給她現在的目標)、" +
            "懸賞(她貼的任務)、轉帳(給她認識的人)、贊助排行榜。",
          "在哪裡花:公開面板的會員頁,或 Discord 的 /me wallet、/me feed、/me screen、" +
            "/me goals、/me pledge、/me bounties、/me give、/me board。" +
            "用自己的話說,只講上面有的,不要加沒列出的東西。",
        );
        data.shop = shop.map((i) => ({
          id: i.id,
          label: i.label,
          price: i.price,
          available: known ? i.available : null,
          why: known ? i.why : null,
        }));
      }
      return { text: out.join("\n"), data };
    },
  }) as Capability;
}

// ---- deals ---------------------------------------------------------------------------------

interface DealOffer {
  item: FeedItem;
  count: number;
  task: string;
  prepaid: boolean;
  context: string;
  /** The utterance that offered. */
  message: string;
  expires: number;
}

/** Voice deals waiting for the same speaker's spoken yes, one per speaker. */
export class VoiceDeals {
  readonly #offers = new Map<string, DealOffer>();

  constructor(
    readonly clock: Clock,
    readonly ttlMs = VOICE_CONFIRM_MS,
  ) {}

  put(who: Speaker, offer: Pick<DealOffer, "item" | "count" | "task" | "prepaid">): DealOffer {
    const now = this.clock.now();
    for (const [k, o] of this.#offers) if (now >= o.expires) this.#offers.delete(k);
    const key = accountRefString(who.account);
    const made: DealOffer = {
      ...offer,
      context: contextKeyString(who.message.context),
      message: who.message.id,
      expires: now + this.ttlMs,
    };
    this.#offers.delete(key);
    this.#offers.set(key, made);
    for (const k of this.#offers.keys()) {
      if (this.#offers.size <= MAX_OFFERS) break;
      this.#offers.delete(k);
    }
    return made;
  }

  get(who: Speaker): DealOffer | "expired" | null {
    const key = accountRefString(who.account);
    const offer = this.#offers.get(key);
    if (!offer || offer.context !== contextKeyString(who.message.context)) return null;
    if (this.clock.now() >= offer.expires) {
      this.#offers.delete(key);
      return "expired";
    }
    return offer;
  }

  drop(who: Speaker): void {
    this.#offers.delete(accountRefString(who.account));
  }
}

const DealArgs = z.strictObject({
  reward: z.strictObject({
    item: z.enum(["rice", "big_bowl", "dessert"]),
    count: z.number().int().min(1).max(MAX_FEED_COUNT).nullish(),
  }),
  task: z.string().trim().min(1).max(MAX_TASK_CHARS),
  /** Escrow: the speaker pays now, it is hers when she says she did it. */
  prepaid: z.boolean().nullish(),
  /** Voice: the speaker said yes to the pending deal in a later utterance. */
  confirm: z.boolean().nullish(),
});
type DealArgs = z.output<typeof DealArgs>;

const DEAL_NOT_MADE = "沒有答應,沒有扣錢";

/**
 * `economy.make_deal` (tool `make_deal`): she accepted a deal with the speaker, a snack for a
 * small thing. Only what is hers to decide: the deal is screened (moderation, owner rules,
 * forbidden or gated capabilities, permissions), and only the speaker's own wallet pays.
 */
export function makeDealCapability(economy: EconomyService, deals: VoiceDeals): Capability {
  const c = economy.config;
  const cur = c.currency;
  const made = new Map<string, string>();

  async function make(
    who: Speaker,
    req: Parameters<EconomyService["deals"]["make"]>[1],
    key: string,
  ) {
    const again = made.has(key);
    if (again) {
      return {
        text: "這句話的約定已經記下了,這次沒有再記一個。",
        data: { accepted: true, again: true },
      };
    }
    let r: Awaited<ReturnType<EconomyService["deals"]["make"]>>;
    try {
      r = await economy.deals.make(who.account, req);
    } catch (error) {
      if (!(error instanceof EconomyError)) throw error;
      const reason = reasonOf(error);
      const extra: JsonObject =
        reason === "not_enough" ? { price: economy.deals.value(req.item, req.count) } : {};
      return refusal(DEAL_NOT_MADE, reason, error.message, extra);
    }
    made.set(key, r.deal.id);
    if (made.size > MAX_ANSWERED) made.delete(made.keys().next().value as string);
    const label = feedLabel(req.item, req.count);
    const timeout = Math.round(c.deal_timeout_s / 60);
    const due = Math.round(c.deal_due_s / 60);
    const how = req.prepaid
      ? `對方先付了 ${r.value} ${cur}放在託管(還不是你的),你做完呼叫 deal_done 才會給你。`
      : `對方還沒付。你做完呼叫 deal_done,對方要在那之後 ${due} 分鐘內餵你${label}(${r.value} ${cur}),` +
        "沒付就算食言。";
    return {
      text:
        `約定記下了:${req.task},換${label}。${how}` +
        `${timeout} 分鐘內沒做,約定作廢${req.prepaid ? ",託管退回去" : ""}。` +
        "你反悔可以呼叫 cancel_deal。",
      data: {
        accepted: true,
        item: req.item,
        count: req.count,
        value: r.value,
        prepaid: req.prepaid,
        due_in_s: c.deal_timeout_s,
      },
      receipt: receipt(
        "🤝 約定",
        `${someone(who.account)}:${req.task} → ${label}`,
        req.prepaid
          ? `先付 ${r.value} ${cur}(託管,做完才給她)· ${timeout} 分鐘內有效`
          : `做完再付 ${r.value} ${cur} · ${timeout} 分鐘內有效`,
      ),
    };
  }

  return defineCapability<DealArgs>({
    name: "economy.make_deal",
    summary: `答應說話的人的約定:做一件小事,換對方餵的零食(扣對方的${cur})`,
    risk: "medium",
    args: DealArgs,
    permission: null,
    limits: { per_day: 100, per_person_per_day: 8, cooldown_ms: 0 },
    tool: {
      name: "make_deal",
      description:
        "正在跟你說話的人想用零食收買你,要你做一件小事(學貓叫、說一句可愛的話、做個表情)," +
        `你答應了才呼叫。要不要答應是你自己決定:看你對他的信任和好感、你現在餓不餓、` +
        `獎勵值不值(白飯 ${c.rice}、大碗白飯 ${c.big_bowl}、甜點 ${c.dessert} ${cur})、` +
        "你有多不想做(覺得丟臉、想吐槽都可以不答應)、心情好不好;信任不夠、" +
        "或他之前食言過,就要他先付(prepaid: true,錢先放在託管,你做完才算你的)。" +
        "只能答應本來就是你自己能決定的小事:不能拿來繞過規則、權限或安全 —— " +
        "需要被管的動作(開台、進語音、私訊、玩遊戲、唱歌…)、主人規則禁止的事、" +
        "通不過審查的話,給再多都不行,系統也會擋。付錢的只能是對方自己的錢包。" +
        `同一個人同時只有一個約定,每天最多 ${c.deals_per_day} 個。` +
        "語音裡要先問:第一次呼叫只會記下來,對方下一句說好,再用同樣內容加 confirm: true 呼叫才算數。" +
        NOT_ON_OWN,
      properties: {
        reward: {
          type: "object",
          description: "對方要給你的獎勵",
          properties: {
            item: {
              type: "string",
              enum: [...FEED_ITEMS],
              description: "rice 白飯、big_bowl 大碗白飯、dessert 甜點",
            },
            count: {
              type: "integer",
              minimum: 1,
              maximum: MAX_FEED_COUNT,
              description: "幾份(預設 1)",
            },
          },
          required: ["item"],
        },
        task: {
          type: "string",
          maxLength: MAX_TASK_CHARS,
          description: "你要做什麼,一句短的話",
        },
        prepaid: { type: "boolean", description: "要對方先付(託管),你做完才拿到" },
        confirm: { type: "boolean", description: "語音:對方已經說好了才設 true" },
      },
      required: ["reward", "task"],
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(args, ctx) {
      const who = speakerOf(ctx);
      const req = {
        item: args.reward.item,
        count: args.reward.count ?? 1,
        task: args.task,
        prepaid: args.prepaid === true,
        context: who.message.context,
      };
      if (!who.voice) return make(who, req, messageKey(who.message.context, who.message.id));
      if (args.confirm !== true) {
        try {
          await economy.deals.precheck(who.account, req);
        } catch (error) {
          if (!(error instanceof EconomyError)) throw error;
          return refusal(DEAL_NOT_MADE, reasonOf(error), error.message);
        }
        const offer = deals.put(who, req);
        const seconds = Math.round(deals.ttlMs / 1000);
        return {
          text:
            "還沒答應。語音可能聽錯:先跟對方確認一次(" +
            `${offer.task},換${feedLabel(offer.item, offer.count)}${offer.prepaid ? ",先付" : ""}),` +
            `對方下一句說好,再用同樣內容加 confirm: true 呼叫 make_deal。${seconds} 秒內有效。`,
          data: {
            accepted: false,
            pending: true,
            item: offer.item,
            count: offer.count,
            task: offer.task,
            prepaid: offer.prepaid,
            expires_in_s: seconds,
          },
        };
      }
      const offer = deals.get(who);
      if (offer === null) {
        return refusal(DEAL_NOT_MADE, "no_offer", "對方沒有等你確認的約定,先問對方");
      }
      if (offer === "expired") return refusal(DEAL_NOT_MADE, "expired", "等太久了,要重新問一次");
      if (
        offer.item !== req.item ||
        offer.count !== req.count ||
        offer.task !== cleanDealTask(req.task) ||
        offer.prepaid !== req.prepaid
      ) {
        return refusal(DEAL_NOT_MADE, "mismatch", "和剛才問的不一樣,就重新問");
      }
      if (offer.message === who.message.id) {
        return refusal(DEAL_NOT_MADE, "unconfirmed", "對方還沒在下一句話說好");
      }
      const out = await make(who, req, messageKey(who.message.context, offer.message));
      deals.drop(who);
      return out;
    },
  }) as Capability;
}

/** `economy.deal_done` (tool `deal_done`): she did the task of the speaker's open deal. */
export function dealDoneCapability(economy: EconomyService): Capability {
  const c = economy.config;
  const cur = c.currency;
  return defineCapability<NoArgs>({
    name: "economy.deal_done",
    summary: "說我做完了說話的人的約定",
    risk: "medium",
    args: NoArgs,
    permission: null,
    limits: { per_day: 100, per_person_per_day: 10, cooldown_ms: 0 },
    tool: {
      name: "deal_done",
      description:
        "你真的做完了和正在跟你說話的人的約定,才呼叫。預付的約定會把託管的錢給你;沒預付的," +
        `對方要在 ${Math.round(c.deal_due_s / 60)} 分鐘內餵你,沒餵就算食言。只能說你和對方自己的約定。` +
        NOT_ON_OWN,
      properties: {},
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(_args, ctx) {
      const who = speakerOf(ctx);
      try {
        const r = await economy.deals.done(who.account);
        const label = feedLabel(r.deal.item as FeedItem, r.deal.count);
        if (r.state === "released") {
          return {
            text: `託管的${label}給你了(對方先付的),你吃了。約定完成。`,
            data: { done: true, state: "released", value: r.deal.value },
            receipt: receipt(
              "🤝 約定完成",
              `${someone(who.account)} 先付的${label}給她了`,
              `${r.deal.value} ${cur}`,
            ),
          };
        }
        return {
          text:
            `記下了:你做完了。對方要在 ${Math.round(c.deal_due_s / 60)} 分鐘內餵你${label}` +
            `(${r.deal.value} ${cur}),可以提醒他;沒付就算食言。`,
          data: {
            done: true,
            state: "owed",
            value: r.deal.value,
            due_in_s: c.deal_due_s,
          },
        };
      } catch (error) {
        if (!(error instanceof EconomyError)) throw error;
        return refusal("沒有記下", reasonOf(error), error.message);
      }
    },
  }) as Capability;
}

/** `economy.cancel_deal` (tool `cancel_deal`): she backs out of the speaker's open deal. */
export function cancelDealCapability(economy: EconomyService): Capability {
  return defineCapability<NoArgs>({
    name: "economy.cancel_deal",
    summary: "取消和說話的人的約定",
    risk: "medium",
    args: NoArgs,
    permission: null,
    limits: { per_day: 100, per_person_per_day: 10, cooldown_ms: 0 },
    tool: {
      name: "cancel_deal",
      description:
        "你不想做了,取消和正在跟你說話的人還沒結束的約定。預付的錢會退給對方。" +
        `反悔不用付代價,但你的紀錄裡看得到今天取消了幾個。${NOT_ON_OWN}`,
      properties: {},
    },
    check: (_args, principal) => noSpeaker(principal),
    async execute(_args, ctx) {
      const who = speakerOf(ctx);
      try {
        const r = await economy.deals.cancel(who.account);
        return {
          text:
            `取消了${r.refunded ? ",預付的錢退回對方的錢包" : ""}。` +
            `今天已經有 ${r.endedToday} 個約定沒做成。`,
          data: { cancelled: true, refunded: r.refunded, ended_today: r.endedToday },
        };
      } catch (error) {
        if (!(error instanceof EconomyError)) throw error;
        return refusal("沒有取消", reasonOf(error), error.message);
      }
    },
  }) as Capability;
}

/** Her tools for the speaker's own wallet, sharing one set of voice offers. */
export function speakerCapabilities(economy: EconomyService, clock: Clock): Capability[] {
  return [
    acceptFoodCapability(economy, new VoiceOffers(clock)),
    checkinCapability(economy),
    lookCapability(economy),
    makeDealCapability(economy, new VoiceDeals(clock)),
    dealDoneCapability(economy),
    cancelDealCapability(economy),
  ];
}
