// The hourly cap of a session: the ledger's stretches and minutes, and the one fixed line someone
// waiting is told when she is back. Fake clock throughout.

import type { Logger } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { AgentConfigSchema, HOUR_CAP_LINE } from "../../agent/src/index.js";
import { HOUR_TOKENS, HOUR_USD, PROFILES, withLimits } from "../src/profiles.js";
import { capMinutes } from "../src/run.js";
import { type HourCap, SpendLedger } from "../src/spend.js";
import { addressed, rig, SESSION, say, T0, USAGE } from "./harness.js";

const MIN = 60_000;
const CAP: HourCap = { sessionUsdPerHour: 1, sessionTokensPerHour: 2_000 };

function recordingLog(): { log: Logger; warns: [Record<string, unknown>, string | undefined][] } {
  const warns: [Record<string, unknown>, string | undefined][] = [];
  const noop = () => undefined;
  const log: Logger = {
    fatal: noop,
    error: noop,
    warn: ((fields: object | string, message?: string) => {
      if (typeof fields === "object") warns.push([fields as Record<string, unknown>, message]);
    }) as Logger["warn"],
    info: noop,
    debug: noop,
    trace: noop,
    child: () => log,
  };
  return { log, warns };
}

describe("the ledger's hourly cap", () => {
  it("the defaults of [modules.agent] are today's caps", () => {
    const config = AgentConfigSchema.parse({});
    expect(config.session_usd_per_hour).toBe(HOUR_USD);
    expect(config.session_tokens_per_hour).toBe(HOUR_TOKENS);
    expect(HOUR_USD).toBe(1);
    expect(HOUR_TOKENS).toBe(3_000_000);
    expect(PROFILES.text.limits).toMatchObject({
      sessionUsdPerHour: HOUR_USD,
      sessionTokensPerHour: HOUR_TOKENS,
    });
    const set = AgentConfigSchema.parse({ session_usd_per_hour: 2.5, session_tokens_per_hour: 0 });
    expect(set).toMatchObject({ session_usd_per_hour: 2.5, session_tokens_per_hour: 0 });
    expect(() => AgentConfigSchema.parse({ session_usd_per_hour: -1 })).toThrow();
  });

  it("0 is no cap on that basis", () => {
    const spend = new SpendLedger();
    spend.add("s", T0 - 10 * MIN, 5, USAGE);
    expect(spend.over("s", T0, { ...CAP, sessionUsdPerHour: 0 })).toBe(false);
    expect(spend.capped("s", T0, { ...CAP, sessionUsdPerHour: 0 })).toBeNull();
    // The token basis (a call without a price) has its own 0.
    spend.add("s", T0 - 5 * MIN, null, USAGE);
    expect(spend.over("s", T0, CAP)).toBe(true);
    expect(spend.over("s", T0, { ...CAP, sessionTokensPerHour: 0 })).toBe(false);
  });

  it("counts the minutes until enough of the hour has aged out", () => {
    const spend = new SpendLedger();
    spend.add("s", T0 - 50 * MIN, 0.5, USAGE);
    spend.add("s", T0 - 40 * MIN, 0.5, USAGE);
    spend.add("s", T0 - 10 * MIN, 0.5, USAGE);
    const capped = spend.capped("s", T0, CAP);
    // At +10 min 1.0 is left (still the cap); at +20 min 0.5.
    expect(capped).toMatchObject({ cap: 1, first: true, until: T0 + 20 * MIN });
    expect(capped?.spent).toMatchObject({ usd: 1.5, basis: "usd" });
    expect(capMinutes({ until: T0 + 20 * MIN }, T0)).toBe(20);
    expect(capMinutes({ until: T0 + 20 * MIN }, T0 + 30_000)).toBe(20);
  });

  it("rounds up, and never promises a time already past", () => {
    const until = T0 + 20 * MIN;
    expect(capMinutes({ until }, until - MIN)).toBe(1);
    expect(capMinutes({ until }, until - MIN - 1)).toBe(2);
    expect(capMinutes({ until }, until - 1)).toBe(1);
    expect(capMinutes({ until }, until)).toBe(1);
    expect(capMinutes({ until }, until + 5 * MIN)).toBe(1);
  });

  it("is under the cap the moment the oldest spend is an hour old", () => {
    const spend = new SpendLedger();
    spend.add("s", T0 - 59 * MIN, 1.2, USAGE);
    expect(spend.capped("s", T0, CAP)?.until).toBe(T0 + MIN);
    expect(spend.capped("s", T0 + MIN - 1, CAP)).not.toBeNull();
    expect(spend.capped("s", T0 + MIN, CAP)).toBeNull();
  });

  it("holds an hour with a call without a price to tokens, until that call ages out", () => {
    const spend = new SpendLedger();
    spend.add("s", T0 - 50 * MIN, null, USAGE);
    spend.add("s", T0 - 30 * MIN, 0.2, USAGE);
    const capped = spend.capped("s", T0, CAP);
    // 2,200 tokens against 2,000; once the unpriced call is gone, 0.2 USD is under 1.
    expect(capped).toMatchObject({ cap: 2_000, until: T0 + 10 * MIN });
    expect(capped?.spent).toMatchObject({ basis: "tokens", tokens: 2_200 });
  });

  it("marks a stretch once; under the cap and over again is a new one", () => {
    const spend = new SpendLedger();
    spend.add("s", T0 - 30 * MIN, 1.5, USAGE);
    expect(spend.capped("s", T0, CAP)?.first).toBe(true);
    expect(spend.capped("s", T0 + MIN, CAP)?.first).toBe(false);
    expect(spend.claimNotice("s")).toBe(true);
    expect(spend.claimNotice("s")).toBe(false);
    // Nobody asked while it was under; the next spend puts it over again.
    spend.add("s", T0 + 31 * MIN, 1.5, USAGE);
    expect(spend.capped("s", T0 + 32 * MIN, CAP)?.first).toBe(true);
    expect(spend.claimNotice("s")).toBe(true);
  });

  it("a notice that could not be said is given back", () => {
    const spend = new SpendLedger();
    expect(spend.claimNotice("s")).toBe(false);
    spend.add("s", T0 - 30 * MIN, 1.5, USAGE);
    spend.capped("s", T0, CAP);
    expect(spend.claimNotice("s")).toBe(true);
    spend.releaseNotice("s");
    expect(spend.claimNotice("s")).toBe(true);
  });
});

