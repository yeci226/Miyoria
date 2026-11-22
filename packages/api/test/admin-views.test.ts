// The admin routes for her life, economy, workspace, party games and notebook (`src/life.ts`,
// `economy.ts`, `workspace.ts`, `party.ts`, `notebook.ts`): timers, her day, the activity table,
// economy health and open items, her workspace and skills, the notebook and the "just now" timeline.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Economy2Key } from "@miyoria/economy";
import { ActuatorRegistryKey } from "@miyoria/gate/actions";
import { LIFE_ACTIVITIES } from "@miyoria/heart/mind";
import { Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import {
  type JustNowEntry,
  JustNowKey,
  type LifeEntry,
  LifeLogKey,
  NotebookKey,
  type NotebookPage,
  PartyOverviewKey,
  type Reminder,
  ReminderDeskKey,
  SkillShelfKey,
  toTimestamp,
} from "@miyoria/types";
import { PersistentWorkspace, SandboxKey } from "@miyoria/workspace/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { ACTIVITY_ROWS } from "../src/life.js";
import { raw } from "./support/http.js";

const TOKEN = "test-token";
const NOW = Date.parse("2026-11-10T12:00:00Z");

const sups: Supervisor[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function harness() {
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  const get = (path: string) => raw(base, "GET", path, { token: TOKEN });
  const post = (path: string, json: unknown) => raw(base, "POST", path, { token: TOKEN, json });
  return { sup, base, get, post };
}

const reminder = (key: string, over: Partial<Reminder> = {}): Reminder => ({
  id: `id-${key}`,
  key,
  what: "問 Owen 考試考得怎樣",
  due: toTimestamp(NOW + 3_600_000),
  daily: false,
  context: null,
  person: null,
  for_account: null,
  fired: 0,
  created_at: toTimestamp(NOW),
  ...over,
});

describe("routes need the token and the module that provides them", () => {
  it("answer 401 without the token and 503 without the module", async () => {
    const h = await harness();
    for (const path of [
      "/api/life/today",
      "/api/life/reminders",
      "/api/life/activities",
      "/api/economy/health",
      "/api/economy/predictions",
      "/api/economy/room",
      "/api/workspace",
      "/api/skills",
      "/api/notebook",
    ]) {
      expect((await raw(h.base, "GET", path)).status, path).toBe(401);
      expect((await h.get(path)).status, path).toBe(503);
    }
    expect((await raw(h.base, "DELETE", "/api/life/reminders/R1", { token: TOKEN })).status).toBe(
      503,
    );
  });
});

describe("her timers", () => {
  it("lists them and cancels one by key", async () => {
    const h = await harness();
    let open = [reminder("R7XK2P"), reminder("R9", { daily: true })];
    h.sup.services.provide("mind", ReminderDeskKey, {
      list: () => open,
      cancel: (k: string) => {
        const had = open.some((r) => r.key === k || r.id === k);
        open = open.filter((r) => r.key !== k && r.id !== k);
        return had;
      },
    });
    const list = await h.get("/api/life/reminders");
    expect(list.status).toBe(200);
    const body = list.body as { reminders: Reminder[] };
    expect(body.reminders.map((r) => r.key)).toEqual(["R7XK2P", "R9"]);
    expect(body.reminders[1]?.daily).toBe(true);

    const gone = await raw(h.base, "DELETE", "/api/life/reminders/R7XK2P", { token: TOKEN });
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ cancelled: true, key: "R7XK2P" });
    const again = await raw(h.base, "DELETE", "/api/life/reminders/R7XK2P", { token: TOKEN });
    expect(again.status).toBe(404);
    expect(
      ((await h.get("/api/life/reminders")).body as { reminders: unknown[] }).reminders,
    ).toHaveLength(1);
  });
});

