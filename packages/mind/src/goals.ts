// Her goals (docs/design/v2-architecture.md §3.7): the structured agenda, `GoalAgendaKey`.
//
// One settings row per goal (`mind:goal:<id>`) of the active profile, a copy in memory. Every
// text she wrote (what / why / steps / why it was dropped) goes through `repairHandleText`
// before it is kept: no per-call `u1` codes in persisted data. Every goal has an expiry; past
// it the goal is dropped on the next sweep. `whenever` goals never fire on their own
// (`goalDue`): they are things she may pick when she plans.
//
// Triggers are checked by cheap code (`TriggerWatch`): a goal whose trigger starts firing wakes
// Plan once (and again after `refireMs` while it still fires and is open), instead of the LLM
// being asked every few minutes whether anything is due.
//
// The free-text agenda (`SelfState.agenda()`) is migrated once into goals with trigger
// `whenever` and a default expiry; the migration remembers which items it took
// (`mind:plan:migration`), so it is idempotent across restarts. The mind then closes the
// migrated items in `self:state`, so there is one agenda.

import { errorMessage, getLogger, SerialQueue } from "@miyoria/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type AgendaItem,
  type Clock,
  type Goal,
  type GoalAgenda,
  type GoalInput,
  type GoalStatus,
  type GoalTrigger,
  goalDue,
  type Handle,
  isGoalExpired,
  isJsonObject,
  isValidHandle,
  type JsonValue,
  newId,
  type PersonId,
  type ProfileId,
  repairHandleText,
  type Timestamp,
  type TriggerProbe,
  toTimestamp,
} from "@miyoria/types";

const log = getLogger("mind.goals");

/** Settings key prefix of goals. */
export const GOAL_PREFIX = "mind:goal:";
/** Settings key of the agenda migration record. */
export const GOAL_MIGRATION_KEY = "mind:plan:migration";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Closed goals are kept this long (the panel, "yesterday"), then deleted. */
const CLOSED_KEEP_MS = 2 * DAY_MS;
/** Open goals kept at most (the oldest `whenever` ones are dropped first). */
export const MAX_OPEN_GOALS = 24;
export const MAX_WHAT = 120;
export const MAX_WHY = 160;
export const MAX_STEPS = 6;
export const MAX_STEP = 60;

export class GoalError extends Error {
  override readonly name = "GoalError";
}

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** `text` cut and without per-call codes; `null` when nothing is left. */
export function cleanText(text: string, max: number): string | null {
  const flat = cut(text, max * 2);
  if (flat === "") return null;
  const repaired = repairHandleText(flat);
  return repaired === null ? null : cut(repaired, max);
}

/** A trigger with valid fields, else `whenever`. */
export function cleanTrigger(trigger: GoalTrigger): GoalTrigger {
  switch (trigger.kind) {
    case "at":
      return Number.isNaN(Date.parse(trigger.time)) ? { kind: "whenever" } : trigger;
    case "when_online":
      return isValidHandle(trigger.person) ? trigger : { kind: "whenever" };
    case "after_activity": {
      const a = trigger.activity.trim();
      return a === "" || a.length > 40
        ? { kind: "whenever" }
        : { kind: "after_activity", activity: a };
    }
    case "whenever":
      return trigger;
  }
}

/** The short key a prompt shows for a goal (`G7XK2P`), stable for its life. */
export function goalKey(goal: Pick<Goal, "id">): string {
  return `G${goal.id
    .replace(/[^0-9A-Za-z]/g, "")
    .slice(-5)
    .toUpperCase()}`;
}

