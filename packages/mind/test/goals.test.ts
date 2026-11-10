import { MemorySettingsStore } from "@miyoria/store";
import {
  type AgendaItem,
  type Goal,
  goalDue,
  type TriggerProbe,
  toTimestamp,
  triggerFires,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  describeTrigger,
  GOAL_MIGRATION_KEY,
  GOAL_PREFIX,
  GoalBook,
  GoalError,
  goalKey,
  parseTrigger,
  resolveTrigger,
  TriggerWatch,
} from "../src/index.js";

const T0 = Date.parse("2026-11-02T12:00:00.000Z"); // 20:00 at UTC+8
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function clock(start = T0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function book(c = clock(), store: MemorySettingsStore | null = null) {
  return new GoalBook({ store, profile: "p", clock: c, maxDays: 14, defaultDays: 3 });
}

const probe = (p: Partial<TriggerProbe> = {}): TriggerProbe => ({
  now: T0,
  online: () => false,
  ended: [],
  ...p,
});

function agendaItem(id: string, text: string, extra: Partial<AgendaItem> = {}): AgendaItem {
  return {
    id,
    text,
    why: "",
    person: null,
    context: null,
    created_at: toTimestamp(T0 - DAY),
    due: null,
    expires_at: null,
    status: "open",
    closed_at: null,
    ...extra,
  };
}

describe("goal triggers", () => {
  it("fire on time, when someone comes online and after an activity", () => {
    const at = { kind: "at" as const, time: toTimestamp(T0 + 10 * MIN) };
    expect(triggerFires(at, probe())).toBe(false);
    expect(triggerFires(at, probe({ now: T0 + 10 * MIN }))).toBe(true);
    const online = { kind: "when_online" as const, person: "Owen" };
    expect(triggerFires(online, probe())).toBe(false);
    expect(triggerFires(online, probe({ online: (h) => h === "Owen" }))).toBe(true);
    const after = { kind: "after_activity" as const, activity: "game" };
    expect(triggerFires(after, probe({ ended: ["singing"] }))).toBe(false);
    expect(triggerFires(after, probe({ ended: ["game", "game:minecraft"] }))).toBe(true);
  });

  it("never treats `whenever` as due (the old `due === null` bug)", () => {
    const b = book();
    const g = b.add({
      what: "整理筆記",
      why: "",
      trigger: { kind: "whenever" },
      expires: toTimestamp(T0 + DAY),
      source: "plan",
    });
    expect(goalDue(g, probe({ online: () => true, ended: ["game"] }))).toBe(false);
    expect(b.due(probe({ now: T0 + 12 * HOUR, online: () => true }))).toEqual([]);
    expect(new TriggerWatch().check(b.goals(), probe(), 0)).toEqual([]);
  });

  it("wake her once when they start firing, again only after the refire time", () => {
    const b = book();
    const g = b.add({
      what: "找 Owen 聊天",
      why: "想他",
      trigger: { kind: "when_online", person: "Owen" },
      expires: toTimestamp(T0 + DAY),
      person: "Owen",
      source: "plan",
    });
    const watch = new TriggerWatch();
    let online = false;
    const p = (now: number) => probe({ now, online: () => online });
    expect(watch.check(b.goals(), p(T0), 30 * MIN)).toEqual([]);
    online = true;
    expect(watch.check(b.goals(), p(T0 + MIN), 30 * MIN).map((x) => x.id)).toEqual([g.id]);
    expect(watch.check(b.goals(), p(T0 + 2 * MIN), 30 * MIN)).toEqual([]);
    expect(watch.check(b.goals(), p(T0 + 32 * MIN), 30 * MIN)).toHaveLength(1);
    // Going offline and coming back fires again at once.
    online = false;
    watch.check(b.goals(), p(T0 + 33 * MIN), 30 * MIN);
    online = true;
    expect(watch.check(b.goals(), p(T0 + 34 * MIN), 30 * MIN)).toHaveLength(1);
  });

  it("knows the next timed trigger and says triggers in words", () => {
    const b = book();
    b.add({
      what: "唱歌",
      why: "",
      trigger: { kind: "at", time: toTimestamp(T0 + 2 * HOUR) },
      expires: toTimestamp(T0 + DAY),
      source: "plan",
    });
    expect(TriggerWatch.nextAt(b.goals(), T0)).toBe(T0 + 2 * HOUR);
    expect(describeTrigger({ kind: "at", time: toTimestamp(T0 + 2 * HOUR) }, 480)).toBe(
      "11/02 22:00 之後",
    );
    expect(describeTrigger({ kind: "when_online", person: "Owen" }, 480)).toBe("Owen 上線時");
    expect(describeTrigger({ kind: "whenever" }, 480)).toBe("有空的時候");
  });

  it("resolve what she wrote: a clock time today or tomorrow, minutes from now", () => {
    expect(resolveTrigger({ kind: "at", time: "21:30", inMin: null }, T0, 480)).toEqual({
      kind: "at",
      time: "2026-11-02T13:30:00.000Z",
    });
    expect(resolveTrigger({ kind: "at", time: "09:00", inMin: null }, T0, 480)).toEqual({
      kind: "at",
      time: "2026-11-03T01:00:00.000Z",
    });
    expect(resolveTrigger({ kind: "at", time: null, inMin: 30 }, T0, 480)).toEqual({
      kind: "at",
      time: toTimestamp(T0 + 30 * MIN),
    });
    expect(parseTrigger({ kind: "at" })).toBeNull();
    expect(parseTrigger({ kind: "when_online", person: " Owen " })).toEqual({
      kind: "when_online",
      person: "Owen",
    });
    expect(parseTrigger("whenever")).toEqual({ kind: "whenever" });
  });
});

describe("her goal book", () => {
  it("drops expired goals on the sweep and deletes long-closed ones", async () => {
    const c = clock();
    const store = new MemorySettingsStore();
    const b = book(c, store);
    const g = b.add({
      what: "問 Owen 報告",
      why: "",
      trigger: { kind: "whenever" },
      expires: toTimestamp(T0 + HOUR),
      source: "plan",
    });
    expect(b.sweep()).toEqual([]);
    c.advance(HOUR);
    expect(b.goals()).toEqual([]);
    const dropped = b.sweep();
    expect(dropped.map((x) => [x.id, x.status, x.close_reason])).toEqual([
      [g.id, "dropped", "過期了"],
    ]);
    c.advance(3 * DAY);
    b.sweep();
    await b.flush();
    expect(b.goal(g.id)).toBeNull();
    expect((await store.list("p", GOAL_PREFIX)).size).toBe(0);
  });

  it("keeps no per-call codes and bounds what she wrote", () => {
    const b = book();
    const g = b.add({
      what: "u1=Owen。找 u1 聊報告",
      why: "u7 一直嗆我。想念他",
      trigger: { kind: "when_online", person: "u1" },
      steps: ["開台", "u3 的事", ""],
      expires: toTimestamp(T0 + 100 * DAY),
      person: "p2",
      source: "plan",
    });
    expect(g.what).toBe("Owen。找 Owen 聊報告");
    expect(g.why).toBe("想念他");
    expect(g.trigger).toEqual({ kind: "whenever" });
    expect(g.steps).toEqual(["開台"]);
    expect(g.person).toBeNull();
    expect(Date.parse(g.expires)).toBe(T0 + 14 * DAY);
    expect(() =>
      b.add({ what: "u1", why: "", trigger: { kind: "whenever" }, expires: "", source: "plan" }),
    ).toThrow(GoalError);
  });

  it("persists, edits and closes goals", async () => {
    const store = new MemorySettingsStore();
    const b = book(clock(), store);
    const g = b.add({
      what: "玩 Minecraft",
      why: "無聊",
      trigger: { kind: "whenever" },
      expires: toTimestamp(T0 + DAY),
      source: "plan",
    });
    expect(
      b.edit(g.id, { trigger: { kind: "after_activity", activity: "singing" } })?.trigger,
    ).toEqual({ kind: "after_activity", activity: "singing" });
    expect(b.edit(g.id, { what: "玩 Minecraft" })).toBeNull();
    expect(b.byKey(goalKey(g).toLowerCase())?.id).toBe(g.id);
    await b.flush();
    const again = book(clock(), store);
    await again.load();
    expect(again.goals().map((x) => [x.what, x.trigger.kind])).toEqual([
      ["玩 Minecraft", "after_activity"],
    ]);
    expect(again.setStatus(g.id, "done", "玩過了")?.status).toBe("done");
    expect(again.setStatus(g.id, "dropped")).toBeNull();
    expect(again.goals()).toEqual([]);
  });

  it("migrates the old agenda once, idempotently, even across restarts", async () => {
    const store = new MemorySettingsStore();
    const items = [
      agendaItem("a1", "等 Owen 上線問報告", { person: "person-owen" }),
      agendaItem("a2", "u3 說要一起唱歌"),
      agendaItem("a3", "練新歌", { expires_at: toTimestamp(T0 + 40 * DAY) }),
      agendaItem("a4", "已經完成的事", { status: "done" }),
    ];
    const handleOf = (p: string) => (p === "person-owen" ? "Owen" : null);
    const b = book(clock(), store);
    expect(b.migrate(items, handleOf)).toBe(2);
    const goals = b.goals();
    expect(goals.map((g) => [g.what, g.trigger.kind, g.person])).toEqual([
      ["等 Owen 上線問報告", "whenever", "Owen"],
      ["練新歌", "whenever", null],
    ]);
    expect(Date.parse(goals[0]?.expires ?? "")).toBe(T0 + 3 * DAY);
    expect(Date.parse(goals[1]?.expires ?? "")).toBe(T0 + 14 * DAY);
    expect(b.migrate(items, handleOf)).toBe(0);
    // Dropped later: never taken again after a restart either.
    b.setStatus(goals[0]?.id ?? "", "dropped", "不用了");
    await b.flush();
    expect(await store.get("p", GOAL_MIGRATION_KEY)).toMatchObject({ items: ["a1", "a2", "a3"] });
    const restarted = book(clock(), store);
    await restarted.load();
    expect(restarted.migrate(items, handleOf)).toBe(0);
    expect(restarted.goals().map((g: Goal) => g.what)).toEqual(["練新歌"]);
  });
});
