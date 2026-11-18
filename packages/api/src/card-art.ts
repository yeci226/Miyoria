// The picture on a card, in one place (docs/design/cards.md §6): the link preview, the member page,
// the public check page and `/me card` all get it from `cardArt`.
//
// It is her rendered picture (`CardPortraitKey`, from the card's draw snapshot) when something
// renders it, and the fixed portrait nearest her expression (`card-<pose>.local.webp` in the panel's
// folder) when nothing does. Older member cards have no draw snapshot, so they always keep the
// fixed portrait they had. Which card may be shown to whom is decided by the caller; this only
// finds the picture.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IssuedCard } from "@miyoria/contracts/api";
import { CardPortraitKey, CardsKey } from "@miyoria/play/cards";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { ApiState } from "./state.js";

const log = getLogger("api.card-art");

export interface CardArt {
  bytes: Uint8Array;
  /** A rendered one is a PNG, opaque; a fixed portrait is a WebP with a clear background. */
  type: "image/png" | "image/webp";
  /** Rendered from the card's draw, so it never changes; the fixed one may give way to it later. */
  live: boolean;
}

/** The fixed portraits read so far (there are ten); a missing one is looked for again. */
const fixed = new Map<string, Uint8Array>();

/** A fixed portrait's file, `null` without the panel folder or the file. */
async function fixedPortrait(dir: string | null, pose: string): Promise<Uint8Array | null> {
  const name = pose.replace(/[^a-z0-9-]/g, "");
  if (dir === null || name === "") return null;
  const key = `${dir}|${name}`;
  const known = fixed.get(key);
  if (known !== undefined) return known;
  try {
    const file = await readFile(join(dir, `card-${name}.local.webp`));
    fixed.set(key, file);
    return file;
  } catch {
    // No renders on this machine: the card is shown without her.
    return null;
  }
}

/**
 * Her rendered picture for a card, from what the card kept of its draw; `null` when nothing renders
 * it, the card has no draw (an older member card) or the render failed.
 */
export async function livePortrait(state: ApiState, serial: string): Promise<Uint8Array | null> {
  const renderer = state.optional(CardPortraitKey);
  const card = renderer ? state.optional(CardsKey)?.card(serial) : null;
  if (!renderer || !card) return null;
  try {
    return await renderer.render({
      parts: card.parts,
      expression: card.expression,
      seed: card.seed,
    });
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot render a card portrait");
    return null;
  }
}

/** The picture of `card`: her rendered one, else the fixed portrait of its pose; `null` with neither. */
export async function cardArt(state: ApiState, card: IssuedCard): Promise<CardArt | null> {
  const live = await livePortrait(state, card.serial);
  if (live !== null) return { bytes: live, type: "image/png", live: true };
  const file = await fixedPortrait(state.panelDir, card.pose);
  return file === null ? null : { bytes: file, type: "image/webp", live: false };
}
