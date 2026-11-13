// The 2026-11-07 live run, as regression scenarios (docs/design/v3-architecture.md §1, §20
// phase 0). Each fixture is synthetic (neutral names, made-up lines): it reproduces the shape of
// an incident, not its words, and the tests assert what she does about it, through the real
// agent, gate, Arbiter, ActivityManager and mind with a scripted LLM.
//
// Not expressible here, covered in the owning package instead: a promise with no action behind
// it (`packages/agent/test/promise-claims.test.ts`: the replay's scripted LLM makes no tool
// calls and the voice and game tools are not registered), and the game staying closed after a
// stop (`packages/arbiter/test/game-hold.test.ts`: `activity.done` is her output, not a replayed
// input). The keying of a reworded line is `packages/game/test/narration.test.ts`; the replay
// shows that the Arbiter goes by the key.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ArbiterDecision, type Impulse, isJsonObject, type Pipeline } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildReport,
  parseReplayLog,
  type ReplayClock,
  type ReplayLog,
  type ReplayReport,
  type ReplayRun,
  replay,
} from "../src/index.js";

const clock: ReplayClock = {
  setNow: (ms) => {
    vi.useFakeTimers();
    vi.setSystemTime(ms);
  },
  advance: async (ms) => {
    await vi.advanceTimersByTimeAsync(ms);
  },
};

afterEach(() => {
  vi.useRealTimers();
});

const MIN = 60_000;

function load(fixture: string): ReplayLog {
  return parseReplayLog(readFileSync(join(import.meta.dirname, "fixtures", fixture), "utf8"));
}

/** The pipeline of the block running now. */
let pipeline: Pipeline = "v2";

async function run(log: ReplayLog): Promise<{ run: ReplayRun; report: ReplayReport }> {
  const r = await replay(log, { clock, pipeline });
  return { run: r, report: buildReport(r) };
}

/** What happened to one impulse: the Arbiter's last decision on it. */
interface Verdict {
  impulse: Impulse;
  decision: ArbiterDecision;
  /** Minutes after the first event. */
  at: number;
}

/** The impulses of the log (in input order) with the Arbiter's last word on each. */
function verdicts(r: ReplayRun): Verdict[] {
  const start = Date.parse(r.inputs[0]?.at ?? "");
  const last = new Map<string, ArbiterDecision>();
  for (const env of r.events) {
    const e = env.event;
    if (
      e.type === "custom" &&
      e.data.topic === "arbiter.decision" &&
      isJsonObject(e.data.payload)
    ) {
      const d = e.data.payload as unknown as ArbiterDecision;
      last.set(d.impulse, d);
    }
  }
  return r.inputs.flatMap((entry) => {
    const e = entry.event;
    if (e.type !== "custom" || e.data.topic !== "arbiter.impulse") return [];
    const impulse = e.data.payload as unknown as Impulse;
    const decision = last.get(impulse.id);
    if (!decision) throw new Error(`no decision for ${impulse.id}`);
    return [{ impulse, decision, at: (Date.parse(entry.at) - start) / MIN }];
  });
}

const accepted = (v: Verdict) => v.decision.verdict === "accepted";
const keyOf = (v: Verdict) => v.impulse.attention?.key ?? null;
/** Her turns opened by an impulse that went out (`initiative`), as the report counts them. */
const sentFromImpulses = (report: ReplayReport) =>
  report.turns.filter((t) => t.reason === "initiative" && t.outcome === "sent").length;

