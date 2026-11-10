import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultGameConfig, GameConfigSchema } from "../src/index.js";
import { itemOf, MethodGuard, methodKey } from "../src/methods.js";
import { AttemptRecord, attemptLine } from "../src/record.js";
import { SkillBook } from "../src/skills.js";

const cfg = defaultGameConfig();
const MIN = 60_000;

describe("method keys", () => {
  it("are the action with its item, not the parameter string", () => {
    expect(methodKey("obtain", { item: "bread" })).toBe("obtain:bread");
    expect(methodKey("obtain", { item: "minecraft:Bread", count: 3 })).toBe("obtain:bread");
    expect(methodKey("mine", { blocks: ["stone", "cobblestone"], count: 5 })).toBe(
      "mine:cobblestone+stone",
    );
    expect(methodKey("hunt", { entity: "cow", count: 2 })).toBe("hunt:cow");
    expect(methodKey("explore", { find: ["oak_log"] })).toBe("explore:oak_log");
    expect(methodKey("explore", {})).toBe("explore");
    expect(methodKey("goto", { x: 1, z: 2 })).toBe("goto");
    expect(itemOf({ block: "Crafting Table" })).toBe("crafting_table");
  });
});

describe("method guard config", () => {
  it("takes PR 8's repeat_failure_limit / repeat_guard_secs as older names of its own keys", () => {
    expect(cfg).toMatchObject({ method_repeat_limit: 2, method_hold_secs: 600 });
    expect(cfg).not.toHaveProperty("repeat_failure_limit");
    const old = GameConfigSchema.parse({ repeat_failure_limit: 3, repeat_guard_secs: 120 });
    expect(old).toMatchObject({ method_repeat_limit: 3, method_hold_secs: 120 });
    // The new name wins when both are set.
    const both = GameConfigSchema.parse({ repeat_failure_limit: 0, method_repeat_limit: 4 });
    expect(both.method_repeat_limit).toBe(4);
    // 0 under the old name still turns the guard off.
    const off = new MethodGuard(GameConfigSchema.parse({ repeat_failure_limit: 0 }));
    off.failed("obtain:cooked_beef", "invalid", "no crafting recipe", 0);
    expect(off.held("obtain:cooked_beef", 1)).toBeNull();
  });
});

