import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MarketConfigSchema } from "@miyoria/play/market";
import { PartyConfigSchema } from "@miyoria/play/party";
import {
  Config,
  type ConfigSchema,
  configJsonSchema,
  defineManifest,
  type Module,
  type ModuleContext,
  SettingsError,
  Supervisor,
  settingFields,
} from "@miyoria/runtime/kernel";
import { openStore, type Store } from "@miyoria/store";
import type { JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODULE_CONFIG_SCHEMAS } from "../src/config-schema.js";
import { effectiveSection, ModuleSettings } from "../src/module-settings.js";

class Recorder implements Module {
  readonly seen: JsonValue[] = [];
  readonly manifest;
  constructor(
    id: string,
    readonly schema: ConfigSchema,
    requires: string[] = [],
  ) {
    this.manifest = defineManifest(id, id, { requires, configSchema: schema });
  }
  async start(ctx: ModuleContext): Promise<void> {
    this.seen.push(ctx.config(this.schema) as JsonValue);
  }
}

/** The `SettingsError` a call is refused with. */
async function refusal(call: Promise<unknown>): Promise<SettingsError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof SettingsError) return error;
    throw error;
  }
  throw new Error("the call was not refused");
}

let store: Store | null = null;
afterEach(async () => {
  await store?.close();
  store = null;
});

/** `market` and `party`, and `sing` requiring `market` (so restarting the market stops it). */
async function setup(toml = "", guard: string | null = null) {
  store = await openStore("memory://");
  const config = Config.fromToml(toml);
  const sup = new Supervisor();
  const state = { guard };
  const settings = new ModuleSettings({
    config,
    revisions: store.moduleState.revisions,
    supervisor: sup,
    guard: () => state.guard,
    checkMs: 10,
  });
  const market = new Recorder("market", MarketConfigSchema);
  const party = new Recorder("party", PartyConfigSchema);
  const sing = new Recorder("sing", PartyConfigSchema, ["market"]);
  for (const m of [market, party, sing]) {
    const file = config.module(m.manifest.id).config;
    await sup.register(m, settings.boot(m.manifest.id, file, m.schema), true);
  }
  await sup.startAll();
  return { settings, sup, market, party, sing, state, store };
}

describe("the example file", () => {
  // Every field the panel may change is also written (or commented) in the example file, under its
  // module's table, so whoever reads the file finds it there too.
  const text = readFileSync(
    fileURLToPath(new URL("../../../miyoria.example.toml", import.meta.url)),
    "utf8",
  );
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^#\s?/, "").trim());
  for (const [id, schema] of MODULE_CONFIG_SCHEMAS) {
    if (schema === null) continue;
    const fields = settingFields(configJsonSchema(schema)).fields;
    if (fields.length === 0) continue;
    it(`names every panel field of \`${id}\``, () => {
      const missing = fields.filter((f) => {
        // A module id with a dot is a quoted key: `[modules."platform.discord.bot".emoji]`.
        const key = id.includes(".") ? JSON.stringify(id) : id;
        const table = ["modules", key, ...f.keys.slice(0, -1)].join(".");
        const start = lines.indexOf(`[${table}]`);
        if (start === -1) return true;
        const end = lines.findIndex((l, i) => i > start && l.startsWith("["));
        const body = lines.slice(start + 1, end === -1 ? undefined : end);
        return !body.some((l) => l.startsWith(`${f.keys.at(-1)} =`));
      });
      expect(missing.map((f) => f.path)).toEqual([]);
    });
  }
});

describe("effectiveSection", () => {
  it("lays the layer over the file key by key and skips a key that does not fit", () => {
    const out = effectiveSection(
      { auction_hours: 12, auction_channel: "123456" },
      { auction_hours: 999, auction_step: 7 },
      MarketConfigSchema,
    );
    expect(out.config).toEqual({ auction_hours: 12, auction_channel: "123456", auction_step: 7 });
    expect(out.skipped.map((s) => s.keys)).toEqual([["auction_hours"]]);
  });
});