describe.each(["v2", "v3"] as const)("pipeline %s", (under) => {
  beforeEach(() => {
    pipeline = under;
  });

  describe("2026-11-07: the same thing said again and again", () => {
    it("one game fact over two hours reaches voice at most once per repeat window", async () => {
      const { run: r, report } = await run(load("same-fact-repeated.jsonl"));
      const all = verdicts(r);
      const pickaxe = all.filter((v) => keyOf(v) === "game:craft:stone_pickaxe");
      expect(pickaxe).toHaveLength(25);

      const said = pickaxe.filter(accepted);
      // 45 minutes between the same fact, in 120 minutes: three times at most (was 25).
      expect(said.length).toBeGreaterThanOrEqual(2);
      expect(said.length).toBeLessThanOrEqual(3);
      for (const [i, v] of said.entries()) {
        const before = said[i - 1];
        if (before) expect(Math.round(v.at - before.at)).toBeGreaterThanOrEqual(45);
      }
      const held = pickaxe.filter((v) => !accepted(v));
      expect(held.every((v) => v.decision.reason === "repeat")).toBe(true);
      expect(held).toHaveLength(25 - said.length);

      // Only what the Arbiter accepted became a turn of hers that went out, and a different fact
      // in the middle is a new thing.
      const other = all.filter((v) => keyOf(v) === "game:ore:iron_ore");
      expect(other.filter(accepted)).toHaveLength(1);
      expect(sentFromImpulses(report)).toBe(said.length + 1);
    });

    it("the same fact in other words is the same fact (the key, not the words, decides)", async () => {
      const { run: r } = await run(load("same-fact-reworded.jsonl"));
      const all = verdicts(r);
      expect(all).toHaveLength(8);
      // The precondition: every line says it differently.
      expect(new Set(all.map((v) => v.impulse.hint)).size).toBe(8);
      expect(all.filter(accepted)).toHaveLength(1);
      const held = all.filter((v) => !accepted(v));
      expect(held).toHaveLength(7);
      expect(held.every((v) => v.decision.reason === "repeat")).toBe(true);
    });
  });

  describe("2026-11-07: talking to an empty room", () => {
    const narration = (all: Verdict[]) => all.filter((v) => keyOf(v) !== null);

    it("after max_unanswered turns nobody answered she stops, and a person speaking resumes her", async () => {
      const { run: r, report } = await run(load("empty-room.jsonl"));
      const lines = narration(verdicts(r));
      expect(lines.map((v) => keyOf(v))).toEqual([
        "game:thing:1",
        "game:thing:2",
        "game:thing:3",
        "game:thing:4",
        "game:thing:5",
        "game:thing:6",
        "game:thing:7",
        "game:thing:8",
      ]);
      const outcome = (v: Verdict) => (accepted(v) ? "said" : (v.decision.reason ?? "?"));
      expect(lines.map(outcome)).toEqual([
        // Three turns of her own, no person in between ...
        "said",
        "said",
        "said",
        // ... and then she is quiet, whatever new thing comes up.
        "unanswered",
        "unanswered",
        "unanswered",
        "unanswered",
        // Bob spoke at minute 40: she may talk again.
        "said",
      ]);
      // She is told why (the limit is in the reason).
      const held = lines.filter((v) => !accepted(v));
      expect(held.every((v) => v.decision.detail.includes("3"))).toBe(true);
      // Bob called her by name and was answered.
      const answered = report.turns.filter((t) => t.reason === "addressed" && t.outcome === "sent");
      expect(answered).toHaveLength(1);
    });

    it("the limit is the configured one", async () => {
      const log = load("empty-room.jsonl");
      log.meta.modules = { arbiter: { max_unanswered: 2 } };
      const lines = narration(verdicts((await run(log)).run));
      expect(lines.map((v) => (accepted(v) ? "said" : "held")).slice(0, 4)).toEqual([
        "said",
        "said",
        "held",
        "held",
      ]);
    });

    it("never limits what nobody can wait for: a death, low health, a result she must report, a song", async () => {
      const { run: r } = await run(load("empty-room.jsonl"));
      const all = verdicts(r);
      const unkeyed = all.filter((v) => keyOf(v) === null);
      expect(unkeyed.map((v) => v.impulse.source)).toEqual(["game", "game", "followup", "song"]);
      // They come while she is stopped: the narration just before and after is held.
      const around = all.filter((v) => keyOf(v) === "game:thing:6" || keyOf(v) === "game:thing:7");
      expect(around.map((v) => v.decision.reason)).toEqual(["unanswered", "unanswered"]);
      for (const v of unkeyed) {
        expect(v.decision.verdict, v.impulse.why).toBe("accepted");
        // And she said it: a line of hers in voice right after it came in.
        const at = Date.parse(r.inputs[0]?.at ?? "") + v.at * MIN;
        const spoke = r.sink.speeches().filter((s) => s.at >= at && s.at <= at + 30_000);
        expect(spoke.length, v.impulse.why).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("2026-11-07: told to stop", () => {
    it("what people just said to her is in front of Plan, with the rule to keep to a stop request", async () => {
      const { run: r } = await run(load("told-to-stop-playing.jsonl"));
      const plans = r.llm.requests.filter((q) => q.reasoning_purpose === "plan");
      expect(plans.length).toBeGreaterThanOrEqual(1);
      const text = JSON.stringify(plans[0]?.messages);
      expect(text).toContain('source=\\"heard\\"');
      expect(text).toContain("Alice: Miyoria, please stop playing Minecraft.");
      // The rule that makes it count: a request to stop is not made up for with another reason.
      expect(text).toContain("叫你停下或別做某件事");
      // The Plan before anyone said anything (the daily one) has no such block.
      const daily = r.llm.requests.find((q) => q.reasoning_purpose === "plan_daily");
      expect(JSON.stringify(daily?.messages)).not.toContain('source=\\"heard\\"');
    });
  });

  describe("2026-11-07: her own lines stay where she is", () => {
    it("game commentary and a task result meant for a text channel are said in voice", async () => {
      const { run: r } = await run(load("own-lines-stay-in-voice.jsonl"));
      expect(r.sink.messages()).toEqual([]);
      const spoken = r.sink.speeches();
      expect(spoken).toHaveLength(2);
      for (const s of spoken) {
        expect(s.action.payload.type === "speak" && s.action.payload.context).toMatchObject({
          kind: "voice",
          channel: "v1",
        });
      }
    });

    it("with keep_in_voice off the same lines are posted to the text channel", async () => {
      const log = load("own-lines-stay-in-voice.jsonl");
      log.meta.modules = { agent: { voice: { keep_in_voice: false } } };
      const { run: r } = await run(log);
      expect(r.sink.speeches()).toEqual([]);
      const posted = r.sink.messages();
      expect(posted).toHaveLength(2);
      for (const m of posted) {
        expect(m.action.payload.type === "send_message" && m.action.payload.context).toMatchObject({
          kind: "channel",
          channel: "c1",
        });
      }
    });
  });
});
