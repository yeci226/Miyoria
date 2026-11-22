// A real store (SQLite in memory) with the exchange's tables and an in-memory wallet that keeps
// the economy's rules (a posting's rows together or not at all, once per first key, a covered
// posting refused below zero, someone blocked only a holder), so the exchange's service is tested
// on its own. The economy's real wallet is tested in `packages/economy/test/exchange-wallet.test.ts`.
// Every name here is made up.

import { openTestDb, type TestDb } from "@miyoria/store/testing";
import {
  type AccountRef,
  accountRefString,
  type ExchangeEntry,
  type ExchangePerson,
  type ExchangePost,
  type ExchangeWallet,
  type PersonId,
  type Timestamp,
} from "@miyoria/types";
import { afterEach } from "vitest";
import { type ExchangeConfig, exchangeConfig } from "../src/config.js";
import { exchangeSchema } from "../src/migrations.js";
import type { QuoteProvider } from "../src/real/provider.js";
import {
  type ExchangeDeps,
  ExchangeService,
  type TraderInfo,
  type Traders,
} from "../src/service.js";
import { ExchangeStore } from "../src/store.js";

/** Monday 2026-11-23 11:30 local (UTC+8): the first round is at 12:00. */
export const T0 = Date.UTC(2026, 10, 23, 3, 30, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const discord = (id: string): AccountRef => ({ platform: "discord", id });
export const ALICE = discord("1");
export const ALICE_ALT = discord("1b");
export const BOB = discord("2");
export const CAROL = discord("3");
/** Blocked: a holder, not a member. */
export const MALLORY = discord("6");
/** Known for two days only. */
export const NEWBIE = discord("7");
export const OWNER = discord("8");
export const STRANGER = discord("9");
export const HER = discord("0");

const PEOPLE: Record<string, { person: PersonId; name: string; blocked?: boolean }> = {
  "discord:0": { person: "p-her", name: "她" },
  "discord:1": { person: "p-alice", name: "Alice" },
  "discord:1b": { person: "p-alice", name: "Alice 的分身" },
  "discord:2": { person: "p-bob", name: "Bob" },
  "discord:3": { person: "p-carol", name: "Carol" },
  "discord:6": { person: "p-mallory", name: "Mallory", blocked: true },
  "discord:7": { person: "p-newbie", name: "Newbie" },
  "discord:8": { person: "p-owner", name: "Owner" },
};

export const INFO: Record<string, TraderInfo> = {
  "p-her": { known_days: 400, tier: 9, insider: false, self: true },
  "p-alice": { known_days: 60, tier: 2, insider: false, self: false },
  "p-bob": { known_days: 40, tier: 1, insider: false, self: false },
  "p-carol": { known_days: 10, tier: 0, insider: false, self: false },
  "p-mallory": { known_days: 90, tier: 1, insider: false, self: false },
  "p-newbie": { known_days: 2, tier: 0, insider: false, self: false },
  "p-owner": { known_days: 900, tier: 5, insider: true, self: false },
};

interface Row {
  person: PersonId;
  reason: string;
  delta: number;
  key: string;
  ref: string;
  at: number;
}

export class FakeWallet implements ExchangeWallet {
  /** The economy's coin name (`[modules.economy] currency`). */
  currency = "魚幣";
  /** The shared economy rate (`[modules.economy] twd_per_coin`): NT$ per coin. */
  twdPerCoin = 1;
  readonly rows: Row[] = [];
  /** While set, every call throws (the economy is down). */
  down = false;
  /** While set, a posting is written and then the call throws (Core stopped right after). */
  throwAfterPost = false;
  /** While set, a posting throws before anything is written (Core stopped right before). */
  throwBeforePost = false;

  constructor(private readonly clock: { at: number }) {}

  #check(): void {
    if (this.down) throw new Error("the economy is down");
  }

  balanceOf(person: PersonId): number {
    return this.rows.filter((r) => r.person === person).reduce((t, r) => t + r.delta, 0);
  }

  fund(account: AccountRef, amount: number, reason = "fund"): void {
    const who = PEOPLE[accountRefString(account)];
    if (!who) throw new Error("unknown");
    this.rows.push({
      person: who.person,
      reason,
      delta: amount,
      key: `fund:${this.rows.length}`,
      ref: "",
      at: this.clock.at,
    });
  }

  /** Every row of the exchange's reasons, summed: what went out of wallets into the exchange. */
  exchangeNet(): number {
    return this.rows
      .filter((r) => r.reason.startsWith("exchange_"))
      .reduce((t, r) => t + r.delta, 0);
  }

  async member(account: AccountRef): Promise<ExchangePerson | null> {
    this.#check();
    const who = PEOPLE[accountRefString(account)];
    return who && !who.blocked ? { person: who.person, name: who.name } : null;
  }

  async holder(account: AccountRef): Promise<ExchangePerson | null> {
    this.#check();
    const who = PEOPLE[accountRefString(account)];
    return who ? { person: who.person, name: who.name } : null;
  }

  async balance(person: PersonId): Promise<number> {
    this.#check();
    return this.balanceOf(person);
  }

  async transferredIn(person: PersonId, since: Timestamp): Promise<number> {
    this.#check();
    const from = Date.parse(since);
    return this.rows
      .filter((r) => r.person === person && r.reason === "transfer_in" && r.at >= from)
      .reduce((t, r) => t + r.delta, 0);
  }

  async post(
    person: PersonId,
    entries: readonly ExchangeEntry[],
    ref: string,
    covered: boolean,
  ): Promise<ExchangePost> {
    this.#check();
    if (this.throwBeforePost) throw new Error("stopped before the posting");
    const first = entries[0];
    if (!first) return { ok: true, balance: this.balanceOf(person), duplicate: true };
    if (this.rows.some((r) => r.person === person && r.key === first.key)) {
      return { ok: true, balance: this.balanceOf(person), duplicate: true };
    }
    const sum = entries.reduce((t, e) => t + e.delta, 0);
    if (covered && this.balanceOf(person) + sum < 0)
      return { ok: false, reason: "short", balance: this.balanceOf(person) };
    for (const e of entries)
      this.rows.push({
        person,
        reason: e.reason,
        delta: e.delta,
        key: e.key,
        ref,
        at: this.clock.at,
      });
    if (this.throwAfterPost) throw new Error("stopped after the posting");
    return { ok: true, balance: this.balanceOf(person), duplicate: false };
  }

  async posted(person: PersonId, key: string): Promise<boolean> {
    this.#check();
    return this.rows.some((r) => r.person === person && r.key === key);
  }

  /** Every coin in every wallet. */
  async circulation(): Promise<number> {
    this.#check();
    return this.rows.reduce((t, r) => t + r.delta, 0);
  }
}

