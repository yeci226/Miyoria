// The live suites end to end with no network: a stub subject, and a judge on the real router over
// a scripted provider behind the run's meter.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  contentText,
  LlmRouter,
  type Pricing,
  parseModelRef,
} from "@miyoria/llm/llm";
import { Profile, ProfileManifestSchema } from "@miyoria/runtime/profile";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { liveMain } from "../src/live/cli.js";
import { type Judge, routerJudge } from "../src/live/judge.js";
import { BudgetStopError, Meter } from "../src/live/meter.js";
import { setupLiveModel } from "../src/live/model.js";
import {
  defaultSuites,
  formatRun,
  HISTORY_FILE,
  historyLine,
  runLive,
  runnableSuites,
  writeRun,
} from "../src/live/run.js";
import { PERSONA_SCENES, pairScenes, RELATIONSHIP_PAIRS } from "../src/live/scenes.js";
import { NO_USAGE, type Reply, type Scene, type Subject } from "../src/live/subject.js";
import type { SuiteContext } from "../src/live/suite.js";
import { type PersonaItem, runPersona } from "../src/live/suites/persona.js";
import {
  closeIsA,
  type RelationshipItem,
  runRelationship,
} from "../src/live/suites/relationship.js";
import { runTools, type ToolItem } from "../src/live/suites/tools.js";
import { TOOL_TASKS } from "../src/tasks/set.js";

const USAGE = { prompt_tokens: 100, completion_tokens: 10, cached_prompt_tokens: 0 };

/** Answers every request with the text `answer` gives for it. */
class Scripted implements ChatProvider {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];
  constructor(readonly answer: (system: string, user: string, n: number) => string) {}
  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const text = (role: string) =>
      request.messages
        .filter((m) => m.role === role)
        .map((m) => contentText(m.content))
        .join("\n");
    const out = this.answer(text("system"), text("user"), this.requests.length);
    return (async function* (): ChatStream {
      yield { type: "text_delta", text: out };
      yield { type: "done", finish_reason: "stop", usage: USAGE };
    })();
  }
}

function setup(
  answer: (system: string, user: string, n: number) => string,
  meterOptions: { pricing?: Map<string, Pricing>; maxUsd?: number } = {},
): { provider: Scripted; meter: Meter; judge: Judge } {
  const provider = new Scripted(answer);
  const meter = new Meter(meterOptions);
  const router = new LlmRouter(
    new Map([["scripted", meter.wrap(provider)]]),
    new Map([["chat", [parseModelRef("scripted:m")]]]),
  );
  return { provider, meter, judge: routerJudge(router) };
}

function reply(lines: string[], more: Partial<Reply> = {}): Reply {
  return {
    lines,
    calls: [],
    silent: lines.length === 0,
    usage: { ...NO_USAGE },
    ms: 1,
    ...more,
  };
}

function stub(respond: (scene: Scene) => Reply | Promise<Reply>, name = "stub"): Subject {
  return { name, unsupported: () => null, respond: async (scene) => respond(scene) };
}

function context(subject: Subject, judge: Judge, meter: Meter): SuiteContext {
  return { subject, judge, meter, persona: "她是鯨魚娘。", repeat: 1, seed: "s", log: () => {} };
}

const five = (score: number) => ({ score, reason: "理由" });
const all = (score: number) =>
  JSON.stringify({
    in_character: five(score),
    fits: five(score),
    brevity: five(score),
    clean: five(score),
    grounded: five(score),
  });

const temp: string[] = [];
function tempDir(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "live-eval-"));
  temp.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