describe("her day", () => {
  const entry = (id: string, activity: LifeEntry["activity"], at: number): LifeEntry => ({
    id,
    activity,
    what: `做了 ${id}`,
    at: toTimestamp(at),
    minutes: id === "b" ? 12 : null,
    capability: activity === "browse" ? "web.search" : null,
  });

  it("returns today and lately with what her prompt says", async () => {
    const h = await harness();
    const all = [
      entry("old", "diary", Date.now() - 3 * 86_400_000),
      entry("a", "browse", Date.now() - 600_000),
      entry("b", "code", Date.now() - 300_000),
    ];
    h.sup.services.provide("mind", LifeLogKey, {
      entries: (since = 0) => all.filter((e) => Date.parse(e.at) >= since),
      today: () => all.slice(1),
      summary: (scope = "today") => (scope === "today" ? "今天逛了網路" : null),
    });
    const res = await h.get("/api/life/today");
    expect(res.status).toBe(200);
    const body = res.body as {
      today: { id: string; minutes: number | null }[];
      lately: { id: string }[];
      summary_today: string | null;
      summary_lately: string | null;
    };
    expect(body.today.map((e) => e.id)).toEqual(["a", "b"]);
    expect(body.lately.map((e) => e.id)).toEqual(["old", "a", "b"]);
    expect(body.today[1]?.minutes).toBe(12);
    expect(body.summary_today).toBe("今天逛了網路");
    expect(body.summary_lately).toBeNull();
  });

  it("marks the rows whose capability is not registered", async () => {
    const h = await harness();
    const registered = new Set(["web.search", "sing.play"]);
    h.sup.services.provide("actions", ActuatorRegistryKey, {
      get: (name: string) => (registered.has(name) ? ({} as never) : undefined),
    } as never);
    const res = await h.get("/api/life/activities");
    expect(res.status).toBe(200);
    const rows = (res.body as { activities: Record<string, unknown>[] }).activities;
    const byId = Object.fromEntries(rows.map((r) => [r.id as string, r]));
    expect(byId.browse).toMatchObject({
      available: true,
      capability: "web.search",
      done_today: null,
    });
    expect(byId.browse?.capabilities).toEqual([
      { id: "web.search", registered: true },
      { id: "web.read", registered: false },
    ]);
    expect(byId.diary).toMatchObject({ available: false, capability: null });
    expect(rows).toHaveLength(LIFE_ACTIVITIES.length);
  });

  it("keeps a table that matches the mind module's", () => {
    expect(
      ACTIVITY_ROWS.map((r) => ({
        id: r.id,
        label: r.label,
        does: r.does,
        leaves: r.leaves,
        capabilities: r.capabilities,
        people: r.people,
        hours: r.hours,
        per_day: r.per_day,
        share: r.share,
        generic: r.generic,
      })),
    ).toEqual(
      LIFE_ACTIVITIES.map((a) => ({
        id: a.id,
        label: a.label,
        does: a.does,
        leaves: a.leaves,
        capabilities: a.capabilities,
        people: a.people,
        hours: a.hours,
        per_day: a.perDay,
        share: a.share,
        generic: a.generic,
      })),
    );
  });
});

