// A gift she kept (docs/design/economy.md §16): the picture its giver can show. It reads like a
// panel block: the frame with `她收到的東西 / 名字`, the gift as the headline, her line as a
// quote, and a strip of what it was and when. No price and no bond: a gift is a moment, not a
// score.

import type { GiftPictureData } from "@miyoria/types";
import { blockTitle, facts, finish, page, paragraph, SPACE, T, TYPE } from "./draw.js";

type Out = { drawn: ReturnType<typeof finish>; alt: string };

export function giftPicture(d: GiftPictureData): Out {
  const { canvas: c, top } = page("她收到的東西", d.name, d.date);
  let y = blockTitle(c, top, d.favourite ? "她很喜歡" : "她收下了");
  y = paragraph(c, y, d.item, 2, { size: 24, fill: T.foreground });
  y += SPACE.stage - 8;
  y = blockTitle(c, y, "她說");
  y = paragraph(c, y, `「${d.line}」`, 4, { size: TYPE.body, fill: T.foreground });
  y += SPACE.stage - 8;
  y = facts(c, y, [
    { label: "送的人", value: d.name },
    ...(d.kind === "" ? [] : [{ label: "是", value: d.kind }]),
    { label: "那一天", value: d.date },
  ]);
  const fav = d.favourite ? ",她很喜歡" : "";
  return {
    drawn: finish(c, y),
    alt: `${d.name}送她的「${d.item}」(${d.date})${fav}。她說:「${d.line}」`,
  };
}