describe("the judge", () => {
  const schema = z.object({ n: z.number() });

  it("takes the JSON object out of a reply with prose and fences around it", async () => {
    const { judge } = setup(() => '好的:\n```json\n{"n": 3}\n```');
    expect(await judge.ask("s", "u", schema)).toEqual({ ok: true, value: { n: 3 } });
  });

  it("asks with thinking at high, for a JSON object, on the chat purpose", async () => {
    const { judge, provider } = setup(() => '{"n": 1}');
    await judge.ask("s", "u", schema);
    expect(provider.requests[0]).toMatchObject({ reasoning: "high", json_mode: true, model: "m" });
  });

  it("asks once more after an unusable answer and uses the repaired one", async () => {
    const { judge, provider } = setup((_s, _u, n) => (n === 1 ? "我覺得不錯" : '{"n": 2}'));
    expect(await judge.ask("s", "u", schema)).toEqual({ ok: true, value: { n: 2 } });
    expect(provider.requests).toHaveLength(2);
  });

  it("gives up after the retry: not ok, and no throw", async () => {
    const { judge, provider } = setup(() => '{"n": "many"}');
    const verdict = await judge.ask("s", "u", schema);
    expect(verdict.ok).toBe(false);
    expect(provider.requests).toHaveLength(2);
  });
});

describe("suite persona", () => {
  it("scores every situation and reports the mean and the share of low replies", async () => {
    // The judge finds one reply bad on one dimension.
    const { judge, meter, provider } = setup((_s, user) =>
      user.includes("大肥魚") ? JSON.stringify({ ...JSON.parse(all(4)), clean: five(2) }) : all(4),
    );
    const result = await runPersona(
      context(
        stub(() => reply(["哼。"])),
        judge,
        meter,
      ),
    );
    const items = result.items as PersonaItem[];
    expect(items).toHaveLength(20);
    expect(provider.requests).toHaveLength(20);
    expect(result.headline.low_share).toBeCloseTo(1 / 20);
    // 99 scores of 4 and one of 2, scaled from 1..5 to 0..1.
    expect(result.headline.score).toBeCloseTo((398 / 100 - 1) / 4);
    expect(result.stopped).toBeUndefined();
  });

  it("gives the judge the watch note and the persona, and the subject neither", async () => {
    const seen: Scene[] = [];
    const { judge, meter, provider } = setup(() => all(5));
    await runPersona(
      context(
        stub((scene) => {
          seen.push(scene);
          return reply(["嗯。"]);
        }),
        judge,
        meter,
      ),
    );
    const first = PERSONA_SCENES[0];
    const system = contentText(provider.requests[0]?.messages[0]?.content ?? "");
    const user = contentText(provider.requests[0]?.messages[1]?.content ?? "");
    expect(system).toContain("她是鯨魚娘。");
    expect(user).toContain(first?.situation.watch);
    expect(JSON.stringify(seen)).not.toContain(first?.situation.watch);
  });

  it("asks only whether silence fits when she said nothing", async () => {
    const { judge, meter, provider } = setup((system) =>
      system.includes("in_character") ? all(3) : JSON.stringify({ fits: five(5) }),
    );
    const silentOn12 = stub((scene) => reply(scene.id === "persona-12" ? [] : ["嗯。"]));
    const result = await runPersona(context(silentOn12, judge, meter));
    const twelve = (result.items as PersonaItem[]).find((i) => i.id === 12);
    expect(twelve?.silent).toBe(true);
    expect(twelve?.scores).toEqual({ fits: five(5) });
    const asked = contentText(provider.requests[11]?.messages[1]?.content ?? "");
    expect(asked).toContain("(她沒有說話)");
  });

  it("leaves a reply the judge could not score out of the numbers", async () => {
    const { judge, meter } = setup((_s, user) => (user.includes("小雨:早\n") ? "不知道" : all(5)));
    const result = await runPersona(
      context(
        stub(() => reply(["嗯。"])),
        judge,
        meter,
      ),
    );
    const failed = (result.items as PersonaItem[]).filter((i) => i.scores === null);
    expect(failed.map((i) => i.id)).toEqual([15]);
    expect(failed[0]?.judge_error).toBeTruthy();
    expect(result.headline).toEqual({ score: 1, low_share: 0 });
  });

  it("addresses every scene but the one where nobody calls her", () => {
    const none = PERSONA_SCENES.filter((s) => s.scene.address === "none").map((s) => s.scene.id);
    expect(none).toEqual(["persona-12"]);
    const byName = (id: number) => PERSONA_SCENES.find((s) => s.situation.id === id)?.scene.people;
    expect(byName(7)?.[0]?.closeness?.bond).toBe(0);
    expect(byName(8)?.[0]?.closeness?.bond).toBe(300);
  });
});

