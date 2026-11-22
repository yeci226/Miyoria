// `/me card` (docs/design/v5-play.md §2, §6.3): the daily card she gives, the same one the member
// page gives, through the `Keepsakes` service the api module provides. Without it (api off, no
// cards) the answer is a neutral notice.
//
// The answer is a neutral card only the person sees; what she wrote is shown as written. `/me card`
// shows today's card and issues one only when there is none yet today; a daily card costs fish
// coins, the first of the day too. The rest of the cards lives under the same command (the owner
// wants few commands): `action` issues another card today (`foil` makes it a foil card), or shows
// the dex (圖鑑), the public odds (機率), the pity counter (保底) or sets the wishlist (願望單, with
// `wish`: up to three part names, or 清空). The fortune slip is not here: it is the paid add-on of
// `/me checkin` (`fortune:true`, in the economy). Someone who was here before the cards finds their
// keepsake card the first time they look (P5): that look shows it and issues nothing. The button
// of a card she drops in a channel (v5-play §6.2) is a route of this command, not a command of its
// own.

import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/runtime/kernel";
import {
  CharacterKey,
  CurrencyKey,
  DEFAULT_CHARACTER,
  DEFAULT_CURRENCY,
  type KeepsakeCard,
  type KeepsakeCardBook,
  type KeepsakeCardImage,
  type KeepsakeCards,
  type KeepsakeOdds,
  type KeepsakeResult,
  type Keepsakes,
  KeepsakesKey,
  newId,
  PicturesKey,
} from "@miyoria/types";
import { type ComponentInvocation, ComponentResult, defineRoute } from "./components.js";
import type { CommandRegistry } from "./registry.js";
import {
  type CardBlock,
  type CardOptions,
  type CommandReply,
  cardReply,
  notice,
  pictureParts,
} from "./reply.js";
import { ArgKind, argSpec, commandSpec, type Invocation } from "./spec.js";

const log = getLogger("commands.keepsakes");

/** Members have these through `me.*`. */
export const CARD_NODE = "me.card";

const UNAVAILABLE = "這個功能現在不能用。";

/** `/me card action:…`. */
export const CARD_NEW = "再發一張";
export const CARD_DEX = "圖鑑";
export const CARD_ODDS = "機率";
export const CARD_PITY = "保底";
export const CARD_WISH = "願望單";
/** `wish:` that clears the wishlist. */
export const CLEAR_WISHES = "清空";

/** The button of a card she dropped in a channel: `mi:cards:drop:<id>` (`@miyoria/play/cards`). */
export const CARD_DROP_ROUTE = "cards:drop";

/** Under a keepsake card given on the first look; `coin` and `her` are the profile's words. */
const keepsakeNote = (coin: string, her: string): string =>
  `在有卡片之前你就在了，這張是${her}給你的紀念卡，不用${coin}。`;

/** What it cost, under the card. */
function paidLine(charged: number, balance: number | null): CardBlock | null {
  if (charged <= 0) return null;
  return { type: "muted", text: `花了 ${charged}${balance === null ? "" : `，剩 ${balance}`}` };
}

/** What a card that is not a daily one is called on it. */
const KIND_NAMES: Readonly<Record<string, string>> = {
  milestone: "里程碑卡",
  keepsake: "紀念卡",
  drop: "頻道裡撿到的卡",
};

function cardText(card: KeepsakeCard): CardBlock[] {
  const kind = card.kind === undefined ? null : (KIND_NAMES[card.kind] ?? null);
  const head = [
    `第 ${card.number} 張`,
    kind,
    card.rarity,
    card.relationship,
    card.foil ? "閃卡" : null,
  ]
    .filter((x) => x !== null && x !== "")
    .join("　");
  const lines = [head];
  if (card.line) lines.push(card.line);
  if (card.expression || card.parts.length > 0) {
    lines.push([card.expression, ...card.parts].filter((x) => x !== null).join("・"));
  }
  if (card.fields.length > 0)
    lines.push(card.fields.map((f) => `${f.label}：${f.text}`).join("\n"));
  const blocks: CardBlock[] = [{ type: "text", text: lines.join("\n") }];
  blocks.push({ type: "muted", text: `編號 ${card.serial}` });
  return blocks;
}