describe("a run refused for the hourly cap", () => {
  async function capped(spentAt = T0 - 30 * MIN) {
    const spend = new SpendLedger();
    spend.add(SESSION.id, spentAt, 1.5, USAGE);
    const { log, warns } = recordingLog();
    const r = await rig([say("嗨")], { runner: { compaction: null, spend }, log });
    return { r, spend, warns };
  }

  it("someone waiting is told once when she is back, with no model call", async () => {
    const { r, warns } = await capped();
    r.line("Owen", "@她 在嗎");
    const result = await r.run();
    expect(result.outcome).toBe("over_budget");
    expect(result.limits).toEqual(["spend"]);
    expect(r.model.requests).toEqual([]);
    expect(r.outlet.texts()).toEqual([HOUR_CAP_LINE(30)]);
    expect(r.outlet.lines[0]).toMatchObject({ focus: true, replyTo: { id: "m1" } });
    expect(r.outlet.texts()[0]).toBe("這一個小時話講太多了,先休息一下……大概 30 分鐘後回來。");
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: "line", via: "fixed", text: HOUR_CAP_LINE(30) }),
    );
    expect(r.transcript.tail(SESSION.id).entries.at(-1)).toMatchObject({
      kind: "self",
      content: HOUR_CAP_LINE(30),
      message_id: "out-1",
    });
    expect(warns).toEqual([
      [
        expect.objectContaining({
          session: SESSION.id,
          basis: "usd",
          spent: 1.5,
          cap: 1,
          minutes: 30,
        }),
        expect.stringContaining("hourly cap"),
      ],
    ]);

    // The next message of the stretch: nothing, and no second warning.
    r.clock.tick(5 * MIN);
    r.line("Owen", "@她 還在嗎");
    expect((await r.run(addressed("m2"))).outcome).toBe("over_budget");
    expect(r.outlet.texts()).toHaveLength(1);
    expect(warns).toHaveLength(1);
    expect(r.model.requests).toEqual([]);
  });

  it("says nothing on a turn nobody addressed; the first one addressed is told", async () => {
    const { r, warns } = await capped();
    r.line("Owen", "今天好熱");
    expect((await r.run({ kind: "glance", lines: 1 })).outcome).toBe("over_budget");
    expect(r.outlet.texts()).toEqual([]);
    expect(warns).toHaveLength(1);
    r.clock.tick(10 * MIN);
    r.line("Owen", "@她 在嗎");
    await r.run(addressed("m2"));
    expect(r.outlet.texts()).toEqual([HOUR_CAP_LINE(20)]);
    expect(warns).toHaveLength(1);
  });

  it("under the cap and over it again: told again", async () => {
    const { r, spend, warns } = await capped();
    r.line("Owen", "@她 在嗎");
    await r.run();
    r.clock.tick(30 * MIN);
    r.line("Owen", "@她 回來了嗎");
    expect((await r.run(addressed("m2"))).outcome).toBe("said");
    expect(r.outlet.texts()).toEqual([HOUR_CAP_LINE(30), "嗨"]);
    spend.add(SESSION.id, r.clock.now(), 1.5, USAGE);
    r.clock.tick(MIN);
    r.line("Owen", "@她 再聊");
    expect((await r.run(addressed("m3"))).outcome).toBe("over_budget");
    expect(r.outlet.texts().at(-1)).toBe(HOUR_CAP_LINE(59));
    expect(warns).toHaveLength(2);
  });

  it("a notice the outlet could not send is said to the next one waiting", async () => {
    const { r } = await capped();
    r.outlet.block = () => "busy";
    r.line("Owen", "@她 在嗎");
    await r.run();
    expect(r.outlet.texts()).toEqual([]);
    r.outlet.block = () => null;
    r.line("Owen", "@她 在嗎?");
    await r.run(addressed("m2"));
    expect(r.outlet.texts()).toEqual([HOUR_CAP_LINE(30)]);
  });

  it("the voice profile says it too", async () => {
    const { r } = await capped();
    r.line("Owen", "在嗎", { spoken: true });
    const result = await r.run(addressed(), { profile: PROFILES.voice });
    expect(result.outcome).toBe("over_budget");
    expect(r.outlet.texts()).toEqual([HOUR_CAP_LINE(30)]);
    expect(r.transcript.tail(SESSION.id).entries.at(-1)).toMatchObject({ spoken: true });
  });

  it("the cap the run is given counts; 0 is none", async () => {
    const { r } = await capped();
    r.line("Owen", "@她 在嗎");
    const higher = withLimits(PROFILES.text, { sessionUsdPerHour: 2 });
    expect((await r.run(addressed(), { profile: higher })).outcome).toBe("said");
    const none = withLimits(PROFILES.text, { sessionUsdPerHour: 0, sessionTokensPerHour: 0 });
    r.line("Owen", "@她 再一次");
    expect((await r.run(addressed("m2"), { profile: none })).outcome).toBe("said");
    expect(r.outlet.texts()).toEqual(["嗨", "嗨"]);
  });
});