describe("economy 2.0", () => {
  it("serves the health table, including the state with no totals", async () => {
    const h = await harness();
    const v2 = {
      currency: "魚幣",
      health: async () => ({
        available: false,
        days: [],
        week: { issued: 0, recovered: 0, ratio: null },
        warn: null,
      }),
      predictions: async (account: unknown) => {
        expect(account).toBeNull();
        return [
          {
            id: "P1",
            question: "她會死嗎",
            options: [{ label: "會", staked: 0, backers: 0, multiplier: null }],
            total: 0,
            closes_at: "2026-11-02T00:00:00.000Z",
            status: "open",
            winner: null,
            settles: { kind: "goal", label: "照她的遊戲目標「蓋房子」的結果自動結算" },
            settled_by: null,
            my_bet: null,
          },
        ];
      },
      room: async () => [
        {
          id: "sofa",
          label: "沙發",
          kind: "furniture",
          kind_label: "家具",
          price: 500,
          funded: 120,
          backers: 3,
          placed: false,
        },
      ],
    };
    h.sup.services.provide("economy", Economy2Key, v2 as never);
    const health = await h.get("/api/economy/health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ currency: "魚幣", available: false, days: [] });
    expect((await h.get("/api/economy/predictions")).body).toMatchObject({
      predictions: [{ id: "P1" }],
    });
    expect((await h.get("/api/economy/room")).body).toMatchObject({ room: [{ id: "sofa" }] });
  });

  it("lets the owner settle or call off a prediction by hand, kept with who did it", async () => {
    const h = await harness();
    const calls: unknown[][] = [];
    const settled = {
      id: "p1",
      winner: "做到",
      winners: 2,
      pool: 50,
      paid: 48,
      rake: 2,
      refunded: false,
    };
    h.sup.services.provide("economy", Economy2Key, {
      currency: "魚幣",
      health: async () => ({}),
      resolvePredictionByAdmin: async (...args: unknown[]) => {
        calls.push(["resolve", ...args]);
        return settled;
      },
      cancelPredictionByAdmin: async (...args: unknown[]) => {
        calls.push(["cancel", ...args]);
        if (args[0] === "gone") throw Object.assign(new Error("沒有這個預測"), { status: 409 });
        return { ...settled, winner: null, winners: 0, paid: 50, rake: 0, refunded: true };
      },
    } as never);
    const resolved = await h.post("/api/economy/predictions/p1/resolve", { option: "做到" });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ currency: "魚幣", settled });
    const cancelled = await h.post("/api/economy/predictions/p1/cancel", {});
    expect(cancelled.body).toMatchObject({ settled: { refunded: true, rake: 0 } });
    // The operator goes with the call, for the prediction's record.
    expect(calls.map((c) => [c[0], c[1], typeof c.at(-1)])).toEqual([
      ["resolve", "p1", "string"],
      ["cancel", "p1", "string"],
    ]);
    const gone = await h.post("/api/economy/predictions/gone/cancel", {});
    expect(gone.status).toBe(409);
    expect(gone.body).toEqual({ error: "沒有這個預測" });
    // A body without the option never reaches the economy.
    expect((await h.post("/api/economy/predictions/p1/resolve", {})).status).toBe(422);
    expect(calls).toHaveLength(3);
  });

  it("is a 503 when the economy has no 2.0", async () => {
    const h = await harness();
    h.sup.services.provide("economy", Economy2Key, {} as never);
    expect((await h.get("/api/economy/health")).status).toBe(503);
  });
});

describe("party games", () => {
  it("is a 503 naming the module when it is off, and the snapshot when it is on", async () => {
    const h = await harness();
    expect((await raw(h.base, "GET", "/api/party")).status).toBe(401);
    const off = await h.get("/api/party");
    expect(off.status).toBe(503);
    expect(JSON.stringify(off.body)).toContain("party module");
    // On, with nothing running: an empty snapshot, not an error.
    const snapshot = { sessions: [], recent: [] };
    h.sup.services.provide("party", PartyOverviewKey, { snapshot: () => snapshot });
    const on = await h.get("/api/party");
    expect(on.status).toBe(200);
    expect(on.body).toEqual(snapshot);
  });
});

