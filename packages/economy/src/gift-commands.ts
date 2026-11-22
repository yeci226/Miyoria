// Free-form gifts in Discord (docs/design/economy.md §16), on the existing entry points:
//
// * `/me feed thing:<名字>`: names any gift. A fixed food named in words (白飯, 鋼盆, 甜點) is fed
//   at once like `/me feed item:`. Anything else answers with a neutral card only the member sees:
//   the name, its price tier, the balance after, and 確認 / 取消. Nothing is charged and she is
//   not told until 確認; only the person who asked can press it (the card's session is theirs,
//   and the gift is checked against the presser); the buttons stop working when the quote runs
//   out, and a second press or a retry charges once (the ledger key is the gift's).
// * `/me gifts` (shown as `/me play gifts`): what they gave her and what she said, with a picture
//   of the newest gift she kept.
//
// Her answer is her own message and the receipt card of `answer_gift`, where she answers.

import {
  type AnyComponentRoute,
  type CardBlock,
  type CommandRegistry,
  type CommandReply,
  ComponentResult,
  cardReply,
  commandSpec,
  componentId,
  defineRoute,
  type Invocation,
  notice,
  pictureParts,
} from "@miyoria/commands";
import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/runtime/kernel";
import { newId, PicturesKey } from "@miyoria/types";
import { WALLET_NODE } from "./economy.js";
import {
  FreeGiftsKey,
  type GiftDesk,
  type GiftQuote,
  type GiftView,
  TAKEN_FOR_HER,
} from "./gifts.js";
import { EconomyError, EconomyKey, type FeedItem } from "./types.js";

const log = getLogger("economy.gifts");

export const GIFT_PATHS = ["me gifts"] as const;

export const GIFT_ROUTES = {
  ok: "me:gift:ok",
  no: "me:gift:no",
} as const;

const UNAVAILABLE = "送禮現在打不開";
/** Gifts `/me gifts` lists. */
const LISTED = 8;
/** Longest wait for the picture before `/me gifts` answers with its text alone. */
const PICTURE_MS = 8_000;

const STATUS_WORD: Readonly<Record<GiftView["status"], string>> = {
  pending: "等你確認",
  cancelled: "取消了",
  expired: "過期了",
  rejected: "送不了",
  confirmed: "等她回應",
  accepted: "她收下了",
  refused: "她沒收,已退回",
  refunded: "已退回",
  refund_due: "退回中",
};

function desk(services: ServiceLookup): GiftDesk | null {
  return services.get(FreeGiftsKey) ?? null;
}

/** A neutral card only the presser sees. */
function privately(text: string, muted: string | null = null, title: string | null = null) {
  const blocks: CardBlock[] = [{ type: "text", text }];
  if (muted) blocks.push({ type: "muted", text: muted });
  return cardReply(blocks, { accent: "neutral", ephemeral: true, title });
}

function refusal(error: unknown): CommandReply {
  if (error instanceof EconomyError) {
    return error.status === 503 ? notice("warn", error.message) : privately(error.message);
  }
  log.warn({ error: errorMessage(error) }, "a gift failed");
  return notice("warn", UNAVAILABLE);
}

/** 「約 NT$1,500 → 1,500 魚幣」, or the price alone when it did not come from an estimate. */
export function priceLine(q: Pick<GiftQuote, "twd" | "price" | "currency">): string {
  const coins = `${q.price.toLocaleString("en-US")} ${q.currency}`;
  return q.twd === null ? coins : `約 NT$${q.twd.toLocaleString("en-US")} → ${coins}`;
}

/**
 * The quote: what it is, what it costs (the NT$ estimate and the coins), what is left after, and
 * 確認 / 取消. A large gift says so on a line of its own, with the balance after.
 */
export function quoteCard(q: GiftQuote, confirmS: number): CommandReply {
  const minutes = Math.max(1, Math.round(confirmS / 60));
  const lines = [`**${q.item}**　${q.kind_word}`, `${priceLine(q)}　送出後剩 ${q.balance_after}`];
  if (q.big) {
    lines.push(
      `這是一份大禮:${q.price.toLocaleString("en-US")} ${q.currency},送出後只剩 ${q.balance_after}。`,
    );
  }
  const muted = [
    ...(q.note ? [q.note] : []),
    `按確認才扣${q.currency},她會自己決定收不收,不收全部退回。${minutes} 分鐘內有效。`,
  ];
  return cardReply(
    [
      { type: "text", text: lines.join("\n") },
      { type: "muted", text: muted.join("\n") },
      {
        type: "buttons",
        buttons: [
          { id: componentId(GIFT_ROUTES.ok, q.id), label: "確認", style: "primary" },
          { id: componentId(GIFT_ROUTES.no, q.id), label: "取消", style: "secondary" },
        ],
      },
    ],
    { accent: "neutral", title: "送她禮物", ephemeral: true, session: {} },
  );
}

/**
 * `/me feed thing:`: a quote to confirm, or the fixed food fed at once by `feed`, or why it
 * cannot be given (only the member sees any of it).
 */
