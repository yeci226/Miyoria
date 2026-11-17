// The economy plugin's tables on a test store (`tables.ts`), and the wallet of an account the way
// the economy finds it: the person identity resolves the account to.

import type { SqliteStore } from "@miyoria/store";
import type { AccountRef, PersonId } from "@miyoria/types";
import { type EconomyTables, economyTables } from "../src/tables.js";

/** The economy's tables on `store` (migrated on first use, the same object every time). */
export function economyOf(store: SqliteStore): EconomyTables {
  return store.plugin(economyTables);
}

/** The coin ledger on `store`. */
export function ledgerOf(store: SqliteStore): EconomyTables["ledger"] {
  return economyOf(store).ledger;
}

/** The wallet of `account`: its person. An account nobody saw is nobody's (reads find nothing). */
export function walletOf(store: SqliteStore, account: AccountRef): PersonId {
  return store.persons.personOf(account)?.id ?? `nobody:${account.platform}:${account.id}`;
}
