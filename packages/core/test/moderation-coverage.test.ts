// §16 as a check on the code: everything she writes or says passes the output review, and
// everything people write passes the input defence. Same idea as one-mouth.test.ts: each place
// that can put a line in front of someone is listed with the reason it is covered. A new one fails
// here until someone wires it, or says why it does not have to be.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Permissions } from "@miyoria/commands";
import { isOwnerAccount } from "@miyoria/types";
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

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/** The body of the method or function that starts at `head`, up to the next one at its level. */
function bodyOf(text: string, head: string): string {
  const start = text.indexOf(head);
  expect(start, head).toBeGreaterThan(-1);
  const indent = /^ */.exec(text.slice(text.lastIndexOf("\n", start) + 1))?.[0] ?? "";
  const end = text.indexOf(`\n${indent}}`, start);
  return text.slice(start, end);
}

describe("every line of hers is reviewed", () => {
  it("`filterOutgoing` only runs behind `screen`: nothing calls it on its own", () => {
    expect(using(/\bfilterOutgoing\(/)).toEqual(
      [
        // `sanitizeGameChat`: only ever given what `safeOutgoing` let through (checked below).
        "packages/play/game/src/chat-text.ts",
        // The one that calls it, after `screen`.
        "packages/types/src/moderation.ts",
        // Its definition.
        "packages/types/src/untrusted.ts",
      ].sort(),
    );
    const safe = bodyOf(read("packages/types/src/moderation.ts"), "export function safeOutgoing(");
    expect(safe.indexOf("moderation?.screen(")).toBeGreaterThan(-1);
    expect(safe.indexOf("moderation?.screen(")).toBeLessThan(safe.indexOf("filterOutgoing("));
  });

  it("whoever builds a line has it reviewed first", () => {
    const builders = using(/\btype:\s*"(?:speak|send_message)"/).filter(
      // The bus shape of `action.settled`: it builds no words.
      (f) => f !== "packages/types/src/action.ts",
    );
    expect(builders).toEqual(
      ["packages/gate/actions/src/builtin.ts", "packages/brain/agent/src/mainline/main.ts"].sort(),
    );
    for (const file of builders) expect(read(file), file).toContain("safeOutgoing(");
  });

  it("each way out of a run goes through the review", () => {
    // The runner's outlets hand every line of hers, text and voice, to the mouth.
    for (const file of [
      "packages/brain/selfhost/src/outlet.ts",
      "packages/brain/selfhost/src/voice-outlet.ts",
    ]) {
      expect(read(file), file).toContain("agent.mainline.say(");
    }
    // And the mouth reviews before it builds the line.
    const say = bodyOf(
      read("packages/brain/agent/src/mainline/main.ts"),
      "async say(line: FixedLine)",
    );
    expect(say.indexOf("safeOutgoing(")).toBeGreaterThan(-1);
    expect(say.indexOf("safeOutgoing(")).toBeLessThan(say.indexOf("newAction("));
  });

  it("every sink a line can reach reviews it or is told why it need not", () => {
    expect(using(/\bimplements PlatformSink\b/)).toEqual(
      [
        // The terminal: the owner's own console, nobody else reads it.
        "packages/core/src/cli-platform.ts",
        "packages/discord/src/sink.ts",
        "packages/play/game/src/chat.ts",
      ].sort(),
    );
    const discord = read("packages/discord/src/sink.ts");
    expect(bodyOf(discord, "async send(")).toContain("safeOutgoing(");
    expect(bodyOf(discord, "async setVoiceStatus(")).toContain("safeOutgoing(");
    const voice = read("packages/voice/voice/src/sink.ts");
    const producer = bodyOf(voice, "#producer(");
    expect(producer.match(/this\.#review\(/g)).toHaveLength(2);
    expect(producer).toContain('"tts"');
    expect(producer).toContain('"translation"');
    expect(producer.indexOf('"tts"')).toBeLessThan(producer.indexOf("translator.translate("));
    expect(producer.indexOf("translator.translate(")).toBeLessThan(
      producer.indexOf('"translation"'),
    );
    expect(bodyOf(voice, "async speak(")).toContain("this.#review(");
  });

  it("the voice sink is only reached by the scheduler; the other voices go through the mouth, reviewed", () => {
    expect(using(/\.speak\(/)).toEqual(["packages/runtime/scheduler/src/scheduler.ts"]);
    for (const file of ["packages/gate/actions/src/builtin.ts", "packages/play/game/src/chat.ts"]) {
      const text = read(file);
      expect(text.indexOf("safeOutgoing("), file).toBeGreaterThan(-1);
      expect(text.indexOf("mouth.say("), file).toBeGreaterThan(-1);
      expect(text.indexOf("safeOutgoing("), file).toBeLessThan(text.lastIndexOf("mouth.say("));
    }
  });

  it("game chat is sanitized only after the review", () => {
    expect(using(/\bsanitizeGameChat\(/)).toEqual(
      [
        "packages/play/game/src/actions.ts",
        "packages/play/game/src/chat-text.ts",
        "packages/play/game/src/chat.ts",
      ].sort(),
    );
    const act = bodyOf(read("packages/play/game/src/actions.ts"), "export function safeActCall(");
    expect(act.indexOf("safeOutgoing(")).toBeLessThan(act.indexOf("sanitizeGameChat("));
    const chat = read("packages/play/game/src/chat.ts");
    const deliver = bodyOf(chat, "async deliver(");
    expect(deliver.indexOf("this.#safe(")).toBeGreaterThan(-1);
    expect(deliver.indexOf("this.#safe(")).toBeLessThan(deliver.indexOf("this.#type("));
    expect(bodyOf(chat, "async #link(")).toContain("this.#safe(");
  });
});

describe("everything people write is judged", () => {
  it("whoever turns a message into something she knows asks the input defence", () => {
    const readers = using(/is\(Events\.PlatformMessageCreated,/);
    // Only counters and presence: no text of a message goes anywhere from these.
    const counting = [
      "packages/brain/arbiter/src/module.ts",
      "packages/brain/arbiter/src/unanswered.ts",
      "packages/economy/src/earn.ts",
      // The raw record of each line (the store), not something she knows.
      "packages/memory/facts/src/record.ts",
      "packages/memory/learning/src/modules.ts",
      "packages/memory/memory/src/module.ts",
      "packages/heart/self/src/module.ts",
      "packages/heart/self/src/rules.ts",
      "packages/heart/person/src/module.ts",
      "packages/stage/src/link/module.ts",
      "packages/memory/world/src/module.ts",
      // How lively a channel is, for a card drop: who wrote and when, never what.
      "packages/play/cards/src/drops.ts",
    ];
    expect(readers.filter((f) => !counting.includes(f))).toEqual(
      [
        "packages/brain/agent/src/runtime.ts",
        "packages/memory/facts/src/bus.ts",
        // Players' answers in the voice channel's chat: judged before they reach a game.
        "packages/play/party/src/module.ts",
      ].sort(),
    );
    for (const file of ["runtime", "bus", "party"]) {
      const path = {
        runtime: "packages/brain/agent/src/runtime.ts",
        bus: "packages/memory/facts/src/bus.ts",
        party: "packages/play/party/src/module.ts",
      }[file] as string;
      expect(read(path), path).toContain("inspectInput(");
    }
  });

  it("the publishers that know more than the bus judge it themselves", () => {
    const chat = bodyOf(read("packages/play/game/src/chat.ts"), "#onChat(");
    expect(chat.indexOf("inspectInput(")).toBeGreaterThan(-1);
    expect(chat.indexOf("inspectInput(")).toBeLessThan(
      chat.indexOf("Events.PlatformMessageCreated"),
    );
    expect(chat).toContain('source: "game_chat"');
  });

  it("what tools bring back is outside content", () => {
    // The runner screens every result before she reads it; the service guard judges it as a tool's.
    expect(read("packages/brain/self/src/run.ts")).toContain("guard.screenResult?.(result.text");
    const guard = read("packages/brain/self/src/service-guard.ts");
    expect(bodyOf(guard, "screenResult(text: string")).toContain('source: "tool"');
  });

  it("the node that marks the owner is held by owners alone", () => {
    const permissions = Permissions.fromStrings(["discord:1"]);
    const of = (id: string) => ({ platform: "discord", id });
    expect(isOwnerAccount(permissions, of("1"))).toBe(true);
    expect(isOwnerAccount(permissions, of("2"))).toBe(false);
    // No Authorizer: nobody is the owner.
    expect(isOwnerAccount(undefined, of("1"))).toBe(false);
  });

  it("the owner comes from the Authorizer, never from a name", () => {
    const owner = bodyOf(
      read("packages/types/src/moderation.ts"),
      "export function isOwnerAccount(",
    );
    expect(owner).toContain("authorizer?.allows(");
    expect(
      using(/\bowner:\s*(?:true|[a-z]+\.includes)/).filter((f) => f.includes("moderation")),
    ).toEqual([]);
  });
});
