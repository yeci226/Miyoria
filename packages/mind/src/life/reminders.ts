// `remind_me` (docs/design/v4-plan.md §8.3 item 1): timers she sets herself ("二十分鐘後看一下烤箱",
// "明天九點問 Owen 考試考得怎樣"), or because someone asked her to.
//
// Before this, "九點提醒我" needed a goal to wake Plan, another model call and the gate, and often
// nothing happened. A timer here is plain data: kept in the settings store (`mind:reminder:<id>`)
// so it survives a restart, capped in count and horizon, cancellable. When it comes due it does
// not speak (§15: nothing in the background speaks): it becomes a proposal to the main line with
// a stable attention key (`reminder:<id>`, the revision counting how often it came due), and she
// decides what to say. Owner rules screen the proposal, the Arbiter's quiet hours and pause hold
// it back until they end (§8.4).
//
// A timer about a person is a wish too (`@miyoria/types` `wish.ts`), and must not be a fourth way
// to raise one (2026-11-10: a proposal, two promises and a goal asked S the same thing). Setting
// one about something they answered already is refused; a one-off timer is cancelled once she
// asked (a daily one stays: tomorrow is another question); and what comes due is screened again
// on the board before it reaches the Floor.

import {
  type ActionResult,
  type Capability,
  CapabilityError,
  defineCapability,
  type ExecContext,
} from "@miyoria/actions";
import { errorMessage, getLogger, SerialQueue, type ServiceLookup, sleep } from "@miyoria/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  ArbiterKey,
  type Clock,
  type ContextKey,
  isJsonObject,
  isValidHandle,
  type JsonValue,
  newId,
  newImpulse,
  type ProfileId,
  ProposalBoardKey,
  REMIND_CAPABILITY,
  type Reminder,
  type ReminderDesk,
  repairHandleText,
  sameAccount,
  toTimestamp,
  type Wish,
  type Wishes,
  wishHolder,
} from "@miyoria/types";
import { z } from "zod";

const log = getLogger("mind.reminders");

/** Bus topic of a timer that was set, came due, was held back, ended or was cancelled. */
export const REMINDER_TOPIC = "mind.reminder";
/** Settings key prefix of her timers. */
export const REMINDER_PREFIX = "mind:reminder:";
/** Permission node of asking her for a timer (trusted and above have it through `tools.*`). */
export const REMIND_NODE = "tools.remind";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A timer held back (quiet hours, a refusal that only has to wait) is tried again this often. */
export const RETRY_MS = 5 * MINUTE_MS;
/** A one-off timer that could not be delivered for this long is dropped as missed. */
export const MISSED_AFTER_MS = DAY_MS;
/** The loop never sleeps longer than this (the clock may jump). */
const MAX_SLEEP_MS = MINUTE_MS;
const MAX_WHAT = 120;

export class ReminderError extends Error {
  override readonly name = "ReminderError";
}

export interface ReminderLimits {
  /** Open timers at most. */
  max: number;
  /** Open timers one person may have asked for. */
  perPerson: number;
  /** How far ahead a timer may be set (days). */
  maxDays: number;
  /** How long a due timer stays on the board for the main line (minutes). */
  holdMins: number;
}

/** What a delivery came to: on the board (or with the Arbiter), held back, or refused for good. */
export type DeliveryOutcome =
  | { status: "delivered"; detail: string }
  | { status: "held"; detail: string }
  | { status: "dropped"; detail: string };

/** Hands a due timer to the main line. `late`: minutes it is overdue. */
export type Deliver = (reminder: Reminder, late: number) => Promise<DeliveryOutcome>;

function cut(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** The short key she and the panel use (`R7XK2P`), stable for its life. */
export function reminderKey(id: string): string {
  return `R${id
    .replace(/[^0-9A-Za-z]/g, "")
    .slice(-5)
    .toUpperCase()}`;
}

/** `MM/DD HH:MM` local. */
export function localWhen(at: number, offsetMinutes: number): string {
  const d = new Date(at + offsetMinutes * MINUTE_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * When `at` means (epoch ms), local time at `offsetMinutes`: `HH:MM` is the next time the clock
 * shows it, `YYYY-MM-DD HH:MM` (or `YYYY-MM-DDTHH:MM`) that local moment. `null`: unreadable.
 */
export function parseAt(at: string, now: number, offsetMinutes: number): number | null {
  const s = at.trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (h > 23 || m > 59) return null;
    const local = new Date(now + offsetMinutes * MINUTE_MS);
    let t =
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) -
      offsetMinutes * MINUTE_MS;
    if (t <= now) t += DAY_MS;
    return t;
  }
  const full = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(s);
  if (full) {
    const [y, mo, d, h, m] = full.slice(1).map(Number) as [number, number, number, number, number];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || m > 59) return null;
    return Date.UTC(y, mo - 1, d, h, m) - offsetMinutes * MINUTE_MS;
  }
  return null;
}

