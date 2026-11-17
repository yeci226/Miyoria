// The GPU lease shapes: what a minimal request becomes, what each answer looks like, what is refused.

import { describe, expect, it } from "vitest";
import {
  HostClusterContextSchema,
  HostGpuAcquireResultSchema,
  HostGpuAcquireSchema,
  HostGpuReleaseSchema,
  HostGpuRenewResultSchema,
  HostGpuRenewSchema,
} from "../src/index.js";

describe("gpu.* shapes", () => {
  it("fills a minimal acquire with the defaults a holder that knows nothing yet would send", () => {
    expect(HostGpuAcquireSchema.parse({ job: "a1", stage: "convert" })).toEqual({
      job: "a1",
      stage: "convert",
      mode: "exclusive",
      max_s: 60,
      reason: "",
      on_gpu: true,
      pauses: true,
      need_mb: {},
      own_mb: 0,
      est_work_s: null,
      est_work_by_card: {},
      cpu_fallback: false,
      queued: [],
      ack: false,
      resumed: false,
      announced: false,
    });
  });

  it("keeps learned values per card", () => {
    const p = HostGpuAcquireSchema.parse({
      job: "a1",
      stage: "lead",
      need_mb: { "RTX 4070 SUPER/12282": 2300 },
    });
    expect(p.need_mb).toEqual({ "RTX 4070 SUPER/12282": 2300 });
    expect(
      HostGpuAcquireSchema.safeParse({ job: "a1", stage: "lead", need_mb: 2300 }).success,
    ).toBe(false);
  });

  it("tells the four answers apart by `type`", () => {
    const wait = {
      type: "wait",
      code: "no_room",
      reason: "…",
      announce: true,
      evict: ["http://127.0.0.1:8002"],
    };
    expect(HostGpuAcquireResultSchema.parse(wait)).toEqual(wait);
    expect(
      HostGpuAcquireResultSchema.parse({ type: "cpu", code: "no_room_cpu", reason: "…" }).type,
    ).toBe("cpu");
    expect(
      HostGpuAcquireResultSchema.parse({ type: "refused", code: "no_room", reason: "…" }).type,
    ).toBe("refused");
    expect(
      HostGpuAcquireResultSchema.safeParse({ type: "evicted", code: "x", reason: "" }).success,
    ).toBe(false);
  });

  it("renews with a step, an end, or nothing", () => {
    expect(HostGpuRenewSchema.parse({ lease: "a1" })).toEqual({
      lease: "a1",
      own_mb: 0,
      queued: [],
      step: null,
      end: null,
    });
    const step = HostGpuRenewSchema.parse({ lease: "a1", step: { recent_s: [0.1, 0.1, 0.1] } });
    expect(step.step).toEqual({ recent_s: [0.1, 0.1, 0.1], normal_s: {} });
    expect(
      HostGpuRenewSchema.safeParse({ lease: "a1", step: { recent_s: [1, 1, 1, 1] } }).success,
    ).toBe(false);
    expect(HostGpuRenewSchema.parse({ lease: "a1", end: { how: "oom" } }).end).toEqual({
      how: "oom",
      step_s: null,
      normal_s: {},
    });
    const action = { type: "reduce", code: "spill_reduce", reason: "…", steps: 20 };
    expect(
      HostGpuRenewResultSchema.parse({
        ok: true,
        action,
        clear_steps: true,
        learned: null,
        evict: [],
      }).action,
    ).toEqual(action);
  });

  it("releases by closing the window unless asked to keep it", () => {
    expect(HostGpuReleaseSchema.parse({ lease: "a1" })).toEqual({
      lease: "a1",
      window: "close",
      done: false,
    });
  });

  it("takes Core's context with the defaults of the song worker's old /gpu/context", () => {
    expect(HostClusterContextSchema.parse({})).toEqual({
      in_voice: false,
      listeners: 0,
      live: false,
      urgent: [],
    });
    expect(HostClusterContextSchema.safeParse({ listeners: -1 }).success).toBe(false);
  });
});