/**
 * A card's reply with its picture on top: the same one its link preview shows (`cardImage`). A card
 * that cannot be drawn is told in words alone.
 */
async function cardWithPicture(
  keepsakes: Keepsakes,
  serial: string,
  blocks: CardBlock[],
  options: CardOptions,
): Promise<CommandReply> {
  let image: KeepsakeCardImage | null = null;
  try {
    image = (await keepsakes.cardImage?.(serial)) ?? null;
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot draw a card for its reply");
  }
  if (image === null) return cardReply(blocks, options);
  return cardReply([{ type: "image", name: image.name }, ...blocks], {
    ...options,
    files: [{ name: image.name, data: image.data, contentType: image.contentType }],
  });
}

/** The pity in words. */
function pityText(pity: { since: number; pity: number; until: number }): string {
  return pity.until === 0
    ? `已經連續 ${pity.since} 張沒有 SR 以上，下一張保證有。`
    : `連續 ${pity.since} 張沒有 SR 以上；再 ${pity.until} 張還沒有的話，下一張保證有。`;
}

/** Under today's card: how many were given, the price, and what else `/me card` can do. */
function todayHint(today: KeepsakeCards): string {
  const parts = [`今天發了 ${today.today} / ${today.per_day} 張。`];
  if (today.today < today.per_day && today.prices.card !== null) {
    const foil = today.prices.foil === null ? "" : `，加 foil 做成閃卡（再 ${today.prices.foil}）`;
    parts.push(`再一張用 action:${CARD_NEW}（${today.prices.card}${foil}）。`);
  }
  parts.push(`圖鑑、機率、保底和願望單也在 action 裡。`);
  return parts.join("");
}

function bookText(book: KeepsakeCardBook): CardBlock[] {
  const lines = [`收集到 ${book.parts.owned} / ${book.parts.total} 種部件。`];
  for (const s of book.series) {
    lines.push(`${s.name}：${s.owned} / ${s.total}${s.complete ? `（稱號「${s.title}」）` : ""}`);
  }
  if (book.legacy.length > 0) {
    lines.push(
      `舊收藏：${book.legacy.map((i) => (i.count > 1 ? `${i.name}×${i.count}` : i.name)).join("、")}`,
    );
  }
  const blocks: CardBlock[] = [{ type: "text", text: lines.join("\n") }];
  blocks.push({ type: "muted", text: pityText(book.pity) });
  blocks.push({
    type: "muted",
    text:
      book.wishlist.length > 0
        ? `願望單：${book.wishlist.join("、")}（不改機率，抽到時她會知道）`
        : `願望單是空的：用 action:${CARD_WISH} wish:部件名稱 標記最多三個。`,
  });
  return blocks;
}

function oddsText(odds: KeepsakeOdds): CardBlock[] {
  const lines = [
    `一張 ${odds.price}，一天最多 ${odds.per_day} 張。`,
    odds.rarities.map((r) => `${r.rarity} ${r.shown}%`).join("　"),
  ];
  if (odds.pity_after !== null) {
    lines.push(`連續 ${odds.pity_after} 張沒有 SR 以上，下一張保證有。`);
  }
  for (const slot of odds.slots) {
    lines.push(`${slot.name}：${slot.parts.map((p) => `${p.name} ${p.shown}%`).join("、")}`);
  }
  const blocks: CardBlock[] = [{ type: "text", text: lines.join("\n") }];
  blocks.push({ type: "muted", text: "機率對每個人都一樣；表情由你們的關係決定，不靠抽。" });
  return blocks;
}

