import type { ProfileId } from "@miyoria/contracts/wire";
import { monotonicFactory } from "ulid";
import { serviceKey } from "./service-key.js";

// The id types themselves are contracts: ULIDs (26-character Crockford base32 strings, sortable
// by creation time) for events, turns, actions and people; free-form strings for the rest.
export type {
  ActionId,
  EventId,
  ModuleId,
  PersonId,
  PlatformId,
  ProfileId,
  TurnId,
} from "@miyoria/contracts/wire";

/** Service: the active profile id, provided by the app before modules start. */
export const ProfileIdKey = serviceKey<ProfileId>("ProfileId");

const nextUlid = monotonicFactory();

/** A fresh ULID. Ids made in the same millisecond still sort in creation order. */
export function newId(): string {
  return nextUlid();
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: string): boolean {
  return ULID.test(value);
}
