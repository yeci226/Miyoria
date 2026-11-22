// How the deep-sea exchange is paid for (docs/design/exchange.md): a port the economy provides
// (`ExchangeWalletKey`) and the exchange (`@miyoria/play/exchange`) moves coins through, so
// neither package depends on the other. Coins are only earned, never bought; nothing here buys
// bond, and she never trades.
//
// One posting is one or more ledger rows of one wallet, written together or not at all, each with
// its own key; the first row's key decides a retry, so a posting that went through is never
// written twice. The exchange keeps what the rows are for (the order, the fill, the vault) in its
// own tables; the rows are what the wallet sees.

import { DEFAULT_CURRENCY } from "./character.js";
import type { PersonId } from "./ids.js";
import type { AccountRef } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** The ledger reasons of the exchange (statements and the health table read them). */
export const EXCHANGE_REASONS = {
  /** Coins a member puts in: a buy's margin (the whole cost of a plain buy), margin added. */
  in: "exchange_in",
  /** Coins back to a member: a sale, what a liquidation left, a buy that did not fill. */
  out: "exchange_out",
  /** Burned: the buy fee, the sale fee and tax, the carry fee of leverage. */
  fee: "exchange_fee",
  /** The fee of a buy that did not fill, given back. */
  feeBack: "exchange_fee_back",
  /** Real instruments (the house is the counterparty): coins burned into a position by a buy. */
  burn: "exchange_burn",
  /** The burn of a real buy that did not fill, given back. */
  burnBack: "exchange_burn_back",
  /** Coins minted back by a real sale, a payout, what a liquidation left. */
  mint: "exchange_mint",
  /** A leveraged loss past its margin, taken from the wallet (cross margin). */
  loss: "exchange_loss",
} as const;

export type ExchangeReason = (typeof EXCHANGE_REASONS)[keyof typeof EXCHANGE_REASONS];

/** Someone whose wallet the exchange may use. */
export interface ExchangePerson {
  person: PersonId;
  /** The display name of the account (untrusted). */
  name: string;
}

/** One row of a posting: its reason, its coins, its own key. */
export interface ExchangeEntry {
  reason: ExchangeReason;
  delta: number;
  key: string;
}

export type ExchangePost =
  | { ok: true; balance: number; duplicate: boolean }
  | { ok: false; reason: "short"; balance: number }
  | { ok: false; reason: "refused"; message: string };

export interface ExchangeWallet {
  /** What the coins are called (`魚幣`). */
  readonly currency: string;
  /** NT dollars per coin: the economy's one fixed rate (`[modules.economy] twd_per_coin`). */
  readonly twdPerCoin?: number;
  /** The person behind `account` when they may buy: she knows them and has not blocked them. */
  member(account: AccountRef): Promise<ExchangePerson | null>;
  /** The person behind `account` when she knows them, blocked or not: they may still sell. */
  holder(account: AccountRef): Promise<ExchangePerson | null>;
  balance(person: PersonId): Promise<number>;
  /** Coins received by transfer since `since`. */
  transferredIn(person: PersonId, since: Timestamp): Promise<number>;
  /**
   * Writes `entries` to `person`'s wallet together, once. With `covered`, refused (`short`) when
   * their sum would take the balance below zero. A posting whose first key is there already is a
   * `duplicate` and writes nothing.
   */
  post(
    person: PersonId,
    entries: readonly ExchangeEntry[],
    ref: string,
    covered: boolean,
  ): Promise<ExchangePost>;
  /** Whether a row under `key` is in `person`'s wallet. */
  posted(person: PersonId, key: string): Promise<boolean>;
  /**
   * Every coin in every wallet together (her purse included): what the owner's page sets the
   * exchange's net minting against. Absent when the economy cannot sum its ledger.
   */
  circulation?(): Promise<number>;
}

export const ExchangeWalletKey = serviceKey<ExchangeWallet>("ExchangeWallet");

// ---- the small print (owner 2026-11-21): one wording, under every exchange surface -------------

/**
 * Under every exchange surface: Discord cards, pictures, panel sections, the opt-in. `currency` is
 * the profile's coin name (`CurrencyKey`); the wording around it never changes.
 */
export function exchangeDisclaimer(currency: string = DEFAULT_CURRENCY): string {
  return `${currency}是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。`;
}

/** The base line with the default coin name (what every surface of the first character shows). */
export const EXCHANGE_DISCLAIMER = exchangeDisclaimer();
/** Added on surfaces with real stocks. */
export const EXCHANGE_DISCLAIMER_REAL = "資料來源:Yahoo Finance,報價可能延遲。";
/** Added on surfaces with leverage. */
export const EXCHANGE_DISCLAIMER_LEVERAGE = "槓桿可能讓你賠光錢包和其他持股。";

/** The small print for a surface: always the base line, the others when they apply. */
export function exchangeSmallPrint(
  o: { real?: boolean; leverage?: boolean; currency?: string } = {},
): string {
  return [
    exchangeDisclaimer(o.currency),
    o.real ? EXCHANGE_DISCLAIMER_REAL : null,
    o.leverage ? EXCHANGE_DISCLAIMER_LEVERAGE : null,
  ]
    .filter((x) => x !== null)
    .join("");
}
