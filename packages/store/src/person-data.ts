// What happens to a person's rows in every schema when they ask to be forgotten, or when two
// people turn out to be one (docs/design/v5-data.md §2.4, §3.1, §4.2). Each schema that keeps
// something about people may declare a hook for both (`StorePlugin.forgetPerson`,
// `StorePlugin.mergePerson`, and the store's own schemas here); this coordinator calls every
// installed schema's hook in one transaction and records the request as one event in it.
//
// The event is an audit entry (`audit.person.forget`, `audit.person.merge`): for the owner, kept
// forever like the rest of the audit log and never deleted by a wipe, on the panel's audit page.
// It names the person and what each schema did, never anything they said.
//
// - Order: dependents first. A plugin's hook runs before the hooks of the schemas it requires;
//   `identity` (which merges the person rows) and the event log run last.
// - All or nothing: a hook that throws rolls back what every hook wrote, and no event is recorded.
// - A hook says what it did as counts, or that it does nothing and why (`declined`): money and
//   audit records are kept (§2.5), and the result lists every schema either way.

import { AuditRecorded, auditType } from "@miyoria/contracts/events";
import {
  type AccountRef,
  type JsonObject,
  type JsonValue,
  newId,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";
import { StoreError } from "./common.js";
import type { Db } from "./db.js";
import type { EventStore } from "./events/log.js";
import type { Identity } from "./identity/identity.js";

/** A person asked her to forget them. */
export interface PersonForget {
  readonly person: PersonId;
  /**
   * `person` and every person merged into them: rows written before a merge still carry the
   * absorbed id.
   */
  readonly ids: readonly PersonId[];
  /** Their accounts (an absorbed person's moved with the merge). */
  readonly accounts: readonly AccountRef[];
  /** Why, in a few words (`forget me`); kept on redaction records, never their text. */
  readonly reason: string;
  /** The module that asked (`memory`). */
  readonly source: string;
}

/** `absorb` turned out to be `keep` (a link code, the owner): `absorb` becomes part of `keep`. */
export interface PersonMerge {
  readonly keep: PersonId;
  readonly absorb: PersonId;
  readonly source: string;
}

/** What a hook did: rows per kind (its own names), or why it does nothing. */
export interface PersonHookResult {
  readonly counts: Readonly<Record<string, number>>;
  /** Set when the hook leaves its rows as they are on purpose. */
  readonly declined?: string;
}

/** A hook that leaves its rows as they are, saying why. */
export function declined(why: string): PersonHookResult {
  return { counts: {}, declined: why };
}

/** One schema's hooks, bound to its code. */
export interface PersonHooks {
  /** The schema's id (`memory`, `identity`, `core` for the event log). */
  readonly plugin: string;
  forgetPerson?(request: PersonForget): PersonHookResult;
  mergePerson?(request: PersonMerge): PersonHookResult;
}

/** What one schema's hook did. */
export interface PersonHookOutcome {
  plugin: string;
  counts: Record<string, number>;
  declined: string | null;
}

/** The audit action recording a forget request; `detail` is `{ ids, reason, hooks }`. */
export const PERSON_FORGET_ACTION = "person.forget";
/** The audit action recording a merge; `target` is the kept person, `detail` `{ absorb, hooks }`. */
export const PERSON_MERGE_ACTION = "person.merge";
/** The event types of the two (`audit.person.forget`, `audit.person.merge`). */
export const PERSON_FORGET_TYPE = auditType(PERSON_FORGET_ACTION);
export const PERSON_MERGE_TYPE = auditType(PERSON_MERGE_ACTION);

/** What a request did, schema by schema in the order they ran, and the event recording it. */
export interface PersonRequestResult {
  /** The id of the audit entry recording the request (`PERSON_FORGET_TYPE`, `PERSON_MERGE_TYPE`). */
  event: string;
  hooks: PersonHookOutcome[];
}

/** The counts of `plugin`'s hook in `result`, empty when it has none or declined. */
export function hookCounts(result: PersonRequestResult, plugin: string): Record<string, number> {
  return result.hooks.find((h) => h.plugin === plugin)?.counts ?? {};
}

/** Forgetting and merging people, through every installed schema's hooks (`PersonData`). */
export interface PersonDataStore {
  /**
   * Forgets `person` in every schema, in one transaction; throws a `StoreError` for an unknown or
   * absorbed person.
   */
  forget(person: PersonId, request: { reason: string; source: string }): PersonRequestResult;
  /** Merges `absorb` into `keep` in every schema, in one transaction. */
  merge(keep: PersonId, absorb: PersonId, request: { source: string }): PersonRequestResult;
  /** The schemas whose hooks a request runs, in the order it runs them. */
  participants(): string[];
}

function outcomeOf(plugin: string, result: PersonHookResult): PersonHookOutcome {
  return { plugin, counts: { ...result.counts }, declined: result.declined ?? null };
}

/** `hooks` of a request's audit entry: `{ <schema>: { <kind>: n } | { declined } }`. */
function summary(outcomes: readonly PersonHookOutcome[]): JsonObject {
  return Object.fromEntries(
    outcomes.map((o) => [o.plugin, o.declined === null ? o.counts : { declined: o.declined }]),
  );
}

export class PersonData implements PersonDataStore {
  readonly #db: Db;
  readonly #events: EventStore;
  readonly #identity: Identity;
  /** The schemas in migration order: a hook runs before those of the schemas before it. */
  readonly #order: () => readonly string[];
  readonly #hooks = new Map<string, PersonHooks>();

  constructor(db: Db, events: EventStore, identity: Identity, order: () => readonly string[]) {
    this.#db = db;
    this.#events = events;
    this.#identity = identity;
    this.#order = order;
  }

  /** Adds a schema's hooks; a schema has one set. */
  add(hooks: PersonHooks): void {
    if (this.#hooks.has(hooks.plugin)) {
      throw new StoreError(`the person hooks of \`${hooks.plugin}\` are added already`);
    }
    this.#hooks.set(hooks.plugin, hooks);
  }

  #ordered(): PersonHooks[] {
    const order = this.#order();
    const rank = (id: string) => {
      const at = order.indexOf(id);
      return at < 0 ? Number.MAX_SAFE_INTEGER : at;
    };
    // Dependents first: the reverse of the migration order, the event log (`core`) last.
    return [...this.#hooks.values()].sort((a, b) => rank(b.plugin) - rank(a.plugin));
  }

  participants(): string[] {
    return this.#ordered().map((h) => h.plugin);
  }

  /** The audit entry of a request, in its transaction; returns its id. */
  #record(action: string, person: PersonId, detail: JsonValue, source: string): string {
    return this.#events.appendNow({
      draft: {
        id: newId(),
        at: toTimestamp(this.#db.clock.now()),
        type: auditType(action),
        v: AuditRecorded.v,
        person_id: person,
        data: { actor: source, action, target: person, detail, ok: true },
      },
      source,
    }).id;
  }

  #live(id: PersonId): PersonId {
    const row = this.#identity.personRow(id);
    if (row === null || row.merged_into !== null) throw new StoreError(`unknown person \`${id}\``);
    return row.id as PersonId;
  }

  forget(person: PersonId, request: { reason: string; source: string }): PersonRequestResult {
    return this.#db.tx(() => {
      const id = this.#live(person);
      const ask: PersonForget = {
        person: id,
        ids: [id, ...this.#identity.absorbedInto(id)],
        accounts: this.#identity
          .accountsOf(id)
          .map((a) => ({ platform: a.platform, id: a.external_id })),
        reason: request.reason,
        source: request.source,
      };
      const hooks: PersonHookOutcome[] = [];
      for (const h of this.#ordered()) {
        if (h.forgetPerson) hooks.push(outcomeOf(h.plugin, h.forgetPerson(ask)));
      }
      const detail = { ids: [...ask.ids], reason: ask.reason, hooks: summary(hooks) };
      return { event: this.#record(PERSON_FORGET_ACTION, id, detail, ask.source), hooks };
    });
  }

  merge(keep: PersonId, absorb: PersonId, request: { source: string }): PersonRequestResult {
    return this.#db.tx(() => {
      const ask: PersonMerge = { keep: this.#live(keep), absorb: this.#live(absorb), ...request };
      if (ask.keep === ask.absorb) throw new StoreError("a person cannot be merged into itself");
      const hooks: PersonHookOutcome[] = [];
      for (const h of this.#ordered()) {
        if (h.mergePerson) hooks.push(outcomeOf(h.plugin, h.mergePerson(ask)));
      }
      const detail = { absorb: ask.absorb, hooks: summary(hooks) };
      return { event: this.#record(PERSON_MERGE_ACTION, ask.keep, detail, ask.source), hooks };
    });
  }
}