/** Runs a task's reference calls on the scene's tools: what a subject that solves it does. */
function referenceSubject(skip: (scene: Scene) => string | null = () => null): Subject {
  return {
    name: "reference",
    unsupported: skip,
    async respond(scene) {
      const task = TOOL_TASKS.find((t) => `tools-${t.id}` === scene.id);
      if (!task || !scene.tools) throw new Error("not a tool scene");
      const calls = task.reference.calls.map((c) => ({
        tool: c.tool,
        args: c.args,
        ...(scene.tools as NonNullable<Scene["tools"]>).call(c.tool, c.args),
      }));
      return reply([task.reference.answer], { calls });
    },
  };
}

describe("suite tools", () => {
  it("runs the thirteen tasks with the subject as the agent and decides by their criteria", async () => {
    const { judge, meter } = setup(() => "{}");
    const result = await runTools(context(referenceSubject(), judge, meter));
    expect(result.items).toHaveLength(13);
    expect(result.headline.success).toBe(1);
    expect(result.unsupported).toEqual([]);
  });

  it("fails a subject that answers without touching a tool", async () => {
    const { judge, meter } = setup(() => "{}");
    const result = await runTools(
      context(
        stub(() => reply(["應該沒問題。"])),
        judge,
        meter,
      ),
    );
    expect(result.headline.success).toBe(0);
  });

  it("reports what the subject cannot be shown as unsupported, not as a failure", async () => {
    const { judge, meter } = setup(() => "{}");
    const noReminders = referenceSubject((scene) =>
      scene.tools?.tools.includes("remind_me") ? "no reminders in this subject" : null,
    );
    const result = await runTools(context(noReminders, judge, meter));
    const withReminders = TOOL_TASKS.filter((t) => t.tools.includes("remind_me")).map((t) => t.id);
    expect(withReminders.length).toBeGreaterThan(0);
    expect(result.unsupported).toEqual(
      withReminders.map((id) => ({ id, reason: "no reminders in this subject" })),
    );
    expect(result.items).toHaveLength(13 - withReminders.length);
    expect((result.items as ToolItem[]).every((i) => !withReminders.includes(i.id))).toBe(true);
    expect(result.headline.success).toBe(1);
  });

  it("gives a scene its clock only when the task sets one", async () => {
    const seen: Scene[] = [];
    const { judge, meter } = setup(() => "{}");
    await runTools(
      context(
        stub((scene) => {
          seen.push(scene);
          return reply([]);
        }),
        judge,
        meter,
      ),
    );
    expect(seen.filter((s) => s.now !== undefined).map((s) => s.id)).toEqual([
      "tools-event-reminder",
      "tools-move-a-reminder",
    ]);
    expect(seen.every((s) => s.address === "mention" && s.tools !== undefined)).toBe(true);
  });
});

/** Says who it thinks it is talking to: a stranger or someone close. */
const twoVoices = stub((scene) =>
  reply([(scene.people[0]?.closeness?.bond ?? 0) >= 100 ? "幹嘛啦(熟)" : "我們認識嗎(生)"]),
);

/** A judge that can tell the two voices apart, and finds the line held. */
function sharpJudge(_system: string, user: string): string {
  if (_system.includes("底線")) {
    return JSON.stringify({ A: { held: true, reason: "" }, B: { held: true, reason: "" } });
  }
  const a = user.slice(user.indexOf("<回覆A>"), user.indexOf("</回覆A>"));
  return JSON.stringify({ closer: a.includes("(熟)") ? "A" : "B", reason: "口氣" });
}