export interface Rig {
  service: ExchangeService;
  store: ExchangeStore;
  raw: TestDb;
  wallet: FakeWallet;
  clock: { at: number };
  dms: { person: PersonId; text: string }[];
  audits: { action: string; target: string; detail: Record<string, unknown>; by: string }[];
  /** While set, the economy's wallet is not there. */
  walletGone: boolean;
  /** A new service over the same store (a new process). */
  restart(config?: Partial<ExchangeConfig>): ExchangeService;
  /** Moves the clock and runs the pass. */
  at(ms: number): Promise<void>;
  /** Runs the pass every round from now until `ms`. */
  runTo(ms: number): Promise<void>;
}

let dbs: TestDb[] = [];
afterEach(() => {
  for (const d of dbs) d.close();
  dbs = [];
});

export const OPEN: Partial<ExchangeConfig> = {
  open: true,
  leverage: true,
  local_enabled: true,
  local_leverage: true,
};

export async function rig(
  config: Partial<ExchangeConfig> = OPEN,
  providers?: ReadonlyMap<string, QuoteProvider>,
  /** The profile's words (`[character]`, the coins' name); none: the first character's. */
  words: Partial<Pick<ExchangeDeps, "name" | "currency" | "pronoun">> = {},
): Promise<Rig> {
  const clock = { at: T0 };
  const raw = openTestDb({
    identity: true,
    plugins: [exchangeSchema],
    clock: { now: () => clock.at },
  });
  dbs.push(raw);
  const store = new ExchangeStore(raw.db);
  const wallet = new FakeWallet(clock);
  const dms: Rig["dms"] = [];
  const audits: Rig["audits"] = [];
  const traders: Traders = {
    about: async (_account, person) =>
      INFO[person] ?? { known_days: 0, tier: -1, insider: false, self: false },
    name: async (person) => Object.values(PEOPLE).find((p) => p.person === person)?.name ?? null,
  };
  const r: Rig = {
    service: null as unknown as ExchangeService,
    store,
    raw,
    wallet,
    clock,
    dms,
    audits,
    walletGone: false,
    restart: (more = {}) => {
      r.service = new ExchangeService({
        config: exchangeConfig({ ...config, ...more }),
        store,
        wallet: () => (r.walletGone ? null : wallet),
        traders,
        now: () => clock.at,
        log: silent,
        dm: async (person, text) => {
          dms.push({ person, text });
          return true;
        },
        audit: (action, target, detail, by) => audits.push({ action, target, detail, by }),
        seed: "test-seed",
        ...(providers ? { providers } : {}),
        ...words,
      });
      return r.service;
    },
    at: async (ms) => {
      clock.at = ms;
      await r.service.tick();
    },
    runTo: async (ms) => {
      // One pass a minute after each hour, the way the module's pass reaches each round.
      while (clock.at < ms) {
        clock.at = Math.min(ms, Math.floor(clock.at / HOUR) * HOUR + HOUR + MIN);
        await r.service.tick();
      }
    },
  };
  r.restart();
  return r;
}

const noop = () => undefined;
export const silent = {
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  child: () => silent,
} as never;

/** The local hour `h` (UTC+8) of the day `d` days after T0's day. */
export function local(d: number, h: number, m = 0): number {
  return Date.UTC(2026, 10, 23 + d, h - 8, m, 0);
}
