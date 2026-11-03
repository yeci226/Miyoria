import type { Guild } from "@lng2004/discord.js-selfbot-v13";
import { describe, expect, it } from "vitest";
import { resolveVoiceChannel } from "../src/discord.js";

function guildFetching(fetch: () => Promise<unknown>): Guild {
  return { id: "g1", channels: { cache: new Map(), fetch } } as unknown as Guild;
}

describe("resolveVoiceChannel", () => {
  it("names Discord's reason when the channel fetch fails", async () => {
    const err = Object.assign(new Error("Missing Access"), { code: 50001, httpStatus: 403 });
    const lookup = await resolveVoiceChannel(guildFetching(() => Promise.reject(err)), "c9");
    expect(lookup).toEqual({
      ok: false,
      error: "channel c9 not found in guild g1 (Missing Access, code 50001, HTTP 403)",
    });
  });

  it("keeps the plain message when Discord returns nothing", async () => {
    const lookup = await resolveVoiceChannel(guildFetching(() => Promise.resolve(null)), "c9");
    expect(lookup).toEqual({ ok: false, error: "channel c9 not found in guild g1" });
  });
});