export async function askGift(
  services: ServiceLookup,
  inv: Invocation,
  text: string,
  feed: (item: FeedItem) => Promise<CommandReply>,
): Promise<CommandReply> {
  const gifts = desk(services);
  if (!gifts || !services.get(EconomyKey)) return notice("warn", UNAVAILABLE);
  try {
    // The key is the invoker's platform's (`discord:<ulid>` on Discord, as before). The gift's
    // `source` is the record's own word for where it was asked (`discord` or `web`), not a platform.
    const asked = await gifts.ask(
      inv.invoker,
      text,
      `${inv.context.platform}:${newId()}`,
      "discord",
    );
    if (asked.status === "fixed") return await feed(asked.item);
    if (asked.status === "refused") return privately(`沒辦法送:${asked.message}。`, "沒有扣錢。");
    return quoteCard(asked.quote, gifts.confirmWindowS);
  } catch (error) {
    return refusal(error);
  }
}

async function confirm(services: ServiceLookup, inv: Invocation, id: string) {
  const gifts = desk(services);
  if (!gifts) return ComponentResult.update(notice("warn", UNAVAILABLE));
  try {
    const done = await gifts.confirm(inv.invoker, id);
    const g = done.gift;
    const head =
      g.status === "confirmed"
        ? `送出了「${g.item}」,花了 ${g.price} ${gifts.currency},剩 ${done.balance}。`
        : `「${g.item}」:${STATUS_WORD[g.status]}。`;
    const muted =
      g.status === "confirmed" ? "她下次說話時會看到,收不收由她決定;不收會全部退回。" : null;
    return ComponentResult.update(privately(head, muted, "送她禮物"));
  } catch (error) {
    return ComponentResult.update(refusal(error));
  }
}

async function cancel(services: ServiceLookup, inv: Invocation, id: string) {
  const gifts = desk(services);
  if (!gifts) return ComponentResult.update(notice("warn", UNAVAILABLE));
  try {
    const g = await gifts.cancel(inv.invoker, id);
    const text =
      g.status === "cancelled"
        ? `取消了「${g.item}」,沒有扣錢。`
        : `「${g.item}」:${STATUS_WORD[g.status]}。`;
    return ComponentResult.update(privately(text, null, "送她禮物"));
  } catch (error) {
    return ComponentResult.update(refusal(error));
  }
}

/** The 確認 / 取消 routes of the quote card (registered with `me feed`). */
export function giftRoutes(services: ServiceLookup): AnyComponentRoute[] {
  const id = (p: readonly string[]) => (typeof p[0] === "string" && p[0] !== "" ? p[0] : null);
  return [
    defineRoute<string>({
      route: GIFT_ROUTES.ok,
      parse: id,
      ephemeral: true,
      handle: (inv, gift) => confirm(services, inv, gift),
    }),
    defineRoute<string>({
      route: GIFT_ROUTES.no,
      parse: id,
      ephemeral: true,
      handle: (inv, gift) => cancel(services, inv, gift),
    }),
  ];
}

/** `/me gifts`: their gifts and her lines, with a picture of the newest one she kept. */
async function myGifts(services: ServiceLookup, inv: Invocation): Promise<CommandReply> {
  const gifts = desk(services);
  if (!gifts) return notice("warn", UNAVAILABLE);
  try {
    const list = (await gifts.mine(inv.invoker, 30)).filter((g) => g.status !== "rejected");
    if (list.length === 0) {
      return privately("你還沒有自己取名送過她東西。用 /me feed thing:<名字> 送一樣看看。");
    }
    const lines = list.slice(0, LISTED).map((g) => {
      const said = g.status === "accepted" ? `:「${g.line ?? TAKEN_FOR_HER}」` : "";
      const fav = g.favourite ? "(她很喜歡)" : "";
      return `・${g.item}　${STATUS_WORD[g.status]}${fav}${said}`;
    });
    const newest = list.find((g) => g.status === "accepted");
    const drawn = newest ? await picture(services, inv, newest.id) : pictureParts(null);
    return cardReply(
      [
        ...drawn.blocks,
        { type: "text", text: lines.join("\n") },
        { type: "muted", text: "禮物改變不了她對你的感覺,只是一份心意。" },
      ],
      { accent: "neutral", title: "你送她的東西", files: drawn.files },
    );
  } catch (error) {
    return refusal(error);
  }
}

/** A kept gift's picture; nothing without the renderer, too slow, or when it cannot be drawn. */
async function picture(services: ServiceLookup, inv: Invocation, id: string) {
  try {
    const data = await desk(services)?.picture(inv.invoker, id);
    const pictures = services.get(PicturesKey);
    if (!data || !pictures) return pictureParts(null);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PICTURE_MS));
    const file = await Promise.race([pictures.render("gift", data), timeout]);
    return pictureParts(file);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot draw a gift");
    return pictureParts(null);
  }
}

export function registerGiftCommands(registry: CommandRegistry, services: ServiceLookup): void {
  registry.register(
    commandSpec("me gifts", "你自己取名送她的東西、她說了什麼,附上她最近收下的那一份的圖", {
      permission: WALLET_NODE,
    }),
    (inv) => myGifts(services, inv),
  );
}

export function unregisterGiftCommands(registry: CommandRegistry): void {
  for (const path of GIFT_PATHS) registry.unregister(path);
}
