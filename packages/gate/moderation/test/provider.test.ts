import type { ModerationProvider } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { make } from "./helpers.js";

function provider(
  id: string,
  check: ModerationProvider["check"],
): ModerationProvider & { seen: string[] } {
  const seen: string[] = [];
  return {
    id,
    seen,
    check: (input, signal) => {
      seen.push(input.text);
      return check(input, signal);
    },
  };
}

const never: ModerationProvider["check"] = (_i, signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

describe("providers", () => {
  it("can tighten: a flagged line is blocked and logged as a provider block", async () => {
    const { moderation, blocks } = make();
    moderation.addProvider(provider("hosted", async () => ({ flagged: true, category: "hate" })));
    const v = await moderation.screenAsync({ path: "reply", visible: "a harmless line" });
    expect(v.ok).toBe(false);
    expect(v.visible).toBe("Filtered.");
    expect(v.blocked).toEqual([
      { field: "visible", category: "hate", rule: "hosted:hate", layer: "provider" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).not.toContain("harmless");
  });

  it("an unknown category from a provider is recorded as custom", async () => {
    const { moderation } = make();
    moderation.addProvider(
      provider("hosted", async () => ({ flagged: true, category: "weird" as never })),
    );
    const v = await moderation.screenAsync({ path: "reply", voice: "x" });
    expect(v.blocked[0]?.category).toBe("custom");
  });

  it("cannot loosen: 'not flagged' leaves a local block in place", async () => {
    const { moderation } = make();
    const clean = provider("hosted", async () => ({ flagged: false }));
    moderation.addProvider(clean);
    const v = await moderation.screenAsync({ path: "reply", visible: "n i g g e r" });
    expect(v.ok).toBe(false);
    expect(v.visible).toBe("Filtered.");
    expect(v.blocked.map((b) => b.layer)).toEqual(["rules"]);
  });

  it("cannot loosen: odd answers (extra fields, truthy values) do nothing", async () => {
    const { moderation } = make();
    moderation.addProvider(
      provider("hosted", (async () => ({ flagged: "yes", allow: true, override: true })) as never),
    );
    const v = await moderation.screenAsync({ path: "reply", visible: "n i g g e r" });
    expect(v.ok).toBe(false);
    const clean = await moderation.screenAsync({ path: "reply", visible: "a clean line" });
    expect(clean.ok).toBe(true);
  });

  it("only sees what the local rules passed", async () => {
    const { moderation } = make();
    const p = provider("hosted", async () => ({ flagged: false }));
    moderation.addProvider(p);
    moderation.protect("abcd1234efgh5678");
    await moderation.screenAsync({
      path: "reply",
      visible: "the key is abcd1234efgh5678",
      voice: "fine voice line",
    });
    expect(p.seen).toEqual(["fine voice line"]);
  });

  it("checks the visible and the voice text separately", async () => {
    const { moderation } = make();
    moderation.addProvider(
      provider("hosted", async ({ text }) => ({ flagged: text.includes("bad") })),
    );
    const v = await moderation.screenAsync({
      path: "reply",
      visible: "good text",
      voice: "bad voice",
    });
    expect(v.visible).toBe("good text");
    expect(v.voice).toBe("Filtered.");
  });

  it("a timeout falls back to the local verdict and aborts the provider", async () => {
    const { moderation, failures } = make({ provider_timeout_ms: 30 });
    let aborted = false;
    moderation.addProvider(
      provider("slow", (input, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return never(input, signal);
      }),
    );
    const started = performance.now();
    const v = await moderation.screenAsync({ path: "reply", visible: "a clean line" });
    const took = performance.now() - started;
    expect(v.ok).toBe(true);
    expect(v.visible).toBe("a clean line");
    expect(took).toBeLessThan(500);
    expect(aborted).toBe(true);
    expect(failures[0]?.provider).toBe("slow");
    expect(failures[0]?.reason).toContain("timed out");
  });

  it("a timeout never loosens a local block either", async () => {
    const { moderation } = make({ provider_timeout_ms: 20 });
    moderation.addProvider(provider("slow", never));
    const v = await moderation.screenAsync({ path: "reply", visible: "kys" });
    expect(v.ok).toBe(false);
    expect(v.visible).toBe("Filtered.");
  });

  it("provider_on_failure = block blocks on a timeout and on an error", async () => {
    const { moderation } = make({ provider_timeout_ms: 20, provider_on_failure: "block" });
    const off = moderation.addProvider(provider("slow", never));
    const timedOut = await moderation.screenAsync({ path: "reply", visible: "a clean line" });
    expect(timedOut.blocked[0]).toMatchObject({ rule: "slow:unavailable", layer: "provider" });
    off();
    moderation.addProvider(
      provider("broken", async () => {
        throw new Error("boom");
      }),
    );
    const failed = await moderation.screenAsync({ path: "reply", voice: "a clean line" });
    expect(failed.voice).toBe("Filtered.");
  });

  it("a provider that throws or answers late does not fail the call or leak a rejection", async () => {
    const { moderation } = make({ provider_timeout_ms: 20 });
    moderation.addProvider(
      provider(
        "late",
        (_i, _s) => new Promise((_r, reject) => setTimeout(() => reject(new Error("late")), 60)),
      ),
    );
    moderation.addProvider(
      provider("sync", () => {
        throw new Error("sync boom");
      }),
    );
    const v = await moderation.screenAsync({ path: "reply", visible: "a clean line" });
    expect(v.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
  });

  it("the caller's abort counts as a provider failure, not as a pass for blocked text", async () => {
    const { moderation } = make({ provider_on_failure: "block" });
    moderation.addProvider(provider("slow", never));
    const control = new AbortController();
    control.abort(new Error("cancelled"));
    const v = await moderation.screenAsync({ path: "reply", visible: "fine" }, control.signal);
    expect(v.ok).toBe(false);
  });

  it("with no provider screenAsync equals screen", async () => {
    const { moderation } = make();
    const check = { path: "reply", visible: "kys", voice: "hello" } as const;
    expect(await moderation.screenAsync(check)).toEqual(moderation.screen(check));
  });

  it("a removed provider is no longer asked", async () => {
    const { moderation } = make();
    const p = provider("hosted", async () => ({ flagged: true }));
    const off = moderation.addProvider(p);
    off();
    const v = await moderation.screenAsync({ path: "reply", visible: "fine" });
    expect(v.ok).toBe(true);
    expect(p.seen).toEqual([]);
  });
});
