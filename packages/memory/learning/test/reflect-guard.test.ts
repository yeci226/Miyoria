// The daily reflection under the text runner's accounting (`ReflectGuard`), or as it is.

import type { ReflectGuard, ReflectionRun } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { reflectUnder } from "../src/index.js";

const RUN = { id: "r1", kind: "daily" } as unknown as ReflectionRun;

describe("reflectUnder", () => {
  it("runs the reflection as it is when no guard is provided", async () => {
    const out = await reflectUnder(undefined, async () => RUN, new AbortController().signal);
    expect(out).toEqual({ run: RUN, skipped: null });
  });

  it("runs it through the guard when there is one", async () => {
    let through = 0;
    const guard: ReflectGuard = {
      run: async (run, signal) => {
        through += 1;
        return { ran: true, result: await run(signal ?? new AbortController().signal), why: null };
      },
    };
    const out = await reflectUnder(guard, async () => RUN, new AbortController().signal);
    expect(through).toBe(1);
    expect(out).toEqual({ run: RUN, skipped: null });
  });

  it("runs nothing, and says why, when the guard lets nothing run", async () => {
    let ran = 0;
    const guard: ReflectGuard = {
      run: async () => ({ ran: false, result: null, why: "今晚反思能花的額度用完了" }),
    };
    const out = await reflectUnder(
      guard,
      async () => {
        ran += 1;
        return RUN;
      },
      new AbortController().signal,
    );
    expect(ran).toBe(0);
    expect(out).toEqual({ run: null, skipped: "今晚反思能花的額度用完了" });
  });
});
