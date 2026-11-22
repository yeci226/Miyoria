// `miyoria db`: the cut-over tools (docs/design/v5-data.md §7, §8 step 12), offline, printing what
// the store's functions did: `import-links` (who people are, from the V4 database), `archive`
// (moves a stopped V4 database aside with a single-file copy and hashes) and `doctor` (what a
// database file is, read-only).

import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { databaseUrl, profileId } from "@miyoria/core/light";
import { type Config, configureLogging } from "@miyoria/runtime/kernel";
import type {
  ArchiveOptions,
  ArchiveResult,
  CutoverErrorCode,
  DoctorReport,
  LinkFileImportResult,
  LinkImportCounts,
  PlannedPerson,
} from "@miyoria/store";
import type { Prompter } from "../prompt.js";
import { bold, dim, fail, note, ok, println, section, warn } from "../ui.js";
import { loadConfig } from "./node.js";

export class DbCommandError extends Error {
  override readonly name = "DbCommandError";
}

/** What `archive` asks a person to type before it moves the database. */
export const ARCHIVE_WORD = "archive";

/** How many of each kind the import lists before the counts. */
const SAMPLE = 5;

const REASONS: Record<CutoverErrorCode, string> = {
  missing: "找不到檔案",
  not_database: "不是 SQLite 資料庫",
  not_v4: "不是 V4 的資料庫",
  not_v5: "要寫入的不是 V5 的資料庫",
  profile: "分不出羈絆和卡片是哪個角色的(看 `core.profile`)",
  conflict:
    "有帳號在新的資料庫裡已經屬於別人:要在 V5 跟任何人說話之前匯入,請換一個新的資料庫檔再跑一次",
  held: "資料庫還開著:先停掉 core(`miyoria down` 或關掉前景的 core),也關掉開著這個檔案的其他程式",
  archive_state: "封存資料夾的狀態和上次的計畫對不上",
  same_file: "舊的和新的資料庫是同一個檔案",
};

/** The store, loaded only by these commands (`node:sqlite` and Drizzle stay out of the others). */
const loadStore = () => import("@miyoria/store");

/** Rethrows a store refusal in the CLI's words (the store's English detail after them). */
/**
 * These commands print a report; the store's own log lines (each migration it applies) would land
 * in the middle of it. Warnings and errors still show; `MIYORIA_LOG_LEVEL` overrides.
 */
function quietLogs(): void {
  if (!process.env.MIYORIA_LOG_LEVEL) configureLogging({ level: "warn" });
}

async function explained(error: unknown): Promise<never> {
  const { CutoverError } = await loadStore();
  if (error instanceof CutoverError) {
    throw new DbCommandError(`${REASONS[error.code]}\n  ${dim(error.message)}`);
  }
  throw error;
}