describe("method guard", () => {
  it("holds a method after two failures, and time alone never lets it back", () => {
    const g = new MethodGuard(cfg);
    expect(g.failed("obtain:bread", "precondition", "還缺 小麥 wheat×3", 0)).toBeNull();
    expect(g.held("obtain:bread", 1)).toBeNull();
    const hold = g.failed("obtain:bread", "precondition", "還缺 小麥 wheat×3", 1_000);
    expect(hold).toMatchObject({ method: "obtain:bread", code: "precondition", until: 601_000 });
    expect(hold?.needs).toEqual(new Set(["wheat"]));
    expect(g.held("obtain:bread", 2_000)).toBe(hold);
    expect(g.held("obtain:cooked_beef", 2_000)).toBeNull();
    // 2026-11-08: the hold ran out after ten minutes and the same ask came back unchanged.
    expect(g.held("obtain:bread", 601_000)).toBe(hold);
    expect(g.held("obtain:bread", 3 * 60 * MIN)).toBe(hold);
  });

  it("two failures in a row hold it, whatever their codes", () => {
    const g = new MethodGuard(cfg);
    g.failed("mine:stone", "not_found", "看不到", 0);
    g.failed("mine:stone", "timeout", "挖太久", 1);
    expect(g.held("mine:stone", 2)).not.toBeNull();
  });

  it("comes back when what it said was missing is in her inventory, and only then", () => {
    const g = new MethodGuard(cfg);
    g.seen({ dirt: 3 });
    g.failed("obtain:bread", "precondition", "材料不夠:還缺 小麥 wheat×3", 0);
    g.failed("obtain:bread", "precondition", "材料不夠:還缺 小麥 wheat×3", 1);
    // Something new, but not what was missing: still held.
    g.seen({ dirt: 3, oak_log: 4 }, "mine:oak_log");
    expect(g.held("obtain:bread", 2)).not.toBeNull();
    // The wheat is there: it may be tried again.
    g.seen({ dirt: 3, oak_log: 4, wheat: 3 }, "farm:wheat");
    expect(g.held("obtain:bread", 3)).toBeNull();
    // Tried again and failed the same way: the change did not help, held again at once.
    expect(g.failed("obtain:bread", "precondition", "還要站在工作台旁邊", 4)).not.toBeNull();
    expect(g.held("obtain:bread", 5)).not.toBeNull();
  });

  it("missing something it did not name: something new and the hold's time, both", () => {
    const g = new MethodGuard(cfg);
    g.seen({});
    g.failed("obtain:bread", "precondition", "還缺 小麥×3", 0);
    g.failed("obtain:bread", "precondition", "還缺 小麥×3", 0);
    expect(g.held("obtain:bread", 20 * MIN)).not.toBeNull();
    g.seen({ wheat: 3 });
    expect(g.held("obtain:bread", MIN)).not.toBeNull();
    expect(g.held("obtain:bread", 11 * MIN)).toBeNull();
  });

  it("could not find or reach it: another method getting somewhere lets it back", () => {
    const g = new MethodGuard(cfg);
    g.failed("mine:stone", "not_found", "看不到石頭", 0);
    g.failed("mine:stone", "not_found", "看不到石頭", 0);
    g.changed({ gained: {}, fresh: [], progressed: "mine:stone" });
    expect(g.held("mine:stone", 1)).not.toBeNull();
    g.changed({ gained: {}, fresh: [], progressed: "explore" });
    expect(g.held("mine:stone", 1)).toBeNull();
  });

  it("method_release = time is the guard before: the same code twice, ten minutes", () => {
    const g = new MethodGuard({ ...cfg, method_release: "time" });
    g.failed("mine:stone", "not_found", "看不到", 0);
    g.failed("mine:stone", "timeout", "挖太久", 1);
    expect(g.held("mine:stone", 2)).toBeNull();
    g.failed("mine:stone", "timeout", "挖太久", 3);
    expect(g.held("mine:stone", 4)).not.toBeNull();
    expect(g.held("mine:stone", 600_004)).toBeNull();
  });

  it("only progress with the same method clears it", () => {
    const g = new MethodGuard(cfg);
    g.failed("obtain:bread", "precondition", "x", 0);
    g.failed("obtain:bread", "precondition", "x", 0);
    g.progressed("obtain:cooked_beef");
    g.progressed("stop");
    expect(g.held("obtain:bread", 1)).not.toBeNull();
    g.progressed("obtain:bread");
    expect(g.held("obtain:bread", 1)).toBeNull();
  });

  it("an invalid item method is held for the session; an interruption is no failure", () => {
    const g = new MethodGuard(cfg);
    g.failed("obtain:apple", "invalid", "no crafting recipe makes apple", 0);
    expect(g.held("obtain:apple", 24 * 60 * MIN)).not.toBeNull();
    // `goto` without arguments is a slip, not an impossible method.
    g.failed("goto", "invalid", "goto 要給 {x,z}", 0);
    expect(g.held("goto", 1)).toBeNull();
    g.failed("mine:stone", "busy", "被反射打斷", 0);
    g.failed("mine:stone", "busy", "被反射打斷", 0);
    expect(g.held("mine:stone", 1)).toBeNull();
  });

  it("holds a goal's item and lists every hold for her prompt", () => {
    const g = new MethodGuard(cfg);
    g.holdGoal("bread", "precondition", "還缺 小麥×3", 0);
    g.failed("obtain:apple", "invalid", "沒有配方", 0);
    expect(g.goalHeld("bread", 1)).not.toBeNull();
    expect(g.lines(MIN)).toEqual([
      "目標「bread」(等缺的東西拿到了再試):precondition,還缺 小麥×3",
      "obtain:apple(這場不能再用):invalid,沒有配方",
    ]);
    g.failed("mine:stone", "not_found", "看不到", 0);
    g.failed("mine:stone", "not_found", "看不到", 0);
    expect(g.lines(MIN).at(-1)).toBe("mine:stone(等別的做法有進展再試):not_found,看不到");
    g.goalReached("bread");
    expect(g.goalHeld("bread", 1)).toBeNull();
  });

  it("can be turned off", () => {
    const g = new MethodGuard({ ...cfg, method_repeat_limit: 0 });
    g.failed("obtain:bread", "precondition", "x", 0);
    g.failed("obtain:bread", "precondition", "x", 0);
    g.failed("obtain:apple", "invalid", "x", 0);
    expect(g.holds(1)).toEqual([]);
  });
});

describe("her record", () => {
  it("keeps the newest attempts with their codes, apart from events", () => {
    const r = new AttemptRecord(2);
    const base = { method: "obtain:bread", goal: "做麵包", detail: "還缺 小麥×3" };
    r.add({
      ...base,
      at: 0,
      action: 'obtain {"item":"bread"}',
      result: "failed",
      code: "precondition",
    });
    r.add({
      ...base,
      at: 1_000,
      action: "explore",
      result: "no_progress",
      code: "no_progress",
      detail: "",
    });
    r.add({
      ...base,
      at: 2_000,
      action: 'hunt {"entity":"cow"}',
      result: "progress",
      code: null,
      detail: "+生牛肉×1",
    });
    expect(r.lines(32_000)).toEqual([
      "[31 秒前] explore → 做完了但沒有進展",
      '[30 秒前] hunt {"entity":"cow"} → 有進展:+生牛肉×1',
    ]);
    expect(
      attemptLine(
        { ...base, at: 0, action: "obtain", result: "failed", code: "precondition" },
        5 * MIN,
      ),
    ).toBe("[5 分鐘前] obtain → 失敗(precondition):還缺 小麥×3");
  });
});

