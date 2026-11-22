// Every name she knows people by, for the check that keeps one person's name off another person's
// page (`mentionsAnother`): display names (at first sight and now), handles and what she calls
// them. Finding the one person a name means is `matchPersonName` (`@miyoria/types`).

import type { ServiceLookup } from "@miyoria/runtime/kernel";
import { HandleDirectoryKey, HeartKey, type KnownName } from "@miyoria/types";
import { PeopleStoreKey } from "./stores.js";

/**
 * Every known name, or `null` when the people and the handles cannot be read: without them
 * nothing can be shown to be free of other names, so callers show nothing.
 */
export async function knownNames(services: ServiceLookup): Promise<KnownName[] | null> {
  const people = services.get(PeopleStoreKey);
  const handles = services.get(HandleDirectoryKey);
  if (!people && !handles) return null;
  const out: KnownName[] = [];
  if (people) {
    try {
      for (const p of await people.all()) {
        out.push({ name: p.display_name, person: p.id, account: null });
        for (const a of p.accounts) {
          out.push({ name: a.display_name, person: p.id, account: a.account });
        }
      }
    } catch {
      return null;
    }
  }
  for (const entry of handles?.list() ?? []) {
    const { handle, display_name, person, account } = entry;
    out.push({ name: handle, person, account }, { name: display_name, person, account });
    // What their accounts are called now (a nickname changed since the handle was made).
    for (const name of entry.names ?? []) out.push({ name, person, account });
  }
  // What she calls people (the heart's rows).
  for (const { person, call_name } of services.get(HeartKey)?.callNames?.() ?? []) {
    out.push({ name: call_name, person, account: null });
  }
  return out;
}
