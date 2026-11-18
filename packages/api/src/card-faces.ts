// `CardFacesKey` (`@miyoria/play/cards`): the words on a card nobody bought, built the way a daily
// card's are (`card.ts`, `member.ts`): what the member page would show them now (her line for them
// passed by moderation and naming nobody else), what she writes for the occasion through the same
// checks (`card-words.ts`), and the card's number among all of theirs. The cards module asks for it
// when a bond enters a new tier (a milestone card), with no session: the person's name is the one
// their first account was last seen with.
//
// The keepsake card of someone who came over from the old records (P5) is given here too, the
// first time they open their cards (`keepsakeFor`, called by the routes and the command that show
// them), with facts only; nobody is sent anything for it. Her line for it comes later, when the
// cards module asks for it through `face` (occasion `keepsake`) and then says the card changed
// (`rewritten`), which drops the pictures of the whole card kept here.

import type { CardField, IssuedCard } from "@miyoria/contracts/api";
import {
  type CardFace,
  type CardFaces,
  type CardOccasion,
  CardsKey,
  cardRelationship,
  type OccasionFace,
} from "@miyoria/play/cards";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { IdentityStoreKey, type LegacySnapshot, MemberCardStoreKey } from "@miyoria/store";
import type { PersonId } from "@miyoria/types";
import { dailyCard } from "./card.js";
import { writeCard } from "./card-words.js";
import {
  accountsOf,
  cardView,
  loadMemberOf,
  type MemberContext,
  namesFor,
  shown,
  shownMemories,
} from "./member.js";
import { forgetCardImages } from "./og.js";
import { dateOf, localDay } from "./public.js";
import type { ApiState } from "./state.js";

const log = getLogger("api.card");

/** Memories she is shown for a card's words, at most. */
const MEMORIES = 5;

/**
 * The face of a card for `who` on `occasion`: her words for it, and the relationship it shows
 * (words only; her line for them only as the page shows it). `name` and `avatar_url` are theirs as
 * the card should print them.
 */
export async function occasionFace(
  state: ApiState,
  who: MemberContext,
  name: string,
  avatar_url: string | null,
  occasion: CardOccasion,
): Promise<OccasionFace> {
  const names = await namesFor(state, who);
  const view = cardView(state, who, names);
  // The scene she anchored a tier with is her own words of them and may name anyone: she is
  // given it only as the page would show it.
  const told: CardOccasion =
    occasion.kind === "milestone" && occasion.scene !== null
      ? { ...occasion, scene: shown(state, occasion.scene, names) }
      : occasion;
  const words =
    view.relationship === null
      ? null
      : await writeCard(
          state,
          {
            name,
            view,
            memories: (await shownMemories(state, who, names))
              .slice(0, MEMORIES)
              .map((m) => m.text),
            poses: [],
            occasion: told,
            names,
          },
          (text) => shown(state, text, names),
        );
  const person = who.person?.id ?? null;
  const older = await state
    .optional(MemberCardStoreKey)
    ?.countFor(state.profile(), accountsOf(who));
  const mine = person === null ? 0 : (state.optional(CardsKey)?.count(person) ?? 0);
  const face: CardFace = {
    name,
    avatar_url,
    call_name: view.call_name,
    line: words?.line ?? null,
    stamp: words?.stamp ?? null,
    fields: words?.fields ?? [],
    number: (older ?? 0) + mine + 1,
  };
  return {
    face,
    relationship: { ...cardRelationship(who.row), public_feeling: view.public_feeling },
  };
}

/**
 * What a keepsake card says of them: since when she has known them, what they were to her before
 * (from the V4 import, D4) and how many of the old member cards she had given them. Facts, not her
 * words: the keepsake is issued while their cards are being opened, with no model call to wait for.
 */
function keepsakeFields(
  state: ApiState,
  who: MemberContext,
  legacy: LegacySnapshot | null,
  older: number,
): CardField[] {
  const seen = [legacy?.first_seen, ...(who.person?.accounts.map((a) => a.first_seen) ?? [])]
    .map((t) => (t === undefined ? Number.NaN : Date.parse(t)))
    .filter((ms) => !Number.isNaN(ms));
  const fields: CardField[] = [];
  if (seen.length > 0) {
    const offset = state.publicSide.config.utc_offset_minutes;
    fields.push({ label: "第一次見面", text: dateOf(localDay(Math.min(...seen), offset)) });
  }
  if (legacy?.old_tier) fields.push({ label: "以前的關係", text: legacy.old_tier });
  const cards = legacy?.cards ?? older;
  if (cards > 0) fields.push({ label: "以前的卡", text: `${cards} 張` });
  return fields;
}

/**
 * Their keepsake card, given the first time they open their cards if they came over from the old
 * records (P5): the card as the page shows it when it was given just now, `null` when it was given
 * before, or is not theirs to have (someone she does not know or will not say anything about, or
 * nobody from before). Never throws: a keepsake is no reason for their cards not to open.
 */
export async function keepsakeFor(
  state: ApiState,
  who: MemberContext,
  name: string,
  avatar_url: string | null,
): Promise<IssuedCard | null> {
  const cards = state.optional(CardsKey);
  const person = who.person?.id ?? null;
  if (!cards || person === null || who.hidden) return null;
  try {
    const result = await cards.keepsake(person, async () => {
      const names = await namesFor(state, who);
      const view = cardView(state, who, names);
      const older =
        (await state.optional(MemberCardStoreKey)?.countFor(state.profile(), accountsOf(who))) ?? 0;
      return {
        face: {
          name,
          avatar_url,
          call_name: view.call_name,
          line: null,
          stamp: null,
          fields: keepsakeFields(state, who, cards.importedLegacy(person), older),
          number: older + cards.count(person) + 1,
        },
        relationship: { ...cardRelationship(who.row), public_feeling: view.public_feeling },
      };
    });
    return result.ok && !result.issued.again ? dailyCard(result.issued.card) : null;
  } catch (error) {
    log.warn({ err: errorMessage(error) }, "cannot give a keepsake card");
    return null;
  }
}

/** The faces the cards module asks for, by person. */
export class CardFaceService implements CardFaces {
  constructor(private readonly state: ApiState) {}

  async face(person: PersonId, occasion: CardOccasion): Promise<OccasionFace | null> {
    const { state } = this;
    const identity = state.optional(IdentityStoreKey);
    if (!identity) return null;
    const [first] = await identity.accountsOf(person);
    if (first === undefined) return null;
    const who = await loadMemberOf(state, first.account);
    // Someone she will not say anything about gets no card that would.
    if (who.hidden || who.person?.id !== person) return null;
    return occasionFace(state, who, first.display_name, null, occasion);
  }

  /** A card's words changed (her line on a keepsake): its kept pictures of the whole card go. */
  rewritten(serial: string): void {
    forgetCardImages(this.state, serial);
  }
}
