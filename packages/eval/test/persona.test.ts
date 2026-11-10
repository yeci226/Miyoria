import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Profile } from "@miyoria/profile";
import { describe, expect, it } from "vitest";
import {
  assignSides,
  type BlindRun,
  buildChoicesTemplate,
  buildKey,
  buildSheet,
  type Complete,
  formatCounters,
  parseChoices,
  runBlind,
  tally,
} from "../src/persona/blind.js";
import {
  countReplies,
  isSilence,
  openingOf,
  percentile,
  visibleText,
} from "../src/persona/counters.js";
import { setupModel } from "../src/persona/model.js";
import { SITUATIONS, situationPrompt } from "../src/persona/situations.js";

const root = join(import.meta.dirname, "..", "..", "..");

describe("the twenty situations", () => {
  it("are the document's table, row for row", () => {
    const doc = readFileSync(join(root, "docs", "design", "persona-v4.md"), "utf8");
    const rows = [...doc.matchAll(/^\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)].filter(
      (m) => Number(m[1]) >= 1 && Number(m[1]) <= 20 && !(m[2] ?? "").includes("---"),
    );
    // The table of §6.3 is the only one whose first cell runs 1 to 20 with a category.
    const table = rows.slice(-20);
    expect(table).toHaveLength(20);
    for (const m of table) {
      const s = SITUATIONS.find((x) => x.id === Number(m[1]));
      expect(s, `situation ${m[1]}`).toBeDefined();
      if (!s) continue;
      expect(s.category).toBe((m[2] ?? "").trim());
      expect(s.watch).toBe((m[4] ?? "").trim());
      const said = s.lines.map((l) => `${l.who}:${l.text}`).join(" / ");
      const shown = s.state === undefined ? said : `${said}(狀態:${s.state})`;
      expect(shown).toBe((m[3] ?? "").trim());
    }
  });

  it("number 1 to 20, and the prompt never carries the owner's notes", () => {
    expect(SITUATIONS.map((s) => s.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const s of SITUATIONS) expect(situationPrompt(s)).not.toContain(s.watch);
    const seventeen = SITUATIONS.find((s) => s.id === 17);
    expect(seventeen && situationPrompt(seventeen)).toContain("現在:下午練了一首新歌");
  });
});

describe("assigning A and B", () => {
  it("splits twenty ten and ten, in an order that depends on the seed", () => {
    const sides = assignSides(20, "seed-1");
    expect(sides.filter((v) => v === "old")).toHaveLength(10);
    expect(assignSides(20, "seed-1")).toEqual(sides);
    expect(assignSides(20, "seed-2")).not.toEqual(sides);
    // Not the same sequence for every seed, and not all of one side first.
    expect(sides.slice(0, 10).filter((v) => v === "old").length).toBeLessThan(10);
  });

  it("handles one situation and an odd count", () => {
    expect(["old", "new"]).toContain(assignSides(1, "x")[0]);
    const three = assignSides(3, "x");
    expect(three).toHaveLength(3);
  });
});

/** A fake model: answers by the persona it is given, so which version wrote what is checkable. */
function fake(calls: { system: string; user: string }[] = []): Complete {
  return async (request) => {
    calls.push(request);
    if (request.user.includes("泳裝") && request.system === "NEW") throw new Error("boom");
    return request.system === "OLD" ? "好啦好啦,真是的。" : "收到,我來看。";
  };
}

describe("running the blind test with a fake provider", () => {
  it("asks both versions the same situation with the same settings and records a failure", async () => {
    const calls: { system: string; user: string }[] = [];
    const run = await runBlind({
      situations: SITUATIONS,
      prompts: { old: "OLD", new: "NEW" },
      complete: fake(calls),
      runs: 2,
      seed: "s",
    });
    expect(calls).toHaveLength(20 * 2 * 2);
    expect(run.situations).toHaveLength(20);
    const seven = run.situations.find((r) => r.id === 7);
    expect(seven?.new.every((a) => a.error === "boom")).toBe(true);
    expect(seven?.old.every((a) => a.error === undefined)).toBe(true);
    // Each situation's user message is identical for both versions.
    const one = SITUATIONS.find((s) => s.id === 1);
    const first = calls.filter((c) => c.user === (one ? situationPrompt(one) : ""));
    expect(new Set(first.map((c) => c.system))).toEqual(new Set(["OLD", "NEW"]));
  });

  async function oneRun(): Promise<BlindRun> {
    return runBlind({
      situations: SITUATIONS,
      prompts: { old: "OLD", new: "NEW" },
      complete: fake(),
      runs: 1,
      seed: "k",
    });
  }

  it("writes a sheet that does not say which is which, and a key that does", async () => {
    const run = await oneRun();
    const sheet = buildSheet(SITUATIONS, run);
    expect(sheet).not.toMatch(/\bold\b|\bnew\b|舊版[::]|新版[::]/);
    expect(sheet).not.toContain("OLD");
    expect(sheet).not.toContain("看什麼");
    for (const s of SITUATIONS) expect(sheet).toContain(`## ${s.id}. ${s.category}`);
    expect(sheet.match(/\*\*A\*\*/g)).toHaveLength(20);
    // In each situation, A carries the answer of the version the key says.
    const key = buildKey(run);
    for (const row of run.situations) {
      const aReply = row[row.a][0]?.reply;
      const section = sheet.split(`## ${row.id}. `)[1]?.split("\n## ")[0] ?? "";
      const afterA = section.split("**A**")[1]?.split("**B**")[0] ?? "";
      expect(afterA).toContain(aReply ?? "?");
      expect(key.a[String(row.id)]).toBe(row.a);
    }
    expect(buildChoicesTemplate(SITUATIONS).split("\n").filter(Boolean)).toHaveLength(20);
    expect(key.counters.old.catchphrase_rate).toBe(1);
    expect(key.counters.new.catchphrase_rate).toBe(0);
    expect(formatCounters(key.counters)).toContain("口頭禪出現率");
  });

  it("tallies the owner's choices against the key", async () => {
    const key = buildKey(await oneRun());
    // Always pick the new version's side.
    const pickNew = (id: number): string => (key.a[String(id)] === "new" ? "A" : "B");
    const all = SITUATIONS.map((s) => `${s.id}: ${pickNew(s.id)}`).join("\n");
    expect(tally(key, parseChoices(all))).toMatchObject({ new: 20, old: 0, verdict: "keep" });

    const lines = SITUATIONS.map((s, i) => {
      const old = key.a[String(s.id)] === "new" ? "B" : "A";
      return `${s.id}: ${i < 13 ? pickNew(s.id) : old}`;
    });
    expect(tally(key, parseChoices(lines.join("\n")))).toMatchObject({ new: 13, verdict: "keep" });
    const twelve = lines.map((l, i) => (i === 12 ? l.replace(/[AB]$/, "none") : l));
    expect(tally(key, parseChoices(twelve.join("\n")))).toMatchObject({
      new: 12,
      none: 1,
      verdict: "look",
    });
    const ten = SITUATIONS.map((s, i) => {
      const old = key.a[String(s.id)] === "new" ? "B" : "A";
      return `${s.id}: ${i < 10 ? pickNew(s.id) : old}`;
    });
    expect(tally(key, parseChoices(ten.join("\n"))).verdict).toBe("revise");
    // Blank lines of the template are no answer.
    expect(tally(key, parseChoices(buildChoicesTemplate(SITUATIONS))).verdict).toBe("incomplete");
    expect(parseChoices("3: none: 太像客服\n4 b\n5:\nx").get(3)).toBe("none");
    expect(parseChoices("4 b").get(4)).toBe("B");
  });
});

describe("counters", () => {
  it("count catchphrases, questions, length and openings", () => {
    const c = countReplies([
      "好啦,我看一下。",
      "<emo:shy>哼,才不是。",
      "<silence/>",
      "題目本來就不難。下一題呢?",
      "一".repeat(60),
      "收到",
    ]);
    expect(c.replies).toBe(6);
    expect(c.silent).toBe(1);
    expect(c.catchphrases["好啦"]).toBe(1);
    expect(c.catchphrases["哼"]).toBe(1);
    expect(c.catchphrase_rate).toBe(0.4);
    expect(c.question_rate).toBe(0.2);
    expect(c.openings.stock_opener_rate).toBe(0.4);
    expect(c.length.p90).toBe(60);
    expect(c.length.p10).toBe(2);
    expect(c.openings.top[0]?.count).toBe(1);
    expect(c.openings.distinct_share).toBe(1);
  });

  it("have small helpers that behave", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(visibleText("<emo:joy>好耶 <b/>")).toBe("好耶");
    expect(isSilence(" <silence/> ")).toBe(true);
    expect(openingOf("……好啦,來了")).toBe("好啦");
    expect(countReplies([]).length.p50).toBe(0);
  });
});

