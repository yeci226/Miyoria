// Families: a type pattern with `*` words that registers every type built from parts at once.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineEvent,
  EventDefinitionError,
  EventRegistry,
  familyCovers,
  isEventFamily,
} from "../src/registry.js";

const data = z.object({ n: z.number() });

const Audit = defineEvent({ type: "audit.*", v: 1, data, scope: "owner", tier: "keep" });
const AuditAdmin = defineEvent({ type: "audit.admin.*", v: 1, data, tier: "long" });
const Tasks = defineEvent({ type: "*.task.*", v: 1, data });
const GameTasks = defineEvent({ type: "game.*.task.*", v: 1, data, tier: "short" });
const Game = defineEvent({ type: "game.*.*", v: 1, data, tier: "ambient" });
const GameSession = defineEvent({ type: "game.director.session", v: 1, data, tier: "long" });

describe("family patterns", () => {
  it("are types with a `*` word", () => {
    expect(isEventFamily("audit.*")).toBe(true);
    expect(isEventFamily("game.*.task.*")).toBe(true);
    expect(isEventFamily("audit.module.disable")).toBe(false);
  });

  it("refuse a `*` inside a word, an empty word and a pattern without a fixed word", () => {
    for (const type of ["audit.x*", "audit..*", "*", "*.*"]) {
      expect(() => defineEvent({ type, v: 1, data })).toThrow(EventDefinitionError);
    }
  });

  it("cover one word with a middle `*` and one word or more with a final one", () => {
    expect(familyCovers("audit.*", "audit.module.disable")).toBe(true);
    expect(familyCovers("audit.*", "audit.x")).toBe(true);
    expect(familyCovers("audit.*", "audit")).toBe(false);
    expect(familyCovers("game.*.task.*", "game.minecraft.task.done")).toBe(true);
    expect(familyCovers("game.*.task.*", "game.task.done")).toBe(false);
    expect(familyCovers("*.task.*", "worklane.task.started")).toBe(true);
    expect(familyCovers("*.task.*", "game.minecraft.task.done")).toBe(false);
    expect(familyCovers("game.*.*", "game.neuro.force.done")).toBe(true);
    expect(familyCovers("audit.module.disable", "audit.module.disable")).toBe(true);
  });

  it("cover one word or more with `**` anywhere", () => {
    expect(familyCovers("**.task.done", "worklane.task.done")).toBe(true);
    expect(familyCovers("**.task.done", "game.minecraft.task.done")).toBe(true);
    expect(familyCovers("**.task.done", "ext.test.fixture.task.done")).toBe(true);
    expect(familyCovers("**.task.done", "task.done")).toBe(false);
    expect(familyCovers("**.task.done", "worklane.task.failed")).toBe(false);
    expect(familyCovers("game.**.end", "game.a.b.end")).toBe(true);
    expect(familyCovers("game.**", "game.a.b")).toBe(true);
    expect(isEventFamily("**.task.done")).toBe(true);
    expect(() => defineEvent({ type: "**", v: 1, data })).toThrow(EventDefinitionError);
    expect(() => defineEvent({ type: "a.***", v: 1, data })).toThrow(EventDefinitionError);
  });

  it("rank `**` below a pattern with as many fixed words that takes fewer", () => {
    const Deep = defineEvent({ type: "**.task.done", v: 1, data });
    const Exact = defineEvent({ type: "*.task.done", v: 1, data });
    const events = new EventRegistry().register(Deep, Exact, Game);
    expect(events.resolve("worklane.task.done")).toBe(Exact);
    expect(events.resolve("game.minecraft.task.done")).toBe(Deep);
    expect(events.resolve("game.minecraft.death")).toBe(Game);
  });
});

describe("EventRegistry with families", () => {
  const registry = () =>
    new EventRegistry().register(Audit, AuditAdmin, Tasks, GameTasks, Game, GameSession);

  it("resolves a type to its own definition first", () => {
    expect(registry().resolve("game.director.session")).toBe(GameSession);
    expect(registry().resolve("audit.*")).toBe(Audit);
  });

  it("resolves a type built from parts to the most specific family", () => {
    const events = registry();
    expect(events.resolve("audit.module.disable")).toBe(Audit);
    expect(events.resolve("audit.admin.memory.wipe")).toBe(AuditAdmin);
    expect(events.resolve("worklane.task.done")).toBe(Tasks);
    expect(events.resolve("game.minecraft.task.done")).toBe(GameTasks);
    expect(events.resolve("game.minecraft.death")).toBe(Game);
    expect(events.resolve("game.neuro.force.done")).toBe(Game);
    expect(events.familyOf("game.minecraft.task.done")).toBe("game.*.task.*");
    expect(events.familyOf("game.director.session")).toBe("game.*.*");
    expect(events.resolve("voice.latency")).toBeNull();
  });

  it("prefers a family whose first difference is a fixed word on a tie", () => {
    const events = new EventRegistry().register(Tasks, Game);
    // Both cover `game.task.x` with one fixed word; `game` comes first.
    expect(events.resolve("game.task.x")).toBe(Game);
    expect(events.resolve("sing.task.steered")).toBe(Tasks);
  });

  it("gives a covered type its family's scope and tier", () => {
    const events = registry();
    expect(events.defaults("audit.module.disable")).toEqual({ scope: "owner", tier: "keep" });
    expect(events.defaults("audit.admin.memory.wipe")).toEqual({ scope: null, tier: "long" });
    expect(events.defaults("game.minecraft.death")).toEqual({ scope: null, tier: "ambient" });
    expect(events.defaults("nothing.here")).toEqual({ scope: null, tier: "short" });
  });

  it("resolves a version of the family", () => {
    const Audit2 = defineEvent({ type: "audit.*", v: 2, data: z.string(), tier: "keep" });
    const events = new EventRegistry().register(Audit, Audit2);
    expect(events.resolve("audit.x.y")).toBe(Audit2);
    expect(events.resolve("audit.x.y", 1)).toBe(Audit);
    expect(events.resolve("audit.x.y", 3)).toBeNull();
  });
});
