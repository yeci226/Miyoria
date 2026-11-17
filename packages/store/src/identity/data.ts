// The `identity` tables' parts of the data categories (`data.ts`): the people with their accounts
// and places (`people`, dependents first: places name persons and accounts; handles are
// `persons.handle`), and two of a person's own choices in `persons.prefs` (`voice_consent`,
// `privacy`). The settings keys their owners still write are claimed in `config/data.ts`.

import { type CategoryData, prefsPart, tablePart } from "../data.js";

export const identityData: readonly CategoryData[] = [
  {
    category: "people",
    parts: [
      tablePart("link_codes", "link_codes", "node", null, "code_hash", {
        code_hash: "text",
        account_id: "text",
        expires_at: "ts",
      }),
      tablePart("space_members", "space_members", "node", "last_seen", "space_id, account_id", {
        space_id: "text",
        account_id: "text",
        nick: "text",
        roles: "json",
        joined_at: "ts",
        left_at: "ts",
        last_seen: "ts",
      }),
      tablePart("sessions", "sessions", "node", "last_at", "key", {
        key: "text",
        space_id: "text",
        room_id: "text",
        person_id: "text",
        lane: "text",
        created_at: "ts",
        last_at: "ts",
      }),
      tablePart("rooms", "rooms", "node", "created_at", "created_at, id", {
        id: "text",
        platform: "text",
        external_id: "text",
        space_id: "text",
        parent_id: "text",
        kind: "text",
        name: "text",
        caps: "json",
        dm_person: "text",
        created_at: "ts",
        archived_at: "ts",
      }),
      tablePart("spaces", "spaces", "node", "joined_at", "joined_at, id", {
        id: "text",
        platform: "text",
        external_id: "text",
        name: "text",
        joined_at: "ts",
        left_at: "ts",
      }),
      tablePart("accounts", "accounts", "node", "last_seen", "person_id, platform, external_id", {
        id: "text",
        platform: "text",
        external_id: "text",
        person_id: "text",
        display_name: "text",
        is_self: "bool",
        first_seen: "ts",
        last_seen: "ts",
        linked_at: "ts",
        linked_by: "text",
      }),
      tablePart("people", "persons", "node", "created_at", "created_at, id", {
        id: "text",
        name: "text",
        handle: "text",
        prefs: "json",
        created_at: "ts",
        merged_into: "text",
        legacy: "json",
      }),
    ],
    // Imports name the persons they were about.
    keptEvents: "type GLOB 'identity.*'",
  },
  { category: "voice_consent", parts: [prefsPart("voice_consent", "voice_consent")] },
  { category: "privacy", parts: [prefsPart("privacy", "privacy")] },
];