describe("the model setup", () => {
  it("says there is nothing to call when the config has no provider", async () => {
    const profile = await Profile.loadDir(join(root, "profiles", "deepseek-chan"));
    const dir = mkdtempSync(join(tmpdir(), "blind-"));
    expect(await setupModel(join(dir, "missing.toml"), profile)).toMatchObject({ kind: "none" });
    const empty = join(dir, "miyoria.toml");
    writeFileSync(empty, '[core]\nprofile = "deepseek-chan"\n');
    const none = await setupModel(empty, profile);
    expect(none.kind).toBe("none");
    expect(none.kind === "none" && none.reason).toContain("[llm.providers");
  });

  it("builds the router from a provider and the profile's chain without calling anything", async () => {
    const profile = await Profile.loadDir(join(root, "profiles", "deepseek-chan"));
    const dir = mkdtempSync(join(tmpdir(), "blind-"));
    const file = join(dir, "miyoria.toml");
    writeFileSync(
      file,
      '[llm.providers.deepseek]\nkind = "deepseek"\nbase_url = "http://127.0.0.1:1"\napi_key = "unused"\n',
    );
    const setup = await setupModel(file, profile);
    expect(setup.kind).toBe("ready");
    expect(setup.kind === "ready" && setup.chain).toContain("deepseek:");
  });
});
