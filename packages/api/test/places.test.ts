// The Spaces routes (`GET /api/places/spaces`, `GET /api/member/spaces`) and the `?space=` helpers
// every per-Space route uses (`space-param.ts`): 404 for an unknown Space, 403 for a non-member,
// and the defaults. Identity's real `Places` on an in-memory store; requests go to Hono in process.

import type { AdminSpaces, MemberSpaces } from "@miyoria/contracts/api";
import { PeopleStoreKey, SqliteStore } from "@miyoria/store";
import { type AccountRef, type PersonId, PlacesKey } from "@miyoria/types";
import type { AnyRouter } from "@orpc/server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { memberSpacesRpc, placesSpacesRpc } from "../src/places-routes.js";
import { tableRoutes } from "../src/rpc.js";
import {
  adminSpace,
  memberSpace,
  NO_SPACE,
  NOT_A_MEMBER,
  UNKNOWN_SPACE,
} from "../src/space-param.js";
import type { ApiEnv } from "../src/state.js";

const acct = (id: string): AccountRef => ({ platform: "discord", id });

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function setup() {
  let now = Date.UTC(2026, 10, 22);
  const store = await SqliteStore.open(":memory:", { clock: { now: () => now++ } });
  stores.push(store);
  const state = {
    publicSide: { config: { enabled: true }, admitMember: () => null },
    optional: (key: unknown) => {
      if (key === PlacesKey) return store.places;
      if (key === PeopleStoreKey) return store.people;
      return undefined;
    },
    service: (key: unknown, what: string) => {
      if (key === PlacesKey) return store.places;
      throw ApiError.unavailable(`${what} is not available`);
    },
  };
  const hono = new Hono<ApiEnv>();
  const table: AnyRouter = { places: placesSpacesRpc, member: memberSpacesRpc };
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
  const say = (guild: string, account: string) =>
    store.persons.resolve(
      { platform: "discord", scope: guild, channel: `${guild}-c`, kind: "channel" },
      { account: acct(account), display_name: `u${account}` },
    ).space_id as string;
  const person = (account: string) => store.persons.personOf(acct(account))?.id as PersonId;
  const get = async <T>(path: string, member?: string) => {
    const res = await hono.request(path, { headers: member ? { "x-test-member": member } : {} });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { store, state, say, person, get };
}

describe("the space helpers", () => {
  it("with nothing asked: the member's primary, else their only one; a stranger gets the primary", async () => {
    const { state, say, person } = await setup();
    const A = say("gA", "1");
    const B = say("gB", "2");
    say("gB", "1");
    const s = state as never;
    // In both: the primary. In B only: B. In none: the primary, marked as not theirs.
    expect(memberSpace(s, person("1"))).toMatchObject({ id: A, primary: true, member: true });
    expect(memberSpace(s, person("2"))).toMatchObject({ id: B, primary: false, member: true });
    expect(memberSpace(s, null)).toMatchObject({ id: A, member: false });
    expect(adminSpace(s)?.id).toBe(A);
  });

  it("with a Space asked: 404 when she is not in it, 403 when they are not", async () => {
    const { state, store, say, person } = await setup();
    const A = say("gA", "1");
    const B = say("gB", "2");
    const s = state as never;
    expect(memberSpace(s, person("2"), B).id).toBe(B);
    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof ApiError ? [error.status, error.message] : error;
      }
      return "no error";
    };
    expect(refused(() => memberSpace(s, person("2"), A))).toEqual([403, NOT_A_MEMBER]);
    expect(refused(() => memberSpace(s, null, A))).toEqual([403, NOT_A_MEMBER]);
    expect(refused(() => memberSpace(s, person("2"), "nope"))).toEqual([404, UNKNOWN_SPACE]);
    expect(refused(() => adminSpace(s, "nope"))).toEqual([404, UNKNOWN_SPACE]);
    expect(adminSpace(s, B)?.id).toBe(B);
    // A Space she left is unknown.
    store.places.left("discord", "gB");
    expect(refused(() => memberSpace(s, person("2"), B))).toEqual([404, UNKNOWN_SPACE]);
    expect(refused(() => adminSpace(s, B))).toEqual([404, UNKNOWN_SPACE]);
  });

  it("with no Space at all: the member side has nothing, the admin side null", async () => {
    const { state } = await setup();
    const refused = (): string => {
      try {
        memberSpace(state as never, null);
      } catch (error) {
        return (error as ApiError).message;
      }
      return "no error";
    };
    expect(refused()).toBe(NO_SPACE);
    expect(adminSpace(state as never)).toBeNull();
  });
});

describe("the routes", () => {
  it("GET /api/places/spaces: every Space, the primary first, with members and the default", async () => {
    const { say, get } = await setup();
    const A = say("gA", "1");
    const B = say("gB", "2");
    say("gB", "3");
    const { status, body } = await get<AdminSpaces>("/api/places/spaces");
    expect(status).toBe(200);
    expect(body).toEqual({
      spaces: [
        {
          id: A,
          platform: "discord",
          external_id: "gA",
          name: "gA",
          primary: true,
          established: true,
          members: 1,
        },
        {
          id: B,
          platform: "discord",
          external_id: "gB",
          name: "gB",
          primary: false,
          established: false,
          members: 2,
        },
      ],
      default: A,
    });
  });

  it("GET /api/member/spaces: the caller's own Spaces and their default", async () => {
    const { say, get } = await setup();
    const A = say("gA", "1");
    const B = say("gB", "2");
    const one = await get<MemberSpaces>("/api/member/spaces", "2");
    expect(one).toEqual({
      status: 200,
      body: {
        spaces: [
          {
            id: B,
            platform: "discord",
            external_id: "gB",
            name: "gB",
            primary: false,
            established: false,
          },
        ],
        default: B,
      },
    });
    // Someone she does not know: none of their own, the primary as the default.
    expect((await get<MemberSpaces>("/api/member/spaces", "9")).body).toEqual({
      spaces: [],
      default: A,
    });
  });

  it("GET /api/member/spaces with no Space at all: empty, no default", async () => {
    const { get } = await setup();
    expect((await get<MemberSpaces>("/api/member/spaces", "1")).body).toEqual({
      spaces: [],
      default: null,
    });
  });
});
