// The method guard (docs/design/v4-plan.md §11.2 item 5): a method that keeps failing is held, so
// she has to change method instead of asking again.
//
// A method is an action with the item it is about (`obtain:bread`, `mine:oak_log`,
// `hunt:cow`), not its parameter string: on 2026-11-08 `obtain bread` failed 35 times and the
// old guard (goto / mine / look / attack for 45 s, cleared by any success, even `stop`) never
// held it. A success of another method does not clear a hold by itself; only progress with the
// same method does. An answer that the item cannot be had that way at all (`invalid`, e.g. "no
// crafting recipe makes apple") holds it for the rest of the session at once. A goal that ran
// out of attempts holds its item as a goal (`goal:<item>`), so it is not proposed again four
// seconds later.
//
// When a hold ends (`method_release`). The first version let a hold run out after ten minutes,
// and on the replay of 11-08 `obtain bread` still failed 9 times: the hold ran out and the same
// ask came back unchanged, two failures per ten minutes. Now (`changed`) a held method comes back
// only when something changed that could make it work:
//
// * it said what was missing (`precondition`, the item ids in its answer: "還缺 小麥 wheat×3"),
//   and that is in her inventory now;
// * it said something was missing but not what: something new is in her inventory and the hold
//   is at least `method_hold_secs` old;
// * it could not find or reach something, or did nothing (`not_found`, `unreachable`,
//   `no_progress`, a timeout...): another method got her somewhere since (she moved, saw
//   something new, got something).
//
// What came back and fails again is held again at once: the change did not help. Two failures of a
// method in a row hold it, whatever their codes: with the release tied to a change, the second
// ask of the same thing unchanged is already the loop. Pure; times are epoch ms.

import type { JsonObject, JsonValue } from "@miyoria/types";
import type { GameConfig } from "./config.js";

/** Failure codes that say the method cannot work for this item at all: one is enough. */
export const FINAL_CODES: readonly string[] = ["invalid"];

/** Codes that are not the method failing (her body was taken, someone stopped it). */
export const INTERRUPTION_CODES: readonly string[] = [
  "busy",
  "cancelled",
  "superseded",
  "died",
  "disconnected",
  "crashed",
];

/** Codes that say something was missing: only having it changes that. */
export const MISSING_CODES: readonly string[] = ["precondition"];

/** `"Oak Log"`, `"minecraft:oak_log"` → `"oak_log"`. */
export function normalizeItem(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, "")
    .replace(/\s+/g, "_");
}

function str(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? normalizeItem(value) : null;
}

/** The item (or block, creature) an action is about, if it names one. */
export function itemOf(args: JsonObject): string | null {
  const one = str(args.item) ?? str(args.block) ?? str(args.entity);
  if (one !== null) return one;
  if (Array.isArray(args.blocks)) {
    const blocks = args.blocks.flatMap((b) => str(b) ?? []).sort();
    if (blocks.length > 0) return blocks.join("+");
  }
  if (Array.isArray(args.find)) {
    const found = args.find.flatMap((b) => str(b) ?? []).sort();
    if (found.length > 0) return found.join("+");
  }
  return str(args.find);
}

/** The method of an action: `obtain:bread`, `explore`, `goto:crafting_table`. */
export function methodKey(name: string, args: JsonObject): string {
  const item = itemOf(args);
  return item === null ? name : `${name}:${item}`;
}

/** Item ids a failure names as missing (`還缺 小麥 wheat×3` → `wheat`). */
export function namedItems(why: string): Set<string> {
  return new Set((why.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).map(normalizeItem));
}

const GOAL_PREFIX = "goal:";

export interface MethodHold {
  method: string;
  code: string;
  /** What the game said the last time (game data: escaped where it is shown). */
  why: string;
  /** When it was held. */
  since: number;
  /** `time` release: when it runs out; `changed`: the least it lasts when what is missing is unknown. */
  until: number;
  /** A held proposal already asked for a quick new decision (once per hold). */
  nudged: boolean;
  /** Item ids it said were missing (empty: it did not say). */
  needs: Set<string>;
  /** Something changed since that may help (a new item, another method's progress). */
  changed: boolean;
}

/** What changed in her world: an item that is new, an item gained, another method's progress. */
export interface WorldChange {
  /** Items her inventory gained (id → count). */
  gained: Readonly<Record<string, number>>;
  /** Of those, items she did not have at all before. */
  fresh: readonly string[];
  /** The method that made progress, if one did. */
  progressed: string | null;
}

type MethodConfig = Pick<GameConfig, "method_repeat_limit" | "method_hold_secs" | "method_release">;

export class MethodGuard {
  readonly #cfg: MethodConfig;
  /** The last failure code of each method and how many times in a row it came. */
  readonly #fails = new Map<string, { code: string; n: number }>();
  readonly #held = new Map<string, MethodHold>();
  /** Methods that came back after a change: one more failure holds them again. */
  readonly #released = new Set<string>();
  /** Her inventory as last seen, for what is new. */
  #inventory: Record<string, number> | null = null;

  constructor(cfg: MethodConfig) {
    this.#cfg = cfg;
  }

  get #byChange(): boolean {
    return (this.#cfg.method_release ?? "changed") === "changed";
  }