/** The part names of `wish:`, split on the usual separators; `清空` clears. */
function wishes(raw: string | null): string[] | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (text === CLEAR_WISHES) return [];
  return text
    .split(/[、,，\s]+/)
    .map((w) => w.trim())
    .filter((w) => w !== "");
}

/** A refusal is plain information; only "not now" is a warning. */
function refusal(result: Extract<KeepsakeResult<unknown>, { ok: false }>): CommandReply {
  return notice(result.status >= 500 ? "warn" : "info", result.message);
}

export function registerKeepsakes(registry: CommandRegistry, services: ServiceLookup): void {
  const coin = services.get(CurrencyKey) ?? DEFAULT_CURRENCY;
  const her = (services.get(CharacterKey) ?? DEFAULT_CHARACTER).pronoun;
  const who = (inv: Invocation) => ({
    account: inv.invoker,
    name: inv.invoker_display_name,
    avatar_url: null,
  });
  const guard = async (run: () => Promise<CommandReply>): Promise<CommandReply> => {
    try {
      return await run();
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "a keepsake command failed");
      return notice("warn", UNAVAILABLE);
    }
  };

  /** The dex or the odds as a picture over their text (v5-play §11.5); nothing without one. */
  const picture = async (inv: Invocation, kind: "dex" | "odds") => {
    try {
      const result = await services
        .get(PicturesKey)
        ?.forMember({ account: inv.invoker, name: inv.invoker_display_name }, kind);
      return pictureParts(result?.file);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot draw a card picture");
      return pictureParts(null);
    }
  };

  registry.register(
    commandSpec(
      "me card",
      `${her}給你的每日卡：今天還沒有就發一張（要花${coin}），有了就看今天的`,
      {
        permission: CARD_NODE,
        ephemeral: true,
        args: [
          argSpec(
            "action",
            `${CARD_NEW}：今天再發一張；${CARD_DEX}：你集到的部件和稱號；${CARD_ODDS}：公開機率；${CARD_PITY}：保底計數；${CARD_WISH}：標記想要的部件`,
            ArgKind.choice([CARD_NEW, CARD_DEX, CARD_ODDS, CARD_PITY, CARD_WISH]),
            { required: false },
          ),
          argSpec("foil", `新卡做成閃卡（要多花${coin}）`, ArgKind.boolean, { required: false }),
          argSpec(
            "wish",
            `願望單：最多三個部件名稱，用頓號分開；${CLEAR_WISHES} 就清掉`,
            ArgKind.string,
            { required: false },
          ),
        ],
      },
    ),
    (inv) =>
      guard(async () => {
        const keepsakes = services.get(KeepsakesKey);
        if (!keepsakes) return notice("info", UNAVAILABLE);
        // `wish:` alone sets the wishlist: it never buys a card.
        const action = inv.str("action") ?? (inv.str("wish") === null ? null : CARD_WISH);
        const foil = inv.bool("foil") === true;
        if (action === CARD_ODDS) {
          const odds = await keepsakes.cardOdds();
          if (!odds) return notice("info", UNAVAILABLE);
          const drawn = await picture(inv, "odds");
          return cardReply([...drawn.blocks, ...oddsText(odds)], {
            accent: "neutral",
            title: "每日卡的機率",
            files: drawn.files,
          });
        }
        if (action === CARD_DEX || action === CARD_PITY) {
          const book = await keepsakes.cardBook(inv.invoker);
          if (!book.ok) return refusal(book);
          if (action === CARD_PITY) return notice("info", pityText(book.value.pity));
          const drawn = await picture(inv, "dex");
          return cardReply([...drawn.blocks, ...bookText(book.value)], {
            accent: "neutral",
            title: "你的圖鑑",
            files: drawn.files,
          });
        }
        if (action === CARD_WISH) {
          const parts = wishes(inv.str("wish"));
          if (parts === null) {
            const book = await keepsakes.cardBook(inv.invoker);
            if (!book.ok) return refusal(book);
            const list = book.value.wishlist;
            return notice(
              "info",
              list.length > 0
                ? `願望單：${list.join("、")}`
                : `願望單是空的：用 wish:部件名稱 標記最多三個（名稱看 action:${CARD_ODDS}）。`,
            );
          }
          const set = await keepsakes.setCardWishlist(who(inv), parts);
          if (!set.ok) return refusal(set);
          return notice(
            "info",
            set.value.length > 0
              ? `願望單：${set.value.join("、")}。機率不會變，抽到時她會知道。`
              : "願望單清空了。",
          );
        }
        // Idempotency key on the invoker's own platform (no default platform, v5-architecture §6).
        const key = `${inv.invoker.platform}:${newId()}`;
        const today = await keepsakes.cardsToday(inv.invoker);
        // The first look of someone from before the cards: their keepsake, and nothing charged.
        if (today.keepsake !== undefined) {
          const blocks = cardText(today.keepsake);
          blocks.push({ type: "muted", text: keepsakeNote(coin, her) });
          blocks.push({ type: "muted", text: todayHint(today) });
          return cardWithPicture(keepsakes, today.keepsake.serial, blocks, {
            accent: "neutral",
            title: "你的紀念卡",
          });
        }
        const fresh = action !== CARD_NEW && !foil;
        if (fresh && today.latest !== null && today.today > 0) {
          const blocks = cardText(today.latest);
          blocks.push({ type: "muted", text: todayHint(today) });
          return cardWithPicture(keepsakes, today.latest.serial, blocks, {
            accent: "neutral",
            title: "你的卡片",
          });
        }
        const issued = await keepsakes.issueCard(who(inv), key, { foil });
        if (!issued.ok) return refusal(issued);
        const blocks = cardText(issued.value);
        const paid = paidLine(issued.charged, issued.balance);
        if (paid) blocks.push(paid);
        return cardWithPicture(keepsakes, issued.value.serial, blocks, {
          accent: "neutral",
          title: "你的卡片",
        });
      }),
    {
      components: [
        defineRoute<string>({
          route: CARD_DROP_ROUTE,
          ephemeral: true,
          parse: (params) => (params.length === 1 && params[0] !== "" ? (params[0] ?? null) : null),
          handle: (inv, drop) => pickUp(inv, drop),
        }),
      ],
    },
  );

  /**
   * The button of a card she dropped in a channel (v5-play §6.2). The card goes to the one who
   * picked it up alone (an ephemeral follow-up); the drop itself then says who got it, since who
   * got it is the point. A refusal (too late, one a day already) is theirs alone.
   */
  async function pickUp(inv: ComponentInvocation, drop: string): Promise<ComponentResult> {
    const keepsakes = services.get(KeepsakesKey);
    if (!keepsakes?.claimDrop) return ComponentResult.reply(notice("info", UNAVAILABLE));
    let got: KeepsakeResult<KeepsakeCard>;
    try {
      got = await keepsakes.claimDrop(who(inv), drop);
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "a dropped card failed");
      return ComponentResult.reply(notice("warn", UNAVAILABLE));
    }
    if (!got.ok) return ComponentResult.reply(refusal(got));
    const blocks = cardText(got.value);
    if (inv.canFollowUp()) {
      try {
        await inv.followUp(
          await cardWithPicture(keepsakes, got.value.serial, blocks, {
            accent: "neutral",
            title: "你撿到的卡",
            ephemeral: true,
          }),
        );
      } catch (error) {
        log.warn({ error: errorMessage(error) }, "cannot show a dropped card privately");
      }
    }
    const name = inv.invoker_display_name.trim() || "有人";
    return ComponentResult.update(
      cardReply([{ type: "text", text: `${name} 撿走了這張卡。` }], {
        accent: "neutral",
        title: "掉落的卡",
      }),
    );
  }
}
