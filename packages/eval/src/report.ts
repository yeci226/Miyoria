import type { Scorecard } from "./runner.js";

const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - [...s].length));

export function formatScorecard(card: Scorecard): string {
  const width = Math.max(...card.results.map((r) => r.id.length), 8);
  const lines: string[] = [];
  lines.push(`eval: ${card.results.length} fixtures, pass^${card.k}${card.live ? ", live" : ""}`);
  lines.push("");
  for (const r of card.results) {
    const ran =
      r.passK === null ? "-" : `${r.attempts.filter((a) => a.ok).length}/${r.attempts.length}`;
    lines.push(
      `${pad(r.verdict, 6)} ${pad(r.id, width)}  ${pad(r.harness, 6)} runs ${pad(ran, 4)} ${r.note}`.trimEnd(),
    );
  }
  lines.push("");
  const t = card.totals;
  lines.push(
    `pass ${t.pass}  xfail ${t.xfail}  FAIL ${t.FAIL}  XPASS ${t.XPASS}  BROKEN ${t.BROKEN}`,
  );
  lines.push(
    `pass^${card.k} on code that can run: ${card.passingK}/${card.runnable}` +
      `  (incidents caught by their checks: ${card.results.filter((r) => r.caught.length > 0).length}/${card.results.length})`,
  );
  if (card.live) {
    lines.push("live: no harness calls a model yet, every run above used the recorded behaviour");
  }
  lines.push(card.ok ? "suite: green" : "suite: RED (FAIL, XPASS or BROKEN above)");
  return lines.join("\n");
}