  /**
   * `method` failed with `code` (`no_progress`: it ended without changing anything). Returns
   * the hold this failure started, if it did.
   */
  failed(method: string, code: string, why: string, now: number): MethodHold | null {
    if (this.#cfg.method_repeat_limit <= 0 || INTERRUPTION_CODES.includes(code)) return null;
    // A parameter mistake of an action without an item (`goto` without coordinates) is not the
    // method being impossible: only item methods are held for good.
    if (FINAL_CODES.includes(code) && method.includes(":")) {
      return this.#hold(method, code, why, now, Number.POSITIVE_INFINITY);
    }
    if (this.#byChange && this.#released.delete(method)) {
      // It came back after a change and failed again: the change did not help.
      this.#fails.delete(method);
      return this.#hold(method, code, why, now, now + this.#cfg.method_hold_secs * 1000);
    }
    const prev = this.#fails.get(method);
    // `changed`: two failures in a row, whatever the codes. `time`: the same code twice.
    const n = prev !== undefined && (this.#byChange || prev.code === code) ? prev.n + 1 : 1;
    this.#fails.set(method, { code, n });
    if (n < this.#cfg.method_repeat_limit || this.#cfg.method_hold_secs <= 0) return null;
    this.#fails.delete(method);
    return this.#hold(method, code, why, now, now + this.#cfg.method_hold_secs * 1000);
  }

  #hold(method: string, code: string, why: string, now: number, until: number): MethodHold {
    const hold: MethodHold = {
      method,
      code,
      why,
      since: now,
      until,
      nudged: false,
      needs: MISSING_CODES.includes(code) ? namedItems(why) : new Set(),
      changed: false,
    };
    this.#held.set(method, hold);
    return hold;
  }

  /** `method` got her somewhere: its failures and hold are over. Other methods stay held. */
  progressed(method: string): void {
    this.#fails.delete(method);
    this.#held.delete(method);
    this.#released.delete(method);
  }

  /**
   * Something changed in her world: holds it could help are released (or, when what was missing
   * is not known, marked so they end once they are old enough).
   */
  changed(change: WorldChange): void {
    if (!this.#byChange) return;
    const gained = Object.keys(change.gained).filter((k) => (change.gained[k] ?? 0) > 0);
    for (const hold of [...this.#held.values()]) {
      if (!Number.isFinite(hold.until) || hold.method === change.progressed) continue;
      if (MISSING_CODES.includes(hold.code)) {
        if (hold.needs.size > 0) {
          if (gained.some((g) => hold.needs.has(g))) this.#release(hold);
        } else if (change.fresh.length > 0) {
          hold.changed = true;
        }
      } else if (change.progressed !== null || gained.length > 0) {
        this.#release(hold);
      }
    }
  }

  /**
   * Her inventory as the game shows it now: what is in it that was not before, or more of it, is
   * a change (whoever's step or reflex got it).
   */
  seen(inventory: Record<string, number> | null, progressed: string | null = null): void {
    if (inventory === null) return;
    const before = this.#inventory;
    this.#inventory = { ...inventory };
    if (before === null) return;
    const gained: Record<string, number> = {};
    const fresh: string[] = [];
    for (const [item, n] of Object.entries(inventory)) {
      const had = before[item] ?? 0;
      if (n > had) gained[item] = n - had;
      if (had <= 0 && n > 0) fresh.push(item);
    }
    if (Object.keys(gained).length > 0 || progressed !== null) {
      this.changed({ gained, fresh, progressed });
    }
  }

  #release(hold: MethodHold): void {
    this.#held.delete(hold.method);
    this.#released.add(hold.method);
  }

  /** The hold on `method` right now, if any. */
  held(method: string, now: number): MethodHold | null {
    const hold = this.#held.get(method);
    if (!hold) return null;
    if (!Number.isFinite(hold.until)) return hold;
    const due = now >= hold.until;
    if (!this.#byChange && due) {
      this.#held.delete(method);
      return null;
    }
    if (due && hold.changed) {
      this.#release(hold);
      return null;
    }
    return hold;
  }

  /** A goal for `item` ran out of attempts: proposing it again waits like a method. */
  holdGoal(item: string, code: string, why: string, now: number): MethodHold | null {
    if (this.#cfg.method_hold_secs <= 0) return null;
    return this.#hold(
      `${GOAL_PREFIX}${item}`,
      code,
      why,
      now,
      now + this.#cfg.method_hold_secs * 1000,
    );
  }

  goalHeld(item: string, now: number): MethodHold | null {
    return this.held(`${GOAL_PREFIX}${item}`, now);
  }

  /** The goal for `item` was reached after all. */
  goalReached(item: string): void {
    this.#held.delete(`${GOAL_PREFIX}${item}`);
    this.#released.delete(`${GOAL_PREFIX}${item}`);
  }

  /** Every hold in force, oldest first. */
  holds(now: number): MethodHold[] {
    return [...this.#held.keys()].flatMap((m) => this.held(m, now) ?? []);
  }

  /** What has to change before it comes back, in her terms. */
  #until(h: MethodHold, now: number): string {
    if (!Number.isFinite(h.until)) return "這場不能再用";
    if (!this.#byChange) return `暫停 ${Math.max(1, Math.ceil((h.until - now) / 60_000))} 分鐘`;
    if (MISSING_CODES.includes(h.code)) {
      return h.needs.size > 0 ? `等拿到 ${[...h.needs].join("、")} 再試` : "等缺的東西拿到了再試";
    }
    return "等別的做法有進展再試";
  }

  /** Prompt lines for the holds in force (the reasons are game data; the caller escapes them). */
  lines(now: number): string[] {
    return this.holds(now).map((h) => {
      const what = h.method.startsWith(GOAL_PREFIX)
        ? `目標「${h.method.slice(GOAL_PREFIX.length)}」`
        : h.method;
      return `${what}(${this.#until(h, now)}):${h.code},${h.why}`;
    });
  }
}
