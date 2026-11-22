// The profile's words for the texts of this package (docs/design/v5-profiles.md): the coins' name
// (`[modules.economy] currency`) and how a text refers to her (`[character] pronoun`). Core
// provides both at boot; a bare registry (unit tests) reads the first character's.

import type { ServiceLookup } from "@miyoria/runtime/kernel";
import { CharacterKey, CurrencyKey, DEFAULT_CHARACTER, DEFAULT_CURRENCY } from "@miyoria/types";

/** The coins' name of the running profile (`魚幣` by default). */
export function coinName(services: ServiceLookup | undefined): string {
  return services?.get(CurrencyKey) ?? DEFAULT_CURRENCY;
}

/** How texts refer to her (`她` by default). */
export function pronounOf(services: ServiceLookup | undefined): string {
  return (services?.get(CharacterKey) ?? DEFAULT_CHARACTER).pronoun;
}

/**
 * Under every transfer: coins are play points and may never be traded for money or goods. The
 * wording around the name never changes.
 */
export function transferSmallPrint(currency: string = DEFAULT_CURRENCY): string {
  return `${currency}只是遊戲裡的點數,沒有現金價值。禁止用真錢或任何現實物品買賣、交換${currency};違反者可能被凍結錢包,衍生的糾紛或損失請自行負責。`;
}
