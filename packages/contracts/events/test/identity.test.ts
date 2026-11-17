// `identity.imported`: for the owner, kept forever; its payload reads back as the import wrote it.

import { describe, expect, it } from "vitest";
import { EventRegistry, IdentityImported, readEventData } from "../src/index.js";

describe("identity.imported", () => {
  it("is for the owner and kept forever", () => {
    const registry = new EventRegistry().register(IdentityImported);
    expect(registry.defaults("identity.imported")).toEqual({ scope: "owner", tier: "keep" });
  });

  it("reads a payload back and refuses a negative card count", () => {
    const data = {
      handle: "Owen#2",
      old_handle: "owen",
      name: "owen",
      accounts: [{ platform: "discord", external_id: "1" }],
      prefs: ["voice_consent"],
      legacy: { first_seen: "2026-01-01T00:00:00.000Z", old_tier: "朋友", cards: 2 },
      from: "miyoria-v4-2026-11-15.single.db",
    };
    const event = { type: "identity.imported", v: 1, data };
    expect(readEventData(IdentityImported, event)).toEqual(data);
    const bad = { ...event, data: { ...data, legacy: { ...data.legacy, cards: -1 } } };
    expect(() => readEventData(IdentityImported, bad)).toThrow();
  });
});
