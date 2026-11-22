// The name she writes for whom a DM or a file is for, through the shared resolver
// (`matchPersonName`): the handle, a whole name they go by now, never part of one. Made-up names.

import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { type HandleDirectory, HandleDirectoryKey, type HandleEntry } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { handleLookup } from "../src/builtin.js";

const entry = (handle: string, id: string, names: string[]): HandleEntry => ({
  handle,
  person: `p-${id}`,
  account: { platform: "discord", id },
  display_name: handle,
  names,
  created_at: "2026-11-01T00:00:00.000Z",
});

function lookup(entries: HandleEntry[]) {
  const services = new ServiceRegistry();
  const directory = {
    ofAccount: () => "x",
    ofPerson: () => null,
    resolve: (h: string) => entries.find((e) => e.handle === h) ?? null,
    list: () => entries,
  } as HandleDirectory;
  services.provide("test", HandleDirectoryKey, directory);
  return handleLookup(services);
}

describe("handleLookup", () => {
  const names = lookup([entry("Nobu", "1", ["Model-9 Lumen"]), entry("Kiri", "2", ["Nobu"])]);

  it("finds the handle first, then a whole name they go by now", () => {
    expect(names("Nobu")?.id).toBe("1");
    expect(names("@model-9 lumen")?.id).toBe("1");
    expect(names("Kiri")?.id).toBe("2");
  });

  it("refuses part of a name and says who it may be", () => {
    expect(names("Lumen")).toBeNull();
    expect(names.why?.("Lumen")).toContain("「Nobu」(現在叫「Model-9 Lumen」)");
    expect(names.why?.("Nobu")).toBeNull();
  });
});