/** A path as a person would type it here: relative when it is under the working directory. */
function shown(path: string): string {
  const rel = relative(process.cwd(), path);
  const text = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
  const slashed = sep === "\\" ? text.replaceAll("\\", "/") : text;
  return /[\s"']/.test(slashed) ? `"${slashed}"` : slashed;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The database file `core.database_url` names, absolute. */
export async function configuredDatabase(config: Config, configPath: string): Promise<string> {
  const { parseStoreUrl } = await loadStore();
  let path: string;
  try {
    path = parseStoreUrl(databaseUrl(config)).path;
  } catch (error) {
    throw new DbCommandError(
      `\`core.database_url\` 不是 SQLite 檔案:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (path === ":memory:") {
    throw new DbCommandError("`core.database_url` 是記憶體資料庫,沒有檔案可以處理");
  }
  return isAbsolute(path) ? path : resolve(dirname(configPath), path);
}

const configFlag = (configPath: string) =>
  configPath === "miyoria.toml" ? "" : ` -c ${shown(resolve(configPath))}`;

function countLines(c: LinkImportCounts): string[] {
  const made = c.choice_persons > 0 ? `(另有 ${c.choice_persons} 人只為了保存選擇而建立)` : "";
  return [
    `人 ${c.persons}${made}、帳號 ${c.accounts}`,
    `handle:沿用 ${c.handles_kept}、改名 ${c.handles_renamed}、新取 ${c.handles_made}`,
    `選擇:隱私 ${c.privacy}、語音同意 ${c.voice_consent}`,
    `紀念卡資料:有舊羈絆的 ${c.with_tier} 人、舊卡 ${c.cards} 張`,
    `略過:已經匯入 ${c.skipped_existing}、沒有帳號 ${c.skipped_no_accounts}、` +
      `找不到人的帳號 ${c.orphan_accounts}、沒人用的 handle ${c.handles_left}`,
  ];
}

function personLine(p: PlannedPerson): string {
  const parts = [bold(p.handle)];
  if (p.name !== p.handle) parts.push(dim(`(${p.name})`));
  parts.push(`帳號 ${p.accounts.map((a) => `${a.platform}:${a.external_id}`).join("、")}`);
  const prefs = [
    p.prefs.privacy !== undefined ? "隱私" : null,
    p.prefs.voice_consent !== undefined ? "語音同意" : null,
  ].filter((x) => x !== null);
  if (prefs.length > 0) parts.push(`選擇:${prefs.join("、")}`);
  if (p.legacy === null) parts.push(dim("只為了保存選擇而建立"));
  else parts.push(`羈絆 ${p.legacy.old_tier ?? "無"}、卡 ${p.legacy.cards} 張`);
  if (p.old_handle !== null && p.old_handle !== p.handle) {
    parts.push(dim(`V4 叫 ${p.old_handle}`));
  }
  return `  ${parts.join("  ")}`;
}

function list<T>(items: readonly T[], line: (item: T) => string): void {
  for (const item of items.slice(0, SAMPLE)) println(line(item));
  if (items.length > SAMPLE) println(dim(`  …還有 ${items.length - SAMPLE} 筆`));
}

// ---- import-links ---------------------------------------------------------------------------

export interface ImportLinksCommandOptions {
  from: string | undefined;
  dryRun: boolean;
}

/** `miyoria db import-links --from <file> [--dry-run]`. */
export async function importLinksCommand(
  configPath: string,
  options: ImportLinksCommandOptions,
): Promise<void> {
  quietLogs();
  if (options.from === undefined || options.from === "") {
    throw new DbCommandError("需要 --from <FILE>:V4 的資料庫(通常是 db archive 做的 .single.db)");
  }
  const config = await loadConfig(configPath);
  const from = resolve(options.from);
  const target = await configuredDatabase(config, configPath);
  if (basename(target).toLowerCase() === "miyoria.db") {
    throw new DbCommandError(
      `\`core.database_url\` 還指向 ${shown(target)}:新的資料庫要用新的檔名,舊版才不會打開它。` +
        `先執行 \`miyoria config set core.database_url sqlite:data/core.db\`${configFlag(configPath)}`,
    );
  }
  const profile = profileId(config);

  section(options.dryRun ? "從 V4 匯入身分(試跑)" : "從 V4 匯入身分");
  note(`舊的資料庫:${shown(from)}(只讀,不會改到它)`);
  note(`新的資料庫:${shown(target)}${existsSync(target) ? "" : "(還不存在,會建立)"}`);
  note(`角色:${profile}`);

  const { importLinksFromFile, linkImportCounts } = await loadStore();
  let result: LinkFileImportResult;
  try {
    result = importLinksFromFile(from, target, { dryRun: options.dryRun, profile });
  } catch (error) {
    return await explained(error);
  }

  const counts = linkImportCounts(result);
  section(options.dryRun ? "會匯入的人" : "匯入的人");
  if (result.persons.length === 0) note("沒有要匯入的人");
  list(result.persons, personLine);
  const renamed = result.persons.filter((p) => p.old_handle !== null && p.old_handle !== p.handle);
  if (renamed.length > 0) {
    section("handle 只差大小寫,改了名字");
    list(renamed, (p) => `  ${p.old_handle} → ${bold(p.handle)}`);
  }
  if (result.prefs_added.length > 0) {
    section("加到新資料庫裡已經有的人的選擇");
    list(result.prefs_added, (p) => `  ${p.account.platform}:${p.account.id}  ${p.pref}`);
  }
  const odd = [
    ...result.skipped.no_accounts.map((p) => `沒有帳號的人 ${p.name}(${p.id})`),
    ...result.skipped.orphan_accounts.map(
      (a) => `找不到人的帳號 ${a.platform}:${a.external_id}(人 ${a.person_id})`,
    ),
    ...result.skipped.unreadable.map((key) => `讀不懂的設定 ${key}`),
  ];
  if (odd.length > 0) {
    section("略過的舊資料");
    list(odd, (line) => `  ${line}`);
  }
  if (result.conflicts.length > 0) {
    section("已經屬於別人的帳號");
    list(
      result.conflicts,
      (c) => `  ${c.platform}:${c.external_id}  V4 的 ${c.name},新資料庫裡是 ${c.owner}`,
    );
    fail(REASONS.conflict);
  }

  section("數量");
  for (const line of countLines(counts)) println(`  ${line}`);
  if (options.dryRun) {
    ok("試跑完成,沒有寫入任何東西");
  } else {
    ok(
      `匯入完成:${counts.persons + counts.choice_persons} 人、${counts.accounts} 個帳號,` +
        `${counts.events} 筆 identity.imported 事件${result.created ? `,建立了 ${shown(target)}` : ""}`,
    );
  }
}

// ---- archive ----------------------------------------------------------------------------------

export interface ArchiveCommandOptions {
  file: string | undefined;
  dryRun: boolean;
  yes: boolean;
  /** Replaces the store's seams in tests. */
  store?: Pick<ArchiveOptions, "clock" | "held">;
}

function printArchive(result: ArchiveResult): void {
  note(`封存到:${shown(result.dir)}`);
  for (const f of result.files) {
    const where = f.moved ? dim("(之前已經搬過)") : "";
    println(`  ${shown(f.from)} → ${basename(f.to)}  ${dim(bytes(f.size))}${where}`);
  }
  println(`  單一檔案複本 → ${basename(result.single.path)}`);
  println(`  雜湊 → ${basename(result.manifest)}`);
}

function printNext(result: ArchiveResult, configPath: string): void {
  const data = dirname(result.files.find((f) => f.from.endsWith(".db"))?.from ?? result.dir);
  const fresh = join(data, "core.db");
  const url = relative(dirname(resolve(configPath)), fresh).replaceAll("\\", "/");
  const c = configFlag(configPath);
  const single = shown(result.single.path);
  section("接下來");
  for (const command of [
    `miyoria config set core.database_url sqlite:${url}${c}`,
    `miyoria db import-links --from ${single} --dry-run${c}`,
    `miyoria db import-links --from ${single}${c}`,
    `miyoria db doctor ${shown(fresh)}${c}`,
    `miyoria core${c}`,
  ]) {
    println(`  ${command}`);
  }
  println(dim("  要退回 V4:停掉 V5,把封存的三個檔案改名回原來的名字。"));
}

/** `miyoria db archive [file] [--dry-run]`. */
export async function archiveCommand(
  configPath: string,
  options: ArchiveCommandOptions,
  prompter: Prompter | null,
): Promise<void> {
  quietLogs();
  const path =
    options.file !== undefined
      ? resolve(options.file)
      : await configuredDatabase(await loadConfig(configPath), configPath);
  const { archiveDatabase } = await loadStore();
  const seams = options.store ?? {};
  section(options.dryRun ? "封存 V4 的資料庫(試跑)" : "封存 V4 的資料庫");
  note(`資料庫:${shown(path)}`);

  let plan: ArchiveResult;
  try {
    plan = await archiveDatabase({ path, ...seams, dryRun: true });
  } catch (error) {
    return await explained(error);
  }
  if (plan.state === "already") {
    printArchive(plan);
    ok(`已經封存過了(${plan.date}),沒有要做的事`);
    printNext(plan, configPath);
    return;
  }
  if (plan.resumed) warn("上次的封存沒做完,這次接著做");
  printArchive(plan);
  if (options.dryRun) {
    ok("試跑完成:檔案都沒有被開著,沒有搬動任何東西");
    return;
  }
  if (!options.yes) {
    if (prompter === null) throw new DbCommandError("非互動環境請加上 --yes");
    const typed = await prompter.text(`會把上面的檔案搬走。輸入 ${ARCHIVE_WORD} 確認`, "");
    if (typed.trim() !== ARCHIVE_WORD) {
      println("已取消,沒有搬動任何檔案。");
      return;
    }
  }

  let result: ArchiveResult;
  try {
    result = await archiveDatabase({ path, ...seams });
  } catch (error) {
    return await explained(error);
  }
  for (const f of result.files) {
    if (f.sha256 !== null) ok(`${basename(f.to)}  ${dim(`sha256 ${f.sha256.slice(0, 16)}…`)}`);
    else ok(`${basename(f.to)}  ${dim("(索引檔,不記雜湊)")}`);
  }
  ok(
    `${basename(result.single.path)}  ${dim(`sha256 ${result.single.sha256?.slice(0, 16) ?? "?"}…`)}`,
  );
  ok(`雜湊寫在 ${shown(result.manifest)};沒有刪除任何檔案`);
  printNext(result, configPath);
}

// ---- doctor -------------------------------------------------------------------------------------

const LAYOUTS: Record<DoctorReport["layout"], string> = {
  missing: "檔案不存在",
  empty: "空檔案(0 位元組):Core 會把它當成新的資料庫",
  not_database: "不是 SQLite 資料庫",
  blank: "沒有任何資料表的 SQLite 檔:Core 會把它當成新的資料庫",
  v4: "V4 的資料庫",
  v5: "V5 的資料庫",
  foreign: "有資料表,但不是 Miyoria 的資料庫",
};

function range(versions: readonly number[]): string {
  if (versions.length === 0) return "無";
  const first = versions[0] as number;
  const last = versions.at(-1) as number;
  return versions.length === last - first + 1 && versions.length > 1
    ? `${first}–${last}`
    : versions.join(", ");
}

/** `miyoria db doctor [file]`. Throws when a check failed. */
export async function doctorCommand(configPath: string, file: string | undefined): Promise<void> {
  quietLogs();
  let path: string;
  let profile: string | null = null;
  if (file !== undefined) {
    path = resolve(file);
    if (existsSync(configPath)) profile = profileId(await loadConfig(configPath));
  } else {
    const config = await loadConfig(configPath);
    path = await configuredDatabase(config, configPath);
    profile = profileId(config);
  }
  const { inspectDatabase } = await loadStore();
  const r = inspectDatabase(path, { profile });
  let failures = 0;
  const bad = (msg: string) => {
    failures++;
    fail(msg);
  };

  section(`資料庫檢查:${shown(path)}(只讀)`);
  const kind =
    r.layout === "v4" ? `${LAYOUTS.v4}(schema_version ${r.v4_version})` : LAYOUTS[r.layout];
  if (r.layout === "not_database") bad(kind);
  else if (r.layout === "missing" || r.layout === "foreign") warn(kind);
  else ok(kind);
  if (r.facts.exists) {
    const side = [
      r.facts.wal === null ? "沒有 -wal" : `-wal ${bytes(r.facts.wal)}`,
      r.facts.shm === null ? "沒有 -shm" : `-shm ${bytes(r.facts.shm)}`,
    ];
    const mode = r.facts.walMode === null ? "" : r.facts.walMode ? "、WAL 模式" : "、rollback 模式";
    note(`${bytes(r.facts.size)}、${side.join("、")}${mode}`);
  }
  if (!r.facts.exists || r.facts.walMode === null) {
    if (failures > 0) throw new DbCommandError(`${failures} 項檢查沒通過`);
    return;
  }

  if (r.refusal === null) ok("Core 會開啟這個檔案");
  else {
    warn("Core 會拒絕開啟這個檔案");
    println(dim(`    ${r.refusal}`));
  }

  if (r.migrations !== null) {
    section("遷移");
    for (const m of r.migrations) {
      if (m.code === null) {
        note(`${m.plugin}:${range(m.applied)}(外掛的,Core 啟動時檢查)`);
        continue;
      }
      if (m.unknown.length > 0) bad(`${m.plugin}:${range(m.unknown)} 是比這個版本新的遷移`);
      if (m.changed.length > 0) bad(`${m.plugin}:${range(m.changed)} 套用後被改過`);
      if (m.pending.length > 0) {
        warn(`${m.plugin}:${range(m.pending)} 還沒套用(Core 下次啟動會套用)`);
      } else if (m.unknown.length === 0 && m.changed.length === 0) {
        ok(`${m.plugin}:${range(m.applied)}`);
      }
    }
  }

  section("檢查");
  if (r.integrity !== null) {
    if (r.integrity.length === 1 && r.integrity[0] === "ok") ok("integrity_check:ok");
    else {
      bad(`integrity_check 發現 ${r.integrity.length} 個問題`);
      for (const line of r.integrity.slice(0, SAMPLE)) println(dim(`    ${line}`));
    }
  }
  if (r.foreign_keys !== null) {
    if (r.foreign_keys.count === 0) ok("foreign_key_check:ok");
    else {
      warn(`foreign_key_check:${r.foreign_keys.count} 列指向不存在的資料`);
      for (const line of r.foreign_keys.first) println(dim(`    ${line}`));
    }
  }

  if (r.counts !== null) {
    section("內容");
    const events = r.layout === "v4" ? "事件(log_events)" : "事件";
    println(`  人 ${r.counts.persons}、帳號 ${r.counts.accounts}、${events} ${r.counts.events}`);
    println(`  最新的事件:${r.counts.newest_event ?? "無"}`);
  }
  if (r.spaces !== null) {
    section("伺服器");
    if (r.spaces.length === 0) note("還沒有任何伺服器");
    for (const s of r.spaces) {
      const tags = [
        s.primary ? (r.primary_pending ? "會成為主要的" : "主要的") : null,
        s.left ? "她已經離開" : null,
      ].filter((t) => t !== null);
      println(
        `  ${s.name}  ${dim(`${s.platform}:${s.external_id}`)}  成員 ${s.members}${tags.length > 0 ? `  ${tags.join("、")}` : ""}`,
      );
    }
    if (r.primary_pending && r.spaces.length > 1) {
      warn("主要的伺服器還沒定:Core 下次啟動時(identity v2)會選上面標的那個");
    }
  }
  if (r.layout === "v4") {
    section("import-links 會帶過來的(匯入一個空的資料庫時)");
    if (r.import !== null) for (const line of countLines(r.import)) println(`  ${line}`);
    else warn(`算不出來:${r.import_error ?? "?"}`);
  }
  if (failures > 0) throw new DbCommandError(`${failures} 項檢查沒通過`);
}
