// Two servers she was already in before the upgrade (both established by identity v4) and one
// cluster-level market: the job the one market of before ran (the auction and the lottery in the
// configured channel) runs exactly once, in the Space that owns the channel, through Core's real
// `PlaceConfig` channel rule. A server first seen after the upgrade runs nothing.

import { DatabaseSync } from "node:sqlite";
import {
  type MarketConfig,
  MarketConfigSchema,
  MarketRegistry,
  MarketStore,
  marketSchema,
} from "@miyoria/play/market";
import { type ModuleContext, placeConfig } from "@miyoria/runtime/kernel";
import {
  configSchema,
  Db,
  EventStore,
  Identity,
  identitySchema,
  migrate,
  PlaceSettings,
  SpacePlaces,
} from "@miyoria/store";
import { type ContextKey, PlaceConfigKey, type SpaceRef } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { PlaceConfigs } from "../src/place-config.js";

const A_CHANNEL = "100000000000000001";
const B_CHANNEL = "200000000000000002";
const N_CHANNEL = "300000000000000003";

/** Tuesday 2026-11-17 12:00 at UTC+8: the week's lottery notice is due. */
const TUESDAY = Date.UTC(2026, 10, 17, 4, 0, 0);

const ctx = (scope: string, channel: string): ContextKey => ({
  platform: "discord",
  scope,
  channel,
  kind: "channel",
});
const author = (id: string) => ({ account: { platform: "discord", id }, display_name: id });

/** Spaces and one text room each, as a database at identity v3 has them. */
function oldServers(db: Db, servers: [guild: string, channel: string, primary: boolean][]): void {
  servers.forEach(([guild, channel, primary], i) => {
    db.run(
      `INSERT INTO spaces (id, platform, external_id, name, joined_at, is_primary)
       VALUES ($id, 'discord', $guild, $guild, $at, $primary)`,
      { id: `s-${guild}`, guild, at: i + 1, primary: primary ? 1 : 0 },
    );
    db.run(
      `INSERT INTO rooms (id, platform, external_id, space_id, kind, created_at)
       VALUES ($id, 'discord', $channel, $space, 'text', 1)`,
      { id: `r-${guild}`, channel, space: `s-${guild}` },
    );
  });
}

const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

/**
 * An install of before the upgrade with two servers (gA, the primary, and gB), upgraded; then gN,
 * a server first seen afterwards. The market's cluster section sets `cluster`.
 */
function upgraded(cluster: Record<string, unknown>) {
  const clock = { at: TUESDAY };
  const db = new Db(new DatabaseSync(":memory:", { enableForeignKeyConstraints: true }), {
    now: () => clock.at,
  });
  dbs.push(db);
  migrate(db, [{ ...identitySchema, migrations: identitySchema.migrations.slice(0, 3) }]);
  // What the build of before wrote: two servers and a channel in each (its own SQL: this
  // build's tables have the v4 column already).
  oldServers(db, [
    ["gA", A_CHANNEL, true],
    ["gB", B_CHANNEL, false],
  ]);
  migrate(db, [identitySchema, configSchema, marketSchema]);

  const identity = new Identity(db);
  const places = new SpacePlaces(db, identity);
  identity.resolve(ctx("gN", N_CHANNEL), author("3"));
  const events = new EventStore(db, { identity });
  const configs = new PlaceConfigs({ places, settings: new PlaceSettings(db, events) });
  const services = new Map<unknown, unknown>([[PlaceConfigKey, configs]]);
  const module = {
    id: "market",
    rawConfig: cluster,
    signal: new AbortController().signal,
    services: { get: (key: unknown) => services.get(key) },
  } as unknown as ModuleContext;
  const config = placeConfig(module, MarketConfigSchema);
  const posted: { space: string | null; channel: string }[] = [];
  const markets = new MarketRegistry({
    shared: {
      wallet: () => null,
      now: () => clock.at,
      isSelf: () => false,
      names: null,
      screenName: async () => null,
      picker: null,
      tell: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
      randomInt: () => 0,
    },
    store: new MarketStore(db, events),
    config,
    places,
    post: async (space: SpaceRef | null, channel: string) => {
      posted.push({ space: space?.external_id ?? null, channel });
      return `m${posted.length}`;
    },
  });
  const space = (guild: string) => places.ofGuild("discord", guild) as SpaceRef;
  return { places, markets, posted, config, space };
}

/** Whether the market of `guild` runs the auction and the lottery. */
function running(r: ReturnType<typeof upgraded>, guild: string) {
  const market = r.markets.of(r.space(guild).id);
  return { auction: market?.auctionRunning(), lottery: market?.lotteryRunning() };
}

describe("two established servers and one cluster-level market", () => {
  it("are both established; a server seen after the upgrade is not", () => {
    const r = upgraded({ auction_channel: B_CHANNEL });
    expect(r.space("gA")).toMatchObject({ primary: true, established: true });
    expect(r.space("gB")).toMatchObject({ primary: false, established: true });
    expect(r.space("gN")).toMatchObject({ primary: false, established: false });
  });

  it("run the cluster's auction and lottery only in the server that owns the channel", async () => {
    // The channel is the second server's: before the upgrade the one market posted there.
    const r = upgraded({ auction: true, lottery: true, auction_channel: B_CHANNEL });
    const at = (guild: string) => r.config.for({ space_id: r.space(guild).id }) as MarketConfig;
    expect(at("gB").auction_channel).toBe(B_CHANNEL);
    expect(at("gA").auction_channel).toBe("");
    expect(running(r, "gB")).toEqual({ auction: true, lottery: true });
    // The primary does not also run a lottery without a channel: that would be a second one.
    expect(running(r, "gA")).toEqual({ auction: false, lottery: false });
    expect(running(r, "gN")).toEqual({ auction: false, lottery: false });
    await r.markets.tick();
    expect(r.posted).toEqual([{ space: "gB", channel: B_CHANNEL }]);
  });

  it("with the channel in the primary, run it there only, as before", async () => {
    const r = upgraded({ auction: true, lottery: true, auction_channel: A_CHANNEL });
    expect(running(r, "gA")).toEqual({ auction: true, lottery: true });
    expect(running(r, "gB")).toEqual({ auction: false, lottery: false });
    await r.markets.tick();
    expect(r.posted).toEqual([{ space: "gA", channel: A_CHANNEL }]);
  });

  it("with no channel set at all, keep the one lottery of before in the primary only", () => {
    const r = upgraded({ auction: true, lottery: true });
    expect(running(r, "gA")).toEqual({ auction: false, lottery: true });
    expect(running(r, "gB")).toEqual({ auction: false, lottery: false });
  });

  it("give a cluster channel nobody can place to the primary only, not to every established one", () => {
    const r = upgraded({ auction: true, auction_channel: "900000000000000009" });
    const at = (guild: string) => r.config.for({ space_id: r.space(guild).id }) as MarketConfig;
    expect(at("gA").auction_channel).toBe("900000000000000009");
    expect(at("gB").auction_channel).toBe("");
    expect(at("gN").auction_channel).toBe("");
  });
});
