// The money routes with two servers (phase 6): the sponsor board and the rich list of one server's
// members or of everyone, predictions and bounties of a member's server, and the owner's look at
// one server's predictions or every server's. Identity's real `Places` on an in-memory store; the
// economy and the exchange are fakes that answer by the members or servers they are handed, so
// what is tested is which list a route asks for. Requests go to Hono in process.

import { Economy2Key, EconomyKey } from "@miyoria/economy";
import { ExchangeKey } from "@miyoria/play/exchange";
import { PeopleStoreKey, SqliteStore } from "@miyoria/store";
import { type AccountRef, type PersonId, PlacesKey } from "@miyoria/types";
import type { AnyRouter } from "@orpc/server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { agencyRpc } from "../src/agency.js";
import { economyRpc } from "../src/economy.js";
import { ApiError } from "../src/errors.js";
import { exchangeRpc } from "../src/exchange-routes.js";
import { walletPlayRpc } from "../src/play-routes.js";
import { tableRoutes } from "../src/rpc.js";
import { NOT_A_MEMBER, UNKNOWN_SPACE } from "../src/space-param.js";
import type { ApiEnv } from "../src/state.js";
import { walletRpc } from "../src/wallet.js";

const acct = (id: string): AccountRef => ({ platform: "discord", id });

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

/** A prediction as the fake economy answers it, tagged with its server. */
const prediction = (id: string, space: string | null) => ({
  id,
  space: space === null ? null : { id: space, name: space },
  question: id,
  options: [{ label: "甲", staked: 0, backers: 0, multiplier: null }],
  total: 0,
  closes_at: "2026-11-22T00:00:00.000Z",
  status: "open" as const,
  winner: null,
  settles: { kind: "her" as const, label: "她公布結果" },
  settled_by: null,
  my_bet: null,
});

