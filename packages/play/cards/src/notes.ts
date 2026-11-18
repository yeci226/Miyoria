// What she hears of the cards (docs/design/v5-play.md §2, §6.1, §6.3): a card worth a word reaches
// her as a note she may react to, the way the party games tell her about a game (an `Observation`
// on the event log, not silent, in her working context). Only these are worth one: a milestone
// card (she gave it for a tier they reached), a card she dropped in a channel and who picked it
// up (§6.2: who got it is worth talking about), an SR or better daily card, a card the pity gave, a
// card with a part they wished for, a series completed. Each is one short line, with nothing in it
// that is not public (the rarity and the pity's length are on the odds table; the relationship and
// her words are not repeated; a milestone's tier is hers to know; a title is named only when it is
// public, and a new title is private). Every line names whose card it is, and a card they drew
// says it is theirs, not hers: she gives the cards, so 「抽到」 alone read to her as her own draw
// and she told a channel 「我抽到 SR 了」. An ordinary card is not told:
// she would hear of every purchase otherwise. A keepsake is not told either: it is no news to her,
// and nobody is sent anything for it (P5).

import { isRare } from "./catalogue.js";
import { type IssuedCard, milestoneTier } from "./store.js";

/** The lines a card is worth, in the order above; empty for an ordinary card. */
export function cardNotes(issued: IssuedCard, wishedNames: ReadonlyMap<string, string>): string[] {
  const { card } = issued;
  if (card.kind === "keepsake") return [];
  const who = card.face.call_name ?? card.face.name;
  const got = card.kind === "daily" ? "抽到" : "拿到";
  const lines: string[] = [];
  const tier = milestoneTier(card);
  if (tier !== null) {
    lines.push(`你和 ${who} 的關係到了「${tier.label}」,你給了他一張里程碑卡。`);
  }
  if (card.kind === "drop") {
    const rare = card.parts.filter((p) => isRare(p.rarity)).map((p) => p.name);
    lines.push(
      `你丟在頻道裡的卡被 ${who} 撿走了${rare.length > 0 ? `,上面有「${rare.join("」「")}」` : ""}。`,
    );
  }
  if (card.kind === "daily" && isRare(card.rarity)) {
    const rare = card.parts.filter((p) => isRare(p.rarity)).map((p) => p.name);
    lines.push(
      `${who} 自己抽卡,抽到一張 ${card.rarity} 的卡${rare.length > 0 ? `,上面有「${rare.join("」「")}」` : ""}(是 ${who} 的卡,不是你抽的)。`,
    );
  }
  if (card.pity_hit) {
    lines.push(`${who} 好久沒抽到 SR 以上,${who} 這張是保底給的。`);
  }
  for (const id of card.wished) {
    lines.push(`${who} ${got}的卡上有 ${who} 願望單上的「${wishedNames.get(id) ?? id}」。`);
  }
  // A title is theirs alone until they make it public: the note does not name a private one, so
  // she cannot say it in a channel.
  for (const t of issued.titles) {
    lines.push(
      t.public
        ? `${who} 集滿了一個系列,拿到稱號「${t.title}」。`
        : `${who} 集滿了一個系列,拿到一個稱號。`,
    );
  }
  return lines;
}
