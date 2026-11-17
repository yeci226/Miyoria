// Every part of the package: it follows the rules, its names are its own, and the JSON Schema
// file checked in for it is what its schemas say today. After changing a schema, run
// `pnpm contracts:gen` and commit the file with it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRules, emitPart, emitRoutes, formatDocument, namedSchemas } from "../src/index.js";
import { loadPart, partNames, routesFile, SCHEMA_DIR, schemaFile } from "../src/parts.js";

const names = partNames();
const parts = new Map<string, Record<string, unknown>>();
for (const name of names) parts.set(name, await loadPart(name));

describe("the parts", () => {
  it("are found", () => {
    expect(names).toContain("wire");
  });

  it.each(names)("%s follows the rules", (name) => {
    expect(checkRules(name, parts.get(name) ?? {})).toEqual([]);
  });

  it("do not share a name", () => {
    const owner = new Map<string, { part: string; schema: unknown }>();
    const clashes: string[] = [];
    for (const [name, part] of parts) {
      for (const [id, schema] of namedSchemas(part)) {
        const first = owner.get(id);
        if (first === undefined) owner.set(id, { part: name, schema });
        // A part may export another part's schema again: the same schema, so still one owner.
        else if (first.schema !== schema) clashes.push(`${id}: ${first.part} and ${name}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it.each(names)("schema/%s.json is up to date (pnpm contracts:gen)", (name) => {
    const document = emitPart(name, parts.get(name) ?? {});
    const file = schemaFile(name);
    if (document === null) {
      expect(existsSync(file)).toBe(false);
      return;
    }
    expect(existsSync(file), `${file} is missing`).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(formatDocument(document));
  });

  it.each(names)("schema/%s.routes.json is up to date (pnpm contracts:gen)", (name) => {
    const document = emitRoutes(parts.get(name) ?? {});
    const file = routesFile(name);
    if (document === null) {
      expect(existsSync(file)).toBe(false);
      return;
    }
    expect(existsSync(file), `${file} is missing`).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(formatDocument(document));
  });

  it("have no file left over from a part that is gone", () => {
    const files = existsSync(SCHEMA_DIR)
      ? readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))
      : [];
    const expected = names.flatMap((name) => {
      const part = parts.get(name) ?? {};
      return [
        ...(emitPart(name, part) === null ? [] : [`${name}.json`]),
        ...(emitRoutes(part) === null ? [] : [`${name}.routes.json`]),
      ];
    });
    expect(files.sort()).toEqual(expected.sort());
  });
});
