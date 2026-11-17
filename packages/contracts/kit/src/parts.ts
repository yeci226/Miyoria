// Finds the parts of this package on disk and loads them. Node only: the generator and the tests
// use it, nothing that ships to a browser does.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** `packages/contracts`. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where the generated JSON Schema files are kept. */
export const SCHEMA_DIR = join(PACKAGE_DIR, "schema");

/** Folders that are not contract parts. */
const NOT_PARTS = new Set(["kit", "schema", "dist", "node_modules"]);

/** The names of the parts, in order: every folder with a `src/index.ts`, the kit aside. */
export function partNames(): string[] {
  return readdirSync(PACKAGE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_PARTS.has(entry.name))
    .filter((entry) => existsSync(join(PACKAGE_DIR, entry.name, "src", "index.ts")))
    .map((entry) => entry.name)
    .sort();
}

/** A part's exports. */
export async function loadPart(name: string): Promise<Record<string, unknown>> {
  const entry = join(PACKAGE_DIR, name, "src", "index.ts");
  return (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
}

/** The file a part's JSON Schema is kept in. */
export function schemaFile(name: string): string {
  return join(SCHEMA_DIR, `${name}.json`);
}

/** The file a part's route tables (without schemas) are kept in. */
export function routesFile(name: string): string {
  return join(SCHEMA_DIR, `${name}.routes.json`);
}
