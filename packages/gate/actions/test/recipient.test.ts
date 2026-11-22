// `recipient`: a bare id is on the requester's platform, else the place's, and nobody's when
// neither is known; never a default platform (v5-architecture §6).

import { Principals } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { recipient } from "../src/builtin.js";
import { CTX, OWEN } from "./helpers.js";

describe("recipient", () => {
  it("takes the platform from the requester, then the place, else names nobody", () => {
    expect(recipient("123", Principals.user(OWEN, CTX))).toEqual({
      platform: OWEN.platform,
      id: "123",
    });
    expect(recipient("<@123>", Principals.self(CTX))).toEqual({
      platform: CTX.platform,
      id: "123",
    });
    expect(recipient("123", Principals.panel("api"))).toBeNull();
    expect(recipient(null, Principals.user(OWEN, CTX))).toEqual(OWEN);
  });
});