/** The trigger in words (zh-TW), local times at `offsetMinutes`. */
export function describeTrigger(trigger: GoalTrigger, offsetMinutes: number): string {
  switch (trigger.kind) {
    case "at": {
      const d = new Date(Date.parse(trigger.time) + offsetMinutes * 60_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} 之後`;
    }
    case "when_online":
      return `${trigger.person} 上線時`;
    case "after_activity":
      return `${trigger.activity} 結束之後`;
    case "whenever":
      return "有空的時候";
  }
}

/** Sort order: timed first (soonest), then the event triggers, `whenever` last. */
function triggerRank(goal: Goal): [number, number] {
  switch (goal.trigger.kind) {
    case "at":
      return [0, Date.parse(goal.trigger.time)];
    case "when_online":
    case "after_activity":
      return [1, Date.parse(goal.created_at)];
    case "whenever":
      return [2, Date.parse(goal.created_at)];
  }
}

function isOpen(goal: Goal): boolean {
  return goal.status === "pending" || goal.status === "active";
}

function parseGoal(value: JsonValue): Goal | null {
  if (!isJsonObject(value) || typeof value.id !== "string" || typeof value.what !== "string") {
    return null;
  }
  const t = isJsonObject(value.trigger) ? value.trigger : null;
  let trigger: GoalTrigger = { kind: "whenever" };
  if (t?.kind === "at" && typeof t.time === "string") trigger = { kind: "at", time: t.time };
  else if (t?.kind === "when_online" && typeof t.person === "string") {
    trigger = { kind: "when_online", person: t.person };
  } else if (t?.kind === "after_activity" && typeof t.activity === "string") {
    trigger = { kind: "after_activity", activity: t.activity };
  }
  return {
    ...(value as unknown as Goal),
    trigger,
    steps: Array.isArray(value.steps) ? value.steps.filter((s) => typeof s === "string") : [],
  };
}

export interface GoalBookOptions {
  store: SettingsStore | null;
  profile: ProfileId;
  clock: Clock;
  /** Longest a goal may stay (days). */
  maxDays: number;
  /** Expiry of goals given none or an unusable one (days). */
  defaultDays: number;
  /** Every new or changed goal (`plan.goal`). */
  publish?: (goal: Goal) => void;
}

/** A change to an open goal (Plan's `edit`). */
export interface GoalEdit {
  what?: string;
  why?: string;
  trigger?: GoalTrigger;
  steps?: string[];
  expires?: Timestamp;
}

/** Her goals: `GoalAgendaKey`. Reads answer from memory; writes persist in the background. */
export class GoalBook implements GoalAgenda {
  readonly #o: GoalBookOptions;
  readonly #goals = new Map<string, Goal>();
  readonly #writes = new SerialQueue();
  #migrated = new Set<string>();

  constructor(options: GoalBookOptions) {
    this.#o = options;
  }

  async load(): Promise<void> {
    const store = this.#o.store;
    if (!store) return;
    for (const value of (await store.list(this.#o.profile, GOAL_PREFIX)).values()) {
      const goal = parseGoal(value);
      if (goal) this.#goals.set(goal.id, goal);
    }
    const record = await store.get(this.#o.profile, GOAL_MIGRATION_KEY);
    if (isJsonObject(record) && Array.isArray(record.items)) {
      this.#migrated = new Set(record.items.filter((v): v is string => typeof v === "string"));
    }
  }

  /** Waits for pending writes. */
  flush(): Promise<void> {
    return this.#writes.run(async () => {});
  }

  #now(): number {
    return this.#o.clock.now();
  }

  #persist(goal: Goal | null, id: string): void {
    const store = this.#o.store;
    if (goal) this.#o.publish?.(structuredClone(goal));
    if (!store) return;
    const value = goal === null ? null : (JSON.parse(JSON.stringify(goal)) as JsonValue);
    void this.#writes
      .run(() => store.set(this.#o.profile, `${GOAL_PREFIX}${id}`, value))
      .catch((error: unknown) => log.warn({ err: errorMessage(error) }, "cannot persist a goal"));
  }

  #expiry(expires: Timestamp | null | undefined, now: number): Timestamp {
    const at = expires ? Date.parse(expires) : Number.NaN;
    const max = now + this.#o.maxDays * DAY_MS;
    if (Number.isNaN(at) || at <= now) return toTimestamp(now + this.#o.defaultDays * DAY_MS);
    return toTimestamp(Math.min(at, max));
  }

  // ---- GoalAgenda -----------------------------------------------------------------------------

  goals(): Goal[] {
    const now = this.#now();
    return [...this.#goals.values()]
      .filter((g) => isOpen(g) && !isGoalExpired(g, now))
      .sort((a, b) => {
        const [ka, ta] = triggerRank(a);
        const [kb, tb] = triggerRank(b);
        return ka - kb || ta - tb || (a.id < b.id ? -1 : 1);
      })
      .map((g) => structuredClone(g));
  }

  /** Every goal kept (open and recently closed), newest first. */
  all(): Goal[] {
    return [...this.#goals.values()]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((g) => structuredClone(g));
  }

  goal(id: string): Goal | null {
    const g = this.#goals.get(id);
    return g ? structuredClone(g) : null;
  }

  /** The open goal a prompt key (`G7XK2P`) or id refers to. */
  byKey(key: string): Goal | null {
    const k = key.trim().toUpperCase();
    if (k === "") return null;
    const open = this.goals();
    return open.find((g) => goalKey(g) === k || g.id.toUpperCase() === k) ?? null;
  }

  add(input: GoalInput, id: string = newId()): Goal {
    const now = this.#now();
    const what = cleanText(input.what, MAX_WHAT);
    if (what === null) throw new GoalError("a goal needs a `what`");
    const goal: Goal = {
      id,
      what,
      why: cleanText(input.why, MAX_WHY) ?? "",
      trigger: cleanTrigger(input.trigger),
      steps: (input.steps ?? [])
        .map((s) => cleanText(s, MAX_STEP))
        .filter((s): s is string => s !== null)
        .slice(0, MAX_STEPS),
      status: "pending",
      expires: this.#expiry(input.expires, now),
      person: input.person && isValidHandle(input.person) ? input.person : null,
      context: input.context ?? null,
      source: input.source,
      created_at: toTimestamp(now),
      updated_at: toTimestamp(now),
      closed_at: null,
      close_reason: null,
    };
    this.#goals.set(goal.id, goal);
    this.#persist(goal, goal.id);
    this.#bound(now);
    return structuredClone(goal);
  }

  setStatus(id: string, status: GoalStatus, reason: string | null = null): Goal | null {
    const goal = this.#goals.get(id);
    if (!goal || !isOpen(goal) || goal.status === status) return null;
    const now = toTimestamp(this.#now());
    goal.status = status;
    goal.updated_at = now;
    if (status === "done" || status === "dropped") {
      goal.closed_at = now;
      goal.close_reason = reason === null ? null : cleanText(reason, MAX_WHY);
    }
    this.#persist(goal, id);
    return structuredClone(goal);
  }

  due(probe: TriggerProbe): Goal[] {
    return this.goals().filter((g) => goalDue(g, probe));
  }

  // ---- beyond the interface -----------------------------------------------------------------

  /** Changes an open goal; `null` when it is unknown, closed or nothing usable changed. */
  edit(id: string, patch: GoalEdit): Goal | null {
    const goal = this.#goals.get(id);
    if (!goal || !isOpen(goal)) return null;
    const now = this.#now();
    let changed = false;
    if (patch.what !== undefined) {
      const what = cleanText(patch.what, MAX_WHAT);
      if (what !== null && what !== goal.what) {
        goal.what = what;
        changed = true;
      }
    }
    if (patch.why !== undefined) {
      const why = cleanText(patch.why, MAX_WHY);
      if (why !== null && why !== goal.why) {
        goal.why = why;
        changed = true;
      }
    }
    if (patch.trigger !== undefined) {
      const trigger = cleanTrigger(patch.trigger);
      if (JSON.stringify(trigger) !== JSON.stringify(goal.trigger)) {
        goal.trigger = trigger;
        changed = true;
      }
    }
    if (patch.steps !== undefined) {
      const steps = patch.steps
        .map((s) => cleanText(s, MAX_STEP))
        .filter((s): s is string => s !== null)
        .slice(0, MAX_STEPS);
      if (JSON.stringify(steps) !== JSON.stringify(goal.steps)) {
        goal.steps = steps;
        changed = true;
      }
    }
    if (patch.expires !== undefined) {
      const expires = this.#expiry(patch.expires, now);
      if (expires !== goal.expires) {
        goal.expires = expires;
        changed = true;
      }
    }
    if (!changed) return null;
    goal.updated_at = toTimestamp(now);
    this.#persist(goal, id);
    return structuredClone(goal);
  }

  /**
   * Drops expired open goals and deletes long-closed ones. Returns the goals it dropped.
   */
  sweep(): Goal[] {
    const now = this.#now();
    const dropped: Goal[] = [];
    for (const goal of [...this.#goals.values()]) {
      if (isOpen(goal) && isGoalExpired(goal, now)) {
        const closed = this.setStatus(goal.id, "dropped", "過期了");
        if (closed) dropped.push(closed);
        continue;
      }
      const closedAt = goal.closed_at === null ? Number.NaN : Date.parse(goal.closed_at);
      if (!isOpen(goal) && (Number.isNaN(closedAt) || now - closedAt > CLOSED_KEEP_MS)) {
        this.#goals.delete(goal.id);
        this.#persist(null, goal.id);
      }
    }
    return dropped;
  }

  /** Keeps at most `MAX_OPEN_GOALS` open goals (the oldest `whenever` ones go first). */
  #bound(now: number): void {
    const open = [...this.#goals.values()].filter((g) => isOpen(g) && !isGoalExpired(g, now));
    if (open.length <= MAX_OPEN_GOALS) return;
    const victims = open
      .sort((a, b) => {
        const wa = a.trigger.kind === "whenever" ? 0 : 1;
        const wb = b.trigger.kind === "whenever" ? 0 : 1;
        return wa - wb || (a.created_at < b.created_at ? -1 : 1);
      })
      .slice(0, open.length - MAX_OPEN_GOALS);
    for (const g of victims) this.setStatus(g.id, "dropped", "目標太多了,先放掉最舊的");
  }

  /**
   * Takes over her old free-text agenda items once: each open item becomes a `whenever` goal
   * (its text repaired, its expiry kept within `maxDays`, the default when it had none).
   * Items migrated before are never taken again, even when their goal is gone. Returns how many
   * goals it added.
   */
  /** The old agenda item `id` became a goal (now or on an earlier start). */
  migrated(id: string): boolean {
    return this.#migrated.has(id);
  }

  migrate(items: readonly AgendaItem[], handleOf: (person: PersonId) => Handle | null): number {
    let added = 0;
    for (const item of items) {
      if (item.status !== "open" || this.#migrated.has(item.id)) continue;
      this.#migrated.add(item.id);
      const id = `agenda-${item.id}`;
      if (this.#goals.has(id)) continue;
      try {
        this.add(
          {
            what: item.text,
            why: item.why,
            trigger: { kind: "whenever" },
            expires: item.expires_at ?? toTimestamp(this.#now() + this.#o.defaultDays * DAY_MS),
            person: item.person === null ? null : handleOf(item.person),
            context: item.context,
            source: "plan",
          },
          id,
        );
        added++;
      } catch (error) {
        log.debug({ err: errorMessage(error) }, "agenda item not migrated");
      }
    }
    const store = this.#o.store;
    if (store && items.length > 0) {
      const value = { items: [...this.#migrated], at: toTimestamp(this.#now()) };
      void this.#writes
        .run(() => store.set(this.#o.profile, GOAL_MIGRATION_KEY, value))
        .catch(() => undefined);
    }
    return added;
  }
}

/**
 * Which open goals newly fire: a goal wakes her when its trigger starts firing, and again after
 * `refireMs` while it still fires (and is still open). Pure apart from what it remembers.
 */
export class TriggerWatch {
  readonly #last = new Map<string, { firing: boolean; at: number }>();

  check(goals: readonly Goal[], probe: TriggerProbe, refireMs: number): Goal[] {
    const out: Goal[] = [];
    const ids = new Set<string>();
    for (const goal of goals) {
      ids.add(goal.id);
      const prev = this.#last.get(goal.id);
      if (!goalDue(goal, probe)) {
        this.#last.set(goal.id, { firing: false, at: prev?.at ?? Number.NEGATIVE_INFINITY });
        continue;
      }
      if (prev?.firing && probe.now - prev.at < refireMs) continue;
      this.#last.set(goal.id, { firing: true, at: probe.now });
      out.push(goal);
    }
    for (const id of [...this.#last.keys()]) if (!ids.has(id)) this.#last.delete(id);
    return out;
  }

  /** The earliest `at` trigger after `now` among `goals` (epoch ms), or `null`. */
  static nextAt(goals: readonly Goal[], now: number): number | null {
    let next: number | null = null;
    for (const g of goals) {
      if (g.trigger.kind !== "at") continue;
      const at = Date.parse(g.trigger.time);
      if (!Number.isNaN(at) && at > now && (next === null || at < next)) next = at;
    }
    return next;
  }
}
