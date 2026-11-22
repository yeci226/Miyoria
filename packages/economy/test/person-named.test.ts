// A name she uses for someone, turned into a person: the handle, the name at first sight, what
// she calls them, and the nickname they go by now (a server nickname changed since first sight).
// The names are made up.

import { ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  type HandleDirectory,
  HandleDirectoryKey,
  type HandleEntry,
  nameRefusal,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { personMatch, personNamed } from "../src/tools.js";

function directory(entries: HandleEntry[]): HandleDirectory {
  return {
    ofAccount: () => {
      throw new Error("not used");
    },
    ofPerson: (person) => entries.find((e) => e.person === person)?.handle ?? null,
    resolve: (handle) => entries.find((e) => e.handle === handle) ?? null,
    list: () => entries,
  } as HandleDirectory;
}

function entry(handle: string, person: string, first: string, names?: string[]): HandleEntry {
  return {
    handle,
    person,
    account: { platform: "discord", id: person },
    display_name: first,
    ...(names ? { names } : {}),
    created_at: "2026-11-01T00:00:00.000Z",
  };
}

function services(entries: HandleEntry[]) {
  const s = new ServiceRegistry();
  s.provide("test", HandleDirectoryKey, directory(entries));
  return s;
}

function lookup(entries: HandleEntry[]) {
  const s = services(entries);
  return (name: string) => personNamed(s, name);
}

describe("personNamed", () => {
  const table = [
    entry("Nobu", "p1", "Nobu", ["Model-9 Lumen"]),
    entry("Tsuki", "p2", "Tsuki", ["Engine V7.2 Flash 0042"]),
    entry("Alice", "p3", "Alice"),
  ];
  const find = lookup(table);

  it("finds someone by the nickname they changed to, as she reads it in the chat", () => {
    expect(find("Model-9 Lumen")).toBe("p1");
    expect(find("@model-9 lumen")).toBe("p1");
    expect(find("Engine V7.2 Flash 0042")).toBe("p2");
  });

  it("still finds them by the handle and by the name at first sight", () => {
    expect(find("Nobu")).toBe("p1");
    expect(find("alice")).toBe("p3");
  });

  it("answers nobody for a part of a name, or a name two people go by", () => {
    expect(find("Lumen")).toBeNull();
    const two = lookup([entry("A", "p1", "A", ["Same"]), entry("B", "p2", "B", ["same"])]);
    expect(two("Same")).toBeNull();
  });

  it("says who a part of a name may be, by handle and by the name they go by now", () => {
    const match = personMatch(services(table), "Lumen");
    expect(match.kind).toBe("none");
    if (match.kind !== "one") {
      expect(nameRefusal(match)).toContain("「Nobu」(現在叫「Model-9 Lumen」)");
    }
  });

  it("never finds the one who renamed to someone else's handle in that person's place", () => {
    // Tsuki renames to "Nobu": "Nobu" is still Nobu.
    const renamed = lookup([
      entry("Nobu", "p1", "Nobu", ["Model-9 Lumen"]),
      entry("Tsuki", "p2", "Tsuki", ["Nobu"]),
    ]);
    expect(renamed("Nobu")).toBe("p1");
  });
});
