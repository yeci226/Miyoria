// A result's receipt card goes up where she acted, and she is told it did (registry.ts).

import { notice } from "@miyoria/commands";
import { type JsonValue, type Principal, Principals } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ActionRequest, type Capability, defineCapability } from "../src/index.js";
import { CTX, gate, OWEN } from "./helpers.js";

const paid = defineCapability<Record<string, never>>({
  name: "t.paid",
  summary: "test paid",
  risk: "low",
  args: z.object({}),
  permission: null,
  async execute() {
    return { text: "扣了 20", data: { charged: 20 }, receipt: notice("info", "🍚 收下了") };
  },
}) as Capability;

const request = (principal: Principal, args: JsonValue = {}): ActionRequest => ({
  principal,
  capability: "t.paid",
  args,
  why: null,
  turn: null,
});

describe("receipt cards", () => {
  it("go up in the channel of her turn, and she is told so", async () => {
    const g = await gate();
    g.registry.register(paid);
    const out = await g.registry.invoke(request(Principals.user(OWEN, CTX)));
    expect(out.status).toBe("done");
    expect(g.replies.cards).toHaveLength(1);
    expect(g.replies.cards[0]?.[0]).toEqual(CTX);
    expect(g.replies.cards[0]?.[1].ephemeral).toBe(false);
    if (out.status === "done") expect(out.result.text).toContain("收據卡片");
  });

  it("a command shows its own reply, so nothing more is posted", async () => {
    const g = await gate();
    g.registry.register(paid);
    const out = await g.registry.invoke(request(Principals.command(OWEN, CTX, true)));
    expect(out.status).toBe("done");
    expect(g.replies.cards).toHaveLength(0);
    if (out.status === "done") expect(out.result.text).toBe("扣了 20");
  });
});
