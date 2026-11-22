import { describe, expect, it } from "vitest";
import { params } from "../src/engine/params.js";
import { runSim } from "../src/sim/run.js";
import { simulate, stressParams } from "../src/sim/summary.js";

// The offline simulation's pass criteria (docs/design/exchange.md §9), on fewer runs than the
// report in the doc (`test/sim-report.ts`) so the suite stays quick.

describe("the offline simulation", () => {
  it("is the same run from the same seed", () => {
    const a = runSim({ seed: "same", weeks: 2 });
    const b = runSim({ seed: "same", weeks: 2 });
    expect(a.people).toEqual(b.people);
    expect(a.levels).toEqual(b.levels);
  });

  it("passes every criterion in the market that runs", () => {
    const s = simulate(6, 8, "suite");
    expect(s.violations).toEqual([]);
    expect(s.pass).toEqual({
      vault_never_negative: true,
      nobody_below_zero: true,
      books_balance: true,
      level_in_band_90: true,
      no_strategy_reliably_profitable: true,
      leverage_never_past_margin: true,
      warning_before_liquidation: true,
      no_violations: true,
    });
  });

  it("keeps the vault, the wallets, the books and leverage safe in a much rougher market", () => {
    const s = simulate(6, 8, "suite-stress", stressParams(params()));
    expect(s.violations).toEqual([]);
    expect(s.pass.vault_never_negative).toBe(true);
    expect(s.pass.nobody_below_zero).toBe(true);
    expect(s.pass.books_balance).toBe(true);
    expect(s.pass.leverage_never_past_margin).toBe(true);
    expect(s.pass.warning_before_liquidation).toBe(true);
    expect(s.leverage.liquidated).toBeGreaterThan(0);
  });
});