describe("her workspace and skills", () => {
  async function workspace(h: Awaited<ReturnType<typeof harness>>) {
    const dir = await mkdtemp(join(tmpdir(), "miyoria-ws-"));
    dirs.push(dir);
    const ws = new PersistentWorkspace(dir, {
      maxBytes: 1_000_000,
      maxFiles: 100,
      maxFileBytes: 100_000,
    });
    await ws.ensure();
    h.sup.services.provide("sandbox", SandboxKey, { workspace: ws } as never);
    return ws;
  }

  it("is a 503 that says so when the workspace is off", async () => {
    const h = await harness();
    h.sup.services.provide("sandbox", SandboxKey, { workspace: null } as never);
    const res = await h.get("/api/workspace");
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain("workspace");
  });

  it("lists the workspace files with sizes", async () => {
    const h = await harness();
    const ws = await workspace(h);
    await ws.write("notes/a.txt", "hello");
    const files = await h.get("/api/workspace");
    expect(files.status).toBe(200);
    const fv = files.body as { files: { path: string; size: number }[]; usage: { files: number } };
    expect(fv.files.find((f) => f.path === "notes/a.txt")?.size).toBe(5);
    expect(fv.usage.files).toBe(1);
  });

  /** A shelf like the skills module's: pages of 10 characters, an error with a kind. */
  function shelf(skills: Record<string, { description: string; body: string; files?: unknown[] }>) {
    return {
      list: async () => ({
        skills: Object.entries(skills).map(([name, s]) => ({ name, description: s.description })),
        truncated: false,
      }),
      read: async (name: string, offset = 0) => {
        const skill = skills[name];
        if (!skill) throw Object.assign(new Error("none"), { kind: "not_found" });
        const all = [...skill.body];
        const text = all.slice(offset, offset + 10).join("");
        const end = offset + [...text].length;
        return {
          name,
          description: skill.description,
          text,
          offset,
          next_offset: end < all.length ? end : null,
          truncated: false,
          files: skill.files ?? [],
        };
      },
    };
  }

  it("lists skills and reads a whole body page by page, through the skills module's shelf", async () => {
    const h = await harness();
    h.sup.services.provide(
      "skills",
      SkillShelfKey,
      shelf({
        fishing: {
          description: "釣魚的順序",
          body: "先看天氣。\n再選餌。然後等魚上鉤,不要急。",
          files: [
            { path: "skills/fishing/cast.py", size: 14, script: "approved" },
            { path: "skills/fishing/stray.py", size: 11, script: "unapproved" },
          ],
        },
        raw: { description: "(沒有說明)", body: "沒有說明行" },
      }) as never,
    );
    const index = await h.get("/api/skills");
    expect((index.body as { skills: unknown[] }).skills).toEqual([
      { name: "fishing", description: "釣魚的順序" },
      { name: "raw", description: "(沒有說明)" },
    ]);
    const one = await h.get("/api/skills/fishing");
    expect(one.status).toBe(200);
    const sv = one.body as {
      body: string;
      truncated: boolean;
      files: { path: string; script: string | null }[];
    };
    expect(sv.body).toBe("先看天氣。\n再選餌。然後等魚上鉤,不要急。");
    expect(sv.truncated).toBe(false);
    expect(sv.files.map((f) => f.script)).toEqual(["approved", "unapproved"]);
    expect((await h.get("/api/skills/nope")).status).toBe(404);
  });

  it("says the skills module is missing when it is", async () => {
    const h = await harness();
    const res = await h.get("/api/skills");
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain("skills module");
  });
});

describe("the notebook and the just-now timeline", () => {
  it("reads only her own pages", async () => {
    const h = await harness();
    const seen: unknown[] = [];
    const page: NotebookPage = {
      path: "自己/想做的事",
      chars: 4,
      updated_at: toTimestamp(NOW),
      about: null,
      body: "學做蛋糕",
      created_at: toTimestamp(NOW),
    };
    h.sup.services.provide("memory", NotebookKey, {
      index: (where: unknown) => {
        seen.push(where);
        return [{ path: page.path, chars: 4, updated_at: page.updated_at, about: null }];
      },
      read: (path: string) => (path === page.path ? page : null),
      forgetPerson: async () => 0,
    });
    const list = await h.get("/api/notebook");
    expect((list.body as { pages: { path: string }[] }).pages[0]?.path).toBe("自己/想做的事");
    expect(seen).toEqual([{ context: null }]);
    const read = await h.get(`/api/notebook/page?path=${encodeURIComponent(page.path)}`);
    expect((read.body as NotebookPage).body).toBe("學做蛋糕");
    expect((await h.get("/api/notebook/page?path=nope")).status).toBe(404);
    expect((await h.get("/api/notebook/page")).status).toBe(400);
  });

  it("leaves the DM lines out and counts them", async () => {
    const h = await harness();
    const here = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
    const line = (text: string, priv: boolean): JustNowEntry => ({
      at: toTimestamp(NOW),
      kind: "talk",
      place: { kind: "text", label: "別的文字頻道", context: here as never },
      text,
      private: priv,
    });
    h.sup.services.provide("memory", JustNowKey, {
      entries: async () => [line("公開的", false), line("私訊的", true)],
      render: async () => "",
    });
    expect((await h.get("/api/recent")).status).toBe(400);
    const res = await h.get(`/api/recent?context=${encodeURIComponent(JSON.stringify(here))}`);
    expect(res.status).toBe(200);
    const body = res.body as { entries: { text: string }[]; private_hidden: number };
    expect(body.entries.map((e) => e.text)).toEqual(["公開的"]);
    expect(body.private_hidden).toBe(1);
  });
});