describe("suite relationship", () => {
  it("draws the order from the seed: the same again, and close to even", () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `pair-${i}#0`);
    const first = keys.map((k) => closeIsA("seed-1", k));
    expect(keys.map((k) => closeIsA("seed-1", k))).toEqual(first);
    expect(keys.map((k) => closeIsA("seed-2", k))).not.toEqual(first);
    const asA = first.filter(Boolean).length / keys.length;
    expect(asA).toBeGreaterThan(0.45);
    expect(asA).toBeLessThan(0.55);
  });

  it("shows the two replies without labels, in the drawn order", async () => {
    const { judge, meter, provider } = setup(sharpJudge);
    const result = await runRelationship(context(twoVoices, judge, meter));
    const items = result.items as RelationshipItem[];
    expect(items).toHaveLength(RELATIONSHIP_PAIRS.length);
    expect(new Set(items.map((i) => i.close_shown_as)).size).toBe(2);
    for (const [i, item] of items.entries()) {
      expect(item.close_shown_as).toBe(closeIsA("s", `${item.id}#0`) ? "A" : "B");
      const user = contentText(provider.requests[i * 2]?.messages[1]?.content ?? "");
      const shownA = user.slice(user.indexOf("<回覆A>"), user.indexOf("</回覆A>"));
      expect(shownA.includes("(熟)")).toBe(item.close_shown_as === "A");
      // Nothing in what the judge reads says which reply is whose.
      expect(user).not.toMatch(/bond|closeness|陌生|很熟的/);
    }
    expect(result.headline).toEqual({ told_apart: 1, line_held: 1 });
  });

  it("counts a judge that cannot tell, and a line that did not hold", async () => {
    const { judge, meter } = setup((system, user) => {
      if (system.includes("底線")) {
        const broke = user.includes("上床");
        return JSON.stringify({
          A: { held: !broke, reason: "" },
          B: { held: true, reason: "" },
        });
      }
      return JSON.stringify({ closer: "unknown", reason: "一樣" });
    });
    const result = await runRelationship(
      context(
        stub(() => reply(["嗯。"])),
        judge,
        meter,
      ),
    );
    expect(result.headline.told_apart).toBe(0);
    expect(result.headline.line_held).toBeCloseTo(
      (RELATIONSHIP_PAIRS.length - 1) / RELATIONSHIP_PAIRS.length,
    );
  });

  it("tells the judge a request past the line must be refused at both levels", async () => {
    const { judge, meter, provider } = setup(sharpJudge);
    const past = RELATIONSHIP_PAIRS.filter((p) => p.must_refuse);
    expect(past).toHaveLength(1);
    await runRelationship(context(twoVoices, judge, meter), past);
    const system = contentText(provider.requests[1]?.messages[0]?.content ?? "");
    expect(system).toContain("都必須是拒絕");
  });

  it("makes pairs that differ in closeness and in nothing else", () => {
    for (const pair of RELATIONSHIP_PAIRS) {
      const { far, close } = pairScenes(pair);
      const strip = (s: Scene) => ({ ...s, id: "", people: s.people.map((p) => p.name) });
      expect(strip(far)).toEqual(strip(close));
      expect(far.people[0]?.closeness?.bond).toBeLessThan(close.people[0]?.closeness?.bond ?? 0);
    }
  });
});

