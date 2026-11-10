// Every name she knows people by, for the check that keeps one person's name off another person's
// page (`mentionsAnother`): display names, handles and what she calls them.

import type { ServiceLookup } from "@miyoria/kernel";
import { AffectStateKey, HandleDirectoryKey, type KnownName } from "@miyoria/types";
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
  }
  for (const card of services.get(AffectStateKey)?.cards() ?? []) {
    out.push({ name: card.handle, person: card.person, account: null });
    if (card.call_name) out.push({ name: card.call_name, person: card.person, account: null });
  }
  return out;
}
