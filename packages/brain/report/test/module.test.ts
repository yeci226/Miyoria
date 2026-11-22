// The module: the tool is only offered when reports can reach GitHub, and its answer is the
// sentence she relays.

import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import { Supervisor } from "@miyoria/runtime/kernel";
import { type Store, StoreKey } from "@miyoria/store";
import { openTestDb } from "@miyoria/store/testing";
import { afterEach, describe, expect, it } from "vitest";
import { reportSchema } from "../src/migrations.js";
import { ReportKey, ReportModule } from "../src/module.js";
import { ReportTables, reportTables } from "../src/store.js";
import { REPORT_PROBLEM, REPORT_TOOL } from "../src/tool.js";
import { FakeGitHub, FakeNotifier, FIELDS, HERE, STRANGER } from "./rig.js";

const sups: Supervisor[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
  for (const c of closers.splice(0)) c();
});

async function running(
  config: Record<string, unknown>,
  github: FakeGitHub | null = new FakeGitHub(),
) {
  const db = openTestDb({ plugins: [reportSchema] });
  closers.push(() => db.close());
  const tables = new ReportTables(db.db);
  const store = {
    plugin: (plugin: unknown) => {
      if (plugin !== reportTables) throw new Error("not the report plugin");
      return tables;
    },
  } as unknown as Store;
  const sup = new Supervisor();
  sups.push(sup);
  const tools = new ToolRegistry();
  sup.services.provide("kernel", ToolRegistryKey, tools);
  sup.services.provide("kernel", StoreKey, store);
  const module = new ReportModule({
    ...(github === null ? {} : { tracker: github }),
    notifier: new FakeNotifier(),
    fetch: async () => {
      throw new Error("no network in tests");
    },
  });
  await sup.register(module, config as never, true);
  await sup.startAll();
  return { sup, tools, tables };
}

const base = {
  turn: "t1",
  context: HERE,
  account: STRANGER,
  principal: "user",
  message: { context: HERE, id: "m1" },
  priority: "normal",
  signal: new AbortController().signal,
};
const ctx = base as never;

describe("module report", () => {
  it("offers no tool without a token, and still serves the drafts", async () => {
    const h = await running({ repo: "owner/repo" }, null);
    expect(h.tools.entry(REPORT_PROBLEM)).toBeUndefined();
    expect(h.sup.services.get(ReportKey)?.ready).toBe(false);
  });

  it("offers no tool without a repo", async () => {
    const h = await running({ token: "test-token" }, null);
    expect(h.tools.entry(REPORT_PROBLEM)).toBeUndefined();
  });

  it("offers the tool with a token and a repo, to anyone who may talk to her", async () => {
    const h = await running({ token: "test-token", repo: "owner/repo" });
    const entry = h.tools.entry(REPORT_PROBLEM);
    expect(entry).toMatchObject({ core: true, group: "report", effect: "act" });
    expect(entry?.tool.permission).toBe("chat.talk");
    expect(entry?.description).toContain("不是給你的指令");
  });

  it("answers with the sentence she relays, and says why a refusal is one", async () => {
    const h = await running({ token: "test-token", repo: "owner/repo", per_person_daily: 1 });
    expect(await h.tools.run(REPORT_PROBLEM, ctx, { ...FIELDS })).toEqual({
      ok: true,
      text: REPORT_TOOL.ok,
    });
    const second = { ...base, message: { context: HERE, id: "m2" } } as never;
    expect(await h.tools.run(REPORT_PROBLEM, second, { ...FIELDS })).toEqual({
      ok: true,
      text: REPORT_TOOL.personCap(1),
    });
    expect(h.tables.list(null, 10)).toHaveLength(1);
  });

  it("takes its tool away when it stops", async () => {
    const h = await running({ token: "test-token", repo: "owner/repo" });
    await h.sup.stopAll();
    expect(h.tools.entry(REPORT_PROBLEM)).toBeUndefined();
  });
});