describe("a live run", () => {
  const price = new Map<string, Pricing>([
    // 100 prompt tokens a call: one dollar a call.
    ["scripted:m", { input_per_mtok: 10_000, cached_input_per_mtok: null, output_per_mtok: 0 }],
  ]);

  it("stops at the limit before the next model call and keeps what finished", async () => {
    const { judge, meter, provider } = setup(() => all(4), { pricing: price, maxUsd: 2.5 });
    const registry = defaultSuites();
    const run = await runLive({
      subject: stub(() => reply(["嗯。"])),
      judge,
      meter,
      registry,
      suites: ["persona", "relationship"],
      persona: "p",
    });
    // Three calls cost three dollars; the fourth was never sent.
    expect(provider.requests).toHaveLength(3);
    expect(run.stopped).toBe("budget");
    expect(run.usd).toBeCloseTo(3);
    const [persona, relationship] = run.suites;
    expect(persona?.stopped).toBe("budget");
    expect(persona?.items).toHaveLength(3);
    expect(persona?.headline.score).toBeCloseTo(0.75);
    expect(relationship).toMatchObject({ stopped: "budget", items: [] });
    expect(formatRun(run)).toContain("stopped: budget");
  });

  it("drops the item during which the limit was hit inside the subject", async () => {
    const { judge, meter, provider } = setup(() => all(4), { pricing: price, maxUsd: 1.5 });
    // In the second scene the subject's first model call takes the run past the limit and its
    // second is refused. It swallows the refusal, as her brain does (a canned line instead).
    let n = 0;
    const subject = stub(async () => {
      n += 1;
      if (n === 2) {
        meter.record("scripted:m", USAGE);
        try {
          meter.check();
        } catch {
          return reply(["等等,腦袋卡了一下。"]);
        }
      }
      return reply(["嗯。"]);
    });
    const result = await runPersona(context(subject, judge, meter));
    expect(result.stopped).toBe("budget");
    // The canned line is not scored, and the judge was not asked about it.
    expect(result.items).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
    expect(n).toBe(2);
  });

  it("writes one file per run and appends one history line", async () => {
    const dir = join(tempDir(), "nested", "live");
    const { judge, meter } = setup(sharpJudge, { pricing: price });
    const options = {
      subject: twoVoices,
      judge,
      meter,
      registry: defaultSuites(),
      suites: ["relationship", "memory"],
      persona: "p",
      commit: "abc123",
      seed: "s",
    };
    const run = await runLive(options);
    const written = writeRun(run, dir);
    expect(existsSync(written.file)).toBe(true);
    expect(JSON.parse(readFileSync(written.file, "utf8"))).toMatchObject({
      commit: "abc123",
      subject: "stub",
      suites: [{ suite: "relationship" }, { suite: "memory", skipped: expect.any(String) }],
    });
    writeRun({ ...run, at: "2026-11-17T00:00:00.000Z" }, dir);
    const lines = readFileSync(join(dir, HISTORY_FILE), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const line = JSON.parse(lines[0] ?? "");
    expect(line).toEqual({
      v: 1,
      at: run.at,
      commit: "abc123",
      subject: "stub",
      repeat: 1,
      suites: {
        relationship: {
          headline: { told_apart: 1, line_held: 1 },
          items: RELATIONSHIP_PAIRS.length,
          unsupported: 0,
          stopped: false,
        },
      },
      tokens: {
        calls: 20,
        prompt_tokens: 2000,
        completion_tokens: 200,
        cached_prompt_tokens: 0,
        reasoning_tokens: 0,
      },
      usd: 20,
      duration_ms: expect.any(Number),
      // No chain was given: the models that answered.
      models: ["scripted:m"],
      stopped: null,
    });
  });

  it("says the cost is unknown when a model has no price", async () => {
    const { judge, meter } = setup(sharpJudge);
    const run = await runLive({
      subject: twoVoices,
      judge,
      meter,
      registry: defaultSuites(),
      suites: ["relationship"],
      persona: "p",
    });
    expect(run.unpriced).toEqual(["scripted:m"]);
    expect(historyLine(run).usd).toBeNull();
    expect(historyLine(run).tokens.prompt_tokens).toBe(2000);
    expect(formatRun(run)).toContain("cost: unknown");
  });

  it("keeps `memory` as a slot until a runner is registered from outside", async () => {
    const registry = defaultSuites();
    expect(registry.names()).toEqual([
      "persona",
      "tools",
      "relationship",
      "memory",
      "corrections",
      "feel",
      "play",
    ]);
    expect(runnableSuites(registry)).toEqual(["persona", "tools", "relationship", "feel"]);
    const { judge, meter } = setup(() => "{}");
    const base = { subject: twoVoices, judge, meter, registry, suites: ["memory"], persona: "p" };
    expect((await runLive(base)).suites[0]?.skipped).toBe("no runner registered for this suite");
    registry.register("memory", async () => ({
      suite: "memory",
      headline: { recall_at_5: 0.5 },
      items: [],
      unsupported: [],
    }));
    expect((await runLive(base)).suites[0]?.headline).toEqual({ recall_at_5: 0.5 });
  });
});

describe("the live CLI", () => {
  const quiet = { out: () => {}, err: () => {} };

  it("needs a config path", async () => {
    expect(await liveMain([], quiet)).toBe(2);
  });

  it("refuses a subject it does not have", async () => {
    const said: string[] = [];
    const code = await liveMain(["--config", "x.toml", "--subject", "next"], {
      ...quiet,
      err: (t) => said.push(t),
    });
    expect(code).toBe(2);
    expect(said.join("")).toContain("no subject `next`");
  });

  it("does not run without a model: a missing file, or a config with no provider", async () => {
    const dir = tempDir();
    const said: string[] = [];
    const hooks = { ...quiet, err: (t: string) => said.push(t) };
    expect(await liveMain(["--config", join(dir, "none.toml")], hooks)).toBe(2);
    const empty = join(dir, "empty.toml");
    writeFileSync(empty, "");
    expect(await liveMain(["--config", empty, "--out", join(dir, "out")], hooks)).toBe(2);
    expect(said.join("")).toContain("no config file");
    expect(said.join("")).toContain("sets no [llm.providers.*]");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });
});

describe("the live model", () => {
  it("builds the router from a config file, counts a call by its price and stops at the limit", async () => {
    // A local stand-in for the provider: one streamed chat completion with usage.
    let requests = 0;
    const chunk = (delta: object, finish: string | null, usage?: object) =>
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "m1",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      })}\n\n`;
    const http = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        requests += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk({ role: "assistant", content: '{"n": 1}' }, null));
        res.write(
          chunk({}, "stop", { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }),
        );
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const port = (http.address() as AddressInfo).port;
      const config = join(tempDir(), "eval.toml");
      writeFileSync(
        config,
        [
          "[llm.providers.local]",
          'kind = "openai-compatible"',
          `base_url = "http://127.0.0.1:${port}/v1"`,
          'api_key = "test"',
          "[llm.purposes]",
          'chat = ["local:m1"]',
          '[llm.pricing."local:m1"]',
          "input_per_mtok = 1.0",
          "output_per_mtok = 2.0",
          "",
        ].join("\n"),
      );
      const profile = new Profile({
        dir: "",
        manifest: ProfileManifestSchema.parse({ id: "t", display_name: "T" }),
        sections: [],
        examples: [],
        voice: null,
        avatar: null,
      });
      const model = await setupLiveModel(config, profile, 0.001);
      if (model.kind !== "ready") throw new Error(model.reason);
      expect(model.chain).toBe("local:m1");
      const judge = routerJudge(model.router);
      expect(await judge.ask("s", "u", z.object({ n: z.number() }))).toEqual({
        ok: true,
        value: { n: 1 },
      });
      expect(model.meter.usage()).toMatchObject({
        calls: 1,
        prompt_tokens: 1000,
        completion_tokens: 500,
      });
      expect(model.meter.usd()).toBeCloseTo(0.002);
      // Over the limit now: the next call is refused before anything is sent.
      await expect(judge.ask("s", "u", z.object({ n: z.number() }))).rejects.toBeInstanceOf(
        BudgetStopError,
      );
      expect(requests).toBe(1);
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  });
});
