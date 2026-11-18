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
  it("a line is only built by the mouth and her own DM tool", () => {
    expect(using(/\btype:\s*"(?:speak|send_message)"/)).toEqual(
      [
        // `message.dm`: a tool, so only ever an action of one of her runs; the scheduler checks.
        "packages/gate/actions/src/builtin.ts",
        // The mouth (`MainLine.say`): every line of a run, and the fixed lines.
        "packages/brain/agent/src/mainline/main.ts",
        // The bus shape of `action.settled` in the type's own file.
        "packages/types/src/action.ts",
      ].sort(),
    );
  });

  it("the voice sink is only called by the scheduler; the others go through the mouth", () => {
    expect(using(/\.speak\(/)).toEqual(["packages/runtime/scheduler/src/scheduler.ts"]);
    // The panel's "say" and game chat have no other route: without the mouth they fail.
    for (const file of ["packages/gate/actions/src/builtin.ts", "packages/play/game/src/chat.ts"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).toContain("MouthKey)");
      expect(text, file).toContain("the agent module is not running");
    }
  });

  it("the scheduler refuses what the main line does not own", () => {
    const text = readFileSync(join(ROOT, "packages/runtime/scheduler/src/scheduler.ts"), "utf8");
    expect(text).toContain("mouth.owns(action.turn)");
    // And with no mouth at all (the agent module is not running) no line goes out.
    expect(text).toContain("the agent module is not running");
  });

  it("nobody but a turn writes `utterance` lines: the facts bus has no handler for them", () => {
    const text = readFileSync(join(ROOT, "packages/memory/facts/src/bus.ts"), "utf8");
    expect(text).not.toContain("#playback(");
    expect(text).not.toContain("#settled(");
    // It is not handed the delivery ledger, so it can neither open nor acknowledge a line.
    expect(text).not.toMatch(/DeliveryLedger|#ledger|options\.ledger/);
    expect(text).not.toMatch(/\.(?:open|ack|undelivered)\(/);
  });
});

describe("only the main line acts", () => {
  it("every caller of the gate is listed", () => {
    expect(using(/\.invoke\(\s*(?:\{|request|$)/m).concat(using(/actuators\.invoke\(/))).toEqual(
      expect.arrayContaining(["packages/gate/actions/src/tools.ts"]),
    );
    const callers = [...new Set([...using(/(?:registry|actuators|actuatorsFor\(.*\))\.invoke\(/)])];
    expect(callers.sort()).toEqual(
      [
        // A tool: runs in the hands of a main-line turn.
        "packages/gate/actions/src/tools.ts",
        // Transitions of a request the turn already made.
        "packages/brain/activity/src/port.ts",
        // A person on the member page asking for a song, as a `user`: a request she may turn down.
        "packages/api/src/member.ts",
        // A person at the panel, or a slash command: people, not her.
        "packages/api/src/ops.ts",
        // An expression a person bought on the member page: `stage.expression`, as the panel.
        "packages/economy/src/economy.ts",
        // The game executor: the steps of a session the main line started.
        "packages/play/game/src/actions.ts",
        "packages/play/game/src/chat.ts",
        "packages/play/game/src/commands.ts",
        "packages/play/game/src/director.ts",
        // A slash command asking for a party game: a person, not her.
        "packages/play/party/src/commands.ts",
        "packages/sing/src/commands.ts",
        "packages/stage/src/link/commands.ts",
        "packages/stage/src/link/module.ts",
        "packages/voice/voice/src/commands.ts",
      ].sort(),
    );
  });

  it("the Arbiter has no hands and her Plan none at all", () => {
    const arbiter = readFileSync(join(ROOT, "packages/brain/arbiter/src/module.ts"), "utf8");
    expect(arbiter).not.toContain("actThroughGate");
    const mind = readFileSync(join(ROOT, "packages/heart/mind/src/mind.ts"), "utf8");
    const act = mind.slice(mind.indexOf("async #act("));
    expect(act).not.toContain(".propose(");
    expect(act).not.toContain("arbiter.submit");
    expect(act).not.toContain("registry.invoke");
    // What the Arbiter admits is a run of hers: its host runs no capability itself.
    const desk = readFileSync(join(ROOT, "packages/brain/selfhost/src/impulses.ts"), "utf8");
    expect(desk).not.toContain(".invoke(");
  });

  it("the old self-starting paths are gone: the director's narration only asks the Arbiter", () => {
    const runtime = readFileSync(join(ROOT, "packages/brain/agent/src/runtime.ts"), "utf8");
    expect(runtime).not.toContain("legacyInitiative");
    expect(runtime).not.toContain("onImpulseEvent");
    expect(runtime).not.toContain("openInitiative");
    const director = readFileSync(join(ROOT, "packages/play/game/src/director.ts"), "utf8");
    expect(director).not.toContain("ProposalBoardKey");
    expect(director).toContain("this.#ctx.publish(Events.ArbiterImpulse, impulse);");
  });
});
