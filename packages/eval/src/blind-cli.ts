// `pnpm --filter @miyoria/eval blind --old DIR --new DIR [--config FILE] [--out DIR] [--runs N]
// [--seed S] [--only 1,5,9]`: the persona blind test (docs/design/persona-v4.md §6). Writes
//   blind-sheet.md      what the owner reads: situations with answers A and B
//   blind-choices.txt   the form the owner fills in (`3: A`)
//   blind-key.json      which version was A where, every answer, and the counters (do not open early)
// and `--tally KEY CHOICES` reveals the result. Without a configured provider it says so and exits 0.
//
// Paths are taken from where the command was typed (`INIT_CWD`, which pnpm sets).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Profile } from "@miyoria/profile";
import {
  type BlindKey,
  buildChoicesTemplate,
  buildKey,
  buildSheet,
  formatCounters,
  parseChoices,
  runBlind,
  tally,
} from "./persona/blind.js";
import { DEFAULT_SETTINGS, setupModel } from "./persona/model.js";
import { SITUATIONS } from "./persona/situations.js";

const base = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2);

function opt(name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    [
      "usage: blind --old PROFILE_DIR --new PROFILE_DIR [--config miyoria.toml] [--out DIR]",
      "             [--runs N] [--seed TEXT] [--only 1,5,9]",
      "       blind --tally blind-key.json blind-choices.txt",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const tallyAt = args.indexOf("--tally");
if (tallyAt >= 0) {
  const keyPath = args[tallyAt + 1];
  const choicesPath = args[tallyAt + 2];
  if (!keyPath || !choicesPath) usage();
  const key = JSON.parse(readFileSync(resolve(base, keyPath), "utf8")) as BlindKey;
  const result = tally(key, parseChoices(readFileSync(resolve(base, choicesPath), "utf8")));
  const verdict = {
    keep: "新版 13 題以上:留下",
    revise: "新版 10 題以下:回頭改",
    look: "中間:看輸在哪一類",
    incomplete: "還有題目沒選",
  }[result.verdict];
  process.stdout.write(
    [
      `新版 ${result.new}、舊版 ${result.old}、都不像 ${result.none}(已選 ${result.answered} / ${Object.keys(key.a).length})`,
      `新版沒贏的題號:${result.lost.join(", ") || "無"}`,
      verdict,
      "",
      formatCounters(key.counters),
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const oldDir = opt("old");
const newDir = opt("new");
if (!oldDir || !newDir) usage();
const runs = Number(opt("runs") ?? 1);
if (!Number.isInteger(runs) || runs < 1 || runs > 5) usage();
const only = opt("only")?.split(",").map(Number);
const situations = SITUATIONS.filter((s) => only === undefined || only.includes(s.id));
if (situations.length === 0) usage();

const oldProfile = await Profile.loadDir(resolve(base, oldDir));
const newProfile = await Profile.loadDir(resolve(base, newDir));
const setup = await setupModel(resolve(base, opt("config") ?? "miyoria.toml"), newProfile);
if (setup.kind === "none") {
  process.stdout.write(
    `盲測沒有跑:${setup.reason}。要先在 miyoria.toml 設好模型(見 miyoria.example.toml)。\n`,
  );
  process.exit(0);
}

const seed = opt("seed") ?? new Date().toISOString();
process.stdout.write(
  `${situations.length} 題 × 新舊各 ${runs} 次,模型 ${setup.chain}(${DEFAULT_SETTINGS.purpose},溫度 ${DEFAULT_SETTINGS.temperature})\n`,
);
const run = await runBlind({
  situations,
  prompts: { old: oldProfile.personaPrompt(), new: newProfile.personaPrompt() },
  complete: setup.complete,
  runs,
  seed,
});

const out = resolve(
  base,
  opt("out") ?? join("data", "blind-test", seed.replace(/[^0-9A-Za-z]+/g, "-")),
);
if (existsSync(join(out, "blind-key.json"))) {
  process.stderr.write(`${out} 已經有一次結果,換個 --out\n`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "blind-sheet.md"), buildSheet(situations, run));
writeFileSync(join(out, "blind-choices.txt"), buildChoicesTemplate(situations));
const key = buildKey(run);
writeFileSync(join(out, "blind-key.json"), `${JSON.stringify(key, null, 2)}\n`);

const failed = key.answers.filter((a) => a.error !== undefined).length;
process.stdout.write(
  `${out}\n  給 owner:blind-sheet.md、blind-choices.txt\n  先別看:blind-key.json${failed > 0 ? `\n  ${failed} 次呼叫失敗,見 key 的 error 欄` : ""}\n  揭曉:pnpm --filter @miyoria/eval blind --tally ${join(out, "blind-key.json")} ${join(out, "blind-choices.txt")}\n`,
);
