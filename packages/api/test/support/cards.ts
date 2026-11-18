// Her cards (`@miyoria/play/cards`) for the API tests: the cards service over a store's tables with
// a seeded draw, and a wallet that holds coins by person. A card paid through a real economy's
// ledger uses the economy's own wallet (`EconomyCardWallet`).

import type { HeartStore } from "@miyoria/heart/person";
import {
  type CardCharge,
  type CardPayer,
  CardService,
  type CardStore,
  type CardsConfig,
  type CardWallet,
  cardRelationship,
  cardsConfig,
  seededRandom,
} from "@miyoria/play/cards";
import type { PersonId } from "@miyoria/types";

/** The cards service as the module builds it, with the wallet looked up at each use. */
export function cardService(
  store: CardStore,
  heart: HeartStore,
  wallet: () => CardWallet | null,
  config: Partial<CardsConfig> = {},
): CardService {
  return new CardService(store, {
    config: cardsConfig(config),
    clock: { now: () => Date.now() },
    wallet,
    relationship: (person) => cardRelationship(heart.get(person)),
    random: seededRandom(7),
    migrated: (person) => typeof heart.get(person)?.legacy.migrated_at === "string",
  });
}

/** Coins by person, nothing else: whoever has a person pays like anyone. */
export class CoinPurse implements CardWallet {
  readonly coins = new Map<PersonId, number>();
  readonly charges: { person: PersonId; amount: number; reason: string; key: string }[] = [];
  readonly refunds: string[] = [];

  fund(person: PersonId, amount: number): void {
    this.coins.set(person, (this.coins.get(person) ?? 0) + amount);
  }

  async balance({ person }: CardPayer): Promise<number | null> {
    return this.coins.get(person) ?? 0;
  }

  async spend(
    { person }: CardPayer,
    amount: number,
    reason: string,
    key: string,
  ): Promise<CardCharge> {
    const balance = this.coins.get(person) ?? 0;
    if (balance < amount) return { ok: false, reason: "insufficient", balance };
    this.coins.set(person, balance - amount);
    this.charges.push({ person, amount, reason, key });
    return { ok: true, receipt: `r-${key}`, balance: balance - amount };
  }

  /** No foil is sold here: the economy's wallet sells it. */
  foilPrice(): number | null {
    return null;
  }

  async foil(): Promise<CardCharge> {
    return { ok: false, reason: "refused", message: "not on sale" };
  }

  async refund({ person }: CardPayer, key: string): Promise<number> {
    if (this.refunds.includes(key)) return 0;
    const charge = this.charges.find((c) => c.key === key && c.person === person);
    if (!charge) return 0;
    this.refunds.push(key);
    this.coins.set(person, (this.coins.get(person) ?? 0) + charge.amount);
    return charge.amount;
  }
}
