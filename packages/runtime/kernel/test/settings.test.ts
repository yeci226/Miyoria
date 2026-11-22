import type { JsonValue, ModuleStateKind } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  configJsonSchema,
  defineManifest,
  type Module,
  type ModuleContext,
  manifestJson,
  placeConfig,
  placeFields,
  Supervisor,
  setting,
  settingFields,
  settingGroups,
} from "../src/index.js";

const Schema = z
  .object({
    channel: z
      .string()
      .default("")
      .meta(setting({ kind: "channel", room: "text", ref: "id", label: "頻道", group: "where" })),
    weekday: z
      .number()
      .int()
      .min(0)
      .max(6)
      .default(6)
      .meta(setting({ kind: "weekday", label: "星期幾", group: "when" })),
    price: z
      .number()
      .int()
      .positive()
      .default(50)
      .meta(setting({ kind: "coins", label: "價格", group: "price", help: "一張多少" })),
    start: z
      .enum(["decide", "auto"])
      .default("decide")
      .meta(setting({ kind: "select", label: "開始", labels: { decide: "她決定", auto: "自動" } })),
    hidden: z.number().default(3),
    rewards: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .meta(setting({ kind: "switch", label: "發獎勵", group: "price", order: 1 })),
        cap: z.number().int().nonnegative().default(20),
      })
      .prefault({}),
    channels: z
      .array(z.string())
      .default([])
      .meta(setting({ kind: "channel", multiple: true, ref: "id", label: "頻道們" })),
  })
  .meta(
    settingGroups([
      { id: "where", label: "地點" },
      { id: "when", label: "時間" },
      { id: "price", label: "價格" },
    ]),
  );

describe("settingFields", () => {
  const found = settingFields(configJsonSchema(Schema));

  it("finds the marked fields, nested ones too, and nothing else", () => {
    expect(found.fields.map((f) => f.path)).toEqual([
      "channel",
      "weekday",
      "rewards.enabled",
      "price",
      "start",
      "channels",
    ]);
    expect(found.groups.map((g) => g.id)).toEqual(["where", "when", "price"]);
    expect(found.skipped).toEqual([]);
  });

  it("takes limits, options and defaults from the schema", () => {
    const by = Object.fromEntries(found.fields.map((f) => [f.path, f]));
    expect(by.weekday).toMatchObject({ min: 0, max: 6, int: true, step: 1, default: 6 });
    // `.positive()` on an integer is a minimum of 1.
    expect(by.price).toMatchObject({ min: 1, max: null, help: "一張多少", kind: "coins" });
    expect(by.start).toMatchObject({ options: ["decide", "auto"], labels: { auto: "自動" } });
    expect(by.channels).toMatchObject({ multiple: true, ref: "id", default: [] });
    expect(by.channel).toMatchObject({ room: "text", apply: "module", scope: "cluster" });
    expect(by["rewards.enabled"]?.keys).toEqual(["rewards", "enabled"]);
  });

  it("reads an extension's hand-written JSON Schema and skips a marker it cannot use", () => {
    const json: JsonValue = {
      type: "object",
      properties: {
        on: { type: "boolean", default: false, "x-miyoria": { kind: "switch", label: "開" } },
        odd: { type: "string", "x-miyoria": { kind: "wheel", label: "?" } },
        bare: { type: "string", "x-miyoria": { kind: "text" } },
      },
    };
    const out = settingFields(json);
    expect(out.fields.map((f) => f.path)).toEqual(["on"]);
    expect(out.skipped.map((s) => s.path)).toEqual(["odd", "bare"]);
  });

  it("puts the marker in the manifest's JSON", () => {
    const json = manifestJson(defineManifest("x", "X", { configSchema: Schema, icon: "coins" }));
    expect(settingFields(json.config_schema).fields).toHaveLength(6);
    expect(json.icon).toBe("coins");
    expect(json.category).toBe("system");
  });

  it("reads a field's place scope and merge; union only for a list", () => {
    const Places = z.object({
      mode: z
        .enum(["quiet", "normal"])
        .default("normal")
        .meta(setting({ kind: "select", label: "模式", scope: "room", merge: "union" })),
      forbidden: z
        .array(z.string())
        .default([])
        .meta(setting({ kind: "multi", label: "不能用", scope: "room", merge: "union" })),
      channel: z
        .string()
        .default("")
        .meta(setting({ kind: "channel", label: "頻道", scope: "space", ref: "id" })),
      secret: z
        .string()
        .default("")
        .meta(setting({ kind: "text", label: "金鑰", scope: "space", secret: true })),
      plain: z
        .number()
        .default(1)
        .meta(setting({ kind: "number", label: "數字" })),
    });
    const by = Object.fromEntries(
      settingFields(configJsonSchema(Places)).fields.map((f) => [f.path, f]),
    );
    expect(by.mode).toMatchObject({ scope: "room", merge: "replace" });
    expect(by.forbidden).toMatchObject({ scope: "room", merge: "union" });
    expect(by.channel).toMatchObject({ scope: "space", merge: "replace" });
    expect(by.plain).toMatchObject({ scope: "cluster", merge: "replace" });
    // What `placeConfig` overlays: the place fields, never a secret.
    expect(placeFields(Places)).toEqual([
      { keys: ["mode"], scope: "room", merge: "replace", channel: null },
      { keys: ["forbidden"], scope: "room", merge: "union", channel: null },
      {
        keys: ["channel"],
        scope: "space",
        merge: "replace",
        channel: { ref: "id", multiple: false },
      },
    ]);
  });
});