describe("skill book", () => {
  it("keeps the newest few per target and lists them", () => {
    const book = new SkillBook();
    const skill = (target: string, steps: string[], at: number) => ({
      game: "minecraft",
      target,
      goal: target,
      steps,
      at,
    });
    expect(book.learn(skill("bread", [], 0))).toBeNull();
    for (let i = 0; i < 5; i++) book.learn(skill("cooked_beef", [`hunt ${i}`], i));
    book.learn(skill("stone_pickaxe", ["obtain stone_pickaxe"], 9));
    expect(book.forTarget("minecraft", "cooked_beef").map((s) => s.steps[0])).toEqual([
      "hunt 4",
      "hunt 3",
      "hunt 2",
    ]);
    expect(book.lines("minecraft", "cooked_beef")[0]).toBe("之前拿到 cooked_beef:hunt 4");
    expect(book.lines("minecraft", null)).toEqual([
      "stone_pickaxe:obtain stone_pickaxe",
      "cooked_beef:hunt 4",
    ]);
    expect(book.lines("osu", null)).toEqual([]);
  });
});

// ----- the night of 2026-11-08 as the acceptance case (§11.2 item 9) -----

interface Step {
  t: number;
  action: string;
  target?: string;
  failed: boolean;
  detail?: string;
}

/** The task failure code a recorded detail line stands for (the recording kept only the text). */
function codeOf(detail: string | undefined): string {
  if (detail === undefined) return "internal";
  if (detail.startsWith("參數不對")) return "invalid";
  if (detail.startsWith("材料不夠")) return "precondition";
  if (/挖太久|took longer/.test(detail)) return "timeout";
  if (/看不到|沒挖到/.test(detail)) return "not_found";
  if (detail.includes("no path")) return "unreachable";
  return "internal";
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../eval/fixtures/mc-obtain-bread-loop.json"), "utf8"),
) as { trace: Step[] };

describe("2026-11-08, replayed through the method guard", () => {
  const replay = (config = cfg) => {
    const guard = new MethodGuard(config);
    const ran: Step[] = [];
    const held: Step[] = [];
    for (const step of fixture.trace) {
      if (config.instant_actions.includes(step.action)) continue;
      const method = methodKey(step.action, step.target ? { item: step.target } : {});
      const now = step.t * 1000;
      if (guard.held(method, now) !== null) {
        held.push(step);
        continue;
      }
      ran.push(step);
      if (step.failed) guard.failed(method, codeOf(step.detail), step.detail ?? "", now);
      else {
        guard.progressed(method);
        // She got somewhere (the recording kept no inventory: nothing she gained is known).
        guard.changed({ gained: {}, fresh: [], progressed: method });
      }
    }
    return { ran, held };
  };
  const bread = (s: Step) => s.action === "obtain" && s.target === "bread";

  it("lets bread fail twice, then never again unchanged: no wheat ever came", () => {
    const { ran } = replay();
    expect(fixture.trace.filter(bread)).toHaveLength(32);
    // 2 of 32 over the 2 h 11 min (was 9 with a ten-minute hold that ran out by itself).
    expect(ran.filter(bread)).toHaveLength(2);
  });

  it("method_release = time keeps the old guard: two per ten-minute hold", () => {
    const { ran } = replay({ ...cfg, method_release: "time" });
    const through = ran.filter(bread);
    // The recording kept no codes, so the first one, without a detail, counts as another code.
    expect(through).toHaveLength(9);
    // Never three bread failures with the same code inside one hold window.
    const precondition = through.filter((s) => codeOf(s.detail) === "precondition");
    for (let i = 2; i < precondition.length; i++) {
      const a = precondition[i - 2] as Step;
      const c = precondition[i] as Step;
      expect(c.t - a.t).toBeGreaterThanOrEqual(cfg.method_hold_secs);
    }
  });

  it("asks for an impossible item (no recipe) once per session", () => {
    const { ran } = replay();
    for (const item of ["apple", "cod", "cooked_cod", "cooked_porkchop", "wheat_seeds"]) {
      const invalid = ran.filter(
        (s) => s.target === item && codeOf(s.detail) === "invalid" && s.failed,
      );
      expect(invalid.length, item).toBeLessThanOrEqual(1);
    }
  });

  it("a stop is never a step of hers that counts", () => {
    const { ran, held } = replay();
    expect([...ran, ...held].some((s) => s.action === "stop")).toBe(false);
  });
});