function parseReminder(value: JsonValue): Reminder | null {
  if (!isJsonObject(value)) return null;
  const { id, what, due } = value;
  if (typeof id !== "string" || typeof what !== "string" || typeof due !== "string") return null;
  if (Number.isNaN(Date.parse(due))) return null;
  return {
    ...(value as unknown as Reminder),
    key: reminderKey(id),
    daily: value.daily === true,
    fired: typeof value.fired === "number" ? value.fired : 0,
  };
}

/** What `set` needs. */
export interface ReminderInput {
  what: string;
  due: number;
  daily: boolean;
  context: ContextKey | null;
  person: string | null;
  for_account: AccountRef | null;
}

export interface ReminderBookOptions {
  store: SettingsStore | null;
  profile: ProfileId;
  clock: Clock;
  limits: ReminderLimits;
  offsetMinutes: number;
  deliver: Deliver;
  /** Every new, fired or ended timer (for the panel). */
  publish?: (reminder: Reminder, state: "set" | "fired" | "held" | "done" | "cancelled") => void;
  /** What she wants to ask whom (the arbiter's `WishesKey`), when it runs. */
  wishes?: () => Wishes | null;
}

/** Her timers: `ReminderDeskKey`. Reads answer from memory; writes persist in the background. */
export class ReminderBook implements ReminderDesk {
  readonly #o: ReminderBookOptions;
  readonly #open = new Map<string, Reminder>();
  /** Timers held back: not tried again before this (epoch ms). */
  readonly #retryAt = new Map<string, number>();
  readonly #writes = new SerialQueue();
  #ticking: Promise<void> | null = null;
  #wake: (() => void) | null = null;

  constructor(options: ReminderBookOptions) {
    this.#o = options;
  }

  get limits(): ReminderLimits {
    return this.#o.limits;
  }

  get offsetMinutes(): number {
    return this.#o.offsetMinutes;
  }

