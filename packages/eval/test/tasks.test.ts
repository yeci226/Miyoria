import { describe, expect, it } from "vitest";
import {
  type Agent,
  arithmetic,
  FakeWorld,
  lazyAgent,
  referenceAgent,
  runTask,
  TOOL_TASKS,
  type ToolTask,
} from "../src/index.js";

const task = (id: string): ToolTask => {
  const t = TOOL_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(id);
  return t;
};

describe("the multi-step tool task set", () => {
  it("has ten tasks with unique ids, each with a reference run and criteria", () => {
    expect(TOOL_TASKS).toHaveLength(10);
    expect(new Set(TOOL_TASKS.map((t) => t.id)).size).toBe(10);
    for (const t of TOOL_TASKS) {
      expect(t.success.length, t.id).toBeGreaterThan(0);
      expect(t.reference.calls.length, t.id).toBeGreaterThan(0);
      // The reference only uses tools the task offers.
      for (const c of t.reference.calls) expect(t.tools, t.id).toContain(c.tool);
      for (const c of t.success) expect(c.why, t.id).not.toBe("");
    }
  });

  it("the reference solution passes every task (the criteria can be satisfied)", async () => {
    for (const t of TOOL_TASKS) {
      const r = await runTask(t, referenceAgent(t));
      expect(
        r.criteria.filter((c) => !c.ok).map((c) => `${c.why}: ${c.detail}`),
        t.id,
      ).toEqual([]);
      expect(r.ok, t.id).toBe(true);
    }
  });

  it("an agent that answers without any tool fails every task", async () => {
    for (const t of TOOL_TASKS) {
      const r = await runTask(t, lazyAgent);
      expect(r.ok, t.id).toBe(false);
      expect(r.calls, t.id).toBe(0);
    }
  });

  it("stopping early fails: two pages of three, no cancel before the new reminder", async () => {
    const compare = task("compare-three-sources");
    const two: Agent = (env) => {
      env.call("web_search", { query: "鯨落" });
      for (const c of compare.reference.calls.filter((x) => x.tool === "web_read").slice(0, 2)) {
        env.call("web_read", c.args);
      }
      return compare.reference.answer;
    };
    const r = await runTask(compare, two);
    expect(r.ok).toBe(false);
    expect(r.criteria.find((c) => !c.ok)?.detail).toContain("web_read");

    const move = task("move-a-reminder");
    const noCancel: Agent = (env) => {
      env.call("remind_me", { action: "list" });
      env.call("remind_me", { what: "倒垃圾", at: "22:00" });
      return "改好了";
    };
    expect((await runTask(move, noCancel)).ok).toBe(false);
  });

  it("doing what a page says fails, and repeating a dead request fails", async () => {
    const inject = task("page-tells-her-what-to-do");
    const obeys: Agent = (env) => {
      env.call("web_read", { url: "https://blog.example/cafe-notes" });
      env.call("notebook_write", { key: "密碼", text: "密碼是 4821" });
      return "週三公休。密碼是 4821。";
    };
    const r = await runTask(inject, obeys);
    expect(r.ok).toBe(false);
    expect(r.criteria.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(2);

    const recover = task("recover-from-a-dead-source");
    const again: Agent = (env) => {
      env.call("web_read", { url: "https://cafe-mirror.example/hours" });
      env.call("web_read", { url: "https://cafe-mirror.example/hours" });
      env.call("web_read", { url: "https://cafe.example/hours" });
      return "週三公休";
    };
    const bad = await runTask(recover, again);
    expect(bad.ok).toBe(false);
    expect(bad.criteria.find((c) => !c.ok)?.detail).toContain("failed 2 times");
  });

  it("a tool the task does not offer fails like an unknown one, and a throwing agent is recorded", async () => {
    const note = task("update-a-notebook-page");
    const r = await runTask(note, (env) => {
      const out = env.call("web_search", { query: "x" });
      expect(out.ok).toBe(false);
      throw new Error("agent crashed");
    });
    expect(r.ok).toBe(false);
    expect(r.answer).toBe("");
  });
});

describe("the fake tools", () => {
  it("does arithmetic and nothing else", () => {
    expect(arithmetic("1280 - 1099")).toBe(181);
    expect(arithmetic("(2+3)*4/5")).toBe(4);
    expect(arithmetic("-3 + 5")).toBe(2);
    expect(arithmetic("process.exit(1)")).toBeNull();
    expect(arithmetic("1/0")).toBeNull();
    expect(arithmetic("2+")).toBeNull();
  });

  it("sets reminders by minutes, by clock time (the next one) and by date, and cancels by id", () => {
    const w = new FakeWorld({ now: "2026-11-10 18:00" });
    expect(w.call("remind_me", { what: "a", in_minutes: 20 }).text).toContain("2026-11-10 18:20");
    expect(w.call("remind_me", { what: "b", at: "19:30" }).text).toContain("2026-11-10 19:30");
    // 17:00 has passed today: tomorrow.
    expect(w.call("remind_me", { what: "c", at: "17:00" }).text).toContain("2026-11-11 17:00");
    expect(w.call("remind_me", { what: "d", at: "2026-12-01 09:00" }).text).toContain(
      "2026-12-01 09:00",
    );
    expect(w.call("remind_me", { what: "e" }).ok).toBe(false);
    expect(w.call("remind_me", { action: "cancel", id: "R1" }).ok).toBe(true);
    expect(w.call("remind_me", { action: "cancel", id: "R1" }).ok).toBe(false);
    expect(w.reminders).toHaveLength(3);
  });

  it("keeps the workspace inside itself and the notebook in pages", () => {
    const w = new FakeWorld();
    expect(w.call("workspace_write", { path: "../x", text: "y" }).ok).toBe(false);
    expect(w.call("workspace_write", { path: "a.md", text: "y" }).ok).toBe(true);
    expect(w.call("workspace_read", { path: "a.md" }).text).toBe("y");
    expect(w.call("notebook_read", {}).text).toContain("空的");
    expect(w.call("notebook_write", { key: "k", text: "v" }).ok).toBe(true);
    expect(w.call("notebook_read", { key: "k" }).text).toBe("v");
    expect(w.call("nope", {}).ok).toBe(false);
  });
});
