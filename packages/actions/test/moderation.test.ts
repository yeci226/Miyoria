// `message.dm` and `speak`: the two capabilities that put her words out without a turn. Both go
// through the output review before anything else, under either pipeline.

import { ServiceRegistry } from "@miyoria/kernel";
import {
  type Action,
  ActionSinkKey,
  type FixedLine,
  ModerationKey,
  type ModerationService,
  MouthKey,
  type OutputCheck,
  type PlatformSink,
  PlatformSinks,
  PlatformSinksKey,
  Principals,
  VoiceSinkKey,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { ActuatorRegistry } from "../src/registry.js";
import { CTX, OWEN } from "./helpers.js";

const VOICE = { ...CTX, channel: "v1", kind: "voice" } as const;
const SECRET = `sk-${"aB3dE6gH9jK2mN5pQ8".repeat(2)}`;

/** Blocks what holds 禁語 or a key, and remembers what it was shown. */
function review(asked: OutputCheck[] = []): ModerationService {
  return {
    filteredLine: "Filtered.",
    filteredVoiceLine: "嗶。",
    screen: (check: OutputCheck) => {
      asked.push(check);
      const text = check.visible ?? check.voice ?? "";
      const hit = text.includes("禁語") || text.includes(SECRET);
      const blocked = hit
        ? [{ field: "visible", category: "custom", rule: "test.word", layer: "rules" }]
        : [];
      return { ok: !hit, visible: check.visible ?? null, voice: check.voice ?? null, blocked };
    },
  } as unknown as ModerationService;
}

function rig(moderation: ModerationService | null) {
  const services = new ServiceRegistry();
  const queued: Action[] = [];
  const spoken: string[] = [];
  const said: FixedLine[] = [];
  const sinks = new PlatformSinks();
  sinks.register({
    platform: "discord",
    openDm: async () => CTX,
  } as unknown as PlatformSink);
  services.provide("app", PlatformSinksKey, sinks);
  services.provide("app", ActionSinkKey, {
    submit: async (action) => {
      queued.push(action);
    },
    cancelTurn: async () => undefined,
  });
  services.provide("app", VoiceSinkKey, {
    speak: async (_context, text) => {
      spoken.push(text);
      return "completed" as const;
    },
  });
  if (moderation) services.provide("app", ModerationKey, moderation);
  const registry = new ActuatorRegistry({ services });
  const dm = (text: string) =>
    registry.invoke({
      principal: Principals.command(OWEN, CTX),
      capability: "message.dm",
      args: { text },
      why: null,
      turn: null,
    });
  const speak = (text: string) =>
    registry.invoke({
      principal: Principals.panel("test"),
      capability: "speak",
      args: { context: VOICE, text },
      why: null,
      turn: null,
    });
  const mouth = () =>
    services.provide("app", MouthKey, {
      owns: () => true,
      say: async (line: FixedLine) => {
        said.push(line);
      },
    });
  return { queued, spoken, said, dm, speak, mouth };
}

describe("message.dm", () => {
  it("what is blocked goes out as the filtered line, marked", async () => {
    const r = rig(review());
    await r.dm("那個禁語");
    expect(r.queued[0]?.payload).toMatchObject({ message: { text: "Filtered." } });
    expect(r.queued[0]?.blocked).toBe("test.word");
  });

  it("a secret is caught before it could be masked", async () => {
    const asked: OutputCheck[] = [];
    const r = rig(review(asked));
    await r.dm(`我的金鑰 ${SECRET}`);
    expect(asked[0]?.visible).toContain(SECRET);
    expect(r.queued[0]?.payload).toMatchObject({ message: { text: "Filtered." } });
  });

  it("without the service the old filter still runs", async () => {
    const r = rig(null);
    await r.dm("嗨 @everyone");
    expect(r.queued[0]?.payload).toMatchObject({ message: { text: "嗨 everyone" } });
    expect(r.queued[0]?.blocked).toBeUndefined();
  });
});

describe("speak", () => {
  it("V2: the voice sink gets the spoken stand-in", async () => {
    const r = rig(review());
    await r.speak("那個禁語");
    expect(r.spoken).toEqual(["嗶。"]);
  });

  it("V3: the mouth gets it, and knows it is one", async () => {
    const r = rig(review());
    r.mouth();
    await r.speak("那個禁語");
    expect(r.spoken).toEqual([]);
    expect(r.said).toMatchObject([{ text: "嗶。", blocked: "test.word" }]);
  });
});
