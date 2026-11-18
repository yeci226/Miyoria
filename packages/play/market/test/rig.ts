// A real store (SQLite in memory) with the market's tables and an in-memory wallet that keeps the
// economy's rules (keyed rows, refunds once, a cap over the charges that stand, holds and
// releases), so the market's service is tested on its own. The economy's real wallet is tested in
// `packages/economy/test/market-wallet.test.ts`.

import type { CommandReply } from "@miyoria/commands";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import {
  type AccountRef,
  accountRefString,
  type MarketCap,
  type MarketCharge,
  type MarketChargeReason,
  type MarketPerson,
  type MarketWallet,
  type MemberPictureResult,
  type PersonId,
  type PictureDataMap,
  type PictureFile,
  type PictureKind,
  type Pictures,
  type SongTickets,
} from "@miyoria/types";
import { afterEach } from "vitest";
import { type MarketConfig, marketConfig } from "../src/config.js";
import type { LotPicker } from "../src/lots.js";
import { marketSchema } from "../src/migrations.js";
import { type CallNames, MarketService } from "../src/service.js";
import { MarketStore } from "../src/store.js";

/** Tuesday 2026-11-17 12:00 local (UTC+8). The lot opens Saturday 11-21 20:00, the draw is Sunday 11-22 20:00. */
export const T0 = Date.UTC(2026, 10, 17, 4, 0, 0);
export const OPENS = Date.UTC(2026, 10, 21, 12, 0, 0);
export const DRAW = Date.UTC(2026, 10, 22, 12, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const discord = (id: string): AccountRef => ({ platform: "discord", id });
export const ALICE = discord("1");
export const ALICE_TWO = discord("1b");
export const BOB = discord("2");
export const CAROL = discord("3");
export const DAVE = discord("4");
export const ERIN = discord("5");
/** Never met. */
export const STRANGER = discord("9");
/** Her own account. */
export const HER = discord("0");

const PEOPLE: Record<string, MarketPerson> = {
  "discord:0": { person: "p-her", name: "她" },
  "discord:1": { person: "p-alice", name: "Alice" },
  "discord:1b": { person: "p-alice", name: "Alice two" },
  "discord:2": { person: "p-bob", name: "Bob" },
  "discord:3": { person: "p-carol", name: "Carol" },
  "discord:4": { person: "p-dave", name: "Dave" },
  "discord:5": { person: "p-erin", name: "Erin" },
};

interface Row {
  id: string;
  person: PersonId;
  delta: number;
  reason: string;
  key: string;
  ref: string | null;
  at: number;
}

const NOT_KNOWN = "她還不認識你,先和她說說話吧";

const REFUND_OF: Record<string, string> = {
  song_priority: "song_priority_refund",
  lottery_ticket: "lottery_refund",
};

export class FakeWallet implements MarketWallet {
  readonly currency = "魚幣";
  readonly rows: Row[] = [];
  #n = 0;
  /** While set, every call throws (the economy is down). */
  down = false;
  /** While set, a charge is written and then the call throws (the Core stopped right after). */
  throwAfterCharge = false;

  constructor(private readonly clock: { at: number }) {}

  #who(account: AccountRef): MarketPerson | null {
    if (this.down) throw new Error("the economy is down");
    return PEOPLE[accountRefString(account)] ?? null;
  }

  #byKey(person: PersonId, key: string): Row | undefined {
    return this.rows.find((r) => r.person === person && r.key === key);
  }

  #post(person: PersonId, delta: number, reason: string, key: string, ref: string | null): Row {
    const found = this.#byKey(person, key);
    if (found) return found;
    const row = { id: `row${++this.#n}`, person, delta, reason, key, ref, at: this.clock.at };
    this.rows.push(row);
    return row;
  }

  balanceOf(person: PersonId): number {
    return this.rows.filter((r) => r.person === person).reduce((n, r) => n + r.delta, 0);
  }

  fund(account: AccountRef, amount: number): void {
    const who = this.#who(account) as MarketPerson;
    this.#post(who.person, amount, "fund", `fund${++this.#n}`, null);
  }

  async member(account: AccountRef): Promise<MarketPerson | null> {
    return this.#who(account);
  }

  async balance(account: AccountRef): Promise<number | null> {
    const who = this.#who(account);
    return who === null ? null : this.balanceOf(who.person);
  }

  async charge(
    account: AccountRef,
    amount: number,
    reason: MarketChargeReason,
    key: string,
    ref: string | null,
    cap?: MarketCap,
  ): Promise<MarketCharge> {
    const who = this.#who(account);
    if (who === null) return { ok: false, reason: "refused", message: NOT_KNOWN };
    const first = this.#byKey(who.person, `${reason}:${key}`);
    if (first) {
      if (this.#byKey(who.person, `refund:${first.id}`)) {
        return { ok: false, reason: "refused", message: "這筆已經退回了,請再試一次" };
      }
      return { ok: true, receipt: first.id, balance: this.balanceOf(who.person) };
    }
    if (cap) {
      const since = Date.parse(cap.since);
      const standing = this.rows.filter(
        (r) =>
          r.person === who.person &&
          r.reason === reason &&
          r.at >= since &&
          !this.#byKey(who.person, `refund:${r.id}`),
      ).length;
      if (standing >= cap.limit) return { ok: false, reason: "capped", message: "capped" };
    }
    const balance = this.balanceOf(who.person);
    if (balance < amount) return { ok: false, reason: "insufficient", balance };
    const row = this.#post(who.person, -amount, reason, `${reason}:${key}`, ref);
    if (this.throwAfterCharge) throw new Error("stopped after the charge");
    return { ok: true, receipt: row.id, balance: this.balanceOf(who.person) };
  }

  async charged(account: AccountRef, reason: MarketChargeReason, key: string): Promise<boolean> {
    const who = this.#who(account);
    if (who === null) return false;
    const first = this.#byKey(who.person, `${reason}:${key}`);
    return first !== undefined && !this.#byKey(who.person, `refund:${first.id}`);
  }

  async refund(account: AccountRef, reason: MarketChargeReason, key: string): Promise<number> {
    const who = this.#who(account);
    if (who === null) return 0;
    const charge = this.#byKey(who.person, `${reason}:${key}`);
    if (!charge || this.#byKey(who.person, `refund:${charge.id}`)) return 0;
    const back = REFUND_OF[reason] ?? "refund";
    this.#post(who.person, -charge.delta, back, `refund:${charge.id}`, charge.id);
    return -charge.delta;
  }

  async hold(
    account: AccountRef,
    amount: number,
    key: string,
    ref: string | null,
  ): Promise<MarketCharge> {
    const who = this.#who(account);
    if (who === null) return { ok: false, reason: "refused", message: NOT_KNOWN };
    const first = this.#byKey(who.person, `auction_hold:${key}`);
    if (first) return { ok: true, receipt: first.id, balance: this.balanceOf(who.person) };
    const balance = this.balanceOf(who.person);
    if (balance < amount) return { ok: false, reason: "insufficient", balance };
    const row = this.#post(who.person, -amount, "auction_hold", `auction_hold:${key}`, ref);
    return { ok: true, receipt: row.id, balance: this.balanceOf(who.person) };
  }

  async release(account: AccountRef, key: string): Promise<number> {
    const who = this.#who(account);
    if (who === null) return 0;
    const held = this.#byKey(who.person, `auction_hold:${key}`);
    if (!held || this.#byKey(who.person, `release:${held.id}`)) return 0;
    this.#post(who.person, -held.delta, "auction_release", `release:${held.id}`, held.id);
    return -held.delta;
  }

  async burn(
    account: AccountRef,
    amount: number,
    key: string,
    ref: string | null,
  ): Promise<boolean> {
    const who = this.#who(account);
    if (who === null) return false;
    this.#post(who.person, -amount, "auction_won", `auction_won:${key}`, ref);
    return true;
  }

  async pay(
    account: AccountRef,
    amount: number,
    key: string,
    ref: string | null,
  ): Promise<boolean> {
    const who = this.#who(account);
    if (who === null) return false;
    this.#post(who.person, amount, "lottery_prize", `lottery_prize:${key}`, ref);
    return true;
  }
}

export interface Rig {
  service: MarketService;
  store: MarketStore;
  raw: TestDb;
  wallet: FakeWallet;
  clock: { at: number };
  posted: { channel: string; reply: CommandReply }[];
  told: { summary: string; key: string; person: PersonId | null }[];
  calls: Map<PersonId, string | null>;
  /** What the CSPRNG gives next. */
  dice: number[];
  /** While set, the economy's wallet is not there (`MarketWalletKey` absent). */
  walletGone: boolean;
  /** Restarts the service over the same store (a new process). */
  restart(config?: Partial<MarketConfig>): MarketService;
  /**
   * The singer's set list as the pass sees it (`SongTicketsKey`): the keys it holds; `songs.read`
   * false: it has not read its stored list back yet; `songsGone`: the singer is not running.
   */
  songs: FakeSongs;
  songsGone: boolean;
}

/** The singer's side of the song priority ticket. */
export class FakeSongs implements SongTickets {
  readonly held = new Set<string>();
  read = true;
  holds(key: string): boolean | null {
    return this.read ? this.held.has(key) : null;
  }
}

let dbs: TestDb[] = [];
afterEach(() => {
  for (const d of dbs) d.close();
  dbs = [];
});

export interface RigOptions {
  picker?: LotPicker | null;
  /** Names refused by the screen. */
  unfit?: RegExp;
  /** People she cannot stand. */
  refuses?: PersonId[];
  names?: boolean;
  /** The picture renderer (`PicturesKey`); none by default. */
  pictures?: Pictures | null;
  /** Posts that carry files fail (the channel takes no uploads). */
  noUploads?: boolean;
  /** Setting what she calls someone throws this many times first (the Core stopped there). */
  nameSetFails?: number;
}

/** A renderer that records what it was asked to draw and answers a tiny PNG with an alt line. */
export class FakePictures implements Pictures {
  readonly drawn: { kind: PictureKind; data: PictureDataMap[PictureKind] }[] = [];
  /** `null`: it cannot draw; `"hang"`: it never answers; `"throw"`: it throws. */
  mode: "ok" | "null" | "hang" | "throw" = "ok";

  async render<K extends PictureKind>(
    kind: K,
    data: PictureDataMap[K],
  ): Promise<PictureFile | null> {
    this.drawn.push({ kind, data });
    if (this.mode === "null") return null;
    if (this.mode === "throw") throw new Error("cannot draw");
    if (this.mode === "hang") return new Promise<PictureFile | null>(() => undefined);
    return {
      name: `miyoria-${kind}.png`,
      data: new Uint8Array([137, 80, 78, 71]),
      contentType: "image/png",
      alt: `${kind} 的摘要`,
      artifact_id: null,
    };
  }

  async forMember(): Promise<MemberPictureResult | null> {
    return null;
  }
}

export async function rig(
  config: Partial<MarketConfig> = {},
  options: RigOptions = {},
): Promise<Rig> {
  const clock = { at: T0 };
  const raw = openTestDb({
    identity: true,
    plugins: [marketSchema],
    clock: { now: () => clock.at },
  });
  dbs.push(raw);
  const store = new MarketStore(raw.db, raw.events);
  const wallet = new FakeWallet(clock);
  const posted: Rig["posted"] = [];
  const told: Rig["told"] = [];
  const calls = new Map<PersonId, string | null>();
  const dice: number[] = [];
  let setFails = options.nameSetFails ?? 0;
  const names: CallNames = {
    get: (p) => calls.get(p) ?? null,
    set: (p, n) => {
      if (setFails > 0) {
        setFails -= 1;
        throw new Error("stopped before the name was set");
      }
      calls.set(p, n);
    },
    refuses: (p) => options.refuses?.includes(p) ?? false,
  };
  let n = 0;
  const make = (overrides: Partial<MarketConfig>) =>
    new MarketService({
      config: marketConfig({ auction_channel: "100", ...config, ...overrides }),
      store,
      wallet: () => (r.walletGone ? null : wallet),
      now: () => clock.at,
      isSelf: (a) => a.id === HER.id,
      names: options.names === false ? null : names,
      screenName: async (name) =>
        options.unfit?.test(name) ? "這個稱呼不適合，請換一個。" : name.length > 20 ? "太長" : null,
      picker: options.picker ?? null,
      post: async (channel, reply) => {
        if (options.noUploads && (reply.files?.length ?? 0) > 0) return null;
        posted.push({ channel, reply });
        return `m${++n}`;
      },
      pictures: () => options.pictures ?? null,
      songTickets: () => (r.songsGone ? null : r.songs),
      tell: (summary, key, person) => told.push({ summary, key, person }),
      log: { info: () => undefined, warn: () => undefined },
      randomInt: (max) => {
        const v = dice.shift() ?? 0;
        if (v >= max) throw new Error(`die ${v} >= ${max}`);
        return v;
      },
    });
  const r: Rig = {
    service: make({}),
    store,
    raw,
    wallet,
    clock,
    posted,
    told,
    calls,
    dice,
    walletGone: false,
    songs: new FakeSongs(),
    songsGone: false,
    restart: (overrides = {}) => {
      r.service = make(overrides);
      return r.service;
    },
  };
  return r;
}

/** Every text of a posted card, joined. */
export function textOf(reply: CommandReply): string {
  return reply.text;
}
