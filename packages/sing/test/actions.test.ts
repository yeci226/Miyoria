import { describe, expect, it } from "vitest";
import { singCapabilities } from "../src/actions.js";
import { SingPermissionsSchema } from "../src/config.js";
import type { Singer } from "../src/singer.js";

describe("sing tools", () => {
  // 2026-11-18 in a text channel: asked to sing a link, she was not offered sing_request (it had
  // to be found with find_tools first), read the link as a web page instead and sang nothing.
  // Starting and stopping the song are offered with it: a requested song that is ready is no use
  // to her without sing_start.
  it("offers the three sing tools on every turn", () => {
    const caps = singCapabilities({} as Singer, SingPermissionsSchema.parse({}));
    const always = caps.filter((c) => c.tool?.meta?.core === true).map((c) => c.tool?.name);
    expect(always).toEqual(["sing_request", "sing_start", "sing_stop"]);
  });
});
