// `set_call_name`: she saves how the speaker wants to be called, through the real gate and the
// capability tool; only the speaker's own, whatever the arguments say.

import { ActuatorRegistry, CapabilityTool } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { type AccountRef, type ContextKey, type JsonValue, Principals } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { callNameCapability } from "../src/index.js";
import { acc, Harness, t } from "./helpers.js";

const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };

async function rig() {
  const h = new Harness();
  await h.say("discord:1", "Alice", "嗨", TEXT, t(1, 10));
  await h.say("discord:2", "Bob", "嗨", TEXT, t(1, 10));
  const registry = new ActuatorRegistry({ services: new ServiceRegistry(), builtins: false });
  registry.register(callNameCapability(h.social));
  const capability = registry.get("social.set_call_name");
  if (!capability?.tool) throw new Error("no tool");
  const tool = new CapabilityTool(registry, capability);
  let n = 0;
  const call = (speaker: AccountRef, args: Record<string, JsonValue>) => {
    n += 1;
    return tool.call(
      {
        turn: `turn-${n}`,
        context: TEXT,
        account: speaker,
        principal: Principals.user(speaker, TEXT),
        message: { context: TEXT, id: `m${n}` },
        priority: "request",
        signal: new AbortController().signal,
      },
      args,
    );
  };
  return { h, tool, call };
}

describe("set_call_name", () => {
  it("sets the speaker's own call name, with a delta by her", async () => {
    const { h, call } = await rig();
    const out = await call(acc("discord:1"), { name: "  小雨 ", why: "她說的" });
    expect(out).toContain("小雨");
    expect(h.rel("discord:1").call_name).toBe("小雨");
    expect(h.rel("discord:2").call_name).toBeNull();
    const reasons = h.store.deltas(h.person("discord:1")).map((d) => d.reason);
    expect(reasons).toContain("her (她說的): call_name");
  });

  it("cannot name someone else: no argument picks a person, a stray one is refused", async () => {
    const { h, tool, call } = await rig();
    const props = JSON.stringify(tool.spec.parameters);
    expect(props).not.toMatch(/who|person|target|account/);
    await expect(call(acc("discord:1"), { name: "小胖", who: "discord:2" })).rejects.toThrow();
    expect(h.rel("discord:2").call_name).toBeNull();
    expect(h.rel("discord:1").call_name).toBeNull();
    // Even a plain call lands on the speaker, never on Bob.
    await call(acc("discord:1"), { name: "小胖" });
    expect(h.rel("discord:2").call_name).toBeNull();
  });

  it("clears with a clear word or an empty name", async () => {
    const { h, call } = await rig();
    await call(acc("discord:1"), { name: "小雨" });
    await call(acc("discord:1"), { name: "清除" });
    expect(h.rel("discord:1").call_name).toBeNull();
    await call(acc("discord:1"), { name: "小雨" });
    await call(acc("discord:1"), { name: "" });
    expect(h.rel("discord:1").call_name).toBeNull();
  });

  it("refuses a name the command would refuse, with the reason", async () => {
    const { h, call } = await rig();
    await expect(call(acc("discord:1"), { name: "@everyone" })).rejects.toThrow(/特殊符號/);
    await expect(call(acc("discord:1"), { name: "x".repeat(21) })).rejects.toThrow(/最多/);
    expect(h.rel("discord:1").call_name).toBeNull();
  });

  it("acts for someone: with several people in the turn the call says whom for", async () => {
    const { tool } = await rig();
    expect(tool.actsFor).toBe(true);
  });
});
