// The registry of bus topics: one definition per topic or family, each payload schema exported by
// name (so the JSON Schema file has it), and the tiers and scopes the data doc's rules give.

import { describe, expect, it } from "vitest";
import { contractId, exportedSchemas } from "../../kit/src/index.js";
import * as events from "../src/index.js";

const { BUS_EVENTS, busEventRegistry } = events;

describe("BUS_EVENTS", () => {
  it("has one definition per type", () => {
    const types = BUS_EVENTS.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("names every payload schema and exports it from the part (or it is a wire shape)", () => {
    const exported = new Set(exportedSchemas(events).values());
    for (const d of BUS_EVENTS) {
      const id = contractId(d.data);
      expect(id, d.type).toMatch(/^(Events|Wire)/);
      if (id?.startsWith("Events")) expect(exported.has(d.data), d.type).toBe(true);
    }
  });

  it("resolves every registered type to its own definition", () => {
    const registry = busEventRegistry();
    for (const d of BUS_EVENTS) expect(registry.resolve(d.type)).toBe(d);
  });
});
