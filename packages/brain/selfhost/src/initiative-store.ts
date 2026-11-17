// Reads and writes of the `initiative` plugin's tables (`initiative-schema.ts`): her schedules and
// her inbox. Every time is given by the caller (her clock), never the store's.

import {
  type CategoryData,
  type Db,
  type Identity,
  type PersonForget,
  type StorePlugin,
  tablePart,
} from "@miyoria/store";
import { type AccountRef, type ContextKey, type Timestamp, toTimestamp } from "@miyoria/types";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { initiativeSchema } from "./initiative-migrations.js";
import {
  initiativeInbox as I,
  type InboxKind,
  type InboxRow,
  initiativeSchedules as S,
  type ScheduleRow,
  type ScheduleSource,
  type ScheduleState,
} from "./initiative-schema.js";

export type { InboxKind, InboxRow, ScheduleRow, ScheduleSource, ScheduleState };

/** A new schedule. */
export interface NewSchedule {
  id: string;
  note: string;
  due: number;
  daily: string | null;
  context: ContextKey | null;
  person: string | null;
  for_account: AccountRef | null;
  source: ScheduleSource;
  at: number;
}

/** A new inbox item. */
export interface NewInboxItem {
  key: string;
  kind: InboxKind;
  session: string | null;
  context: ContextKey | null;
  text: string;
  person: string | null;
  at: number;
}

const ts = (ms: number): Timestamp => toTimestamp(ms);

export class InitiativeStore {
  readonly #db: Db;

  readonly #identity: Identity | null;

  constructor(db: Db, identity: Identity | null = null) {
    this.#db = db;
    this.#identity = identity;
  }

