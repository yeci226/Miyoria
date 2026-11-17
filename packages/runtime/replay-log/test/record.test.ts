// The opt-in recorder and the log format it writes (what `pnpm replay` reads back).

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Events, eventEnvelope, type IncomingMessage, toTimestamp } from "@miyoria/types";
import { describe, expect, it, vi } from "vitest";
import { Supervisor } from "../../kernel/src/index.js";
import {
  formatEntry,
  isReplayInput,
  parseReplayLog,
  ReplayLogError,
  ReplayRecorderModule,
} from "../src/index.js";

const message: IncomingMessage = {
  id: { context: { platform: "t", scope: "g", channel: "c", kind: "channel" }, id: "m1" },
  author: { account: { platform: "t", id: "owen" }, display_name: "Owen", is_bot: false },
  text: "@Miyoria 嗨",
  mentions_self: true,
  reply_to_self: false,
  attachments: [],
  ts: toTimestamp(Date.UTC(2026, 10, 3, 6)),
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
    const lines = await record({ dir: "logs" }, (sup) =>
      sup.bus.publish("discord", Events.PlatformMessageCreated, message),
    );
    expect(lines).toEqual([]);
  });

  it("appends her input (and her outcomes) as replayable lines", async () => {
    const lines = await record({ record: true, dir: "logs" }, (sup) => {
      sup.bus.publish("discord", Events.PlatformMessageCreated, message);
      const stamp = toTimestamp(Date.UTC(2026, 10, 3, 6, 0, 0));
      const place = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
      sup.bus.publish("agent", Events.AgentTurnOutcome, {
        turn: "t",
        context: place,
        reason: "addressed",
        outcome: { type: "silence" },
        addressed_by: [],
        focus: [],
        restarts: 0,
        reasoning: null,
        latency_ms: null,
        at: stamp,
      });
      // Not recorded: not in the topics.
      sup.bus.publish("agent", Events.AgentPrompt, {
        turn: "t",
        context: place,
        at: stamp,
        purpose: "chat",
        reasoning: "off",
        blocks: [],
        messages: [],
        prompt_tokens: null,
      });
    });
    const log = parseReplayLog(lines.join("\n"));
    expect(log.entries.map((e) => [e.source, e.type])).toEqual([
      ["discord", "platform.message.created"],
      ["agent", "agent.turn.outcome"],
    ]);
  });

  it("writes the lines byte for byte as the replay harness reads them", async () => {
    const at = Date.UTC(2026, 10, 3, 6, 0, 1, 250);
    const ids: string[] = [];
    const lines = await record({ record: true, dir: "logs" }, (sup) => {
      const first = sup.bus.publish("discord", Events.PlatformMessageCreated, message, {
        now: at,
        turn: "01JC0000000000000000000000",
      });
      const second = sup.bus.publish(
        "stage",
        Events.StageStatus,
        { connected: false },
        { now: at + 1, parent: first.id, session: "home" },
      );
      ids.push(first.id, second.id);
    });
    const [first, second] = ids;
    expect(lines).toEqual([
      `{"id":"${first}","at":"2026-11-03T06:00:01.250Z","type":"platform.message.created","v":1,"parent":null,"turn":"01JC0000000000000000000000","session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":null,"scope":null,"source":"discord","data":{"id":{"context":{"platform":"t","scope":"g","channel":"c","kind":"channel"},"id":"m1"},"author":{"account":{"platform":"t","id":"owen"},"display_name":"Owen","is_bot":false},"text":"@Miyoria 嗨","mentions_self":true,"reply_to_self":false,"attachments":[],"ts":"2026-11-03T06:00:00.000Z"}}`,
      `{"id":"${second}","at":"2026-11-03T06:00:01.251Z","type":"stage.status","v":1,"parent":"${first}","turn":null,"session":"home","space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":null,"scope":null,"source":"stage","data":{"connected":false}}`,
      "",
    ]);
    // What the harness reads back is the envelope as it was published.
    const log = parseReplayLog(lines.join("\n"));
    expect(log.entries.map((e) => e.id)).toEqual(ids);
    expect(log.entries.map(formatEntry)).toEqual(lines.slice(0, 2));
  });
});

describe("log", () => {
  it("parses meta, entries in time order, and skips comments", () => {
    const at = (s: number) => Date.UTC(2026, 10, 3, 6, 0, s);
    const said = eventEnvelope("discord", Events.PlatformMessageCreated, message, { now: at(2) });
    const cue = eventEnvelope(
      "sing",
      Events.SingCue,
      { state: "ended", song: "s1", outcome: "finished" },
      { now: at(1) },
    );
    const log = parseReplayLog(
      [
        '{"meta": {"name": "x", "tail_ms": 5}}',
        "// a comment",
        formatEntry(said),
        formatEntry(cue),
      ].join("\n"),
    );
    expect(log.meta).toEqual({ name: "x", tail_ms: 5 });
    expect(log.entries.map((e) => [e.at, e.source, e.type])).toEqual([
      [toTimestamp(at(1)), "sing", "sing.cue"],
      [toTimestamp(at(2)), "discord", "platform.message.created"],
    ]);
    expect(log.entries[1]?.data).toEqual(message);
  });

  it("refuses what is not a bus envelope, and says so of a line in the old form", () => {
    const old = JSON.stringify({
      at: "2026-11-03T06:00:00.000Z",
      source: "discord",
      event: { type: "platform_message_created", data: message },
    });
    expect(() => parseReplayLog(old)).toThrow(/line 1: an old-format replay line/);
    const said = JSON.parse(
      formatEntry(eventEnvelope("discord", Events.PlatformMessageCreated, message)),
    );
    const { source: _source, ...unsourced } = said;
    expect(() => parseReplayLog(JSON.stringify(unsourced))).toThrow(
      /line 1: not a bus envelope: `source`/,
    );
    expect(() => parseReplayLog(JSON.stringify({ ...said, at: "nope" }))).toThrow(ReplayLogError);
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
