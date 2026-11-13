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
  it("selects the backend", () => {
    expect(parseStoreUrl(DEFAULT_STORE_URL)).toEqual({
      backend: "sqlite",
      path: "data/miyoria.db",
    });
    expect(parseStoreUrl("sqlite://data/x.db")).toEqual({ backend: "sqlite", path: "data/x.db" });
    expect(parseStoreUrl("sqlite:///var/x.db")).toEqual({ backend: "sqlite", path: "/var/x.db" });
    expect(parseStoreUrl("sqlite:///C:/x/y.db")).toEqual({ backend: "sqlite", path: "C:/x/y.db" });
    expect(parseStoreUrl("sqlite:C:\\x\\y.db?mode=rwc")).toEqual({
      backend: "sqlite",
      path: "C:\\x\\y.db",
    });
    for (const memory of ["sqlite::memory:", "memory://", "memory:", "sqlite://:memory:"]) {
      expect(parseStoreUrl(memory)).toEqual({ backend: "sqlite", path: ":memory:" });
    }
    expect(parseStoreUrl("postgres://u:p@h/db")).toEqual({
      backend: "postgres",
      url: "postgres://u:p@h/db",
    });
    expect(parseStoreUrl("postgresql://h/db").backend).toBe("postgres");
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
      expect(await second.schemaVersions()).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
      ]);
      expect(await second.moduleState.get("agent")).toBe(false);
      await second.close();
      await expect(second.moduleState.get("agent")).rejects.toThrow(/closed/);
    }));

  it("refuses a database migrated by a newer build", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "x.db");
      await (await SqliteStore.open(path)).close();
      const raw = new DatabaseSync(path);
      raw.exec("INSERT INTO schema_version (version, name, applied_at) VALUES (99, 'future', 0)");
      raw.close();
      await expect(SqliteStore.open(path)).rejects.toThrow(/migration 99 .* missing/);
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

  it("caps decisions only when asked to on files", () =>
    withTempDir(async (dir) => {
      const store = await SqliteStore.open(join(dir, "d.db"), { maxDecisionsPerProfile: 2 });
      try {
        const context = { platform: "discord", scope: "g", channel: "c", kind: "channel" } as const;
        for (const i of [1, 2, 3]) {
          await store.decisions.append({
            id: `01JAAAAAAAAAAAAAAAAAAAAAA${i}`,
            profile: "p",
            ts: new Date(i * 1000).toISOString(),
            trace: { turn: "t", context, respond: false, score: 0, reasons: [String(i)] },
          });
        }
        const recent = await store.decisions.recent("p", null, 10);
        expect(recent.map((d) => d.trace.reasons[0])).toEqual(["3", "2"]);
      } finally {
        await store.close();
      }
    }));
});
