// The economy plugin's tables (`@miyoria/economy` `tables.ts`) for the API tests: an in-memory
// database whose identity holds the people of the rig's `PeopleStore`, with the same ids. The
// ledger's wallets are persons of its own database, so the people the economy resolves through
// the rig must be persons there too.

import { type EconomyTables, economyTables } from "@miyoria/economy";
import {
  accounts,
  type PeopleStore,
  type PluginContext,
  persons,
  SqliteStore,
  type StorePlugin,
} from "@miyoria/store";
import { type AccountRef, newId, type PersonId } from "@miyoria/types";

/** The store's connection, to write the rig's people as they are. */
const probe: StorePlugin<PluginContext> = {
  schema: { plugin: "probe", migrations: [] },
  open: (ctx) => ctx,
};

export interface EconomyRig {
  store: SqliteStore;
  economy: EconomyTables;
  /** The wallet of `account`: its person in the rig's `PeopleStore`. */
  wallet(account: AccountRef): Promise<PersonId>;
}

/** A store with the economy's tables and every person `people` knows now. */
export async function economyStore(people: PeopleStore): Promise<EconomyRig> {
  const store = await SqliteStore.open(":memory:", { plugins: [economyTables] });
  const { db } = store.plugin(probe);
  for (const person of await people.all()) {
    db.orm
      .insert(persons)
      .values({
        id: person.id,
        name: person.display_name,
        handle: `${person.display_name}#${person.id}`,
        created_at: person.created_at,
      })
      .run();
    for (const a of person.accounts) {
      db.orm
        .insert(accounts)
        .values({
          id: newId(),
          platform: a.account.platform,
          external_id: a.account.id,
          person_id: person.id,
          display_name: a.display_name,
          first_seen: a.first_seen,
          last_seen: a.last_seen,
        })
        .run();
    }
  }
  return {
    store,
    economy: store.plugin(economyTables),
    wallet: async (account) =>
      (await people.personByAccount(account))?.id ?? `nobody:${account.platform}:${account.id}`,
  };
}
