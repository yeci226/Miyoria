// The turn record types keep their bus topics and are kept 90 days, scoped by the session; audit
// entries are one family under `audit.`, for the owner, kept forever.

import { describe, expect, it } from "vitest";
import {
  AgentDecision,
  AgentTurnOutcome,
  AuditRecorded,
  auditType,
  EventRegistry,
  readEventData,
  TURN_EVENTS,
} from "../src/index.js";

const ctx = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;

describe("turn record types", () => {
  it("are named after their bus topics, kept 90 days, scoped by the session", () => {
    expect(TURN_EVENTS.map((d) => d.type)).toEqual(["agent.decision", "agent.turn.outcome"]);
    const registry = new EventRegistry().register(...TURN_EVENTS);
    for (const d of TURN_EVENTS) {
      expect(registry.defaults(d.type)).toEqual({ scope: null, tier: "short" });
    }
  });

  it("read the bus payloads back, extra fields of an outcome included", () => {
    const trace = { turn: "t1", context: ctx, respond: true, score: 0.9, reasons: ["mention"] };
    expect(readEventData(AgentDecision, { type: "agent.decision", v: 1, data: trace })).toEqual(
      trace,
    );
    const record = {
      turn: "t1",
      context: ctx,
      reason: "addressed",
      outcome: { type: "cancelled", cause: "barge_in", by: "Owen" },
      addressed_by: ["Owen"],
      focus: [{ context: ctx, id: "m1" }],
      restarts: 0,
      reasoning: "low",
      latency_ms: 812,
      at: "2026-11-01T12:00:00Z",
      corrections: { claim_held: 1 },
    };
    expect(
      readEventData(AgentTurnOutcome, { type: "agent.turn.outcome", v: 1, data: record }),
    ).toEqual(record);
    expect(() =>
      readEventData(AgentTurnOutcome, {
        type: "agent.turn.outcome",
        v: 1,
        data: { ...record, outcome: { type: "sent" } },
      }),
    ).toThrow();
  });
});

describe("audit entries", () => {
  it("are one family for the owner, kept forever", () => {
    expect(AuditRecorded.type).toBe("audit.*");
    expect(new EventRegistry().register(AuditRecorded).defaults("audit.*")).toEqual({
      scope: "owner",
      tier: "keep",
    });
  });

  it("are typed after their action, a command's words joined by dots", () => {
    expect(auditType("module.disable")).toBe("audit.module.disable");
    expect(auditType("admin memory wipe")).toBe("audit.admin.memory.wipe");
    expect(auditType("  gate.game.act ")).toBe("audit.gate.game.act");
    expect(auditType("a..b")).toBe("audit.a.b");
    expect(auditType("")).toBe("audit.unnamed");
  });

  it("read the entry back", () => {
    const entry = { actor: "api", action: "persona.set", target: "style", detail: null, ok: true };
    expect(readEventData(AuditRecorded, { type: "audit.*", v: 1, data: entry })).toEqual(entry);
  });
});