  /**
   * "Forget me": the schedules and inbox items that are about or from the persons `request.ids`
   * (by handle, or by the account that asked for a schedule) are deleted.
   */
  forgetPerson(request: PersonForget): { schedules: number; inbox: number } {
    const handles = new Set<string>();
    for (const id of request.ids) {
      const handle = this.#identity?.personRow(id)?.handle;
      if (handle) handles.add(handle.toLowerCase());
    }
    const theirs = (person: string | null) =>
      person !== null && handles.has(person.trim().toLowerCase());
    const asked = (account: AccountRef | null) =>
      account !== null &&
      request.accounts.some((a) => a.platform === account.platform && a.id === account.id);
    return this.#db.tx(() => {
      const schedules = this.#db.orm
        .select({ id: S.id, person: S.person, for_account: S.for_account })
        .from(S)
        .where(or(isNotNull(S.person), isNotNull(S.for_account)))
        .all()
        .filter((s) => theirs(s.person) || asked(s.for_account))
        .map((s) => s.id);
      const inbox = this.#db.orm
        .select({ id: I.id, person: I.person })
        .from(I)
        .where(isNotNull(I.person))
        .all()
        .filter((i) => theirs(i.person))
        .map((i) => i.id);
      if (schedules.length > 0) this.#db.orm.delete(S).where(inArray(S.id, schedules)).run();
      if (inbox.length > 0) this.#db.orm.delete(I).where(inArray(I.id, inbox)).run();
      return { schedules: schedules.length, inbox: inbox.length };
    });
  }

  // ---- schedules ------------------------------------------------------------------------------

  addSchedule(s: NewSchedule): ScheduleRow {
    const row = {
      id: s.id,
      note: s.note,
      due: ts(s.due),
      daily: s.daily,
      context: s.context,
      person: s.person,
      for_account: s.for_account,
      source: s.source,
      fired: 0,
      state: "open" as const,
      created_at: ts(s.at),
      updated_at: ts(s.at),
    };
    this.#db.orm.insert(S).values(row).run();
    return row;
  }

  /** The schedules still waiting, soonest first. */
  openSchedules(): ScheduleRow[] {
    return this.#db.orm.select().from(S).where(eq(S.state, "open")).orderBy(asc(S.due)).all();
  }

  schedule(id: string): ScheduleRow | null {
    return this.#db.orm.select().from(S).where(eq(S.id, id)).get() ?? null;
  }

  /** Moves an open schedule to its next time (a daily one that came due). */
  reschedule(id: string, due: number, fired: number, at: number): void {
    this.#db.orm
      .update(S)
      .set({ due: ts(due), fired, updated_at: ts(at) })
      .where(and(eq(S.id, id), eq(S.state, "open")))
      .run();
  }

  /** Ends an open schedule; `false` when it was not open. */
  endSchedule(
    id: string,
    state: Exclude<ScheduleState, "open">,
    fired: number,
    at: number,
  ): boolean {
    const changed = this.#db.orm
      .update(S)
      .set({ state, fired, updated_at: ts(at) })
      .where(and(eq(S.id, id), eq(S.state, "open")))
      .run();
    return changed.changes > 0;
  }

  // ---- the inbox ------------------------------------------------------------------------------

  /** Adds an item; `null` when one with its key is there already (seen or not). */
  addItem(item: NewInboxItem): InboxRow | null {
    const inserted = this.#db.orm
      .insert(I)
      .values({
        key: item.key,
        kind: item.kind,
        session: item.session,
        context: item.context,
        text: item.text,
        person: item.person,
        created_at: ts(item.at),
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) return null;
    return this.#db.orm.select().from(I).where(eq(I.key, item.key)).get() ?? null;
  }

  hasItem(key: string): boolean {
    return this.#db.orm.select({ id: I.id }).from(I).where(eq(I.key, key)).get() !== undefined;
  }

  /** What a run in `session` is shown: its unseen items and home's, oldest first, at most `max`. */
  unseenFor(session: string, max: number): InboxRow[] {
    return this.#db.orm
      .select()
      .from(I)
      .where(and(isNull(I.seen_at), or(eq(I.session, session), isNull(I.session))))
      .orderBy(desc(I.id))
      .limit(max)
      .all()
      .reverse();
  }

  /** Every unseen item, oldest first. */
  unseen(): InboxRow[] {
    return this.#db.orm.select().from(I).where(isNull(I.seen_at)).orderBy(asc(I.id)).all();
  }

  /** It woke her (once). */
  woke(id: number, at: number): void {
    this.#db.orm
      .update(I)
      .set({ woke_at: ts(at) })
      .where(and(eq(I.id, id), isNull(I.woke_at)))
      .run();
  }

  /** The turn its wake started. */
  wokeTurn(id: number, turn: string): void {
    this.#db.orm.update(I).set({ woke_turn: turn }).where(eq(I.id, id)).run();
  }

  /** A run that showed `ids` finished. */
  seen(ids: readonly number[], turn: string, at: number): void {
    if (ids.length === 0) return;
    this.#db.orm
      .update(I)
      .set({ seen_at: ts(at), seen_turn: turn })
      .where(and(inArray(I.id, [...ids]), isNull(I.seen_at)))
      .run();
  }

  item(id: number): InboxRow | null {
    return this.#db.orm.select().from(I).where(eq(I.id, id)).get() ?? null;
  }
}

/** Her schedules and inbox on the panel's data page: counted, exported and wiped with her initiative. */
const initiativeData: readonly CategoryData[] = [
  {
    category: "initiative",
    parts: [
      tablePart("initiative_schedules", "initiative_schedules", "node", "updated_at", "id", {
        id: "text",
        note: "text",
        due: "ts",
        daily: "text",
        context: "json",
        person: "text",
        for_account: "json",
        source: "text",
        fired: "num",
        state: "text",
        created_at: "ts",
        updated_at: "ts",
      }),
      tablePart("initiative_inbox", "initiative_inbox", "node", "created_at", "id", {
        id: "num",
        key: "text",
        kind: "text",
        session: "text",
        context: "json",
        text: "text",
        person: "text",
        created_at: "ts",
        woke_at: "ts",
        woke_turn: "text",
        seen_at: "ts",
        seen_turn: "text",
      }),
    ],
  },
];

/**
 * Her schedules and her inbox as a plugin of the store: Core opens the store with it
 * (`STORE_PLUGINS`), so the tables exist; only the new runner writes them.
 */
export const initiativeTables: StorePlugin<InitiativeStore> = {
  schema: initiativeSchema,
  open: ({ db, identity }) => new InitiativeStore(db, identity),
  data: initiativeData,
  forgetPerson: (store, request: PersonForget) => ({ counts: store.forgetPerson(request) }),
};
