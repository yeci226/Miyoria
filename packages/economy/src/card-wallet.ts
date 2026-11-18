// The wallet her cards are paid through (`CardWalletKey`, docs/design/v5-play.md §2): a daily card
// is one `card_daily` row of the ledger, keyed by the card's serial so a retry is the same charge,
// and its foil finish one `card_foil` row bought like any paid extra (`Economy.purchase`: its price,
// its day's limit), keyed by the same serial. A card that could not be written is given back once,
// found by its serial: the card as one `card_refund` row and the foil as the economy's own `refund`
// row, each keyed on its charge (the foil's key is the one `Economy.refund` uses, so the two cannot
// both pay). A charge that was given back is never answered as paid again. A stranger or someone
// she blocked cannot pay; a refund still reaches someone blocked since, as with every refund, what
// was taken is theirs.

import { CARD_REASONS, type CardCharge, type CardPayer, type CardWallet } from "@miyoria/types";
import { type EconomyService, type Member, STRANGER } from "./economy.js";
import { EconomyError } from "./types.js";

/** The paid extra a foil finish is. */
const FOIL = "card_foil";
/** A charge of this key was given back: a retry is a new try, not this one. */
const GIVEN_BACK = "這筆已經退回了,請再試一次";

export class EconomyCardWallet implements CardWallet {
  constructor(private readonly e: EconomyService) {}

  async #member(payer: CardPayer): Promise<Member | null> {
    try {
      return await this.e.member(payer.account);
    } catch {
      return null;
    }
  }

  /** Whether the charge `receipt` of `who` was given back. */
  async #givenBack(who: Member, receipt: string): Promise<boolean> {
    return (await this.e.ledger().byKey(this.e.profile, who.wallet, `refund:${receipt}`)) !== null;
  }

  async balance(payer: CardPayer): Promise<number | null> {
    const who = await this.#member(payer);
    return who === null ? null : this.e.ledger().balance(this.e.profile, who.wallet);
  }

  async spend(payer: CardPayer, amount: number, reason: string, key: string): Promise<CardCharge> {
    const who = await this.#member(payer);
    if (who === null) return { ok: false, reason: "refused", message: STRANGER };
    try {
      const spent = await this.e.serial(() =>
        this.e.spend(who, amount, reason, key, `${reason}:${key}`),
      );
      if (!spent.fresh && (await this.#givenBack(who, spent.entry.id))) {
        return { ok: false, reason: "refused", message: GIVEN_BACK };
      }
      return { ok: true, receipt: spent.entry.id, balance: spent.balance };
    } catch (error) {
      return this.#refusal(who, error);
    }
  }

  foilPrice(): number | null {
    const { price, per_day } = this.e.price(FOIL);
    return per_day > 0 ? price : null;
  }

  async foil(payer: CardPayer, key: string): Promise<CardCharge> {
    const who = await this.#member(payer);
    if (who === null) return { ok: false, reason: "refused", message: STRANGER };
    try {
      const bought = await this.e.purchase(payer.account, FOIL, key, key);
      if (bought.duplicate && (await this.#givenBack(who, bought.entry_id))) {
        return { ok: false, reason: "refused", message: GIVEN_BACK };
      }
      return { ok: true, receipt: bought.entry_id, balance: bought.balance };
    } catch (error) {
      return this.#refusal(who, error);
    }
  }

  async #refusal(who: Member, error: unknown): Promise<CardCharge> {
    if (!(error instanceof EconomyError)) throw error;
    if (error.status === 402) {
      const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
      return { ok: false, reason: "insufficient", balance };
    }
    if (error.status === 429) return { ok: false, reason: "capped", message: error.message };
    return { ok: false, reason: "refused", message: error.message };
  }

  async refund(payer: CardPayer, key: string, reason: string): Promise<number> {
    const who = await this.e.holder(payer.account);
    return this.e.serial(async () => {
      const ledger = this.e.ledger();
      let back = 0;
      const charge = await ledger.byKey(this.e.profile, who.wallet, `${CARD_REASONS.daily}:${key}`);
      if (charge !== null && charge.delta < 0 && !(await this.#givenBack(who, charge.id))) {
        const post = await ledger.post(
          this.e.entryFor(who, -charge.delta, reason, charge.id, `refund:${charge.id}`),
        );
        if (post.status === "posted") back += -charge.delta;
        else if (post.status !== "duplicate") {
          this.e.log.warn(
            { person: payer.person, receipt: charge.id, status: post.status },
            "cards: the refund of a card was not posted",
          );
        }
      }
      const foil = await ledger.byKey(this.e.profile, who.wallet, `${FOIL}:${key}`);
      if (foil !== null && foil.delta < 0 && (await this.e.refundOnce(who, foil))) {
        back += -foil.delta;
      }
      return back;
    });
  }
}
