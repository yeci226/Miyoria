import { describe, expect, test } from "vitest";
import { DiscordUserResolver, type FetchedMember } from "../src/resolver.js";

const ADMINISTRATOR = 1n << 3n;
const context = { platform: "discord", scope: "300", channel: "20", kind: "channel" } as const;

function member(id: string, bits: bigint, roles: string[]): FetchedMember {
  return {
    user: { id, username: `u${id}`, globalName: null },
    nickname: id === "2" ? "Nick" : null,
    roles: { cache: new Map(roles.map((r) => [r, {}])) },
    permissions: { bitfield: bits },
  };
}

function resolver(members: Record<string, FetchedMember>, fetched: string[] = []) {
  const guild = {
    members: {
      fetch: async (id: string) => {
        fetched.push(id);
        const found = members[id];
        if (!found) throw new Error("Unknown Member");
        return found;
      },
    },
  };
  return new DiscordUserResolver({
    guilds: { cache: new Map([["300", guild]]), fetch: async () => guild },
  });
}

describe("DiscordUserResolver", () => {
  test("returns_roles_and_admin_status", async () => {
    const r = resolver({ "1": member("1", ADMINISTRATOR, ["9"]), "2": member("2", 0n, []) });
    expect(await r.resolveUsers(context, ["1", "2"])).toEqual({
      "1": { display_name: "u1", platform_roles: ["9"], is_guild_admin: true },
      "2": { display_name: "Nick", platform_roles: [], is_guild_admin: false },
    });
  });

  test("leaves_out_people_it_cannot_find_so_callers_refuse", async () => {
    const r = resolver({});
    expect(await r.resolveUsers(context, ["7"])).toEqual({});
  });

  test("ignores_ids_that_are_not_snowflakes_and_dm_contexts", async () => {
    const fetched: string[] = [];
    const r = resolver({ "1": member("1", 0n, []) }, fetched);
    expect(await r.resolveUsers(context, ["../x", "1"])).toMatchObject({ "1": {} });
    expect(fetched).toEqual(["1"]);
    expect(await r.resolveUsers({ ...context, scope: null, kind: "dm" }, ["1"])).toEqual({});
  });
});
