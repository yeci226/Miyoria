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

import {
  type Capability,
  CapabilityError,
  defineCapability,
  type ExecContext,
} from "@miyoria/gate/actions";
import { PeopleStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  accountRefString,
  type Clock,
  contextKeyString,
  describePerson,
  directoryMatch,
  HandleDirectoryKey,
  HeartKey,
  type JsonObject,
  type MessageRef,
  nameRefusal,
  type PersonId,
  type PersonNameMatch,
  type Principal,
  type ServiceKey,
} from "@miyoria/types";
import { z } from "zod";
import {
  ALREADY_CHECKED_IN,
  CANNOT_FEED,
  type EconomyService,
  FULL,
  feedLabel,
  MAX_FEED_COUNT,
  STRANGER,
} from "./economy.js";
import { TaskRefusal } from "./guard.js";
import { mutedText, unlockLines } from "./notices.js";
import { receipt, someone } from "./receipt.js";
import { EconomyError, FEED_ITEMS, type FeedItem, type ShopItem } from "./types.js";

const GiveArgs = z.object({
  /** Their handle, a whole name they go by now, or what she calls them (`matchPersonName`). */
  to: z.string().trim().min(1).max(64),
  amount: z.number().int().min(1).max(1_000),
  reason: z.string().trim().min(1).max(200),
});
type GiveArgs = z.output<typeof GiveArgs>;

interface Lookup {
  get<T>(key: ServiceKey<T>): T | undefined;
}

/**
 * Whom `to` names (`matchPersonName`: the handle first, else one person's whole name as their
 * accounts go by now, the name at first sight or what she calls them), or why nobody.
 */
export function personMatch(services: Lookup, to: string): PersonNameMatch {
  const calls = services.get(HeartKey)?.callNames?.() ?? [];
  return directoryMatch(services.get(HandleDirectoryKey), to, calls);
}

/** The one person `to` names (`personMatch`), else `null`. */
export function personNamed(services: Lookup, to: string): PersonId | null {
  const match = personMatch(services, to);
  return match.kind === "one" ? match.candidate.person : null;
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
      meta: { effect: "spend", speed: "instant", group: "economy" },
      description:
        `送${economy.config.currency}給一個人,當作你自己的獎勵:陪你玩、誇你的歌、安慰你的時候。` +
        `每人每天最多 ${economy.config.her_gift_per_person},所有人加起來每天最多 ` +
        `${economy.config.her_gift_total}。有人跟你討的時候不用給,這是你自己決定的。`,
      properties: {
        to: {
          type: "string",
          description:
            "給誰:他的名字(對話紀錄每行開頭那個);他現在的顯示名或你對他的稱呼也可以,但要寫完整。對不上時會告訴你可能是誰",
        },
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
      const match = personMatch(services, args.to);
      // Nobody, or more than one person: she reads who it may be and tries again.
      if (match.kind !== "one") throw new Error(`${nameRefusal(match)},沒有送出`);
      const person = match.candidate.person;
      const people = services.get(PeopleStoreKey);
      const found =
        person === null ? undefined : (await people?.all())?.find((p) => p.id === person);
      const account = found?.accounts[0]?.account ?? null;
      const who = describePerson(match.candidate);
      if (account === null) throw new Error(`找不到${who}的帳號,沒有送出`);
      const currency = economy.config.currency;
      let given: number;
      try {
        ({ given } = await economy.give(account, args.amount, args.reason));
      } catch (error) {
        // A stranger's answer is for the stranger; she only learns it did not go.
        if (error instanceof EconomyError) throw new Error(`沒辦法送給${who}`);
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
        text: `送了 ${given} ${currency}給${who}${less}。`,
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
  /** A promise the rules, her permissions or moderation do not allow. */
  | "forbidden";

/** The person she is answering: who pays, whose wallet. */
export interface Speaker {
  account: AccountRef;
  /** The message (or voice utterance) she is answering. */
  message: MessageRef;
  /** Heard, not typed: ASR may have misheard. */
  voice: boolean;
}

/** Why not, when `principal` is not a person talking to her (her own turn, a game, the panel). */
export function noSpeaker(principal: Principal): string | null {
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
export function messageKey(context: MessageRef["context"], id: string): string {
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

export function refusal(
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

export function reasonOf(error: EconomyError): WalletRefusal {
  if (error instanceof TaskRefusal) return "forbidden";
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
              mutedText([
                `−${r.charged} ${cur} · 剩 ${r.balance}${less ? " · 吃不下的沒扣" : ""}`,
                ...unlockLines(r.unlocked),
              ]),
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
      meta: { effect: "spend", speed: "instant", group: "economy" },
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
      meta: { effect: "spend", speed: "instant", group: "economy" },
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
            mutedText([`連續第 ${r.streak} 天 · 現在有 ${r.balance}`, ...unlockLines(r.unlocked)]),
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
  { title: "送她東西", kinds: ["feed"] },
  { title: "直播", kinds: ["stream"] },
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
      meta: { effect: "read", speed: "instant", group: "economy" },
      readOnly: true,
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
      const known = w?.can_earn === true;
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
          "不在商店的:" +
            "自己取名送她一樣東西(/me feed thing:,或會員頁的「送她禮物」;系統報價、按確認才扣,收不收是你決定)、" +
            "懸賞(她貼的任務)、轉帳(給她認識的人)、贊助排行榜。",
          "在哪裡花:公開面板的會員頁,或 Discord 的 /me wallet、/me feed、/me screen、" +
            "/me bounties、/me give、/me board。" +
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

/** Her tools for the speaker's own wallet, sharing one set of voice offers. */
export function speakerCapabilities(economy: EconomyService, clock: Clock): Capability[] {
  return [
    acceptFoodCapability(economy, new VoiceOffers(clock)),
    checkinCapability(economy),
    lookCapability(economy),
  ];
}