  #now(): number {
    return this.#o.clock.now();
  }

  now(): number {
    return this.#now();
  }

  async load(): Promise<void> {
    const store = this.#o.store;
    if (!store) return;
    for (const value of (await store.list(this.#o.profile, REMINDER_PREFIX)).values()) {
      const r = parseReminder(value);
      if (r) this.#open.set(r.id, r);
    }
  }

  flush(): Promise<void> {
    return this.#writes.run(async () => {});
  }

  #persist(id: string): void {
    const store = this.#o.store;
    if (!store) return;
    const r = this.#open.get(id);
    const value = r === undefined ? null : (JSON.parse(JSON.stringify(r)) as JsonValue);
    void this.#writes
      .run(() => store.set(this.#o.profile, `${REMINDER_PREFIX}${id}`, value))
      .catch((error: unknown) => log.warn({ err: errorMessage(error) }, "cannot persist a timer"));
  }

  list(): Reminder[] {
    return [...this.#open.values()]
      .sort((a, b) => Date.parse(a.due) - Date.parse(b.due))
      .map((r) => structuredClone(r));
  }

  /** Open timers `account` asked for. */
  of(account: AccountRef): Reminder[] {
    return this.list().filter((r) => r.for_account !== null && sameAccount(r.for_account, account));
  }

  #find(idOrKey: string): Reminder | null {
    const k = idOrKey.trim();
    if (k === "") return null;
    return (
      this.#open.get(k) ??
      [...this.#open.values()].find((r) => r.key.toUpperCase() === k.toUpperCase()) ??
      null
    );
  }

  get(idOrKey: string): Reminder | null {
    const r = this.#find(idOrKey);
    return r === null ? null : structuredClone(r);
  }

  /** Sets a timer; throws `ReminderError` (in her words) past a cap or the horizon. */
  set(input: ReminderInput): Reminder {
    const now = this.#now();
    const { max, perPerson, maxDays } = this.#o.limits;
    const what = repairHandleText(cut(input.what, MAX_WHAT * 2));
    if (what === null || what.trim() === "") throw new ReminderError("要提醒什麼沒有寫");
    if (!Number.isFinite(input.due) || input.due <= now) {
      throw new ReminderError("提醒的時間已經過了");
    }
    if (input.due - now > maxDays * DAY_MS) {
      throw new ReminderError(`最多只能設 ${maxDays} 天內的提醒`);
    }
    if (this.#open.size >= max) {
      throw new ReminderError(`提醒已經有 ${this.#open.size} 個了(上限 ${max}),先取消一些`);
    }
    if (input.for_account !== null && this.of(input.for_account).length >= perPerson) {
      throw new ReminderError(`這個人已經有 ${perPerson} 個提醒在等了,先取消一個`);
    }
    const id = newId();
    const person =
      input.person !== null && isValidHandle(input.person.trim()) ? input.person.trim() : null;
    const wish =
      person === null
        ? null
        : (this.#o.wishes?.()?.hold(person, what, wishHolder("reminder", id)) ?? null);
    if (wish?.state === "closed" && !input.daily) {
      throw new ReminderError(
        wish.end === "stop" ? "對方說你問過了,不要再問" : "這件事對方已經回答過了,不用提醒",
      );
    }
    const reminder: Reminder = {
      id,
      key: reminderKey(id),
      what: cut(what, MAX_WHAT),
      due: toTimestamp(input.due),
      daily: input.daily,
      context: input.context,
      person,
      for_account: input.for_account,
      fired: 0,
      created_at: toTimestamp(now),
    };
    this.#open.set(id, reminder);
    this.#persist(id);
    this.#o.publish?.(structuredClone(reminder), "set");
    this.#wake?.();
    return structuredClone(reminder);
  }

  cancel(idOrKey: string): boolean {
    const r = this.#find(idOrKey);
    if (r === null) return false;
    this.#open.delete(r.id);
    this.#retryAt.delete(r.id);
    this.#persist(r.id);
    this.#o.publish?.(structuredClone(r), "cancelled");
    return true;
  }

  /** She asked what a one-off timer was for, or it was answered: it is not needed any more. */
  wished(wish: Wish): void {
    if (wish.state === "open" || wish.end === "expired") return;
    for (const holder of wish.holders) {
      if (!holder.startsWith("reminder:")) continue;
      const r = this.#open.get(holder.slice("reminder:".length));
      if (r && !r.daily) this.cancel(r.id);
    }
  }

  /** Delivers what is due at `now` (one pass; passes never overlap). */
  tick(now = this.#now()): Promise<void> {
    if (this.#ticking !== null) return this.#ticking;
    this.#ticking = this.#pass(now).finally(() => {
      this.#ticking = null;
    });
    return this.#ticking;
  }

  async #pass(now: number): Promise<void> {
    for (const r of this.list()) {
      const due = Date.parse(r.due);
      if (due > now) break;
      if ((this.#retryAt.get(r.id) ?? 0) > now) continue;
      const late = Math.floor((now - due) / MINUTE_MS);
      if (!r.daily && now - due > MISSED_AFTER_MS) {
        this.#end(r, "done");
        log.info({ reminder: r.key, late }, "a timer was missed: dropped");
        continue;
      }
      let outcome: DeliveryOutcome;
      try {
        outcome = await this.#o.deliver(r, late);
      } catch (error) {
        outcome = { status: "held", detail: errorMessage(error) };
      }
      if (!this.#open.has(r.id)) continue; // cancelled meanwhile
      if (outcome.status === "held") {
        this.#retryAt.set(r.id, now + RETRY_MS);
        this.#o.publish?.(structuredClone(r), "held");
        log.debug({ reminder: r.key, detail: outcome.detail }, "a timer is held back");
        // A daily one that waited a whole day goes on with its next day.
        if (r.daily && now - due >= DAY_MS) this.#next(r, now, false);
        continue;
      }
      log.info({ reminder: r.key, status: outcome.status, detail: outcome.detail }, "timer due");
      this.#next(r, now, true);
    }
  }

  /** After it came due: a daily one moves to its next day, a one-off one ends. */
  #next(r: Reminder, now: number, fired: boolean): void {
    this.#retryAt.delete(r.id);
    const live = this.#open.get(r.id);
    if (!live) return;
    if (fired) live.fired += 1;
    if (!live.daily) {
      this.#end(live, fired ? "fired" : "done");
      return;
    }
    let due = Date.parse(live.due);
    while (due <= now) due += DAY_MS;
    live.due = toTimestamp(due);
    this.#persist(live.id);
    if (fired) this.#o.publish?.(structuredClone(live), "fired");
  }

  #end(r: Reminder, state: "fired" | "done"): void {
    this.#open.delete(r.id);
    this.#retryAt.delete(r.id);
    this.#persist(r.id);
    this.#o.publish?.(structuredClone(r), state);
  }

  /** How long until something may be due (at most a minute). */
  sleepMs(now = this.#now()): number {
    let next = now + MAX_SLEEP_MS;
    for (const r of this.#open.values()) {
      const at = Math.max(Date.parse(r.due), this.#retryAt.get(r.id) ?? 0);
      next = Math.min(next, at);
    }
    return Math.max(next - now, 1_000);
  }

  /** Delivers timers as they come due until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      const woken = new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      try {
        await Promise.race([sleep(this.sleepMs(), signal), woken]);
      } catch {
        return;
      } finally {
        this.#wake = null;
      }
    }
  }
}

// ---- delivery -----------------------------------------------------------------------------------

/** What the main line reads when a timer is due (her words decide what is said). */
export function reminderText(r: Reminder, late: number, offsetMinutes: number): string {
  const whose = r.for_account === null ? "你自己設的提醒" : "有人請你設的提醒";
  const when =
    late >= 5 ? `(本來是 ${localWhen(Date.parse(r.due), offsetMinutes)},晚了 ${late} 分鐘)` : "";
  return `${whose}到了:${r.what}${when}。要不要說、怎麼說由你決定。`;
}

/**
 * The real delivery: held while quiet hours apply or autonomy is paused; else a proposal to the
 * main line (V3), or an impulse for the Arbiter (V2). Nothing speaks from here.
 */
export function deliverer(
  services: ServiceLookup,
  clock: Clock,
  limits: ReminderLimits,
  offsetMinutes: number,
): Deliver {
  return async (r, late) => {
    const now = clock.now();
    const arbiter = services.get(ArbiterKey);
    const held = arbiter?.ledger(null).limits ?? null;
    if (held?.paused) return { status: "held", detail: "自主行動暫停中" };
    if (held?.quiet_hours?.active) return { status: "held", detail: "安靜時段" };
    const holdMs = limits.holdMins * MINUTE_MS;
    const what = reminderText(r, late, offsetMinutes);
    const why = `remind_me ${r.key}`;
    const attention = { key: `reminder:${r.id}`, revision: r.fired + 1, repeat_after_ms: holdMs };
    const board = services.get(ProposalBoardKey);
    if (board) {
      const outcome = await board.propose({
        what,
        why,
        expires: toTimestamp(now + holdMs),
        // Her own agenda coming due: the same row as a goal trigger firing.
        source: "agenda",
        context: r.context,
        about: r.for_account,
        person: r.person,
        goal: null,
        attention,
      });
      return outcome.state === "dropped"
        ? { status: "dropped", detail: outcome.detail }
        : { status: "delivered", detail: outcome.detail };
    }
    if (arbiter) {
      const decision = await arbiter.submit(
        newImpulse(
          {
            source: "agenda",
            context: r.context,
            person: r.person,
            account: r.for_account,
            ttlMs: holdMs,
            why,
            hint: what,
            about: r.for_account === null ? [] : [r.for_account],
            coalesce_key: `reminder:${r.id}`,
            reason: "reminder",
            attention,
          },
          now,
        ),
      );
      if (decision.verdict === "rejected" && decision.reason === "denied") {
        return { status: "dropped", detail: decision.detail };
      }
      return decision.verdict === "accepted" ||
        decision.verdict === "deferred" ||
        decision.verdict === "merged"
        ? { status: "delivered", detail: decision.detail }
        : { status: "held", detail: decision.detail };
    }
    return { status: "held", detail: "主線和 Arbiter 都沒有在跑" };
  };
}

// ---- the capability -----------------------------------------------------------------------------

const RemindArgs = z.object({
  action: z.enum(["set", "list", "cancel"]).optional(),
  what: z
    .string()
    .trim()
    .min(1)
    .max(MAX_WHAT * 2)
    .optional(),
  in_minutes: z.number().int().min(1).optional(),
  at: z.string().trim().min(1).max(40).optional(),
  daily: z.boolean().optional(),
  person: z.string().trim().max(40).optional(),
  id: z.string().trim().max(40).optional(),
});
type RemindArgs = z.output<typeof RemindArgs>;

function line(r: Reminder, offsetMinutes: number): string {
  const when = localWhen(Date.parse(r.due), offsetMinutes);
  return `${r.key} ${when}${r.daily ? "(每天)" : ""}:${r.what}`;
}

/** `self.remind`, tool `remind_me`. */
export function remindCapability(book: ReminderBook): Capability {
  return defineCapability<RemindArgs>({
    name: REMIND_CAPABILITY,
    summary: "設提醒",
    risk: "low",
    args: RemindArgs,
    permission: REMIND_NODE,
    tool: {
      name: "remind_me",
      description:
        "設一個提醒給自己:時間到了你會再想起這件事,到時候要不要說、怎麼說由你決定。" +
        "例如「二十分鐘後看一下烤箱」「明天 09:00 問 Owen 考試考得怎樣」,或別人請你提醒他的事。" +
        "action 預設 set;list 看還有哪些提醒;cancel 用 id 取消。" +
        '時間用 in_minutes(幾分鐘後)或 at("HH:MM" 是下一次到這個時間,或 "YYYY-MM-DD HH:MM",都是你的當地時間),二選一。' +
        "daily 設 true 會每天同一時間提醒。數量和最遠天數有上限。",
      properties: {
        action: { type: "string", enum: ["set", "list", "cancel"], description: "預設 set" },
        what: { type: "string", description: "要提醒的事(用你自己的話,一句)" },
        in_minutes: { type: "integer", description: "幾分鐘後" },
        at: { type: "string", description: '"HH:MM" 或 "YYYY-MM-DD HH:MM"(當地時間)' },
        daily: { type: "boolean", description: "每天同一時間(預設 false)" },
        person: { type: "string", description: "跟誰有關(可省略)" },
        id: { type: "string", description: "cancel 時要取消的提醒(例如 R7XK2P)" },
      },
    },
    async execute(args, ctx: ExecContext): Promise<ActionResult> {
      const offset = book.offsetMinutes;
      const p = ctx.principal;
      // A person may see and cancel the timers they asked for; she sees all of hers.
      const asker = p.kind === "self" ? null : p.requester;
      switch (args.action ?? "set") {
        case "list": {
          const open = asker === null ? book.list() : book.of(asker);
          const text =
            open.length === 0 ? "沒有在等的提醒。" : open.map((r) => line(r, offset)).join("\n");
          return { text, data: { reminders: open.map((r) => ({ ...r })) } as unknown as JsonValue };
        }
        case "cancel": {
          const r = args.id === undefined ? null : book.get(args.id);
          if (r === null) throw new CapabilityError("找不到這個提醒");
          const mine =
            asker === null || (r.for_account !== null && sameAccount(r.for_account, asker));
          if (!mine) throw new CapabilityError("這個提醒不是這個人設的,不能取消");
          book.cancel(r.id);
          return { text: `取消了 ${r.key}:${r.what}`, data: { id: r.id, key: r.key } };
        }
        case "set": {
          if (args.what === undefined) throw new CapabilityError("要提醒什麼沒有寫");
          const now = book.now();
          let due: number | null = null;
          if (args.in_minutes !== undefined && args.at !== undefined) {
            throw new CapabilityError("in_minutes 和 at 只能給一個");
          }
          if (args.in_minutes !== undefined) due = now + args.in_minutes * MINUTE_MS;
          else if (args.at !== undefined) {
            due = parseAt(args.at, now, offset);
            if (due === null) throw new CapabilityError(`看不懂時間「${args.at}」`);
          } else throw new CapabilityError("沒有說什麼時候(in_minutes 或 at)");
          try {
            const r = book.set({
              what: args.what,
              due,
              daily: args.daily === true,
              context: p.context,
              person: args.person ?? null,
              for_account: p.requester,
            });
            // Only set: 「好了」 alone read as the reminder going off, and she told Owen at 07:30
            // that a 10:30 reminder had rung (2026-11-12 23:38).
            return {
              text: `提醒設好了,還沒到時間,到時候才會提醒你:${line(r, offset)}`,
              data: { id: r.id, key: r.key, due: r.due },
            };
          } catch (error) {
            if (error instanceof ReminderError) throw new CapabilityError(error.message);
            throw error;
          }
        }
      }
    },
  }) as Capability;
}
