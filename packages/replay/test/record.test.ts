// The opt-in recorder and the log format it writes (what `pnpm replay` reads back).

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "@miyoria/kernel";
import { customEvent, type Event, toTimestamp } from "@miyoria/types";
import { describe, expect, it, vi } from "vitest";
import {
  isReplayInput,
  parseReplayLog,
  ReplayLogError,
  ReplayRecorderModule,
} from "../src/index.js";

const message: Event = {
  type: "platform_message_created",
  data: {
    id: { context: { platform: "t", scope: "g", channel: "c", kind: "channel" }, id: "m1" },
    author: { account: { platform: "t", id: "owen" }, display_name: "Owen", is_bot: false },
    text: "@Miyoria 嗨",
    mentions_self: true,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(Date.UTC(2026, 10, 3, 6)),
  },
};

async function record(config: unknown, publish: (sup: Supervisor) => void): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "replay-rec-"));
  const sup = new Supervisor();
  try {
    await sup.register(new ReplayRecorderModule({ baseDir: dir }), config as never, true);
    await sup.startAll();
    publish(sup);
    const logs = join(dir, "logs");
    await vi.waitFor(
      () => {
        if (config !== null && (config as { record?: boolean }).record) {
          expect(existsSync(logs) && readdirSync(logs).length).toBe(1);
          const [name] = readdirSync(logs);
          expect(readFileSync(join(logs, name as string), "utf8").split("\n").length).toBe(3);
        }
      },
      { timeout: 2000 },
    );
    await sup.stopAll();
    if (!existsSync(logs)) return [];
    return readdirSync(logs).flatMap((f) => readFileSync(join(logs, f), "utf8").split("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("recorder", () => {
  it("writes nothing unless recording is turned on", async () => {
    const lines = await record({ dir: "logs" }, (sup) => sup.bus.publish("discord", message));
    expect(lines).toEqual([]);
  });

  it("appends her input (and her outcomes) as replayable lines", async () => {
    const lines = await record({ record: true, dir: "logs" }, (sup) => {
      sup.bus.publish("discord", message);
      sup.bus.publish("agent", customEvent("agent.turn.outcome", { turn: "t" }));
      // Not recorded: not in the topics.
      sup.bus.publish("agent", customEvent("agent.prompt", { turn: "t" }));
    });
    const log = parseReplayLog(lines.join("\n"));
    expect(log.entries.map((e) => [e.source, e.event.type])).toEqual([
      ["discord", "platform_message_created"],
      ["agent", "custom"],
    ]);
  });
});

describe("log", () => {
  it("parses meta, entries in time order, and skips comments", () => {
    const at = (s: number) => toTimestamp(Date.UTC(2026, 10, 3, 6, 0, s));
    const log = parseReplayLog(
      [
        '{"meta": {"name": "x", "tail_ms": 5}}',
        "// a comment",
        JSON.stringify({ at: at(2), source: "discord", event: message }),
        JSON.stringify({ at: at(1), event: customEvent("sing.cue", {}) }),
      ].join("\n"),
    );
    expect(log.meta).toEqual({ name: "x", tail_ms: 5 });
    expect(log.entries.map((e) => [e.at, e.source])).toEqual([
      [at(1), "replay"],
      [at(2), "discord"],
    ]);
    expect(() => parseReplayLog('{"at": "nope", "event": {}}')).toThrow(ReplayLogError);
  });

  it("replays what she perceives, never what the replayed modules produce", () => {
    expect(isReplayInput("voice.utterance", "voice")).toBe(true);
    expect(isReplayInput("agent.turn.outcome", "agent")).toBe(false);
    expect(isReplayInput("arbiter.decision", "arbiter")).toBe(false);
    // Impulses of modules the replay does not run (the singer) are input; the agent's are not.
    expect(isReplayInput("arbiter.impulse", "sing")).toBe(true);
    expect(isReplayInput("arbiter.impulse", "actions")).toBe(false);
  });
});
