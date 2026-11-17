import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORE_URL,
  fromMicros,
  openStore,
  parseStoreUrl,
  SqliteStore,
  StoreError,
  toMicros,
} from "../src/index.js";

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "miyoria-sqlite-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("parseStoreUrl", () => {
  it("finds the SQLite path", () => {
    expect(parseStoreUrl(DEFAULT_STORE_URL)).toEqual({ path: "data/miyoria.db" });
    expect(parseStoreUrl("sqlite://data/x.db")).toEqual({ path: "data/x.db" });
    expect(parseStoreUrl("sqlite:///var/x.db")).toEqual({ path: "/var/x.db" });
    expect(parseStoreUrl("sqlite:///C:/x/y.db")).toEqual({ path: "C:/x/y.db" });
    expect(parseStoreUrl("sqlite:C:\\x\\y.db?mode=rwc")).toEqual({ path: "C:\\x\\y.db" });
    for (const memory of ["sqlite::memory:", "memory://", "memory:", "sqlite://:memory:"]) {
      expect(parseStoreUrl(memory)).toEqual({ path: ":memory:" });
    }
  });

  it("refuses PostgreSQL with a clear message, without echoing the URL", async () => {
    for (const url of ["postgres://u:secret@h/db", "postgresql://h/db"]) {
      expect(() => parseStoreUrl(url)).toThrow(/PostgreSQL is no longer supported/);
      expect(() => parseStoreUrl(url)).not.toThrow(/secret/);
      await expect(openStore(url)).rejects.toThrow(/sqlite:<path>/);
    }
  });

  it("rejects unknown schemes without echoing the URL", () => {
    expect(() => parseStoreUrl("mysql://user:secret@h/db")).toThrow(StoreError);
    expect(() => parseStoreUrl("mysql://user:secret@h/db")).not.toThrow(/secret/);
    expect(() => parseStoreUrl("sqlite:")).toThrow(/no path/);
  });
});

describe("timestamps", () => {
  it("microseconds round-trip; millisecond text is unchanged", () => {
    expect(fromMicros(toMicros("2026-11-01T12:00:00.000Z"))).toBe("2026-11-01T12:00:00.000Z");
    expect(fromMicros(toMicros("2026-11-01T12:00:00.0000019Z"))).toBe(
      "2026-11-01T12:00:00.000001Z",
    );
    expect(fromMicros(toMicros("2026-11-01 12:00:00.25+00"))).toBe("2026-11-01T12:00:00.250Z");
    expect(fromMicros(toMicros("2026-11-01T17:30:00+05:30"))).toBe("2026-11-01T12:00:00.000Z");
    expect(fromMicros(toMicros("1969-12-31T23:59:59.999999Z"))).toBe("1969-12-31T23:59:59.999999Z");
    expect(() => toMicros("2026-11-01")).toThrow(/invalid timestamp/);
  });
});

describe("SqliteStore", () => {
  it("creates directories, uses WAL and keeps data across reopen", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "a", "b", "miyoria.db");
      const first = await openStore(`sqlite:${path}`);
      await first.moduleState.set("agent", false);
      await first.close();
      await first.close(); // idempotent
      expect(existsSync(path)).toBe(true);

      const raw = new DatabaseSync(path);
      expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      raw.close();

      const second = await SqliteStore.open(path);
      expect(await second.schemaVersions()).toEqual([1]);
      expect(await second.moduleState.get("agent")).toBe(false);
      await second.close();
      await expect(second.moduleState.get("agent")).rejects.toThrow(/closed/);
    }));

  it("refuses a database migrated by a newer build", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "x.db");
      await (await SqliteStore.open(path)).close();
      const raw = new DatabaseSync(path);
      raw.exec(
        "INSERT INTO _migrations (plugin, version, name, checksum, applied_at) " +
          "VALUES ('legacy', 99, 'future', 'x', 0)",
      );
      raw.close();
      await expect(SqliteStore.open(path)).rejects.toThrow(
        /legacy migration 99 \(future\) was applied but this build does not have it/,
      );
    }));

  it("two connections on one file see each other's writes", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "shared.db");
      const a = await SqliteStore.open(path);
      const b = await SqliteStore.open(path);
      try {
        expect(await a.personaOverrides.set("p", "style", "a", "test")).toBe(1);
        expect(await b.personaOverrides.set("p", "style", "b", "test")).toBe(2);
        expect((await a.personaOverrides.current("p")).get("style")).toBe("b");
      } finally {
        await a.close();
        await b.close();
      }
    }));

  it("stamps rows with the injected clock", async () => {
    const store = await SqliteStore.open(":memory:", { clock: { now: () => 1_000 } });
    try {
      await store.personaOverrides.set("p", "style", "v1", "test");
      const [first] = await store.personaOverrides.history("p", "style");
      expect(first?.edited_at).toBe("1970-01-01T00:00:01.000Z");
    } finally {
      await store.close();
    }
  });
});
