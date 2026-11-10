// §3 principle 1, as a check on the code: only the main line opens her mouth or moves her hands.
//
// The scheduler refuses at run time what is not the main line's (packages/scheduler). This scan
// keeps the ways around it from coming back: every place that can build a line, reach the voice
// sink or run a capability is listed with the reason it may. A new one fails here until someone
// says why it is not a second mouth.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

const FILES = [...sources(join(ROOT, "packages")), ...sources(join(ROOT, "extensions"))];

/** The files that match `pattern`, by path from the repository root. */
function using(pattern: RegExp): string[] {
  return FILES.filter((f) => pattern.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f).replaceAll("\\", "/"))
    .sort();
}

describe("only the main line speaks", () => {
  it("a line is only built by a turn, the mouth and her own DM tool", () => {
    expect(using(/\btype:\s*"(?:speak|send_message)"/)).toEqual([
      // `message.dm`: a tool, so only ever an action of a main-line turn; the scheduler checks.
      "packages/actions/src/builtin.ts",
      // The mouth (`MainLine.say`).
      "packages/agent/src/mainline/main.ts",
      // The turn itself: sentences, text, the fixed line.
      "packages/agent/src/turn.ts",
      // The bus shape of `action.settled` in the type's own file.
      "packages/replay/src/fakes.ts",
      "packages/types/src/action.ts",
    ]);
  });

  it("the voice sink is only called by the scheduler; V2 fallbacks sit behind the mouth", () => {
    expect(using(/\.speak\(/)).toEqual([
      // After `MouthKey`: only reached under `pipeline = "v2"`.
      "packages/actions/src/builtin.ts",
      "packages/game/src/chat.ts",
      "packages/scheduler/src/scheduler.ts",
    ]);
    for (const file of ["packages/actions/src/builtin.ts", "packages/game/src/chat.ts"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text.indexOf("MouthKey)")).toBeGreaterThan(-1);
      expect(text.indexOf("MouthKey)"), file).toBeLessThan(text.lastIndexOf(".speak("));
    }
  });

  it("the scheduler refuses what the main line does not own", () => {
    const text = readFileSync(join(ROOT, "packages/scheduler/src/scheduler.ts"), "utf8");
    expect(text).toContain("mouth.owns(action.turn)");
  });

  it("nobody but a turn writes `utterance` lines: the bus handlers stand down under V3", () => {
    const text = readFileSync(join(ROOT, "packages/facts/src/bus.ts"), "utf8");
    expect(text).toContain("if (!this.#ownLines) this.#playback(event.data);");
    expect(text).toContain("if (!this.#ownLines) this.#settled(");
  });
});

describe("only the main line acts", () => {
  it("every caller of the gate is listed", () => {
    expect(using(/\.invoke\(\s*(?:\{|request|$)/m).concat(using(/actuators\.invoke\(/))).toEqual(
      expect.arrayContaining(["packages/actions/src/tools.ts"]),
    );
    const callers = [...new Set([...using(/(?:registry|actuators|actuatorsFor\(.*\))\.invoke\(/)])];
    expect(callers.sort()).toEqual([
      // A tool: runs in the hands of a main-line turn.
      "packages/actions/src/tools.ts",
      // Transitions of a request the turn already made.
      "packages/activity/src/port.ts",
      // `chat.*` only under V3 (`#propose` runs nothing): the consent check of a line she chose.
      "packages/agent/src/intents.ts",
      // A person on the member page asking for a song, as a `user`: a request she may turn down.
      "packages/api/src/member.ts",
      // A person at the panel, or a slash command: people, not her.
      "packages/api/src/ops.ts",
      // `actThroughGate`: V2 only, `ArbiterEnv.act` is not set under V3.
      "packages/arbiter/src/module.ts",
      // An expression a person bought on the member page: `stage.expression`, as the panel.
      "packages/economy/src/economy.ts",
      // The game executor: the steps of a session the main line started.
      "packages/game/src/actions.ts",
      "packages/game/src/chat.ts",
      "packages/game/src/commands.ts",
      "packages/game/src/director.ts",
      // V2 only: with a proposal board `#submit` is never reached.
      "packages/mind/src/mind.ts",
      "packages/sing/src/commands.ts",
      "packages/stage/src/link/commands.ts",
      "packages/stage/src/link/module.ts",
      "packages/voice/src/commands.ts",
    ]);
  });

  it("under V3 the Arbiter has no hands and her Plan no way but the board", () => {
    const arbiter = readFileSync(join(ROOT, "packages/arbiter/src/module.ts"), "utf8");
    expect(arbiter).toContain("floor === null\n        ? { act:");
    const mind = readFileSync(join(ROOT, "packages/mind/src/mind.ts"), "utf8");
    const act = mind.slice(mind.indexOf("async #act("));
    expect(act.indexOf("if (board)")).toBeLessThan(act.indexOf("arbiter.submit"));
    const intents = readFileSync(join(ROOT, "packages/agent/src/intents.ts"), "utf8");
    expect(intents).toContain("if (main !== null && !talkOnly) return this.#propose(intent);");
  });

  it("the old self-starting paths cannot run under V3", () => {
    const runtime = readFileSync(join(ROOT, "packages/agent/src/runtime.ts"), "utf8");
    const legacy = runtime.slice(runtime.indexOf("#legacyInitiative(context: ContextKey"));
    expect(legacy.indexOf("if (this.mainline)")).toBeLessThan(legacy.indexOf("inbox.push"));
    const director = readFileSync(join(ROOT, "packages/game/src/director.ts"), "utf8");
    expect(director.indexOf("ProposalBoardKey);")).toBeLessThan(
      director.indexOf("v2Event(ARBITER_IMPULSE_TOPIC"),
    );
  });
});