async function setup() {
  let now = Date.UTC(2026, 10, 22);
  const store = await SqliteStore.open(":memory:", { clock: { now: () => now++ } });
  stores.push(store);
  const say = (guild: string, account: string) =>
    store.persons.resolve(
      { platform: "discord", scope: guild, channel: `${guild}-c`, kind: "channel" },
      { account: acct(account), display_name: `u${account}` },
    ).space_id as string;
  // Alice (1) wrote in A (the primary), Bob (2) in B, Erin (5) in both; Dave (4) nowhere.
  const A = say("gA", "1");
  const B = say("gB", "2");
  say("gA", "5");
  say("gB", "5");
  store.persons.see(acct("4"), "u4");
  const person = (account: string) => store.persons.personOf(acct(account))?.id as PersonId;
  const names = new Map(["1", "2", "5"].map((a) => [person(a), `u${a}`]));
  const asked: { predictions: (readonly string[] | undefined)[]; bounties: unknown[] } = {
    predictions: [],
    bounties: [],
  };
  const economy = {
    board: async (_limit: number, members?: ReadonlySet<PersonId>) =>
      [...names]
        .filter(([p]) => !members || members.has(p))
        .map(([, name], i) => ({ rank: i + 1, name, spent: 10 - i })),
    bounties: async (spaces?: readonly string[]) => {
      asked.bounties.push(spaces);
      return [];
    },
  };
  const v2 = {
    currency: "魚幣",
    health: async () => ({}),
    predictions: async (_account: unknown, spaces?: readonly string[]) => {
      asked.predictions.push(spaces);
      return [prediction("PA", A), prediction("PB", B)].filter(
        (p) => !spaces || (p.space !== null && spaces.includes(p.space.id)),
      );
    },
  };
  const exchange = {
    boards: async (_account: unknown, members?: ReadonlySet<string> | null) => ({
      currency: "魚幣",
      rich: [...names]
        .filter(([p]) => !members || members.has(p))
        .map(([, name], i) => ({ rank: i + 1, name, worth: 100 - i, holdings: null, me: false })),
      volume: [],
      me: null,
      week_start: "2026-11-16",
    }),
  };
  const services = new Map<unknown, unknown>([
    [PlacesKey, store.places],
    [PeopleStoreKey, store.people],
    [EconomyKey, economy],
    [Economy2Key, v2],
    [ExchangeKey, exchange],
  ]);
  const state = {
    publicSide: { config: { enabled: true }, admitMember: () => null, passes: () => true },
    optional: (key: unknown) => services.get(key),
    service: (key: unknown, what: string) => {
      const found = services.get(key);
      if (found === undefined) throw ApiError.unavailable(`${what} is not available`);
      return found;
    },
    audit: async () => undefined,
  };
  const hono = new Hono<ApiEnv>();
  const table: AnyRouter = {
    wallet: { ...walletRpc, ...walletPlayRpc },
    agency: agencyRpc,
    exchange: { boards: exchangeRpc.boards },
    economy: { predictions: economyRpc.predictions },
  };
  for (const r of tableRoutes(state as never, table, { responseCheck: "strict" })) {
    hono.on(r.method, r.path, async (c) => {
      if (r.member)
        c.set("member", { account: acct(c.req.header("x-test-member") ?? "0") } as never);
      else c.set("principal", { kind: "token" } as never);
      try {
        return await r.handler(c);
      } catch (error) {
        return error instanceof ApiError
          ? error.toResponse()
          : ApiError.internal(error).toResponse();
      }
    });
  }
  const get = async <T>(path: string, member?: string) => {
    const res = await hono.request(path, { headers: member ? { "x-test-member": member } : {} });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { A, B, get, asked };
}

type Board = { space: { id: string; name: string } | null; entries: { name: string }[] };
type Rich = { space: { id: string; name: string } | null; rich: { name: string }[] };
const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();

describe("the sponsor board on the member page", () => {
  it("is their own server's members by default, another of theirs by ?space=, everyone by scope=all", async () => {
    const { A, B, get } = await setup();
    const mine = await get<Board>("/api/member/board", "2");
    expect(mine.body.space).toEqual({ id: B, name: "gB" });
    expect(names(mine.body.entries)).toEqual(["u2", "u5"]);
    // Erin is in both: the primary by default, the other one when asked.
    expect(names((await get<Board>("/api/member/board", "5")).body.entries)).toEqual(["u1", "u5"]);
    expect((await get<Board>(`/api/member/board?space=${B}`, "5")).body.space?.id).toBe(B);
    const all = await get<Board>("/api/member/board?scope=all", "2");
    expect(all.body.space).toBeNull();
    expect(names(all.body.entries)).toEqual(["u1", "u2", "u5"]);
    expect((await get<Board>(`/api/member/board?space=${A}`, "1")).status).toBe(200);
  });

  it("refuses another person's server and an unknown one, and is everyone's for a member of none", async () => {
    const { A, get } = await setup();
    const other = await get<{ error: string }>(`/api/member/board?space=${A}`, "2");
    expect(other).toEqual({ status: 403, body: expect.objectContaining({ error: NOT_A_MEMBER }) });
    const unknown = await get<{ error: string }>("/api/member/board?space=nope", "2");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe(UNKNOWN_SPACE);
    // Dave wrote nowhere: no server's list is his to see, everyone's is.
    const dave = await get<Board>("/api/member/board", "4");
    expect(dave.body.space).toBeNull();
    expect(names(dave.body.entries)).toEqual(["u1", "u2", "u5"]);
  });
});

describe("the rich list on the member page", () => {
  it("is ranked within one server, or among everyone", async () => {
    const { B, get } = await setup();
    const mine = await get<Rich>("/api/member/exchange/boards", "2");
    expect(mine.body.space?.id).toBe(B);
    expect(names(mine.body.rich)).toEqual(["u2", "u5"]);
    expect(
      names((await get<Rich>("/api/member/exchange/boards?scope=all", "2")).body.rich),
    ).toEqual(["u1", "u2", "u5"]);
  });
});

describe("predictions and bounties on the member page", () => {
  it("are their server's, and another server only by its id when they are in it", async () => {
    const { A, B, get, asked } = await setup();
    type List = { predictions: { id: string; space: { id: string } | null }[] };
    const bob = await get<List>("/api/member/predictions", "2");
    expect(bob.body.predictions.map((p) => p.id)).toEqual(["PB"]);
    expect(asked.predictions.at(-1)).toEqual([B]);
    expect((await get<List>(`/api/member/predictions?space=${A}`, "2")).status).toBe(403);
    expect((await get<List>(`/api/member/predictions?space=${B}`, "5")).body.predictions).toEqual([
      expect.objectContaining({ id: "PB", space: { id: B, name: B } }),
    ]);
    // A member of none reads the primary's (and a bet would be refused with the reason).
    expect(
      (await get<List>("/api/member/predictions", "4")).body.predictions.map((p) => p.id),
    ).toEqual(["PA"]);
    await get("/api/member/bounties", "2");
    expect(asked.bounties.at(-1)).toEqual([B]);
    expect((await get("/api/member/bounties?space=nope", "2")).status).toBe(404);
  });
});

describe("predictions for the owner", () => {
  it("are every server's without ?space=, one server's with it", async () => {
    const { A, get } = await setup();
    type List = { predictions: { id: string }[] };
    expect((await get<List>("/api/economy/predictions")).body.predictions.map((p) => p.id)).toEqual(
      ["PA", "PB"],
    );
    expect(
      (await get<List>(`/api/economy/predictions?space=${A}`)).body.predictions.map((p) => p.id),
    ).toEqual(["PA"]);
    expect((await get("/api/economy/predictions?space=nope")).status).toBe(404);
  });
});
