import type { IncomingMessage, JsonValue } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { logEntryFromIncoming, type MemoryScope, MemorySettingsStore } from "../src/index.js";

describe("MemorySettingsStore", () => {
  it("get / set / delete / list by prefix, per profile", async () => {
    const store = new MemorySettingsStore();
    expect(await store.get("p", "a")).toBeNull();
    await store.set("p", "feedback:day:2026-03-10", { n: 1 });
    await store.set("p", "feedback:day:2026-03", { n: 1 });
    await store.set("p", "mode:c1", "ambient");
    await store.set("q", "feedback:day:2026-03", 1);
    expect([...(await store.list("p", "feedback:day:")).keys()]).toEqual([
      "feedback:day:2026-03",
      "feedback:day:2026-03-10",
    ]);
    await store.set("p", "mode:c1", null);
    expect(await store.get("p", "mode:c1")).toBeNull();
    expect(await store.get("q", "feedback:day:2026-03")).toBe(1);
  });

  it("copies values in and out", async () => {
    const store = new MemorySettingsStore();
    const value: { n: number } = { n: 1 };
    await store.set("p", "k", value);
    value.n = 2;
    const read = (await store.get("p", "k")) as { n: JsonValue };
    expect(read.n).toBe(1);
  });
});

describe("records", () => {
  it("log entries from platform messages", () => {
    const message: IncomingMessage = {
      id: { context: { platform: "discord", scope: "g", channel: "c", kind: "channel" }, id: "m1" },
      author: { account: { platform: "discord", id: "u1" }, display_name: "Owen", is_bot: false },
      text: "hi",
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts: "2026-03-10T00:00:00Z",
    };
    const entry = logEntryFromIncoming("deepseek-chan", message, false);
    expect(entry).toMatchObject({
      profile: "deepseek-chan",
      context: message.id.context,
      author: { platform: "discord", id: "u1" },
      author_name: "Owen",
      text: "hi",
      is_self: false,
      ts: "2026-03-10T00:00:00Z",
      turn: null,
    });
    expect(entry.id).toHaveLength(26);
  });

  it("scopes are internally tagged", () => {
    const scope: MemoryScope = { type: "guild", platform: "discord", guild: "g" };
    expect(JSON.stringify(scope)).toBe('{"type":"guild","platform":"discord","guild":"g"}');
  });
});
