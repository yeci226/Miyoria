// A place she only hears is compacted when it has been quiet and grown past the threshold, with
// the segment pass reading the lines first.

import { type TranscriptStore, transcriptTables } from "@miyoria/memory/transcript";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { SqliteStore } from "@miyoria/store";
import { SegmentFlushKey } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "../../agent/src/index.js";
import type { RunModel } from "../../self/src/index.js";
import { compactIdleSessions } from "../src/idle-compaction.js";

const MINUTE = 60_000;
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

function setup() {
  let now = Date.UTC(2026, 10, 1, 12);
  return {
    clock: {
      now: () => now,
      tick: (ms: number) => {
        now += ms;
      },
    },
  };
}

describe("idle compaction", () => {
  it("compacts a quiet session past the threshold after the segment pass, and no other", async () => {
    const { clock } = setup();
    const store = await SqliteStore.open(":memory:", { plugins: [transcriptTables], clock });
    stores.push(store);
    const transcript: TranscriptStore = store.plugin(transcriptTables);
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: "other" as const,
        author: "Owen",
        content: `第${i}句`,
        tokens: 10,
      }));
    transcript.append("heard", lines(10));
    clock.tick(60 * MINUTE);
    transcript.append("chatty", lines(10));
    transcript.append("short", lines(2));

    const asked: Array<[string, number]> = [];
    const services = new ServiceRegistry();
    services.provide("app", SegmentFlushKey, {
      beforeCompaction: async (session: string, upto: number) => {
        asked.push([session, upto]);
        return "done" as const;
      },
    });
    const warnings: unknown[] = [];
    const agent = {
      ctx: { services, clock },
      log: { warn: (...args: unknown[]) => warnings.push(args) },
    } as unknown as Agent;
    const model = {
      complete: async () => ({ text: "聽到的事" }),
    } as unknown as RunModel;

    const done = await compactIdleSessions(agent, {
      transcript,
      model,
      budget: { thresholdTokens: 50, keepTokens: 20 },
      signal: new AbortController().signal,
    });
    expect(done).toEqual(["heard"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.[0]).toBe("heard");
    expect(transcript.tail("heard").summary?.summary).toBe("聽到的事");
    expect(transcript.tail("chatty").summary).toBeNull();
    expect(transcript.tail("short").summary).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("does nothing without a budget", async () => {
    const { clock } = setup();
    const store = await SqliteStore.open(":memory:", { plugins: [transcriptTables], clock });
    stores.push(store);
    const agent = { ctx: { services: new ServiceRegistry(), clock }, log: {} } as unknown as Agent;
    expect(
      await compactIdleSessions(agent, {
        transcript: store.plugin(transcriptTables),
        model: {} as RunModel,
        budget: null,
        signal: new AbortController().signal,
      }),
    ).toEqual([]);
  });
});
