// The incident suite itself: green today means every fixture behaves as its `status` says, so
// this test goes red when a known failure gets fixed (XPASS: change the fixture to `pass`) and
// when a passing fixture breaks (FAIL).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_DIR,
  formatScorecard,
  loadFixtures,
  ofType,
  runFixture,
  runSuite,
  SUBJECTS,
} from "../src/index.js";

const fixtures = loadFixtures();

describe("incident fixtures", () => {
  it("has 8 to 15 fixtures with unique ids", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    expect(fixtures.length).toBeLessThanOrEqual(15);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
  });

  it("keeps no Discord id, link or mention", () => {
    for (const file of readdirSync(FIXTURE_DIR)) {
      const text = readFileSync(join(FIXTURE_DIR, file), "utf8");
      expect(text, file).not.toMatch(/\d{15,}/);
      expect(text, file).not.toMatch(/https?:\/\//);
      expect(text, file).not.toMatch(/<@/);
    }
  });

  it("covers the known incidents", () => {
    const ids = new Set(fixtures.map((f) => f.id));
    for (const id of [
      "tool-text-sing-request-malformed-tag",
      "tool-text-sing-request-headless-close",
      "mc-obtain-bread-loop",
      "mc-obtain-cooked-beef-loop",
      "stage-stream-failure-unseen",
      "mc-owner-rule-enforced",
      "self-talk-death-spiral-26",
      "repeat-death-quips",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("is green: every fixture does what its status says (pass^3)", () => {
    const card = runSuite(fixtures, { k: 3 });
    const bad = card.results.filter((r) => ["FAIL", "XPASS", "BROKEN"].includes(r.verdict));
    expect(bad.map((r) => `${r.verdict} ${r.id}: ${r.note}`)).toEqual([]);
    expect(card.ok).toBe(true);
    // The scorecard prints (the CLI shows it).
    expect(formatScorecard(card)).toContain("suite: green");
  });

  it("every check sees its incident, and the control passes", () => {
    for (const f of fixtures) {
      const r = runFixture(f, { k: 1 });
      expect(r.caught.length, `${f.id} catches nothing`).toBeGreaterThan(0);
      expect(r.controlOk, `${f.id} control`).not.toBe(false);
    }
  });
});

describe("what the code under test does today", () => {
  const byId = (id: string) => {
    const f = fixtures.find((x) => x.id === id);
    if (!f) throw new Error(id);
    return f;
  };

  it("the failure guard never withholds obtain, so the retries run", () => {
    const fixture = byId("mc-obtain-bread-loop");
    const out = SUBJECTS.guard.run(fixture, { attempt: 0, live: false });
    const blocked = new Set(
      ofType(out, "game_step")
        .filter((s) => s.blocked)
        .map((s) => s.action),
    );
    expect(blocked.has("obtain")).toBe(false);
    // It does hold the low-level actions after a failure.
    expect([...blocked].every((a) => ["goto", "mine", "look", "attack"].includes(a))).toBe(true);
  });

  it("the owner's rule, once written, denies every start she made on her own", () => {
    const fixture = byId("mc-owner-rule-enforced");
    const own = (t: typeof fixture.trace) =>
      ofType(t, "gate").filter(
        (g) =>
          g.capability === "game.start" && (g.principal === "self" || g.principal === "director"),
      );
    expect(own(fixture.trace).filter((g) => g.allowed)).toHaveLength(7);
    const after = SUBJECTS.rule.run(fixture, { attempt: 0, live: false });
    expect(own(after).filter((g) => g.allowed)).toHaveLength(0);
  });

  it("the parser drops a bare <sing_start> but lets a quoted or headless tool call through", () => {
    const bare = SUBJECTS.parser.run(byId("tool-text-sing-start-bare-tag"), {
      attempt: 0,
      live: false,
    });
    expect(ofType(bare, "said")).toHaveLength(0);
    const quoted = SUBJECTS.parser.run(byId("tool-text-sing-request-malformed-tag"), {
      attempt: 0,
      live: false,
    });
    expect(ofType(quoted, "said").some((s) => s.text.includes("<sing_request"))).toBe(true);
  });

  it("streams in different chunks on every attempt and the verdict does not depend on it", () => {
    const fixture = byId("tool-text-sing-start-bare-tag");
    for (let attempt = 0; attempt < 8; attempt++) {
      const out = SUBJECTS.parser.run(fixture, { attempt, live: false });
      expect(ofType(out, "said")).toHaveLength(0);
    }
  });
});
