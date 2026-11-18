// A real ledger (SQLite in memory) and fakes of the rest of her, for the economy 2.0 tests: three
// people she knows (Alice with a second account, Bob, Carol who is blocked), one she never met.

import {
  ActuatorRegistry,
  ActuatorRegistryKey,
  type Capability,
  CapabilityTool,
} from "@miyoria/gate/actions";
import { getLogger, ServiceRegistry } from "@miyoria/runtime/kernel";
import { PeopleStoreKey, SqliteStore } from "@miyoria/store";
import {
  type AccountRef,
  AffectStateKey,
  AuthorizerKey,
  type ContextKey,
  EventLogKey,
  type JsonValue,
  ModerationKey,
  newId,
  type PersonId,
  Principals,
  type PublishedEvent,
  publishedInto,
  SelfStateKey,
  SocialSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, expect } from "vitest";
import { EconomyConfigSchema } from "../src/config.js";
import { EconomyDocsKey, MemoryDocs } from "../src/docs.js";
import { EconomyService } from "../src/economy.js";
import { CoinLedgerStoreKey, LedgerStatsKey } from "../src/records.js";
import { EconomyError, EconomyKey } from "../src/types.js";
import { economyOf, ledgerOf, walletOf } from "./ledger.js";

/** 2026-11-08 12:00 local (UTC+8). */
export const T0 = Date.UTC(2026, 10, 8, 4, 0, 0);
export const DAY = 86_400_000;
export const discord = (id: string): AccountRef => ({ platform: "discord", id });
export const ALICE = discord("1");
export const ALICE_TWO = discord("1b");
export const BOB = discord("2");
export const CAROL = discord("3"); // blocked
export const DAVE = discord("4"); // never met
export const ERIN = discord("5");
export const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };

export interface Rig {
  economy: EconomyService;
  store: SqliteStore;
  registry: ActuatorRegistry;
  services: ServiceRegistry;
  clock: { at: number };
  bus: PublishedEvent[];
  docs: MemoryDocs;
  /** What `random()` returns next (cycled); empty: `0.5`. */
  dice: { values: number[] };
  observed: { summary: string; source: string; key: string }[];
}

let stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores) await s.close();
  stores = [];
});

export interface RigOptions {
  /** Another service over a store an earlier rig opened: a restart. */
  store?: SqliteStore;
  /** Keep the documents and the ledger totals in the store itself (`rig.docs` is then unused). */
  durable?: boolean;
}

export async function rig(
  config: Record<string, JsonValue> = {},
  options: RigOptions = {},
): Promise<Rig> {
  const store = options.store ?? (await SqliteStore.open(":memory:"));
  if (!options.store) stores.push(store);
  const services = new ServiceRegistry();
  const k = "test";
  services.provide(k, CoinLedgerStoreKey, ledgerOf(store));
  services.provide(k, PeopleStoreKey, store.people);
  const ids = new Map<string, PersonId>();
  for (const [a, name] of [
    [ALICE, "Alice"],
    [BOB, "Bob"],
    [CAROL, "Carol"],
    [ERIN, "Erin"],
  ] as const) {
    ids.set(a.id, await store.people.upsertAccount(a, name));
  }
  await store.people.upsertAccount(ALICE_TWO, "Alice two");
  await store.identity.linkAccount(ALICE_TWO, ids.get(ALICE.id) as PersonId);
  services.provide(k, SocialSignalsKey, {
    attitude: (a: AccountRef) => ({ blocked: a.id === CAROL.id }) as never,
  });
  services.provide(k, AuthorizerKey, {
    allows: (_a: AccountRef, node: string) => node === "me.wallet",
  } as never);
  services.provide(k, AffectStateKey, { card: () => null, cards: () => [] } as never);
  services.provide(k, SelfStateKey, {
    drives: () => ({ hunger: 0.9 }),
    adjust: () => undefined,
  } as never);
  services.provide(k, ModerationKey, {
    screen: (c: { visible?: string }) => ({ ok: !/BADWORD/.test(c.visible ?? "") }),
    inspect: () => ({ action: "pass" }),
  } as never);
  const observed: Rig["observed"] = [];
  services.provide(k, EventLogKey, {
    observe: (o: { summary: string; source: string; attention_key: string }) => {
      observed.push({ summary: o.summary, source: o.source, key: o.attention_key });
      return {} as never;
    },
  } as never);
  const registry = new ActuatorRegistry({ services, builtins: false });
  services.provide(k, ActuatorRegistryKey, registry);
  const clock = { at: T0 };
  const bus: PublishedEvent[] = [];
  const dice = { values: [] as number[] };
  let n = 0;
  const docs = new MemoryDocs();
  services.provide(k, EconomyDocsKey, options.durable ? economyOf(store).docs : docs);
  if (options.durable) services.provide(k, LedgerStatsKey, ledgerOf(store));
  const economy = new EconomyService({
    config: EconomyConfigSchema.parse(config),
    services,
    profile: "p",
    clock: { now: () => clock.at },
    publish: publishedInto(bus),
    log: getLogger("test"),
    random: () =>
      dice.values.length === 0 ? 0.5 : (dice.values[n++ % dice.values.length] as number),
  });
  services.provide(k, EconomyKey, economy);
  return { economy, store, registry, services, clock, bus, docs, dice, observed };
}

/** Gives coins that count as nothing (a plain `talked` row, so no cap or achievement sees it). */
export async function fund(r: Rig, account: AccountRef, amount: number): Promise<void> {
  await ledgerOf(r.store).post({
    id: newId(),
    person: walletOf(r.store, account),
    delta: amount,
    reason: "admin_adjust",
    ref: "test",
    idem_key: null,
    ts: toTimestamp(r.clock.at),
  });
}

export const balance = (r: Rig, a: AccountRef) =>
  ledgerOf(r.store).balance("p", walletOf(r.store, a));

export async function rejects(p: Promise<unknown>, status: number, message?: string | RegExp) {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EconomyError);
  expect((error as EconomyError).status).toBe(status);
  if (message !== undefined) expect((error as EconomyError).message).toMatch(message);
}

/** One of her tools, called in a turn where `speaker` wrote message `id`, through the gate. */
export async function say(
  r: Rig,
  capabilities: readonly Capability[],
  tool: string,
  speaker: AccountRef,
  id: string,
  args: Record<string, JsonValue> = {},
  own = false,
  context: ContextKey = TEXT,
): Promise<{ text: string; data: Record<string, JsonValue> }> {
  const capability = capabilities.find((c) => c.tool?.name === tool);
  if (!capability) throw new Error(`no tool ${tool}`);
  if (!r.registry.get(capability.name)) r.registry.register(capability);
  let data: JsonValue = null;
  const text = await new CapabilityTool(
    r.registry,
    r.registry.get(capability.name) ?? capability,
  ).call(
    {
      turn: `turn-${id}`,
      context,
      account: speaker,
      principal: Principals.user(speaker, context),
      message: { context, id },
      priority: "request",
      signal: new AbortController().signal,
      report: (d) => {
        data = d;
      },
    },
    own ? { on_own: true, why: "測試", ...args } : args,
  );
  return { text, data: (data ?? {}) as Record<string, JsonValue> };
}
