// Before the runner compacts a transcript, her memory is asked to read the lines up to the cut
// (`SegmentFlushKey`), and the compaction does not wait on it for longer than it answers.

import { type SegmentFlush, SegmentFlushKey, type SegmentFlushOutcome } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { dm, line, Rig, says, stopRigs, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const DM = dm("dm-owen");

describe("compaction and her memory", () => {
  it("asks the segment pass for the lines up to the cut before it summarises them", async () => {
    const asked: Array<[string, number]> = [];
    const flush: SegmentFlush = {
      async beforeCompaction(session, upto): Promise<SegmentFlushOutcome> {
        asked.push([session, upto]);
        return "done";
      },
    };
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", SegmentFlushKey, flush),
      host: { runner: { compaction: { thresholdTokens: 10, keepTokens: 5 } } },
    });
    rig.model.push(says("嗨 Owen,今天過得怎麼樣"));
    rig.say(line(DM, "owen", "在嗎,我今天去吃了拉麵,好好吃,想跟你說說"));
    await until(() => asked.length > 0, 3_000, "the segment pass asked");
    const session = rig.host?.sessionOf(DM);
    expect(asked[0]?.[0]).toBe(session);
    expect(asked[0]?.[1]).toBeGreaterThanOrEqual(1);
  });
});
