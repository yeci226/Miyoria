// Prints the offline simulation's tables (docs/design/exchange.md §9) as Markdown:
//
//     pnpm exec tsx --conditions=@miyoria/source exchange/test/sim-report.ts [runs] [weeks]
//
// from `packages/play`. The same engine and defaults the module runs; nothing is written anywhere.

import { params } from "../src/engine/params.js";
import { type Summary, simulate, stressParams } from "../src/sim/summary.js";

const runs = Number(process.argv[2] ?? 40);
const weeks = Number(process.argv[3] ?? 12);
console.log("## 一般的市場\n");
report(simulate(runs, weeks, "report"));
console.log("\n## 壓力測試(波動放大)\n");
report(simulate(runs, weeks, "stress", stressParams(params())));

function report(s: Summary): void {
  const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
  const yes = (b: boolean) => (b ? "過" : "沒過");

  const lines: string[] = [];
  lines.push(`${s.runs} 次 × ${s.weeks} 週,共 ${s.rounds} 盤。`, "");
  lines.push("| 條件 | 結果 | 數字 |", "|---|---|---|");
  lines.push(`| 金庫從不為負 | ${yes(s.pass.vault_never_negative)} | 最低 ${s.min_vault} |`);
  lines.push(`| 沒有人低於零 | ${yes(s.pass.nobody_below_zero)} | 錢包最低 ${s.min_wallet} |`);
  lines.push(
    `| 每一盤帳都對得上(進 = 出 + 燒 + 金庫 + 掛單) | ${yes(s.pass.books_balance)} | 最大差 ${s.max_books_gap} |`,
  );
  lines.push(
    `| 水位在 0.8 到 1.2 的時間至少九成 | ${yes(s.pass.level_in_band_90)} | ${pct(s.level_in_band)}(${s.level_rounds} 盤有水位;最低 ${s.level_min.toFixed(2)}、中位數 ${s.level_median.toFixed(2)}、最高 ${s.level_max.toFixed(2)}) |`,
  );
  lines.push(
    `| 沒有一種簡單策略扣掉手續費後穩定賺 | ${yes(s.pass.no_strategy_reliably_profitable)} | 見下表 |`,
  );
  lines.push(
    `| 槓桿部位賠的從不超過保證金 | ${yes(s.pass.leverage_never_past_margin)} | 退回低於零 ${s.leverage.paid_below_zero} 次;強制賣出時保證金剩下最少 ${s.leverage.min_ratio_at_liquidation === null ? "—" : pct(s.leverage.min_ratio_at_liquidation)} |`,
  );
  lines.push(
    `| 強制賣出之前一定先警告過 | ${yes(s.pass.warning_before_liquidation)} | ${s.leverage.warned_first} / ${s.leverage.liquidated} |`,
  );
  lines.push("");
  lines.push(
    "| 策略 | 人次 | 平均報酬 | 中位數 | 賺錢的比例 | 每次平均的 95% 下界 | 穩定賺? |",
    "|---|---|---|---|---|---|---|",
  );
  for (const r of s.strategies) {
    lines.push(
      `| ${r.label} | ${r.people} | ${pct(r.mean)} | ${pct(r.median)} | ${pct(r.profitable, 0)} | ${pct(r.low)} | ${r.reliably_profitable ? "是" : "否"} |`,
    );
  }
  lines.push("");
  lines.push("| 其他 | 數字 |", "|---|---|");
  lines.push(`| 每週成交金額(每次模擬) | ${Math.round(s.volume_per_week)} |`);
  lines.push(`| 每週燒掉(每次模擬) | ${Math.round(s.burned_per_week)} |`);
  lines.push(`| 燒掉的 ÷ 成交金額 | ${pct(s.burned_share_of_volume, 2)} |`);
  lines.push(`| 大盤的單日波動(標準差) | ${pct(s.fish_daily_sd, 2)} |`);
  lines.push(`| 個股的單日波動(標準差) | ${pct(s.company_daily_sd, 2)} |`);
  lines.push(`| 熔斷(每次模擬) | ${s.breakers_per_run.toFixed(2)} |`);
  lines.push(`| 槓桿部位 / 被強制賣出 | ${s.leverage.positions} / ${s.leverage.liquidated} |`);
  lines.push(`| 槓桿部位平均拿回(÷ 保證金) | ${pct(s.leverage.mean_paid_over_margin)} |`);
  if (s.violations.length > 0) lines.push("", "違規:", ...s.violations.map((v) => `- ${v}`));
  console.log(lines.join("\n"));
}