describe("ModuleSettings", () => {
  it("describes the marked fields with where each value comes from", async () => {
    const { settings } = await setup("[modules.market]\nauction_hours = 12\n");
    const view = settings.describe("market");
    expect(view.groups.map((g) => g.id)).toEqual(["auction", "lottery", "song"]);
    expect(view.fields.map((f) => f.path)).not.toContain("auction_purpose");
    expect(view.fields.map((f) => f.path)).not.toContain("lottery_prize_share");
    expect(view.values.auction_hours).toMatchObject({ value: 12, source: "file", file: 12 });
    expect(view.values.auction_channel).toMatchObject({ value: "", source: "default" });
    expect(view.revision).toBe(0);
    expect(settings.editable("market")).toBe(true);
  });

  it("saves into the layer, restarts the module and its dependents, and keeps a history", async () => {
    const { settings, market, sing, party } = await setup("[modules.market]\nauction_hours = 12\n");
    const result = await settings.save(
      "market",
      { expected: 0, set: { auction_hours: 48, auction: false }, reset: [] },
      "panel:p1",
    );
    expect(result).toMatchObject({ revision: 1, applied: "restarted", state: "running" });
    expect(market.seen.at(-1)).toMatchObject({ auction_hours: 48, auction: false });
    expect(sing.seen).toHaveLength(2);
    const view = settings.describe("market");
    expect(view.values.auction_hours).toMatchObject({ value: 48, source: "panel", file: 12 });
    expect(view.updated).toMatchObject({ version: 1, by: "panel:p1" });

    // A nested field.
    await settings.save("party", { expected: 1, set: { "rewards.max_coins": 5 }, reset: [] }, "p");
    expect(party.seen.at(-1)).toMatchObject({ rewards: { max_coins: 5, enabled: true } });

    await settings.save("market", { expected: 2, set: {}, reset: ["auction_hours"] }, "panel:p1");
    expect(market.seen.at(-1)).toMatchObject({ auction_hours: 12 });
    const history = settings.history("market");
    expect(history.items.map((h) => h.version)).toEqual([3, 1]);
    expect(history.items[0]?.changes).toEqual([
      { path: "auction_hours", label: "拍多久", before: 48, after: null },
    ]);
    expect(settings.overrides().map((o) => o.key)).toEqual([
      "modules.market.auction",
      "modules.party.rewards.max_coins",
    ]);

    await settings.revert("market", 1, 3, "panel:p1");
    expect(market.seen.at(-1)).toMatchObject({ auction_hours: 48 });
  });

  it("refuses a bad value per field in zh-TW, an unmarked field, an env reference and a stale revision", async () => {
    const { settings } = await setup();
    const save = (set: Record<string, JsonValue>, expected = 0) =>
      refusal(settings.save("market", { expected, set, reset: [] }, "p"));
    const bad = await save({ auction_hours: 0 });
    expect(bad.kind).toBe("invalid");
    expect(bad.problems[0]?.path).toBe("auction_hours");
    expect(bad.problems[0]?.message).toMatch(/^拍多久:.*1/);

    const hidden = await save({ lottery_prize_share: 0.5 });
    expect(hidden.kind).toBe("not_editable");
    expect(hidden.problems.map((p) => p.path)).toEqual(["lottery_prize_share"]);

    // biome-ignore lint/suspicious/noTemplateCurlyInString: the reference the layer refuses
    expect((await save({ auction_channel: "${CHANNEL}" })).kind).toBe("not_editable");

    await settings.save("market", { expected: 0, set: { auction_hours: 2 }, reset: [] }, "p");
    expect((await save({ auction_hours: 3 })).kind).toBe("conflict");
  });

  it("waits for the guard before restarting what she is using, then applies", async () => {
    const { settings, market, state } = await setup("", "singing");
    expect(settings.describe("market").guard).toBe("singing");
    expect(settings.describe("party").guard).toBeNull();
    const result = await settings.save(
      "market",
      { expected: 0, set: { auction_hours: 5 }, reset: [] },
      "p",
    );
    expect(result.applied).toBe("deferred");
    expect(settings.pending("market")).toBe("singing");
    expect(market.seen).toHaveLength(1);
    state.guard = null;
    await vi.waitFor(() => expect(market.seen).toHaveLength(2));
    expect(market.seen.at(-1)).toMatchObject({ auction_hours: 5 });
    expect(settings.pending("market")).toBeNull();
    settings.close();
  });

  it("expands the layer's env references and calls a key equal to the file's the file's", async () => {
    const env = (name: string) => (name === "AUCTION_CHANNEL" ? "123456" : undefined);
    store = await openStore("memory://");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the reference the import keeps
    const ref = "${AUCTION_CHANNEL}";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a variable that is not set
    const missing = "${NOPE}";
    const config = Config.fromToml(`[modules.market]\nauction_channel = "${ref}"\n`, env);
    const settings = new ModuleSettings({
      config,
      revisions: store.moduleState.revisions,
      supervisor: new Supervisor(),
      guard: () => null,
      env,
    });
    // What `miyoria config import` writes: the file as it is, references and all.
    store.moduleState.revisions.write(
      { modules: { market: { auction_channel: ref, auction_hours: 30, auction_step: missing } } },
      "import",
    );
    const file = config.module("market").config;
    const booted = settings.boot("market", file, MarketConfigSchema) as Record<string, JsonValue>;
    expect(booted.auction_channel).toBe("123456");
    expect(booted.auction_hours).toBe(30);
    // A variable that is not set: the key is skipped, never a literal reference.
    expect(booted.auction_step).toBeUndefined();
    const sup = new Supervisor();
    await sup.register(new Recorder("market", MarketConfigSchema), booted, false);
    const view = new ModuleSettings({
      config,
      revisions: store.moduleState.revisions,
      supervisor: sup,
      guard: () => null,
      env,
    }).describe("market");
    expect(view.values.auction_channel).toMatchObject({ value: "123456", source: "file" });
    expect(view.values.auction_hours).toMatchObject({ value: 30, source: "panel" });
    expect(view.values.auction_step?.invalid).toBe("環境變數 NOPE 沒有設定");
  });

  it("skips a panel value that no longer fits, at boot and on the form", async () => {
    const { settings, store: s } = await setup("[modules.market]\nauction_hours = 12\n");
    // A value an older schema took, written straight into the revisions.
    s.moduleState.revisions.write({ modules: { market: { auction_hours: 999 } } }, "test");
    const view = settings.describe("market");
    expect(view.values.auction_hours).toMatchObject({ value: 12, source: "file" });
    expect(view.values.auction_hours?.invalid).toBeTruthy();
    expect(settings.boot("market", { auction_hours: 12 }, MarketConfigSchema)).toEqual({
      auction_hours: 12,
    });
  });
});
