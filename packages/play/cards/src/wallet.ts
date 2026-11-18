// How a card is paid for: the port lives in `@miyoria/types` (`cards.ts`) so the economy can provide
// it without depending on this package; it is re-exported here for the cards' callers.

export {
  CARD_REASONS,
  type CardCharge,
  type CardPayer,
  type CardWallet,
  CardWalletKey,
} from "@miyoria/types";
