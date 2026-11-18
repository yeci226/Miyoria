// A card's serial: `MYR-XXXX-XXXX-XXXX`, 60 bits from the system's CSPRNG in Crockford base32, the
// form the member cards always had (`packages/api/src/card.ts`), so a code printed on a card reads
// the same way.

import { randomBytes } from "node:crypto";

/** Crockford base32: no I, L, O or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newSerial(): string {
  let bits = randomBytes(8).readBigUInt64BE(0);
  let body = "";
  for (let i = 0; i < 12; i++) {
    body = ALPHABET[Number(bits & 31n)] + body;
    bits >>= 5n;
  }
  return `MYR-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}
