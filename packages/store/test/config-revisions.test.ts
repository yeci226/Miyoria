// Config revisions (v5-data §6): writing one, reading the current one and the history, reverting,
// the `config.revised` event, and module on/off kept as `enabled` flags of the current revision.

import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigConflictError,
  ConfigModuleState,
  ConfigRevisions,
  changedPaths,
  openStore,
  type Store,
} from "../src/index.js";

const T0 = Date.UTC(2026, 10, 15);

const open: TestDb[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

function setup() {
  let now = T0;
  const t = openTestDb({ config: true, clock: { now: () => now } });
  open.push(t);
  const revisions = new ConfigRevisions(t.db, t.events);
  return {
    t,
    revisions,
    modules: new ConfigModuleState(t.db, revisions),
    tick: () => {
      now += 1000;
    },
  };
}

function revisedEvents(t: TestDb) {
  return t.events.query({ types: ["config.revised"], order: "asc" }).map((e) => ({
    ...(e.envelope.data as object),
    scope: e.envelope.scope,
    tier: e.envelope.tier,
  }));
}

describe("config revisions", () => {
  it("writes numbered whole documents; the current one is the highest", () => {
    const { t, revisions, tick } = setup();
    expect(revisions.current()).toBeNull();
    expect(revisions.history()).toEqual([]);

    const first = revisions.write({ core: { profile: "deepseek-chan" } }, "import", {
      note: "miyoria.toml",
    });
    expect(first).toEqual({
      version: 1,
      doc: { core: { profile: "deepseek-chan" } },
      created_at: "2026-11-15T00:00:00.000Z",
      created_by: "import",
      note: "miyoria.toml",
    });
    tick();
    const second = revisions.write(
      {
        core: { profile: "deepseek-chan" },
        modules: { "platform.discord.bot": { enabled: false } },
      },
      "panel:p1",
    );
    expect(second.version).toBe(2);
    expect(second.note).toBeNull();
    expect(revisions.current()).toEqual(second);
    expect(revisions.get(1)).toEqual(first);
    expect(revisions.get(3)).toBeNull();
    expect(revisions.history().map((r) => r.version)).toEqual([2, 1]);
    expect(revisions.history(1).map((r) => r.version)).toEqual([2]);

    // Each revision is one event for the owner, kept, with the paths that changed.
    expect(revisedEvents(t)).toEqual([
      {
        version: 1,
        created_by: "import",
        note: "miyoria.toml",
        changed: ["core"],
        scope: "owner",
        tier: "keep",
      },
      {
        version: 2,
        created_by: "panel:p1",
        note: null,
        changed: ["modules"],
        scope: "owner",
        tier: "keep",
      },
    ]);
  });

  it("writes nothing for a document equal to the current one, key order aside", () => {
    const { t, revisions } = setup();
    revisions.write({ a: 1, b: { c: [1, 2] } }, "cli");
    const again = revisions.write({ b: { c: [1, 2] }, a: 1 }, "cli");
    expect(again.version).toBe(1);
    expect(revisedEvents(t)).toHaveLength(1);
    // An empty document is a revision too.
    expect(revisions.write({}, "cli").version).toBe(2);
  });

  it("refuses what is not a JSON object, an empty author, and what `validate` refuses", () => {
    const { t } = setup();
    const revisions = new ConfigRevisions(t.db, t.events, {
      validate: (doc) => {
        if ("bad" in doc) throw new Error("invalid config at `bad`");
        return { ...doc, normalised: true };
      },
    });
    expect(() => revisions.write([] as never, "cli")).toThrow(/must be a JSON object/);
    expect(() => revisions.write({ x: undefined } as never, "cli")).toThrow(/JSON object/);
    expect(() => revisions.write({}, " ")).toThrow(/needs its author/);
    expect(() => revisions.write({ bad: 1 }, "cli")).toThrow(/invalid config at `bad`/);
    expect(revisions.current()).toBeNull();
    expect(revisions.write({ a: 1 }, "cli").doc).toEqual({ a: 1, normalised: true });
  });

  it("applies only on top of the revision the writer started from", () => {
    const { revisions } = setup();
    revisions.write({ a: 1 }, "panel:p1", { expected: 0 });
    revisions.write({ a: 2 }, "panel:p2", { expected: 1 });
    let error: unknown = null;
    try {
      revisions.write({ a: 3 }, "panel:p1", { expected: 1 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigConflictError);
    expect(error).toMatchObject({ expected: 1, current: 2 });
    expect(revisions.current()?.doc).toEqual({ a: 2 });
  });

  it("reverts by writing an earlier document as the next revision", () => {
    const { revisions } = setup();
    revisions.write({ a: 1 }, "import");
    revisions.write({ a: 2 }, "cli");
    const back = revisions.revert(1, "panel:p1");
    expect(back).toMatchObject({ version: 3, doc: { a: 1 }, note: "revert to 1" });
    expect(() => revisions.revert(9, "cli")).toThrow(/no config revision 9/);
  });

  it("rolls back with the caller's transaction, the event too", () => {
    const { t, revisions } = setup();
    expect(() =>
      t.db.tx(() => {
        revisions.write({ a: 1 }, "cli");
        throw new Error("later step failed");
      }),
    ).toThrow(/later step failed/);
    expect(revisions.current()).toBeNull();
    expect(revisedEvents(t)).toEqual([]);
  });

  it("names the changed paths TOML-style", () => {
    expect(
      changedPaths(
        { core: { a: 1 }, modules: { "platform.discord.bot": { enabled: true } }, x: [1] },
        { core: { a: 1 }, modules: { "platform.discord.bot": { enabled: false } }, x: [1, 2] },
      ),
    ).toEqual(['modules."platform.discord.bot".enabled', "x"]);
    expect(changedPaths({ a: { b: 1 } }, { a: 1 })).toEqual(["a"]);
    expect(changedPaths({ a: 1 }, {})).toEqual(["a"]);
    expect(changedPaths(undefined, { a: 1 })).toEqual(["a"]);
    expect(changedPaths({ a: null }, { a: null })).toEqual([]);
  });
});

describe("module on/off in the config", () => {
  it("is the enabled flag of modules.<id> in the current revision", async () => {
    const { t, revisions, modules } = setup();
    expect(await modules.get("osu")).toBeNull();
    expect(await modules.list()).toEqual(new Map());
    await modules.set("ext.miyoria.osu", false);
    expect(revisions.current()).toMatchObject({
      version: 1,
      doc: { modules: { "ext.miyoria.osu": { enabled: false } } },
      created_by: "runtime",
      note: "module ext.miyoria.osu off",
    });
    // The rest of the document and of the module's section stays.
    revisions.write(
      { core: { profile: "p" }, modules: { "ext.miyoria.osu": { enabled: false, x: 1 } } },
      "cli",
    );
    await modules.set("ext.miyoria.osu", true);
    await modules.set("speech", false);
    expect(revisions.current()?.doc).toEqual({
      core: { profile: "p" },
      modules: { "ext.miyoria.osu": { enabled: true, x: 1 }, speech: { enabled: false } },
    });
    expect(await modules.get("ext.miyoria.osu")).toBe(true);
    expect(await modules.list()).toEqual(
      new Map([
        ["ext.miyoria.osu", true],
        ["speech", false],
      ]),
    );
    // Setting what it already is writes nothing.
    const version = revisions.current()?.version;
    await modules.set("speech", false);
    expect(revisions.current()?.version).toBe(version);
    expect(revisedEvents(t).at(-1)).toMatchObject({
      created_by: "runtime",
      note: "module speech off",
      changed: ["modules.speech"],
    });
  });

  it("clears every flag in one revision and says how many there were", async () => {
    const { revisions, modules } = setup();
    expect(modules.clear("wipe")).toBe(0);
    expect(revisions.current()).toBeNull();
    await modules.set("a", false);
    await modules.set("b", true);
    revisions.write(
      {
        ...revisions.current()?.doc,
        modules: { a: { enabled: false, keep: 1 }, b: { enabled: true } },
      },
      "cli",
    );
    expect(modules.clear("wipe")).toBe(2);
    expect(revisions.current()).toMatchObject({
      doc: { modules: { a: { keep: 1 }, b: {} } },
      created_by: "wipe",
    });
    expect(await modules.list()).toEqual(new Map());
  });
});

describe("the store's module state", () => {
  let store: Store | null = null;
  afterEach(async () => {
    await store?.close();
    store = null;
  });

  it("counts, exports and wipes the flags as the module_state category", async () => {
    store = await openStore("memory://");
    await store.moduleState.set("speech", false);
    await store.moduleState.set("api", true);
    const inventory = await store.profileData.inventory("p");
    const category = inventory.categories.find((c) => c.id === "module_state");
    expect(category).toMatchObject({ count: 2, parts: [{ id: "module_state", count: 2 }] });
    expect(category?.updated_at).toEqual(expect.any(String));
    const backup = await store.profileData.export("p", ["module_state"]);
    expect(backup.parts.module_state).toEqual([
      { module_id: "api", enabled: true, updated_at: expect.any(String) },
      { module_id: "speech", enabled: false, updated_at: expect.any(String) },
    ]);
    expect(await store.profileData.wipe("p", ["module_state"])).toEqual({ module_state: 2 });
    expect(await store.moduleState.list()).toEqual(new Map());
    expect(await store.moduleState.get("speech")).toBeNull();
  });
});