describe("placeConfig without Core's service", () => {
  it("gives every place the module's own section", () => {
    const Places = z.object({
      channel: z
        .string()
        .default("")
        .meta(setting({ kind: "channel", label: "頻道", scope: "space", ref: "id" })),
    });
    const ctx = {
      id: "x",
      rawConfig: { channel: "1" },
      services: { get: () => undefined },
    } as unknown as ModuleContext;
    const cfg = placeConfig(ctx, Places);
    expect(cfg.base()).toEqual({ channel: "1" });
    expect(cfg.for({ space_id: "s" })).toBe(cfg.base());
    expect(cfg.onChange(() => {})).toBeTypeOf("function");
    expect(() =>
      placeConfig({ ...ctx, rawConfig: { channel: 5 } } as unknown as ModuleContext, Places),
    ).toThrow(/modules\.x/);
  });
});

class Recorder implements Module {
  readonly seen: (JsonValue | null)[] = [];
  readonly manifest;

  constructor(id: string, requires: string[] = []) {
    this.manifest = defineManifest(id, id, { requires });
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.seen.push(ctx.config(z.looseObject({})) as JsonValue);
  }
}

const stateOf = (sup: Supervisor, id: string): ModuleStateKind | undefined =>
  sup.list().find((s) => s.id === id)?.state;

describe("Supervisor.reconfigure", () => {
  it("restarts the module and its dependents with the new config", async () => {
    const sup = new Supervisor();
    const base = new Recorder("base");
    const top = new Recorder("top", ["base"]);
    await sup.register(base, { a: 1 }, true);
    await sup.register(top, null, true);
    await sup.startAll();
    await sup.reconfigure("base", { a: 2 });
    expect(base.seen).toEqual([{ a: 1 }, { a: 2 }]);
    expect(top.seen).toHaveLength(2);
    expect(stateOf(sup, "base")).toBe("running");
    expect(stateOf(sup, "top")).toBe("running");
    expect(sup.configOf("base")).toEqual({ a: 2 });
    expect(sup.dependentsOf("base")).toEqual(["top"]);
  });

  it("keeps the config of a disabled module, or one told not to restart, for its next start", async () => {
    const sup = new Supervisor();
    const off = new Recorder("off");
    const on = new Recorder("on");
    await sup.register(off, { a: 1 }, false);
    await sup.register(on, { a: 1 }, true);
    await sup.startAll();
    await sup.reconfigure("off", { a: 2 });
    await sup.reconfigure("on", { a: 3 }, { restart: false });
    expect(off.seen).toEqual([]);
    expect(on.seen).toEqual([{ a: 1 }]);
    await sup.enable("off");
    await sup.restart("on");
    expect(off.seen).toEqual([{ a: 2 }]);
    expect(on.seen).toEqual([{ a: 1 }, { a: 3 }]);
  });
});
