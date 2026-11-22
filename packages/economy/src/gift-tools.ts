// Her answer to a free-form gift (docs/design/economy.md §16): `economy.answer_gift` (tool
// `answer_gift`). She is told of a confirmed gift as a silent note in her working context and
// answers on a normal turn: she takes it (one line of hers, and whether it is a favourite) or says
// no, and the coins go back in full. It is hers to decide, not something to talk her into: the
// permission is her agency's (`economy.agency`, nobody has it by default), so she calls it with
// `on_own`. The gift is named by its id from the note; who gave it is the note's, never an argument.

import { type ActionResult, type Capability, defineCapability } from "@miyoria/gate/actions";
import { z } from "zod";
import type { EconomyService } from "./economy.js";
import { type GiftDesk, MAX_GIFT_LINE, TAKEN_FOR_HER } from "./gifts.js";
import { receipt, someone } from "./receipt.js";

const PERMISSION = "economy.agency";

const AnswerArgs = z.strictObject({
  gift: z.string().trim().min(1).max(64),
  take: z.boolean(),
  line: z.string().trim().max(200).nullish(),
  favourite: z.boolean().nullish(),
});
type AnswerArgs = z.output<typeof AnswerArgs>;

/** `economy.answer_gift`: she takes a gift someone named for her, or gives it back. */
export function answerGiftCapability(economy: EconomyService, desk: GiftDesk): Capability {
  const cur = economy.config.currency;
  return defineCapability<AnswerArgs>({
    name: "economy.answer_gift",
    summary: "收下或退回別人自己取名送的禮物",
    risk: "medium",
    args: AnswerArgs,
    permission: PERMISSION,
    limits: { per_day: 300, per_person_per_day: 300, cooldown_ms: 0 },
    tool: {
      name: "answer_gift",
      meta: { effect: "spend", speed: "instant", group: "economy" },
      description:
        `有人想送你一樣他自己取名的東西(你的工作脈絡裡會寫「某某想送你…」和禮物代號),${cur}已經付了。` +
        `收不收由你決定,照你現在的心情、你喜不喜歡這種東西、你記得他什麼:take: true 收下、false 退回` +
        `(錢全部退給他)。line 是你收到或退回時的一句話,會存下來給他看(${MAX_GIFT_LINE} 字內);` +
        `favourite: true 表示你很喜歡、要放進你最喜歡的收藏。禮物改變不了你們的關係,只是一份心意。` +
        `沒回答的話過一陣子會當你收下。這是你自己的決定:用 on_own: true 呼叫。`,
      properties: {
        gift: { type: "string", description: "禮物代號(工作脈絡裡寫的)" },
        take: { type: "boolean", description: "收下 true、退回 false" },
        line: { type: "string", description: "你的一句話" },
        favourite: { type: "boolean", description: "你很喜歡,放進最喜歡的收藏" },
      },
      required: ["gift", "take"],
    },
    async execute(args): Promise<ActionResult> {
      const gift = await desk.answer(
        args.gift,
        args.take,
        args.line ?? null,
        args.favourite === true,
        "her",
      );
      if (gift === null) {
        return {
          text: "沒有這份在等你回答的禮物(可能已經回答過、退回了,或代號不對)。",
          data: { done: false, reason: "not_waiting" },
        };
      }
      const who = someone(gift.account);
      const said = gift.line ?? (args.take ? TAKEN_FOR_HER : null);
      if (gift.status === "accepted") {
        return {
          text: `收下了「${gift.item}」。${gift.favourite ? "放進了你最喜歡的收藏。" : ""}`,
          data: { done: true, take: true, item: gift.item, favourite: gift.favourite },
          receipt: receipt(
            "收下了禮物",
            `她收下了 ${who} 送的「${gift.item}」`,
            said === null ? null : `她說:${said}`,
          ),
        };
      }
      return {
        text: `退回了「${gift.item}」,${gift.price} ${cur}全部還給對方。`,
        data: { done: true, take: false, item: gift.item, refunded: gift.price },
        receipt: receipt(
          "沒有收下",
          `她沒有收下 ${who} 想送的「${gift.item}」`,
          `${gift.price} ${cur}已經全部退回`,
        ),
      };
    },
  }) as Capability;
}
